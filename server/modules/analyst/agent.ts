import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.ts';
import { AppError } from '../../lib/errors.ts';
import { type Services, type SourceRef, TOOL_DEFINITIONS, TOOLS, type ToolName } from './tools.ts';

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; label: string; status: 'running' | 'done' | 'error'; detail?: string }
  | { type: 'sources'; sources: SourceRef[] }
  | { type: 'notice'; message: string };

export interface AgentResult {
  text: string;
  sources: SourceRef[];
  /** Messages produced during this turn, to append to the stored conversation. */
  newMessages: BetaMessageParam[];
  model: string;
  stopReason: string | null;
}

const MAX_TURNS = 8;

export function analystConfigured(): boolean {
  return Boolean(config.anthropicApiKey);
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!analystConfigured()) {
    throw new AppError(503, 'analyst_not_configured', 'The AI analyst needs an Anthropic API key. Set ANTHROPIC_API_KEY in .env and restart.');
  }
  client ??= new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2 });
  return client;
}

export function systemPrompt(today: string): string {
  return `You are the analyst inside Command Centre, a personal intelligence platform used by one person to follow world events, research investments and track their own performance. Today is ${today}.

Your reader relies on you for decisions, so the standard is that of a careful intelligence analyst: everything factual is traceable to a source, and it is always clear what is known, what is inferred, and what is unknown.

Where your information comes from
- The platform's tools are your only source of current information: its news archive (headlines and summaries from public RSS feeds), delayed market prices, company-filed SEC financials, and the user's own portfolio, running log, objectives and tasks. Call tools before answering anything that depends on current or user-specific data. Calling several at once is fine.
- The news archive holds headlines and short summaries, not full articles, and only since the platform began ingesting. If a question needs detail the summaries do not contain, say so rather than filling the gap from memory.
- Your own background knowledge may be used to explain concepts and history, but it has a training cutoff. Label it as background, and never present it as a current fact or attach a source link to it.
- Market prices are delayed. State the as-of time when you quote a price.

How to write
- Lead with the answer. Write for an intelligent non-specialist: plain words, define jargon the first time, short paragraphs. Use tables for side-by-side comparisons.
- Separate what sources report from your own reading of it. Put reported facts first, each with an inline markdown link to the article, filing or data page it came from, using the exact URLs the tools returned. Then give your interpretation under a heading such as "Assessment", written so it is clearly yours.
- Attribute claims that rest on one outlet ("according to …"), and note when several independent outlets agree. A story marked single-source is unverified; treat it that way.
- State uncertainty concretely: what you could not determine, which data was missing or stale, and how confident you are (high, moderate, low) in each judgement and why.
- Never invent a figure, quote, date, URL or event. If the tools return nothing relevant, say that the platform holds no data on it and suggest what the user could add or refresh.
- Investment questions: give analysis and the considerations on each side, grounded in the data. Do not give personalised buy or sell instructions; note that this is research, not financial advice, once, briefly, where relevant.
- Fitness questions: you can analyse the training log, but you are not a medical professional; say so if the question turns medical.`;
}

