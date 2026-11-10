import type { AnalystService } from '../../../server/modules/analyst/service.ts';
import type { AgentEvent } from '../../../server/modules/analyst/agent.ts';
import type { ReportRequest } from '../../../server/modules/analyst/digest.ts';
import type { SourceRef } from '../../../server/modules/analyst/tools.ts';
import type { MarketsService } from '../../../server/modules/markets/service.ts';
import type { Candle, Quote, RangeKey, SearchHit } from '../../../server/modules/markets/providers.ts';
import type { FiscalYear } from '../../../server/modules/markets/sec.ts';
import type { ArticleDto, NewsService, RefreshResult, StoryDto } from '../../../server/modules/news/service.ts';
import type { PersonalService } from '../../../server/modules/personal/service.ts';

// The client's types are the server's own return types, so the two cannot drift.
type R<T extends (...a: never[]) => unknown> = Awaited<ReturnType<T>>;
export type { AgentEvent, ArticleDto, Candle, FiscalYear, Quote, RangeKey, RefreshResult, ReportRequest, SearchHit, SourceRef, StoryDto };
export type NewsMeta = R<NewsService['meta']>;
export type NewsSource = R<NewsService['listSources']>[number];
export type MapCountry = R<NewsService['mapData']>[number];
export type Trend = R<NewsService['trend']>;
export type QuoteRow = R<MarketsService['quotes']>[number];
export type BoardRow = R<MarketsService['board']>[number];
export type WatchRow = R<MarketsService['watchlist']>[number];
export type History = R<MarketsService['history']>;
export type Company = R<MarketsService['company']>;
export type Portfolio = R<MarketsService['portfolio']>;
export type PortfolioRisk = R<MarketsService['portfolioRisk']>;
export type Transaction = R<MarketsService['transactions']>[number];
export type Note = R<MarketsService['notes']>[number];
export type PersonalOverview = R<PersonalService['performance']>;
export type Objective = R<PersonalService['objectives']>[number];
export type Task = R<PersonalService['tasks']>[number];
export type Deadline = R<PersonalService['deadlines']>[number];
export type RunEntry = R<PersonalService['runs']>[number];
export type ConversationList = R<AnalystService['conversations']>;
export type Conversation = R<AnalystService['conversation']>;
export type ReportSummary = R<AnalystService['reports']>[number];
export type Report = R<AnalystService['report']>;
export interface Status {
  serverTime: string;
  news: { articleCount: number; lastIngestAt: string | null; archiveStart: string | null; sourcesEnabled: number; sourcesFailing: number; refreshMinutes: number };
  analyst: { configured: boolean; model: string | null };
  sec: { userAgentConfigured: boolean };
}
export interface Gdelt { query: string; span: string; unit: string; points: { date: string; value: number }[]; fetchedAt: string; stale: boolean; provider: string }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    return new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? res.statusText);
  } catch {
    return new ApiError(res.status, 'error', res.status === 504 || res.status === 502 ? 'The Command Centre server is not responding.' : res.statusText || 'Request failed');
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: { contentType: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': raw?.contentType ?? 'application/json' },
      body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the Command Centre server. Check that it is running.');
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, text: string, contentType: string) => request<T>('POST', path, text, { contentType }),
  qs,
};

export type StreamEvent = AgentEvent | { type: 'conversation'; id: number; title: string } | { type: 'report'; report: Report } | { type: 'done' } | { type: 'error'; code: string; message: string };

/** POST and consume a server-sent event stream, invoking onEvent per event. */
export async function stream(path: string, body: unknown, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Cannot reach the Command Centre server. Check that it is running.');
  }
  if (!res.ok || !res.body) throw await toError(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!chunk.startsWith('data: ')) continue;
      const event = JSON.parse(chunk.slice(6)) as StreamEvent;
      if (event.type === 'done' || event.type === 'error') finished = true;
      onEvent(event);
    }
  }
  if (!finished) onEvent({ type: 'error', code: 'interrupted', message: 'The connection closed before the answer finished.' });
}
