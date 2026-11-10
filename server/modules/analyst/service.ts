import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.ts';
import { type DB, nowIso, transaction } from '../../db.ts';
import { notFound } from '../../lib/errors.ts';
import { type AgentEvent, analystConfigured, runAnalyst } from './agent.ts';
import { buildDigest, reportPrompt, type ReportRequest, reportTitle } from './digest.ts';
import type { Services, SourceRef } from './tools.ts';

type MessageParam = Anthropic.Beta.BetaMessageParam;

export class AnalystService {
  constructor(
    private db: DB,
    private services: Services,
  ) {}

  status() {
    return { configured: analystConfigured(), model: analystConfigured() ? config.analystModel : null };
  }

  conversations() {
    return this.db.prepare('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100').all().map((r) => ({ id: Number(r.id), title: String(r.title), updatedAt: String(r.updated_at) }));
  }

  /** Displayable transcript: user questions and final assistant answers with their sources. */
  conversation(id: number) {
    const conv = this.db.prepare('SELECT id, title FROM conversations WHERE id = ?').get(id);
    if (!conv) throw notFound('Conversation');
    const messages = this.db
      .prepare('SELECT id, role, display, created_at FROM messages WHERE conversation_id = ? AND display IS NOT NULL ORDER BY id')
      .all(id)
      .map((r) => ({ id: Number(r.id), role: String(r.role) as 'user' | 'assistant', createdAt: String(r.created_at), ...(JSON.parse(String(r.display)) as { text: string; sources?: SourceRef[]; steps?: string[] }) }));
    return { id: Number(conv.id), title: String(conv.title), messages };
  }

  deleteConversation(id: number) {
    if (this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes === 0) throw notFound('Conversation');
  }

  private history(conversationId: number): MessageParam[] {
    return this.db
      .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id')
      .all(conversationId)
      .map((r) => ({ role: String(r.role) as 'user' | 'assistant', content: JSON.parse(String(r.content)) }));
  }

  /** One chat turn. Persists the full exchange (including tool traffic) only if the turn succeeds. */
  async chat(opts: { conversationId?: number; text: string; today: string; emit: (e: AgentEvent | { type: 'conversation'; id: number; title: string }) => void; signal?: AbortSignal }) {
    let conversationId = opts.conversationId;
    let title: string;
    if (conversationId) {
      const row = this.db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId);
      if (!row) throw notFound('Conversation');
      title = String(row.title);
    } else {
      title = opts.text.replace(/\s+/g, ' ').slice(0, 80);
    }
    const history = conversationId ? this.history(conversationId) : [];
    const steps: string[] = [];
    const result = await runAnalyst({
      services: this.services,
      history,
      userText: opts.text,
      today: opts.today,
      signal: opts.signal,
      emit: (e) => {
        if (e.type === 'tool' && e.status === 'running') steps.push(e.label);
        opts.emit(e);
      },
    });
    const now = nowIso();
    transaction(this.db, () => {
      if (!conversationId) {
        conversationId = Number(this.db.prepare('INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)').run(title, now, now).lastInsertRowid);
      } else {
        this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
      }
      const insert = this.db.prepare('INSERT INTO messages (conversation_id, role, content, display, created_at) VALUES (?, ?, ?, ?, ?)');
      result.newMessages.forEach((m, i) => {
        const isFirst = i === 0;
        const isLast = i === result.newMessages.length - 1 && m.role === 'assistant';
        const display = isFirst ? { text: opts.text } : isLast ? { text: result.text, sources: result.sources, steps } : null;
        insert.run(conversationId!, m.role, JSON.stringify(m.content), display ? JSON.stringify(display) : null, now);
      });
    });
    opts.emit({ type: 'conversation', id: conversationId!, title });
    return { conversationId: conversationId! };
  }

  // ---- reports ---------------------------------------------------------------

  reports() {
    return this.db.prepare('SELECT id, title, kind, engine, created_at FROM reports ORDER BY id DESC LIMIT 200').all().map((r) => ({ id: Number(r.id), title: String(r.title), kind: String(r.kind), engine: String(r.engine), createdAt: String(r.created_at) }));
  }

  report(id: number) {
    const r = this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    if (!r) throw notFound('Report');
    return { id: Number(r.id), title: String(r.title), kind: String(r.kind), engine: String(r.engine), body: String(r.body), sources: JSON.parse(String(r.sources)) as SourceRef[], createdAt: String(r.created_at) };
  }

  deleteReport(id: number) {
    if (this.db.prepare('DELETE FROM reports WHERE id = ?').run(id).changes === 0) throw notFound('Report');
  }

  private saveReport(title: string, kind: string, engine: string, body: string, sources: SourceRef[]) {
    const res = this.db.prepare('INSERT INTO reports (title, kind, engine, body, sources, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(title, kind, engine, body, JSON.stringify(sources), nowIso());
    return this.report(Number(res.lastInsertRowid));
  }

  /**
   * Generate and store a report. engine 'ai' uses the analyst; 'digest' is the
   * deterministic data-only version and needs no API key.
   */
  async generateReport(opts: { request: ReportRequest; engine: 'ai' | 'digest'; today: string; emit: (e: AgentEvent) => void; signal?: AbortSignal }) {
    const title = reportTitle(opts.request, opts.today);
    if (opts.engine === 'digest') {
      const { body, sources } = await buildDigest(opts.request, this.services, opts.today);
      opts.emit({ type: 'text', delta: body });
      opts.emit({ type: 'sources', sources });
      return this.saveReport(title, opts.request.kind, 'data-digest', body, sources);
    }
    const result = await runAnalyst({ services: this.services, history: [], userText: reportPrompt(opts.request, opts.today), today: opts.today, emit: opts.emit, signal: opts.signal });
    return this.saveReport(title, opts.request.kind, `ai:${result.model}`, result.text, result.sources);
  }
}
