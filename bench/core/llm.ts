// The benchmark's only door to a model. Every call goes through `complete()`, which:
//  - uses one model for every condition (default claude-haiku-5-5), so no system gets a stronger brain;
//  - caches responses on disk by request hash (resume a run, re-score without paying twice);
//  - records provider-reported usage and prices it with a dated table;
//  - can run in mock mode (a function supplies the answer), so the whole pipeline is testable for free.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

/** USD per million tokens. Source: Anthropic pricing as cached in the claude-api skill on 2026-10-06. */
export const PRICING: Record<string, { in: number; out: number; cacheRead: number; longIn?: number; longOut?: number; longAbove?: number; asOf: string }> = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cacheRead: 0.01, longIn: 0.50, longOut: 2.50, longAbove: 100_000, asOf: '2026-10-06' },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, asOf: '2026-10-06' },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, asOf: '2026-10-06' },
};

export interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

export function costUsd(model: string, u: Usage): number {
  const p = PRICING[model];
  if (!p) return NaN;
  const prompt = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const long = p.longAbove != null && prompt > p.longAbove;
  const rin = long ? p.longIn! : p.in;
  const rout = long ? p.longOut! : p.out;
  return (u.input_tokens * rin + (u.cache_creation_input_tokens ?? 0) * rin * 1.25 + (u.cache_read_input_tokens ?? 0) * p.cacheRead + u.output_tokens * rout) / 1e6;
}

export interface CallRecord { purpose: string; model: string; usage: Usage; cost_usd: number; cached: boolean; ms: number }

export interface Request {
  purpose: string; // actor | judge | summary | notes | extractor | tool-agent
  system: string;
  messages: { role: 'user' | 'assistant'; content: unknown }[];
  schema?: Record<string, unknown>;
  tools?: unknown[];
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  /** Trial number: trial 2 of the same request must not hit trial 1's cache. */
  trial?: number;
  /** Prompt caching, as any production caller would use it: 'conversation' caches the whole prefix (a tool loop
   *  re-sends its growing history every turn); 'system' caches only the system prompt (a one-off call whose system
   *  prompt every case shares). Cache writes cost 1.25x, so a unique prompt is never cached whole. */
  promptCache?: 'conversation' | 'system';
}

export interface Response { text: string; content: { type: string; [k: string]: unknown }[]; stop_reason: string; usage: Usage; record: CallRecord }

export interface LlmOptions {
  model?: string;
  cacheDir?: string;
  /** Mock mode: answer every request locally. */
  mock?: (req: Request) => { text?: string; content?: Response['content'] } | Promise<{ text?: string; content?: Response['content'] }>;
  /** Max concurrent provider requests. */
  concurrency?: number;
  /** Ignore cached responses (still writes them). */
  refresh?: boolean;
}

export class Llm {
  model: string;
  calls: CallRecord[] = [];
  #opts: LlmOptions;
  #active = 0;
  #queue: (() => void)[] = [];
  #client: unknown = null;

  constructor(opts: LlmOptions = {}) {
    this.#opts = opts;
    this.model = opts.model ?? DEFAULT_MODEL;
    if (opts.cacheDir) mkdirSync(opts.cacheDir, { recursive: true });
  }

  async #slot<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.#opts.concurrency ?? 6;
    if (this.#active >= max) await new Promise<void>((res) => this.#queue.push(res));
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }

  async #provider() {
    if (!this.#client) {
      const { anthropicClient } = await import('../../src/anthropic.ts');
      this.#client = anthropicClient();
    }
    return this.#client as { messages: { create(body: unknown): Promise<unknown> } };
  }

  #body(req: Request) {
    return {
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.promptCache === 'system' ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }] : req.system,
      messages: req.messages,
      ...(req.tools ? { tools: req.tools } : {}),
      ...(req.promptCache === 'conversation' ? { cache_control: { type: 'ephemeral' } } : {}),
      output_config: {
        effort: req.effort ?? 'medium',
        ...(req.schema ? { format: { type: 'json_schema', schema: req.schema } } : {}),
      },
    };
  }

  async complete(req: Request): Promise<Response> {
    const body = this.#body(req);
    const key = createHash('sha256').update(JSON.stringify({ body, trial: req.trial ?? 1 })).digest('hex');
    const file = this.#opts.cacheDir ? join(this.#opts.cacheDir, `${key}.json`) : null;
    const started = Date.now();

    if (this.#opts.mock) {
      const m = await this.#opts.mock(req);
      const content = m.content ?? [{ type: 'text', text: m.text ?? '' }];
      const text = content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('');
      const usage = { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: Math.ceil(text.length / 4) };
      return this.#finish(req, { text, content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage }, true, started, true);
    }

    if (file && !this.#opts.refresh && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Omit<Response, 'record'>;
      return this.#finish(req, saved, true, started, false);
    }

    const res = await this.#slot(async () => {
      const client = await this.#provider();
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return (await client.messages.create(body)) as { content: Response['content']; stop_reason: string; usage: Usage };
        } catch (e) {
          lastErr = e;
          const status = (e as { status?: number }).status ?? 0;
          if (status && status < 500 && status !== 429 && status !== 408) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
        }
      }
      throw lastErr;
    });
    if (res.stop_reason === 'refusal') throw new Error(`${req.purpose}: model refused`);
    const text = res.content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('');
    // thinking blocks are kept: a tool loop must hand them back unchanged on the next turn
    const out = { text, content: res.content, stop_reason: res.stop_reason, usage: res.usage };
    if (file) writeFileSync(file, JSON.stringify(out));
    return this.#finish(req, out, false, started, false);
  }

  #finish(req: Request, r: Omit<Response, 'record'>, cached: boolean, started: number, mock: boolean): Response {
    const record: CallRecord = { purpose: req.purpose, model: mock ? `mock:${this.model}` : this.model, usage: r.usage, cost_usd: mock ? 0 : costUsd(this.model, r.usage), cached, ms: Date.now() - started };
    this.calls.push(record);
    return { ...r, record };
  }

  /** Parse a structured-output response. */
  static json<T>(r: Response): T {
    return JSON.parse(r.text) as T;
  }
}

/** chars/4: the estimate used for budgets and for conditions whose context is not a single model call. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export function sumUsage(calls: CallRecord[]) {
  return calls.reduce(
    (a, c) => ({
      input_tokens: a.input_tokens + c.usage.input_tokens + (c.usage.cache_read_input_tokens ?? 0),
      output_tokens: a.output_tokens + c.usage.output_tokens,
      cost_usd: a.cost_usd + (Number.isFinite(c.cost_usd) ? c.cost_usd : 0),
      calls: a.calls + 1,
    }),
    { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 },
  );
}
