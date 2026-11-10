import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from './config.ts';
import type { DB } from './db.ts';
import { Cache } from './lib/cache.ts';
import { AppError, badRequest } from './lib/errors.ts';
import { fetchJson } from './lib/http.ts';
import { AnalystService } from './modules/analyst/service.ts';
import { RANGES, type RangeKey } from './modules/markets/providers.ts';
import { MarketsService } from './modules/markets/service.ts';
import { TOPICS } from './modules/news/classify.ts';
import { COUNTRY_BY_ISO } from './modules/news/gazetteer.ts';
import { NewsService } from './modules/news/service.ts';
import { PersonalService } from './modules/personal/service.ts';

export interface Platform {
  app: express.Express;
  news: NewsService;
  markets: MarketsService;
  personal: PersonalService;
  analyst: AnalystService;
  cache: Cache;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD').refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  // Reject roll-overs such as 2026-02-30, which Date silently turns into March.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, 'Not a real calendar date');
const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');
  return id;
};
const parse = <S extends z.ZodType>(schema: S, data: unknown): z.infer<S> => {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input', r.error.issues);
  }
  return r.data;
};
/** The user's local calendar date, supplied by the browser; falls back to the server's. */
const todayOf = (req: Request): string => {
  const raw = (req.query.today ?? (req.body as { today?: unknown } | undefined)?.today) as unknown;
  const ok = dateStr.safeParse(raw);
  if (ok.success) return ok.data;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const optStr = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const optInt = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
const country = (v: unknown) => {
  const s = optStr(v)?.toUpperCase();
  if (s && !COUNTRY_BY_ISO.has(s)) throw badRequest(`Unknown country code "${s}"`);
  return s;
};
const topic = (v: unknown) => {
  const s = optStr(v);
  if (s && !TOPICS.some((t) => t.id === s)) throw badRequest(`Unknown topic "${s}"`);
  return s;
};

/** Server-sent events over a POST response, for streamed analyst output. */
function sse(res: Response) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return {
    signal: controller.signal,
    send: (event: unknown) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    fail: (err: unknown) => {
      const e = err instanceof AppError ? err : new AppError(500, 'internal', err instanceof Error ? err.message : 'Unexpected error');
      if (!(err instanceof AppError)) console.error('[analyst]', err);
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'error', code: e.code, message: e.message })}\n\n`);
    },
    end: () => {
      if (!res.writableEnded) res.end();
    },
  };
}

export function createPlatform(db: DB): Platform {
  const cache = new Cache(db);
  const news = new NewsService(db);
  const markets = new MarketsService(db, cache);
  const personal = new PersonalService(db);
  const analyst = new AnalystService(db, { news, markets, personal });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  const api = express.Router();

  // ---- system ----------------------------------------------------------------
  api.get('/status', (_req, res) => {
    const sources = news.listSources();
    res.json({
      serverTime: new Date().toISOString(),
      news: { ...news.meta(), countries: undefined, topics: undefined, sourcesEnabled: sources.filter((s) => s.enabled).length, sourcesFailing: sources.filter((s) => s.enabled && s.lastError).length, refreshMinutes: config.newsRefreshMinutes },
      analyst: analyst.status(),
      sec: { userAgentConfigured: config.secUserAgentConfigured },
    });
  });

  // ---- news ------------------------------------------------------------------
  api.get('/news/meta', (_req, res) => void res.json(news.meta()));
  api.get('/news/sources', (_req, res) => void res.json(news.listSources()));
  api.post('/news/sources', (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(1).max(80), url: z.string().trim().url().max(500) }), req.body);
    res.status(201).json(news.addSource(b.name, b.url));
  });
  api.patch('/news/sources/:id', (req, res) => {
    const b = parse(z.object({ enabled: z.boolean() }), req.body);
    news.setSourceEnabled(String(req.params.id), b.enabled);
    res.json({ ok: true });
  });
  api.delete('/news/sources/:id', (req, res) => {
    news.removeSource(String(req.params.id));
    res.json({ ok: true });
  });
  api.post('/news/refresh', async (_req, res) => {
    const results = await news.refresh();
    res.json({ results, inserted: results.reduce((a, r) => a + r.inserted, 0), failed: results.filter((r) => !r.ok).length });
  });
  api.get('/news/articles', (req, res) => {
    const kind = optStr(req.query.kind);
    if (kind && kind !== 'reporting' && kind !== 'commentary') throw badRequest('kind must be "reporting" or "commentary"');
    res.json(
      news.articles({
        country: country(req.query.country),
        topic: topic(req.query.topic),
        kind: kind as 'reporting' | 'commentary' | undefined,
        source: optStr(req.query.source),
        q: optStr(req.query.q),
        since: optStr(req.query.since),
        before: optStr(req.query.before),
        limit: optInt(req.query.limit),
        offset: optInt(req.query.offset),
      }),
    );
  });
  api.get('/news/stories', (req, res) => {
    res.json(news.stories({ hours: optInt(req.query.hours), country: country(req.query.country), topic: topic(req.query.topic), limit: optInt(req.query.limit), q: optStr(req.query.q) }));
  });
  api.get('/news/stories/:id', (req, res) => void res.json(news.story(idParam(req))));
  api.get('/news/map', (req, res) => void res.json(news.mapData(Math.min(optInt(req.query.hours) ?? 48, 336))));
  api.get('/news/trends', (req, res) => {
    res.json(news.trend({ country: country(req.query.country), topic: topic(req.query.topic), q: optStr(req.query.q), days: optInt(req.query.days) }));
  });
  /** Long-range global media attention from the GDELT project, independent of this archive. */
  api.get('/news/gdelt', async (req, res) => {
    const q = optStr(req.query.q);
    if (!q || q.length > 80) throw badRequest('q is required (max 80 characters)');
    const span = optStr(req.query.span) ?? '6m';
    if (!/^(1|3|6|12)m$/.test(span)) throw badRequest('span must be 1m, 3m, 6m or 12m');
    const url = `${config.upstream.gdelt}/api/v2/doc/doc?query=${encodeURIComponent(`"${q.replaceAll('"', '')}"`)}&mode=timelinevol&timespan=${span}&format=json&timelinesmooth=5`;
    const hit = await cache.wrap(`gdelt:${q.toLowerCase()}:${span}`, 6 * 3_600_000, async () => {
      const body = await fetchJson<{ timeline?: { data?: { date: string; value: number }[] }[] }>(url, { provider: 'GDELT', timeoutMs: 20_000, retries: 0 });
      const data = body.timeline?.[0]?.data ?? [];
      return data.map((d) => ({ date: `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`, value: d.value }));
    });
    res.json({ query: q, span, unit: 'Share of all monitored global news coverage, %', points: hit.value, fetchedAt: new Date(hit.storedAt).toISOString(), stale: hit.stale, provider: 'GDELT Project' });
  });

  // ---- markets ---------------------------------------------------------------
  api.get('/markets/board', async (_req, res) => void res.json(await markets.board()));
  api.get('/markets/search', async (req, res) => void res.json(await markets.search(optStr(req.query.q) ?? '')));
  api.get('/markets/quotes', async (req, res) => {
    const symbols = (optStr(req.query.symbols) ?? '').split(',').filter(Boolean).slice(0, 30);
    if (!symbols.length) throw badRequest('symbols is required');
    res.json(await markets.quotes(symbols));
  });
  api.get('/markets/history/:symbol', async (req, res) => {
    const range = (optStr(req.query.range) ?? '1Y').toUpperCase();
    if (!(range in RANGES)) throw badRequest(`range must be one of ${Object.keys(RANGES).join(', ')}`);
    res.json(await markets.history(String(req.params.symbol), range as RangeKey));
  });
  api.get('/markets/company/:symbol', async (req, res) => void res.json(await markets.company(String(req.params.symbol))));
  api.get('/markets/watchlist', async (_req, res) => void res.json(await markets.watchlist()));
  api.post('/markets/watchlist', async (req, res) => {
    const b = parse(z.object({ symbol: z.string().trim().min(1).max(15) }), req.body);
    res.status(201).json(await markets.addToWatchlist(b.symbol));
  });
  api.delete('/markets/watchlist/:symbol', (req, res) => {
    markets.removeFromWatchlist(String(req.params.symbol));
    res.json({ ok: true });
  });
  api.get('/markets/portfolio', async (_req, res) => void res.json(await markets.portfolio()));
  api.get('/markets/portfolio/risk', async (_req, res) => void res.json(await markets.portfolioRisk()));
  api.get('/markets/transactions', (_req, res) => void res.json(markets.transactions()));
  api.post('/markets/transactions', (req, res) => {
    const b = parse(
      z.object({
        symbol: z.string().trim().min(1).max(15),
        side: z.enum(['buy', 'sell']),
        quantity: z.number().positive().max(1e12),
        price: z.number().nonnegative().max(1e9),
        fee: z.number().nonnegative().max(1e9).optional(),
        tradedOn: dateStr,
        note: z.string().max(500).optional(),
      }),
      req.body,
    );
    res.status(201).json(markets.addTransaction(b));
  });
  api.delete('/markets/transactions/:id', (req, res) => {
    markets.deleteTransaction(idParam(req));
    res.json({ ok: true });
  });
  api.get('/markets/notes', (req, res) => void res.json(markets.notes(optStr(req.query.symbol))));
  const noteSchema = z.object({
    symbol: z.string().trim().min(1).max(15),
    title: z.string().trim().min(1).max(160),
    body: z.string().max(20_000).default(''),
    stance: z.enum(['bullish', 'neutral', 'bearish']).default('neutral'),
    targetPrice: z.number().positive().nullable().optional(),
  });
  api.post('/markets/notes', (req, res) => void res.status(201).json(markets.saveNote(parse(noteSchema, req.body))));
  api.put('/markets/notes/:id', (req, res) => void res.json(markets.saveNote({ ...parse(noteSchema, req.body), id: idParam(req) })));
  api.delete('/markets/notes/:id', (req, res) => {
    markets.deleteNote(idParam(req));
    res.json({ ok: true });
  });

  // ---- personal --------------------------------------------------------------
  api.get('/personal/overview', (req, res) => void res.json(personal.performance(todayOf(req))));
  api.get('/personal/runs', (_req, res) => void res.json(personal.runs()));
  api.post('/personal/runs', (req, res) => {
    const b = parse(
      z.object({
        runOn: dateStr,
        distanceKm: z.number().positive().max(500),
        durationS: z.number().int().positive().max(7 * 86_400),
        kind: z.enum(['easy', 'tempo', 'intervals', 'long', 'race', 'recovery']).optional(),
        avgHr: z.number().int().min(30).max(250).nullable().optional(),
        elevationM: z.number().min(0).max(20_000).nullable().optional(),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    res.status(201).json(personal.addRun(b));
  });
  api.post('/personal/runs/import-gpx', express.text({ type: () => true, limit: '25mb' }), (req, res) => {
    if (typeof req.body !== 'string' || !req.body.trim()) throw badRequest('Upload a GPX file');
    try {
      res.status(201).json(personal.importGpx(req.body));
    } catch (err) {
      throw err instanceof AppError ? err : badRequest(err instanceof Error ? err.message : 'Could not read GPX file');
    }
  });
  api.delete('/personal/runs/:id', (req, res) => {
    personal.deleteRun(idParam(req));
    res.json({ ok: true });
  });
  api.get('/personal/objectives', (req, res) => void res.json(personal.objectives(todayOf(req))));
  api.post('/personal/objectives', (req, res) => {
    const b = parse(
      z
        .object({
          title: z.string().trim().min(1).max(160),
          description: z.string().max(2000).optional(),
          category: z.string().trim().max(40).optional(),
          unit: z.string().trim().max(20).optional(),
          startValue: z.number().finite().optional(),
          targetValue: z.number().finite(),
          dueOn: dateStr.nullable().optional(),
        })
        .refine((o) => o.targetValue !== (o.startValue ?? 0), { message: 'Target must differ from the starting value', path: ['targetValue'] }),
      req.body,
    );
    res.status(201).json(personal.addObjective(b));
  });
  api.post('/personal/objectives/:id/progress', (req, res) => {
    const b = parse(z.object({ value: z.number().finite(), note: z.string().max(300).optional() }), req.body);
    personal.logObjective(idParam(req), b.value, b.note);
    res.json({ ok: true });
  });
  api.patch('/personal/objectives/:id', (req, res) => {
    const b = parse(z.object({ status: z.enum(['active', 'achieved', 'dropped']) }), req.body);
    personal.setObjectiveStatus(idParam(req), b.status);
    res.json({ ok: true });
  });
  api.delete('/personal/objectives/:id', (req, res) => {
    personal.deleteObjective(idParam(req));
    res.json({ ok: true });
  });
  api.get('/personal/tasks', (_req, res) => void res.json(personal.tasks()));
  api.post('/personal/tasks', (req, res) => {
    const b = parse(z.object({ title: z.string().trim().min(1).max(200), notes: z.string().max(2000).optional(), dueOn: dateStr.nullable().optional(), priority: z.number().int().min(1).max(3).optional() }), req.body);
    res.status(201).json(personal.addTask(b));
  });
  api.patch('/personal/tasks/:id', (req, res) => {
    const b = parse(z.object({ title: z.string().trim().min(1).max(200).optional(), notes: z.string().max(2000).optional(), dueOn: dateStr.nullable().optional(), priority: z.number().int().min(1).max(3).optional(), done: z.boolean().optional() }), req.body);
    personal.updateTask(idParam(req), b);
    res.json({ ok: true });
  });
  api.delete('/personal/tasks/:id', (req, res) => {
    personal.deleteTask(idParam(req));
    res.json({ ok: true });
  });
  api.get('/personal/deadlines', (_req, res) => void res.json(personal.deadlines()));
  api.post('/personal/deadlines', (req, res) => {
    const b = parse(z.object({ title: z.string().trim().min(1).max(200), dueOn: dateStr, category: z.string().trim().max(40).optional(), notes: z.string().max(1000).optional() }), req.body);
    res.status(201).json(personal.addDeadline(b));
  });
  api.patch('/personal/deadlines/:id', (req, res) => {
    const b = parse(z.object({ done: z.boolean() }), req.body);
    personal.setDeadlineDone(idParam(req), b.done);
    res.json({ ok: true });
  });
  api.delete('/personal/deadlines/:id', (req, res) => {
    personal.deleteDeadline(idParam(req));
    res.json({ ok: true });
  });

  // ---- analyst ---------------------------------------------------------------
  api.get('/analyst/status', (_req, res) => void res.json(analyst.status()));
  api.get('/analyst/conversations', (_req, res) => void res.json(analyst.conversations()));
  api.get('/analyst/conversations/:id', (req, res) => void res.json(analyst.conversation(idParam(req))));
  api.delete('/analyst/conversations/:id', (req, res) => {
    analyst.deleteConversation(idParam(req));
    res.json({ ok: true });
  });
  api.post('/analyst/chat', async (req, res) => {
    const b = parse(z.object({ conversationId: z.number().int().positive().optional(), text: z.string().trim().min(1).max(8000) }), req.body);
    if (!analyst.status().configured) throw new AppError(503, 'analyst_not_configured', 'The AI analyst needs an Anthropic API key. Set ANTHROPIC_API_KEY in .env and restart.');
    const stream = sse(res);
    try {
      await analyst.chat({ ...b, today: todayOf(req), emit: stream.send, signal: stream.signal });
      stream.send({ type: 'done' });
    } catch (err) {
      stream.fail(err);
    } finally {
      stream.end();
    }
  });
  api.get('/analyst/reports', (_req, res) => void res.json(analyst.reports()));
  api.get('/analyst/reports/:id', (req, res) => void res.json(analyst.report(idParam(req))));
  api.delete('/analyst/reports/:id', (req, res) => {
    analyst.deleteReport(idParam(req));
    res.json({ ok: true });
  });
  const reportSchema = z.object({
    engine: z.enum(['ai', 'digest']),
    request: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('daily-brief') }),
      z.object({ kind: z.literal('country'), iso3: z.string().length(3) }),
      z.object({ kind: z.literal('company'), symbol: z.string().trim().min(1).max(15) }),
      z.object({ kind: z.literal('comparison'), subject: z.enum(['countries', 'companies']), a: z.string().trim().min(1).max(15), b: z.string().trim().min(1).max(15) }),
      z.object({ kind: z.literal('custom'), prompt: z.string().trim().min(3).max(4000) }),
    ]),
  });
  api.post('/analyst/reports', async (req, res) => {
    const b = parse(reportSchema, req.body);
    if (b.engine === 'ai' && !analyst.status().configured) throw new AppError(503, 'analyst_not_configured', 'AI reports need an Anthropic API key. Generate a data digest instead, or set ANTHROPIC_API_KEY.');
    if (b.engine === 'digest' && b.request.kind === 'custom') throw badRequest('Custom reports need the AI analyst.');
    if (b.request.kind === 'country') country(b.request.iso3);
    if (b.request.kind === 'comparison' && b.request.subject === 'countries') {
      country(b.request.a);
      country(b.request.b);
    }
    const stream = sse(res);
    try {
      const report = await analyst.generateReport({ ...b, today: todayOf(req), emit: stream.send, signal: stream.signal });
      stream.send({ type: 'report', report });
      stream.send({ type: 'done' });
    } catch (err) {
      stream.fail(err);
    } finally {
      stream.end();
    }
  });

  api.use((_req, _res, next) => next(new AppError(404, 'not_found', 'No such API endpoint')));
  app.use('/api', api);

  // ---- static client (production build) ---------------------------------------
  const dist = path.resolve('dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.get(/^(?!\/api\/).*/, (_req, res) => void res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return void res.end();
    if (err instanceof AppError) {
      return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { status?: number; type?: string })?.type === 'entity.parse.failed' ? 400 : (err as { status?: number })?.status === 413 ? 413 : 500;
    if (status === 500) console.error('[api] unhandled error', err);
    res.status(status).json({ error: { code: status === 500 ? 'internal' : 'bad_request', message: status === 400 ? 'Request body is not valid JSON' : status === 413 ? 'Upload is too large' : 'Internal server error' } });
  });

  return { app, news, markets, personal, analyst, cache };
}
