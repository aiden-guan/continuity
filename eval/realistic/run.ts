// Score Continuity on the realistic threads.
//
//   node eval/realistic/run.ts                   # offline (rule-based extractor + offline policy agent)
//   node eval/realistic/run.ts --extractor llm   # Claude extractor (needs ANTHROPIC_API_KEY)
//   node eval/realistic/run.ts --only P01,R03 --verbose
//
// Every thread is played through the real engine (Harness: signed Primitive-shaped webhooks, the
// normalizer, the extractor, the resolver). At each checkpoint the engine's state is compared with the
// gold: active terms, contested pairs, superseded values, statements that must NOT be applied,
// obligations, documents, checks, who acts next, and — for checkpoints with a handoff — what the
// offline policy agent would write. Results go to eval/realistic/results/latest.json.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Harness } from '../../src/sim/harness.ts';
import { makePdf } from '../../src/sim/pdf.ts';
import { setSimTime } from '../../src/clock.ts';
import { labelOf } from '../../src/engine/resolver.ts';
import { heuristicExtractor } from '../../src/extract/heuristic.ts';
import { llmExtractor } from '../../src/extract/llm.ts';
import { policyDecide } from '../../src/agent/policy.ts';
import type { Claim } from '../../src/types.ts';
import { TERM_KEYS, validateThread, type GoldCheckpoint, type GoldTerm, type Thread } from './schema.ts';

const { values: args } = parseArgs({ options: { extractor: { type: 'string', default: 'heuristic' }, only: { type: 'string' }, verbose: { type: 'boolean', default: false } } });
const here = fileURLToPath(new URL('.', import.meta.url));
const only = args.only?.split(',').map((s) => s.trim());
const threads: Thread[] = readdirSync(join(here, 'threads')).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(join(here, 'threads', f), 'utf8')) as Thread)
  .filter((t) => !only || only.includes(t.id));
if (args.extractor === 'llm' && !process.env.ANTHROPIC_API_KEY) { console.error('--extractor llm needs ANTHROPIC_API_KEY'); process.exit(1); }
const extractor = args.extractor === 'llm' ? llmExtractor() : heuristicExtractor;

// ---- value comparison (Continuity's normalized forms)
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
function sameValue(term: string, gold: unknown, got: unknown): boolean {
  if (typeof gold === 'number') return typeof got === 'number' && Math.abs(gold - got) < 0.005;
  if (Array.isArray(gold)) {
    const key = (l: { qty: number; date: string }) => `${l.date}:${l.qty}`;
    return Array.isArray(got) && JSON.stringify([...gold].map(key).sort()) === JSON.stringify([...(got as { qty: number; date: string }[])].map(key).sort());
  }
  if (term === 'payment.wire_instructions' || term === 'deal.fell_through') return !!got; // free text: presence is the test
  const a = norm(gold), b = norm(got);
  return a === b || (a.length > 3 && (b.includes(a) || a.includes(b)));
}

interface Score { ok: number; total: number }
const add = (s: Score, ok: boolean) => { s.total++; if (ok) s.ok++; };
const pct = (s: Score) => (s.total ? `${Math.round((s.ok / s.total) * 100)}%` : '—');
const metric = () => ({ ok: 0, total: 0 });
const totals = {
  active_recall: metric(), active_precision: metric(), contested: metric(), superseded: metric(), not_applied: metric(),
  obligation_found: metric(), obligation_status: metric(), documents: metric(), checks: metric(), next_actor: metric(), joint: metric(), handoff: metric(),
};
const byFeature = new Map<string, { joint: Score; recall: Score }>();

