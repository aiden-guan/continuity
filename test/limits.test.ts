// Limits on Claude calls during interpretation: an overall deadline (even for an extractor that ignores
// its AbortSignal), the signal handed to the extractor, the circuit breaker, the concurrency limiter, and
// attachment downloads that cannot hang. Ported from samrocksnature's test/queue.test.ts; the per-task
// promise-chain tests there do not apply here (durable jobs already serialize work per task).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type AttachmentFetcher, type EngineOptions } from '../src/engine/engine.ts';
import { Breaker, isTransient, limiter } from '../src/engine/limit.ts';
import { heuristicExtractor } from '../src/extract/heuristic.ts';
import type { Extractor } from '../src/extract/types.ts';
import { fromPrimitiveWebhook } from '../src/ingest/normalize.ts';
import { SimMailbox } from '../src/sim/mailbox.ts';
import { defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import type { EventInput } from '../src/types.ts';

// Wall-clock bound for "was cut off by the configured limit". Generous (far above the tiny limits the tests set, so a
// loaded machine still passes) yet well below the defaults (150 s extraction deadline, 30 s attachment timeout), so a
// limit that silently fell back to its default still fails. The limit itself is also checked without the clock.
const CUT_OFF_BOUND_MS = 10_000;

const addr = defaultAddresses();
const task = procurementTask(addr);
const ORG = 'org_limits';
const mailbox = new SimMailbox();

function mail(subject: string, body = 'Unit price is $11.40 per unit.'): EventInput {
  const delivery = mailbox.inbound({ from: addr.supplier, fromName: 'Dana', to: addr.self, subject, body, at: '2026-10-19T11:00:00Z', threadKey: `t${Math.random()}` }, 'k');
  return fromPrimitiveWebhook(JSON.parse(delivery.body));
}

async function setup(extractor: Extractor, opts: EngineOptions = {}, fetchAttachment: AttachmentFetcher | null = null) {
  const backend = new MemoryBackend();
  await backend.ensureOrg(ORG);
  const engine = new Engine(backend, extractor, fetchAttachment, opts);
  await engine.createTask(ORG, task, '2026-10-19T08:00:00Z');
  const flags = async () => (await backend.loadTask(ORG, task.id)).store.flagsForTask(task.id);
  const claims = async () => (await backend.loadTask(ORG, task.id)).store.claimsForTask(task.id);
  return { backend, engine, flags, claims };
}

test('an extraction past its deadline falls back to rules and is flagged, even if the extractor ignores the signal', { timeout: 60_000 }, async () => {
  const hangs: Extractor = { name: 'hangs', extract: () => new Promise(() => {}) };
  const { engine, flags, claims } = await setup(hangs, { extractDeadlineMs: 50 });
  const started = Date.now();
  const r = await engine.ingest(ORG, mail('PO-4817 quote'));
  const elapsed = Date.now() - started;
  assert.equal(r.extractor, heuristicExtractor.name);
  // the configured 50 ms deadline fired (not the default), and nothing waited on the hung extractor
  assert.ok((await flags()).some((f) => f.kind === 'extractor_fallback' && /deadline of 50 ms exceeded/.test(f.detail)));
  assert.ok(elapsed < CUT_OFF_BOUND_MS, `ingest took ${elapsed} ms with a 50 ms extraction deadline`);
  assert.equal((await claims()).find((c) => c.key === 'price.unit')?.value, 11.4);
});

test('the deadline signal is passed to the extractor so it can cancel its own request', async () => {
  let aborted = false;
  const cooperative: Extractor = {
    name: 'cooperative',
    extract: (_input, o) => new Promise((_resolve, reject) => o?.signal?.addEventListener('abort', () => {
      aborted = true;
      reject(o.signal!.reason);
    })),
  };
  const { engine } = await setup(cooperative, { extractDeadlineMs: 30 });
  await engine.ingest(ORG, mail('PO-4817 quote'));
  assert.equal(aborted, true);
});

test('circuit breaker: after repeated outages the primary extractor is skipped, then retried after the cooldown', async () => {
  let calls = 0;
  let now = 0;
  const down: Extractor = {
    name: 'down',
    async extract() {
      calls++;
      throw Object.assign(new Error('overloaded'), { status: 529 });
    },
  };
  const { engine, flags } = await setup(down, { breaker: new Breaker(3, 60_000, () => now) });
  for (let i = 0; i < 5; i++) await engine.ingest(ORG, mail(`PO-4817 m${i}`));
  assert.equal(calls, 3, 'calls 4 and 5 were skipped');
  assert.equal(engine.breaker.state, 'open');
  assert.equal((await flags()).filter((f) => /circuit open/.test(f.detail)).length, 2);
  now = 61_000; // cooldown over: one trial call goes through
  await engine.ingest(ORG, mail('PO-4817 m5'));
  assert.equal(calls, 4);

  // bad output (not an outage) does not count against the breaker
  const bad: Extractor = { name: 'bad', async extract() { throw new SyntaxError('Unexpected token'); } };
  const b = await setup(bad, { breaker: new Breaker(1, 60_000) });
  const r = await b.engine.ingest(ORG, mail('PO-4817 x'));
  assert.equal(r.extractor, heuristicExtractor.name);
  assert.equal(b.engine.breaker.state, 'closed');
});

test('isTransient: outages and overload count, bad requests and bad output do not', () => {
  assert.equal(isTransient(Object.assign(new Error('x'), { status: 529 })), true);
  assert.equal(isTransient(Object.assign(new Error('x'), { status: 429 })), true);
  assert.equal(isTransient(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  assert.equal(isTransient(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransient(Object.assign(new Error('x'), { status: 400 })), false);
  assert.equal(isTransient(new SyntaxError('Unexpected token')), false);
});

test('limiter: at most N jobs run at once, the rest wait their turn', async () => {
  const run = limiter(2);
  let active = 0;
  let peak = 0;
  const job = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  };
  await Promise.all(Array.from({ length: 6 }, () => run(job)));
  assert.equal(peak, 2);
});

test('an attachment download that hangs is cut off by its timeout; the email is still interpreted', { timeout: 60_000 }, async () => {
  let sawSignal = false;
  let abortReason: unknown = null;
  const hangingFetch: AttachmentFetcher = (_event, _part, signal) => new Promise((_resolve, reject) => {
    sawSignal = !!signal;
    signal?.addEventListener('abort', () => {
      abortReason = signal.reason;
      reject(signal.reason);
    });
  });
  const { engine, flags } = await setup(heuristicExtractor, { attachmentTimeoutMs: 30 }, hangingFetch);
  const input = mail('PO-4817 quote attached');
  // as in live mode: attachment metadata only, the bytes stay at Primitive
  input.attachments = [{ filename: 'quote.pdf', content_type: 'application/pdf', size_bytes: 1000, sha256: 'abc', part_index: 0 }];
  const started = Date.now();
  const r = await engine.ingest(ORG, input);
  const elapsed = Date.now() - started;
  assert.equal(sawSignal, true);
  // the download was ended by the timeout signal, not by anything else, and well before the 30 s default
  assert.equal((abortReason as Error | null)?.name, 'TimeoutError');
  assert.ok(elapsed < CUT_OFF_BOUND_MS, `ingest took ${elapsed} ms with a 30 ms attachment timeout`);
  assert.equal(r.extractor, heuristicExtractor.name);
  assert.ok((await flags()).some((f) => f.kind === 'attachment_unreadable'));
});