function errorMessage(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AppError(503, 'analyst_auth', 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY.');
  if (err instanceof Anthropic.PermissionDeniedError) return new AppError(503, 'analyst_auth', 'This API key is not permitted to use the configured model.');
  if (err instanceof Anthropic.NotFoundError) return new AppError(503, 'analyst_model', `Model "${config.analystModel}" was not found. Check ANALYST_MODEL.`);
  if (err instanceof Anthropic.RateLimitError) return new AppError(429, 'analyst_rate_limited', 'The AI provider is rate limiting requests. Wait a moment and try again.');
  if (err instanceof Anthropic.APIConnectionError) return new AppError(502, 'analyst_unreachable', 'Could not reach the AI provider. Check your network connection.');
  if (err instanceof Anthropic.APIError) return new AppError(502, 'analyst_error', `AI provider error${err.status ? ` (${err.status})` : ''}: ${err.message}`);
  return new AppError(500, 'analyst_error', err instanceof Error ? err.message : 'Unexpected analyst error');
}

/**
 * Run one analyst turn: stream the model, execute any tool calls against the
 * platform's own data, and loop until it produces a final answer.
 */
export async function runAnalyst(opts: {
  services: Services;
  history: BetaMessageParam[];
  userText: string;
  today: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<AgentResult> {
  const anthropic = getClient();
  const sources = new Map<string, SourceRef>();
  const cite = (s: SourceRef) => {
    if (!sources.has(s.url)) sources.set(s.url, s);
  };
  const newMessages: BetaMessageParam[] = [{ role: 'user', content: opts.userText }];
  let text = '';
  let stopReason: string | null = null;
  let model = config.analystModel;
  let jsonRetries = 0;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = anthropic.beta.messages.stream(
        {
          model: config.analystModel,
          max_tokens: 32_000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          // If the primary model declines on policy grounds, let the API route to its default fallback.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: [{ type: 'text', text: systemPrompt(opts.today), cache_control: { type: 'ephemeral' } }],
          tools: TOOL_DEFINITIONS,
          messages: [...opts.history, ...newMessages],
        },
        { signal: opts.signal },
      );
      let turnText = '';
      stream.on('text', (delta) => {
        turnText += delta;
        opts.emit({ type: 'text', delta });
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming a tool input can fail to parse; re-issue that turn (bounded).
        if (err instanceof Anthropic.APIError || opts.signal?.aborted || jsonRetries++ >= 2) throw err;
        continue;
      }
      stopReason = message.stop_reason;
      model = message.model;
      text += turnText;

      if (message.stop_reason === 'refusal') {
        opts.emit({ type: 'notice', message: 'The model declined to answer this request.' });
        if (!text) text = 'The model declined to answer this request.';
        break;
      }
      if (message.stop_reason === 'pause_turn') {
        newMessages.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
        continue;
      }
      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) {
        newMessages.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
        if (message.stop_reason === 'max_tokens') opts.emit({ type: 'notice', message: 'The answer was cut off at the length limit.' });
        break;
      }
      if (message.stop_reason === 'max_tokens') {
        throw new AppError(502, 'analyst_error', 'The model ran out of output budget while requesting data. Try a narrower question.');
      }
      newMessages.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
      if (turnText && !turnText.endsWith('\n')) {
        text += '\n\n';
        opts.emit({ type: 'text', delta: '\n\n' });
      }

      const results = await Promise.all(
        toolUses.map(async (use): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const spec = TOOLS[use.name as ToolName];
          if (!spec) return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}` };
          // Inputs are model output: validate against the schema before running anything.
          const parsed = spec.schema.safeParse(use.input);
          if (!parsed.success) {
            return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify({ INVALID_INPUT: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }) };
          }
          const label = (spec.label as (i: unknown) => string)(parsed.data);
          opts.emit({ type: 'tool', id: use.id, name: use.name, label, status: 'running' });
          try {
            const out = await (spec.run as (i: unknown, c: unknown) => Promise<unknown>)(parsed.data, { services: opts.services, today: opts.today, cite });
            opts.emit({ type: 'tool', id: use.id, name: use.name, label, status: 'done' });
            return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out) };
          } catch (err) {
            const detail = err instanceof Error ? err.message : 'tool failed';
            opts.emit({ type: 'tool', id: use.id, name: use.name, label, status: 'error', detail });
            return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Tool failed: ${detail}` };
          }
        }),
      );
      newMessages.push({ role: 'user', content: results });
      if (turn === MAX_TURNS - 1) opts.emit({ type: 'notice', message: 'Stopped after the maximum number of research steps.' });
    }
  } catch (err) {
    throw errorMessage(err);
  }

  // Only list sources the answer could have drawn on; order by first use.
  const used = [...sources.values()];
  opts.emit({ type: 'sources', sources: used });
  return { text: text.trim(), sources: used, newMessages, model, stopReason };
}