function scoreCheckpoint(t: Thread, h: Harness, c: GoldCheckpoint, at: string) {
  const L = (addr: string) => labelOf(t.task, addr);
  const keys = new Set(TERM_KEYS[t.domain]);
  const claims = h.claims().filter((x) => keys.has(x.key));
  const misses: string[] = [];
  const find = (g: GoldTerm, statuses: Claim['status'][]) => claims.find((x) => L(x.speaker) === g.party && x.key === g.term && statuses.includes(x.status) && sameValue(g.term, g.value, x.value));
  const r: Record<string, Score> = Object.fromEntries(Object.keys(totals).map((k) => [k, metric()]));

  for (const g of c.active) { const hit = !!find(g, ['active']); add(r.active_recall, hit); if (!hit) misses.push(`missing active ${g.party} ${g.term}=${JSON.stringify(g.value)}`); }
  // precision: every active engine claim must match a gold active term (same party, term and value)
  const goldActive = c.active;
  for (const x of claims.filter((x) => x.status === 'active')) {
    const hit = goldActive.some((g) => g.party === L(x.speaker) && g.term === x.key && sameValue(g.term, g.value, x.value));
    add(r.active_precision, hit);
    if (!hit) misses.push(`unexpected active ${L(x.speaker)} ${x.key}=${JSON.stringify(x.value)}`);
  }
  for (const g of c.contested ?? []) { const hit = !!find(g, ['contested']); add(r.contested, hit); if (!hit) misses.push(`not contested ${g.party} ${g.term}=${JSON.stringify(g.value)}`); }
  for (const g of c.superseded ?? []) { const hit = !find(g, ['active', 'contested']); add(r.superseded, hit); if (!hit) misses.push(`old value still current ${g.party} ${g.term}=${JSON.stringify(g.value)}`); }
  // must not apply: neither for the party the gold credits nor for whoever actually sent the message
  const senderOf = (id: string) => L(t.messages.find((m) => m.id === id)?.from ?? '');
  for (const g of c.tentative ?? []) {
    const applied = find(g, ['active', 'contested']) || find({ ...g, party: senderOf(g.stated_in) }, ['active', 'contested']);
    add(r.not_applied, !applied);
    if (applied) misses.push(`${g.why} statement was applied ${L(applied.speaker)} ${g.term}=${JSON.stringify(g.value)} (${applied.status})`);
  }

  const obs = h.obligations();
  const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 3));
  const used = new Set<string>();
  for (const o of c.obligations ?? []) {
    const cands = obs.filter((x) => !used.has(x.id) && L(x.debtor) === o.owed_by && x.kind === o.kind);
    const want = words(o.about);
    const best = cands.map((x) => ({ x, overlap: [...words(x.text)].filter((w) => want.has(w)).length })).sort((p, q) => q.overlap - p.overlap)[0]?.x;
    add(r.obligation_found, !!best);
    if (!best) { misses.push(`no ${o.kind} owed by ${o.owed_by} (${o.about})`); continue; }
    used.add(best.id);
    const statusOk = best.status === o.status || (o.status === 'answered' && best.status === 'fulfilled') || (o.status === 'fulfilled' && best.status === 'answered');
    add(r.obligation_status, statusOk);
    if (!statusOk) misses.push(`${o.kind} owed by ${o.owed_by} is ${best.status}, expected ${o.status} (${o.about})`);
  }
  const arts = h.artifacts();
  for (const d of c.documents ?? []) { const a = arts.find((x) => x.filename === d.filename); const ok = a?.status === d.status; add(r.documents, ok); if (!ok) misses.push(`document ${d.filename} is ${a?.status ?? 'missing'}, expected ${d.status}`); }
  const checks = h.checks();
  for (const [prefix, want] of Object.entries(c.checks ?? {})) { const ch = checks.find((x) => x.id.startsWith(prefix)); const ok = ch?.status === want; add(r.checks, ok); if (!ok) misses.push(`check ${prefix} is ${ch?.status ?? 'missing'}, expected ${want}`); }
  const ctx = h.context('fresh-agent', { now: at });
  add(r.next_actor, ctx.next_actor === c.next_actor);
  if (ctx.next_actor !== c.next_actor) misses.push(`next actor ${ctx.next_actor}, expected ${c.next_actor}`);

  if (c.handoff) {
    const d = policyDecide(ctx);
    const to = c.handoff.to ? t.task.participants.find((p) => p.label === c.handoff!.to)?.address : undefined;
    const body = d.messages.filter((m) => !to || m.to === to).map((m) => m.body).join('\n');
    const okAction = c.handoff.expect === 'wait' ? d.action === 'wait' : d.action === 'send' && !!body;
    const okMust = c.handoff.must.every((p) => new RegExp(p, 'i').test(body));
    const okNot = !c.handoff.must_not.some((p) => new RegExp(p, 'i').test(body));
    add(r.handoff, okAction && okMust && okNot);
    if (!(okAction && okMust && okNot)) misses.push(`handoff: action ${d.action}${okMust ? '' : `, missing ${c.handoff.must.filter((p) => !new RegExp(p, 'i').test(body)).join(' / ')}`}${okNot ? '' : `, said ${c.handoff.must_not.filter((p) => new RegExp(p, 'i').test(body)).join(' / ')}`}`);
  }
  const joint = r.active_recall.ok === r.active_recall.total && r.active_precision.ok === r.active_precision.total && r.contested.ok === r.contested.total
    && r.superseded.ok === r.superseded.total && r.not_applied.ok === r.not_applied.total && ctx.next_actor === c.next_actor;
  add(r.joint, joint);
  return { r, misses, joint };
}

