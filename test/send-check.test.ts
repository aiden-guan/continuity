// Claude's second opinion on outgoing wording (a fake classifier stands in for the model here).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/server.ts';
import { defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import { cachedClassifier, modelBindingPhrases, sendClassifierFromEnv, type SendCheck } from '../src/engine/send-check.ts';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import { LocalSimTransport } from '../src/transport/transport.ts';
import type { Continuity } from '../src/service.ts';

delete process.env.PRIMITIVE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const a = defaultAddresses();
let base = '';
let app: Continuity;
let close: () => void;
let calls: string[] = [];
let answer: (body: string) => SendCheck = () => ({ binding: false, spans: [], rationale: 'asks a question' });

before(async () => {
  const built = await buildApp({ backend: new MemoryBackend(), port: 0, auth: 'off', transport: new LocalSimTransport() });
  app = built.app;
  app.sendClassifier = async (body) => {
    calls.push(body);
    return answer(body);
  };
  await new Promise<void>((r) => built.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
  close = () => built.server.close();
  await post('/tasks', procurementTask(a));
});
after(() => close());

async function post(path: string, body: unknown) {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const mail = (body: string, intent: string | undefined, to = a.supplier) => post('/tasks/PO-4817/send', { agent_id: 't', to, body, intent });

test('no key or CONTINUITY_SEND_CHECK=off: no model check', () => {
  assert.equal(sendClassifierFromEnv(), null);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-used';
  process.env.CONTINUITY_SEND_CHECK = 'off';
  try {
    assert.equal(sendClassifierFromEnv(), null);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CONTINUITY_SEND_CHECK;
  }
});

test('a paraphrased commitment the tripwire misses is caught by the model', async () => {
  calls = [];
  answer = () => ({ binding: true, spans: ['Abgemacht, bitte liefern Sie alle 500'], rationale: 'accepts and orders delivery (German)' });
  const r = await mail('Abgemacht, bitte liefern Sie alle 500.', 'negotiate');
  // no requirement has failed (nothing is known yet), so a human decides rather than a hard block
  assert.equal(r.status, 202);
  assert.match(r.body.reasons.join(' '), /intent mismatch.*Abgemacht, bitte liefern Sie alle 500 \(model\)/);
  assert.equal(calls.length, 1);
});

test('the model is consulted only where it can change the outcome', async () => {
  calls = [];
  answer = () => ({ binding: false, spans: [], rationale: 'question' });
  assert.equal((await mail('Can you deliver all 500 units by Friday?', 'ask')).status, 200);
  assert.equal(calls.length, 1);
  await mail('We accept your offer.', 'commit'); // declared commitment: goes to a human anyway
  await mail('We accept your offer.', 'negotiate'); // tripwire already caught it
  await mail('Budget looks fine to me.', 'inform', a.finance); // internal mail cannot commit us
  assert.equal(calls.length, 1);
});

test('fails closed: a classifier error holds the send for a human', async () => {
  const orig = app.sendClassifier;
  app.sendClassifier = async () => {
    throw new Error('timeout');
  };
  try {
    const r = await mail('Thanks — talk soon.', 'inform');
    assert.equal(r.status, 202); // a human sees it, nothing goes out
    assert.match(r.body.reasons.join(' '), /wording check could not decide \(timeout\)/);
  } finally {
    app.sendClassifier = orig;
  }
});

test('quoted spans must really occur in the draft; a "binding" verdict still counts without one', async () => {
  const fake = async (): Promise<SendCheck> => ({ binding: true, spans: ['we accept everything'], rationale: 'accepts the offer' });
  const r = await modelBindingPhrases(fake, 'Fine, go for it.');
  assert.deepEqual(r.phrases, ['(model judged binding: accepts the offer)']);
  const ok = await modelBindingPhrases(async () => ({ binding: true, spans: ['go for it'], rationale: '' }), 'Fine, go for it.');
  assert.deepEqual(ok.phrases, ['go for it (model)']);
});

test('one model call per distinct draft', async () => {
  let n = 0;
  const c = cachedClassifier(async () => {
    n++;
    return { binding: false, spans: [], rationale: '' };
  }, 2);
  await c('a');
  await c('a');
  await c('b');
  await c('a');
  assert.equal(n, 2);
  await c('c');
  await c('b'); // 'b' was evicted by 'c' (LRU of 2: a, c)
  assert.equal(n, 4);
});