async function runThread(t: Thread) {
  const h = new Harness(t.task, extractor, t.messages[0].at);
  await h.ready;
  const ids = new Map<string, { messageId: string; references: string[] }>();
  const out: { after: string; joint: boolean; misses: string[] }[] = [];
  for (const m of t.messages) {
    setSimTime(m.at);
    const parent = m.in_reply_to ? ids.get(m.in_reply_to) ?? null : null;
    if (m.direction === 'outbound') {
      const s = await h.out(m.to, m.subject, m.body, m.at, parent ? { messageId: parent.messageId, references: parent.references } : null);
      ids.set(m.id, { messageId: s.messageId, references: [...(parent?.references ?? []), ...(parent ? [parent.messageId] : [])] });
    } else {
      const d = await h.in({
        from: m.from, fromName: m.fromName, to: m.to, subject: m.subject, body: m.body, at: m.at, threadKey: `${t.id}:${m.in_reply_to ?? m.id}`,
        inReplyTo: parent?.messageId ?? null, references: parent ? [...parent.references, parent.messageId] : [],
        attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, content_type: 'application/pdf', bytes: makePdf(a.lines) })), auth: m.auth ?? 'pass',
      });
      ids.set(m.id, { messageId: d.messageId, references: parent ? [...parent.references, parent.messageId] : [] });
    }
    for (const c of t.checkpoints.filter((c) => c.after === m.id)) {
      const { r, misses, joint } = scoreCheckpoint(t, h, c, m.at);
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) { totals[k].ok += r[k].ok; totals[k].total += r[k].total; }
      for (const f of t.features) {
        const b = byFeature.get(f) ?? { joint: metric(), recall: metric() };
        add(b.joint, joint); b.recall.ok += r.active_recall.ok; b.recall.total += r.active_recall.total;
        byFeature.set(f, b);
      }
      out.push({ after: c.after, joint, misses });
    }
  }
  return out;
}

const invalid = threads.flatMap((t) => validateThread(t));
if (invalid.length) { console.error(`invalid threads:\n${invalid.join('\n')}`); process.exit(1); }
const rows: { id: string; domain: string; title: string; checkpoints: { after: string; joint: boolean; misses: string[] }[] }[] = [];
for (const t of threads) {
  const cps = await runThread(t);
  rows.push({ id: t.id, domain: t.domain, title: t.title, checkpoints: cps });
  console.log(`${t.id} ${t.domain.padEnd(12)} ${cps.map((c) => (c.joint ? '✔' : '✖')).join(' ')}  ${t.title.slice(0, 80)}`);
  if (args.verbose) for (const c of cps) for (const x of c.misses) console.log(`      after ${c.after}: ${x}`);
}
const summary = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { ...v, rate: v.total ? v.ok / v.total : null }]));
console.log(`\nExtractor: ${extractor.name} · ${threads.length} threads · ${totals.joint.total} checkpoints`);
const label: Record<string, string> = {
  joint: 'checkpoint fully right (terms + next actor)', active_recall: 'current terms found', active_precision: 'current terms correct (no wrong extras)',
  contested: 'disputes flagged as contested', superseded: 'replaced values no longer current', not_applied: 'statements that must not apply, not applied',
  obligation_found: 'obligations found', obligation_status: 'obligation status right', documents: 'document status right', checks: 'requirement checks right',
  next_actor: 'who acts next right', handoff: 'fresh agent email passes rubric',
};
for (const [k, v] of Object.entries(totals)) console.log(`  ${label[k].padEnd(48)} ${pct(v).padStart(5)}  (${v.ok}/${v.total})`);
console.log('\nBy hard case (checkpoints fully right · current terms found):');
for (const [f, b] of [...byFeature].sort()) console.log(`  ${f.padEnd(28)} ${pct(b.joint).padStart(5)} · ${pct(b.recall).padStart(5)}`);
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', `latest-${args.extractor}.json`), JSON.stringify({ extractor: extractor.name, generated_at: new Date().toISOString(), summary, by_feature: Object.fromEntries(byFeature), threads: rows }, null, 1));
console.log(`\nwrote eval/realistic/results/latest-${args.extractor}.json`);
