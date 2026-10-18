// Value benchmark, Fig 1: temporal dependency depth and thread fan-out.
//
// One procurement deal (RFQ, quote PDF, finance approval in its own thread) is followed by D
// interdependent state changes, and then finance asks whether the order can be placed. Total task
// mail is held at N_TASK messages at every depth (state-neutral chatter fills the gap), so depth,
// not volume, is what varies. The fan-out family keeps the same six changes, with identical text,
// and only spreads them over more threads.
//
// Changes (each one moves at least one item a correct answer depends on):
//   price_up        supplier corrects the unit price upward, above the approved budget
//   budget_raise    finance approves a higher cap that covers the current price
//   price_hold      supplier goes back to its original price
//   split           only part arrives by the deadline, the rest is late; a revised quote is promised
//   restore         supplier finds capacity: all units by the deadline again; an updated quote is promised
//   revised_quote   the promised quote arrives as a PDF reflecting the current terms
//   quote_missing   "quote attached", but nothing is attached (still owed)
//   forwarder_date  the supplier's forwarder states a later delivery date (contested)
//   settle          supplier and forwarder confirm the supplier's date (contest resolved)
//   ops_price       supplier operations (no pricing authority) mentions a new price (unverified)
//   partial_answer  we ask two things about a live problem; the supplier answers only the easy one
//
// Trap: the right answer is the composition of every change. Reading the latest message, or stopping
// at any intermediate state, gives a wrong list of problems: a resolved one reported as live, a live
// one missed, an old price or schedule used, the quote treated as received.
//
// The oracle comes from this file's own semantics. A first pass simulates the chain on plain numbers
// (to sample a valid chain); the second pass writes the mail and tracks evidence per term. The two
// must agree on the final state, or generation throws.
import type { ActionCond, Archetype, BenchCase, BenchParty, Capability, Checkpoint, OracleConflict, OracleDocument, OracleLoop, OracleSuperseded, OracleTerm } from '../core/types.ts';
import { MailBuilder, Rand, addDays, at, body, moneyShort, pdf, reaskText, sayDate, seedOf, staleText, type DateStyle } from '../core/util.ts';
import { SIGNATURE, addParty, aliasForms, firstName, lotsDisplay, lotsLine, procurementBackground, procurementChatter, procurementDeal, quoteLines, round2, sayFrom, shortName, type Lot, type ProcurementDeal } from '../verticals/procurement/vertical.ts';

export const N_TASK = 16; // at most 10 chatter messages, so no chatter line repeats
const MAX_STEP_MSGS = N_TASK - 5;

export type StepType = 'price_up' | 'budget_raise' | 'price_hold' | 'split' | 'restore' | 'revised_quote' | 'quote_missing' | 'forwarder_date' | 'settle' | 'ops_price' | 'partial_answer';
const TYPES: StepType[] = ['price_up', 'budget_raise', 'price_hold', 'split', 'restore', 'revised_quote', 'quote_missing', 'forwarder_date', 'settle', 'ops_price', 'partial_answer'];
const CAP: Record<StepType, number> = { price_up: 2, budget_raise: 2, price_hold: 1, split: 1, restore: 1, revised_quote: 2, quote_missing: 1, forwarder_date: 1, settle: 1, ops_price: 1, partial_answer: 1 };
const WEIGHT: Partial<Record<StepType, number>> = { ops_price: 0.6, quote_missing: 0.6 };

export type ThreadMode = 'natural' | 'half' | 'spread';
export interface ChainSpec { id: string; title: string; depth: number; threads: ThreadMode; family: 'depth' | 'fanout' }

interface Step { type: StepType; msgs: number; p: Record<string, unknown> }
interface Sim { price: number; budget: number; lots: Lot[]; quoteOwed: boolean; contested: boolean; fwdLots: Lot[] | null; ask: null | 'expedite' | 'price'; counts: Record<StepType, number> }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isFull = (lots: Lot[], d: ProcurementDeal) => lots.length === 1 && lots[0].qty === d.qty && lots[0].date <= d.deadline;
const blockersOf = (s: { price: number; budget: number; lots: Lot[]; quoteOwed: boolean; contested: boolean }, d: ProcurementDeal) => ({
  over: s.price > s.budget + 1e-9,
  late: !isFull(s.lots, d),
  contested: s.contested,
  quoteOwed: s.quoteOwed,
});
const clear = (b: ReturnType<typeof blockersOf>) => !b.over && !b.late && !b.contested && !b.quoteOwed;

// ------------------------------------------------------------------ pass 1: sample a valid chain

function plan(d: ProcurementDeal, spec: ChainSpec, pr: Rand): { steps: Step[]; sim: Sim } {
  const sim: Sim = { price: d.price, budget: d.budget, lots: [{ qty: d.qty, date: d.deadline }], quoteOwed: false, contested: false, fwdLots: null, ask: null, counts: Object.fromEntries(TYPES.map((t) => [t, 0])) as Record<StepType, number> };
  const steps: Step[] = [];
  // the fan-out family keeps every change between us, the supplier and finance, so the natural thread count is exactly 2
  const extraParties = spec.family === 'depth';
  const prices = new Set([d.price]);
  for (let i = 0; i < spec.depth; i++) {
    const b = blockersOf(sim, d);
    const full = !b.late;
    const pre: Record<StepType, boolean> = {
      price_up: !b.over,
      budget_raise: b.over,
      price_hold: sim.price !== d.price,
      split: full && !sim.contested,
      restore: !full,
      revised_quote: sim.quoteOwed,
      quote_missing: sim.quoteOwed,
      forwarder_date: extraParties && full && !sim.contested,
      settle: sim.contested,
      ops_price: extraParties,
      partial_answer: sim.ask === null && !sim.contested && (!full || b.over),
    };
    const cands = TYPES.filter((t) => pre[t] && sim.counts[t] < CAP[t]);
    const total = cands.reduce((s, t) => s + (WEIGHT[t] ?? 1), 0);
    let x = pr.next() * total;
    let type = cands[cands.length - 1];
    for (const t of cands) { x -= WEIGHT[t] ?? 1; if (x <= 0) { type = t; break; } }
    sim.counts[type]++;
    const p: Record<string, unknown> = {};
    let msgs = 1;
    switch (type) {
      case 'price_up':
        p.old = sim.price;
        p.price = round2(sim.budget + pr.pick([0.15, 0.3, 0.45, 0.6, 0.9]));
        p.reason = pr.pick(['resin surcharge', 'copper price', 'component cost', 'freight surcharge from our own vendor']);
        p.again = sim.counts.price_up > 1;
        sim.price = p.price as number;
        prices.add(sim.price);
        break;
      case 'budget_raise':
        p.old = sim.budget;
        p.budget = round2(sim.price + pr.pick([0.05, 0.1, 0.25, 0.5]));
        p.proactive = pr.chance(0.35);
        msgs = p.proactive ? 1 : 2;
        sim.budget = p.budget as number;
        break;
      case 'price_hold':
        p.old = sim.price;
        p.price = d.price;
        p.answersAsk = sim.ask === 'price';
        if (sim.ask === 'price') sim.ask = null;
        sim.price = d.price;
        break;
      case 'split': {
        const k = Math.min(d.qty - 10, Math.max(10, Math.round((d.qty * pr.pick([0.4, 0.5, 0.6, 0.7])) / 10) * 10));
        p.lots = [{ qty: k, date: d.deadline }, { qty: d.qty - k, date: addDays(d.deadline, pr.pick([3, 4, 5, 6])) }];
        sim.lots = p.lots as Lot[];
        sim.quoteOwed = true;
        break;
      }
      case 'restore':
        p.old = sim.lots;
        p.answersAsk = sim.ask === 'expedite';
        if (sim.ask === 'expedite') sim.ask = null;
        sim.lots = [{ qty: d.qty, date: d.deadline }];
        sim.quoteOwed = true;
        break;
      case 'revised_quote':
        p.price = sim.price;
        p.lots = sim.lots;
        p.afterMissing = sim.counts.quote_missing > 0;
        sim.quoteOwed = false;
        break;
      case 'quote_missing':
        break;
      case 'forwarder_date':
        p.lots = [{ qty: d.qty, date: addDays(d.deadline, pr.pick([2, 3, 4, 5])) }];
        p.booking = `FF-${pr.int(10000, 99999)}`;
        sim.contested = true;
        sim.fwdLots = p.lots as Lot[];
        break;
      case 'settle':
        p.old = sim.fwdLots;
        msgs = 2;
        sim.contested = false;
        sim.fwdLots = [{ qty: d.qty, date: d.deadline }];
        break;
      case 'ops_price': {
        let v = round2(sim.price - pr.pick([0.3, 0.5, 0.8, 1.0]));
        while (prices.has(v) || v <= 0.5) v = round2(v + 0.15);
        p.price = v;
        break;
      }
      case 'partial_answer':
        p.kind = !full ? (b.over && pr.chance(0.5) ? 'price' : 'expedite') : 'price';
        msgs = 2;
        sim.ask = p.kind as 'expedite' | 'price';
        break;
    }
    steps.push({ type, msgs, p });
  }
  return { steps, sim };
}

// ------------------------------------------------------------------ pass 2: evidence trackers

class TermTrack {
  cur: { value: unknown; ev: string[] };
  hist: { value: unknown; ev: string[]; by: string }[] = [];
  constructor(value: unknown, ev: string) { this.cur = { value, ev: [ev] }; }
  set(value: unknown, ev: string) {
    if (same(this.cur.value, value)) { this.cur.ev.push(ev); return; }
    this.hist.push({ ...this.cur, by: ev });
    // a revert brings the value's earlier evidence back
    const old = this.hist.filter((h) => same(h.value, value)).flatMap((h) => h.ev);
    this.cur = { value, ev: [...old, ev] };
  }
  confirm(ev: string) { this.cur.ev.push(ev); }
  /** Values that held at some point and do not hold now (a reverted-to value is current, not superseded). */
  dead(): { value: unknown; ev: string[]; by: string }[] {
    const out = new Map<string, { value: unknown; ev: string[]; by: string }>();
    for (const h of this.hist) {
      if (same(h.value, this.cur.value)) continue;
      const k = JSON.stringify(h.value);
      const prev = out.get(k);
      out.set(k, { value: h.value, ev: [...new Set([...(prev?.ev ?? []), ...h.ev])], by: h.by });
    }
    return [...out.values()];
  }
}

// ------------------------------------------------------------------ the generator

export function chainArchetype(spec: ChainSpec): Archetype {
  const capabilities: Capability[] = spec.family === 'depth' ? ['supersession', 'open_loops', 'cross_thread', 'cold_handoff'] : ['cross_thread', 'supersession', 'open_loops'];
  const archetype: Archetype = {
    id: spec.id,
    title: spec.title,
    capabilities,
    priority: 'P0',
    generate(variant: number): BenchCase {
      // fan-out: the same chain and text at every thread count; only the threading differs
      const family = spec.family === 'fanout' ? 'value_fanout' : spec.id;
      const d = procurementDeal(new Rand(seedOf(family, variant, 'deal')), variant);
      const wantClear = variant % 3 === 0;
      let picked: { steps: Step[]; sim: Sim } | null = null;
      for (let attempt = 0; attempt < 400; attempt++) {
        const cand = plan(d, spec, new Rand(seedOf(family, variant, 'plan', attempt)));
        const msgs = cand.steps.reduce((s, x) => s + x.msgs, 0);
        if (msgs > MAX_STEP_MSGS) continue;
        picked = cand;
        if (clear(blockersOf(cand.sim, d)) === wantClear) break;
      }
      return render(archetype, spec, variant, d, picked!.steps, picked!.sim, new Rand(seedOf(family, variant, 'text')), new Rand(seedOf(spec.id, variant, 'threads')));
    },
  };
  return archetype;
}

function render(a: Archetype, spec: ChainSpec, variant: number, d: ProcurementDeal, steps: Step[], sim: Sim, r: Rand, tr: Rand): BenchCase {
  const { self, supplier, finance, supplierOps, forwarder } = d.cast;
  const mb = new MailBuilder();
  const A = d.alias;
  const unit = d.item.unit;
  const g = variant === 0;
  const dateStyle: DateStyle = g ? 'weekday_short_date' : r.pick(['weekday_short_date', 'long', 'month_day', 'weekday_long'] as const);
  const day = (n: number, hhmm: string) => at(addDays(d.start, n), hhmm);
  const say = (date: string, writtenAt: string) => sayFrom(date, writtenAt, dateStyle);
  const aliasIn = () => (g ? A : r.pick(aliasForms(A).slice(0, 3)));
  const ref = g ? 'Q-2291' : `Q-${r.int(1000, 9999)}`;
  const file0 = `${d.company.split(' ')[0]}-Quote-${ref}.pdf`;
  const validUntil = addDays(d.deadline, 7);
  const usesOps = steps.some((s) => s.type === 'ops_price');
  const usesFwd = steps.some((s) => s.type === 'forwarder_date');
  if (usesOps) addParty(d, supplierOps);
  if (usesFwd) addParty(d, forwarder);
  // finance's approval is the price ceiling here (it can be raised), so the goal says so instead of a fixed cap
  d.task.goal = `Buy ${d.qty} ${d.item.name} for ${A}. All ${d.qty} must arrive by ${sayDate(d.deadline, 'weekday_short_date')}; the unit price must stay within the budget finance approves.`;
  d.task.requirements = d.task.requirements.map((q) => (q.key === 'requirement.max_unit_price' ? { ...q, display: `within finance's approved budget (initial request ${moneyShort(d.budget)})` } : q));
  const sig = (p: BenchParty) => (p === forwarder ? 'Regards,\nFastFreight Ops' : p === supplierOps ? `${shortName(p)}\n${d.company} Operations` : p === finance ? `${firstName(p)}\nAcme Finance` : `${shortName(p)}\n${d.company}`);

  // ---- threads: a thread key per conversation; a message in a known thread replies to its last message
  const lastOf = new Map<string, string>();
  const stateThreads = new Set<string>();
  const post = (threadKey: string, newSubject: string, m: { direction: 'inbound' | 'outbound'; from: BenchParty; to: BenchParty[]; cc?: BenchParty[]; at: string; body: string; attachments?: ReturnType<typeof pdf>[]; note?: string }, state = true) => {
    const last = lastOf.get(threadKey);
    const key = mb.add({
      direction: m.direction, from: m.from.address, fromName: m.direction === 'outbound' ? self.name : shortName(m.from), to: m.to.map((p) => p.address), ...(m.cc ? { cc: m.cc.map((p) => p.address) } : {}),
      subject: last ? mb.reSubject(last) : newSubject, replyTo: last ?? null, at: m.at, body: m.body, ...(m.attachments ? { attachments: m.attachments } : {}), ...(m.note ? { note: m.note } : {}),
    });
    lastOf.set(threadKey, key);
    if (state) stateThreads.add(threadKey);
    return key;
  };
  const threadFor = (channel: string, i: number) => (spec.threads === 'natural' ? channel : spec.threads === 'spread' || i % 2 === 1 ? `${channel}#${i}` : channel);

  // ---- base: RFQ, quote, budget request and approval (day 0)
  const rfqAt = day(0, '09:00');
  const rfq = post('supplier', `RFQ: ${d.qty} x ${d.item.sku} — ${A}`, {
    direction: 'outbound', from: self, to: [supplier], at: rfqAt,
    body: body(`Hi ${firstName(supplier)},`, `We need ${d.qty} ${d.item.name} delivered by ${sayDate(d.deadline, 'weekday_short_date')} for ${A}. Can you deliver all ${d.qty} by then, and at what unit price? Please send a formal quote.`, `Thanks,\n${SIGNATURE}`),
  });
  const quoteAt = day(0, '13:30');
  const quote = post('supplier', '', {
    direction: 'inbound', from: supplier, to: [self], at: quoteAt,
    body: body('Hi,', g ? `Quote attached: all ${d.qty} units by ${sayDate(d.deadline, 'weekday_short_date')} at ${moneyShort(d.price)} each, Net 30.` : r.pick([
      `Quote attached. We can supply all ${d.qty} ${unit} by ${say(d.deadline, quoteAt)} at ${moneyShort(d.price)} per unit, Net 30.`,
      `Please find our formal quote attached: ${moneyShort(d.price)}/unit, the full ${d.qty} delivered ${say(d.deadline, quoteAt)}.`,
      `Good news, we have capacity. ${d.qty} ${unit}, ${say(d.deadline, quoteAt)}, ${moneyShort(d.price)} each. Details in the attached quote.`,
    ]), sig(supplier)),
    attachments: [pdf(file0, quoteLines(d, { ref, date: d.start, validUntil }))],
  });
  const budgetAskAt = day(0, '14:40');
  const budgetAsk = post('finance', `Budget approval request — ${A}`, {
    direction: 'outbound', from: self, to: [finance], at: budgetAskAt,
    body: body(`Hi ${firstName(finance)},`, `${d.company} quotes ${moneyShort(d.price)}/unit for ${d.qty} ${unit}, all by ${sayDate(d.deadline, 'weekday_short_date')}. Could you approve a budget of up to ${moneyShort(d.budget)} per unit?`, SIGNATURE),
  });
  const approval = post('finance', '', {
    direction: 'inbound', from: finance, to: [self], at: day(0, '16:20'),
    body: body(g ? `Approved. The budget for ${A} is approved up to ${moneyShort(d.budget)} per unit.` : r.pick([`Approved — up to ${moneyShort(d.budget)} per unit for ${A}.`, `You're cleared to spend up to ${moneyShort(d.budget)}/unit on ${A}.`, `Budget for ${A} approved at a ceiling of ${moneyShort(d.budget)} per unit.`]), sig(finance)),
  });

  // ---- oracle trackers
  const price = new TermTrack(d.price, quote);
  const lots = new TermTrack([{ qty: d.qty, date: d.deadline }], quote);
  const budget = new TermTrack(d.budget, approval);
  let fwd: TermTrack | null = null;
  let contested = false;
  let quoteOwed: string[] | null = null; // evidence of the open promise
  let owedWhat = ''; // which document is owed, in words the judge can check against
  let missingSince: string | null = null; // "attached" without an attachment, not yet fixed
  let ask: { kind: 'expedite' | 'price'; ev: string[] } | null = null;
  const docs: { file: string; price: number; lots: Lot[] }[] = [{ file: file0, price: d.price, lots: [{ qty: d.qty, date: d.deadline }] }];
  const closed: OracleLoop[] = [
    { kind: 'ask', debtor: supplier.address, subject: 'document.quote', display: 'Formal quote (received)', evidence: [rfq, quote] },
    { kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Unit price (answered)', evidence: [rfq, quote] },
    { kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', display: 'Can all units arrive by the deadline (answered)', evidence: [rfq, quote] },
    { kind: 'ask', debtor: finance.address, subject: 'budget.max_unit_price', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [budgetAsk, approval] },
  ];
  const answered: { what: string; known: string; term: 'price' | 'lots'; value: unknown }[] = [];
  let opsClaim: { price: number; ev: string } | null = null;
  let revisions = 0;
  const history: string[] = []; // plain-language log for the judge and for auditors
  const trace: { step: number; type: StepType; events: string[]; price: number; budget: number; lots: Lot[]; quoteOwed: boolean; contested: boolean; blockers: string[] }[] = [];

  // ---- time slots: step messages and chatter interleaved over day 1 08:30 → day 3 15:30 (business hours)
  const stepMsgs = steps.reduce((s, x) => s + x.msgs, 0);
  const nChatter = Math.max(0, N_TASK - 5 - stepMsgs);
  const items: ({ kind: 'chatter'; i: number } | { kind: 'step'; i: number })[] = steps.map((_, i) => ({ kind: 'step' as const, i }));
  for (let i = 0; i < nChatter; i++) items.splice(r.int(0, items.length), 0, { kind: 'chatter', i });
  const windows: [number, string, number][] = [[1, '08:30', 570], [2, '08:30', 570], [3, '08:30', 420]];
  const totalMin = windows.reduce((s, w) => s + w[2], 0);
  const nSlots = nChatter + stepMsgs;
  let slot = 0;
  const nextAt = () => {
    const pos = Math.round(((slot + 0.5) / nSlots) * totalMin) + r.int(-8, 8);
    slot++;
    let left = Math.max(0, Math.min(totalMin - 1, pos));
    for (const [n, start, len] of windows) {
      if (left < len) return new Date(Date.parse(day(n, start)) + left * 60_000).toISOString().replace('.000', '');
      left -= len;
    }
    return day(3, '15:30');
  };
  let lastAt = approval;
  const ensureAfter = (iso: string) => { const prev = mb.get(lastAt).at; return iso > prev ? iso : new Date(Date.parse(prev) + 7 * 60_000).toISOString().replace('.000', ''); };

  procurementBackground(r, d, mb, day(1, '10:10'), g ? 4 : r.int(3, 5), g ? 0 : r.int(0, 6));

  for (const item of items) {
    if (item.kind === 'chatter') {
      const t = ensureAfter(nextAt());
      const [k] = procurementChatter(r, d, mb, new Date(Date.parse(t) - 20 * 60_000).toISOString().replace('.000', ''), 1, item.i + (g ? 0 : 3));
      lastAt = k;
      continue;
    }
    const step = steps[item.i];
    const p = step.p;
    const ch = (c: string) => threadFor(c, item.i);
    const tAt = () => ensureAfter(nextAt());
    const before = mb.events.length;
    switch (step.type) {
      case 'price_up': {
        const old = moneyShort(p.old as number);
        const nw = moneyShort(p.price as number);
        const al = aliasIn();
        const ev = post(ch('supplier'), r.pick([`${A} — price correction`, `Correction: unit price for ${al}`, `${al} pricing update`]), {
          direction: 'inbound', from: supplier, to: [self], at: tAt(),
          body: body('Hi,', p.again ? `I'm sorry to come back on this again for ${al}: the ${p.reason} moved once more, and the unit price has to go to ${nw} (from ${old}). No other changes.` : r.pick([
            `Correction to our quote for ${al}: the unit price should read ${nw}, not ${old}. Our ${p.reason} went up after we quoted. No other changes.`,
            `Apologies, I have to revise the price on ${al}: it is ${nw} per unit rather than ${old} (${p.reason}). Nothing else changes.`,
            `Important update on ${al}: the ${old} unit price no longer holds. With the ${p.reason} we need ${nw} per unit. No other changes.`,
          ]), sig(supplier)),
        });
        price.set(p.price, ev);
        lastAt = ev;
        history.push(`The supplier raised the unit price from ${old} to ${nw}.`);
        break;
      }
      case 'budget_raise': {
        const nw = moneyShort(p.budget as number);
        const cur = moneyShort(price.cur.value as number);
        const al = aliasIn();
        let ev: string;
        if (p.proactive) {
          ev = post(ch('finance'), r.pick([`${A} approval updated`, `${al}: revised budget`, `Budget ceiling for ${al}`]), {
            direction: 'inbound', from: finance, to: [self], at: tAt(),
            body: body(r.pick([
              `Ops told me about the supplier's new price on ${al}. I've raised the approval to ${nw} per unit.`,
              `Saw the price change on ${al} in the supplier portal. Approval is now up to ${nw}/unit.`,
              `Heads-up: I've increased the ${al} budget ceiling to ${nw} per unit to cover the new supplier price.`,
            ]), sig(finance)),
          });
        } else {
          const askEv = post(ch('finance'), r.pick([`Budget increase needed — ${A}`, `${al}: approval for revised price`, `${al} budget`]), {
            direction: 'outbound', from: self, to: [finance], at: tAt(),
            body: body(`Hi ${firstName(finance)},`, `${d.company} now quotes ${cur} per unit for ${al}, above the ${moneyShort(p.old as number)} you approved. Could you approve up to ${nw} per unit?`, SIGNATURE),
          });
          ev = post(ch('finance'), '', {
            direction: 'inbound', from: finance, to: [self], at: tAt(),
            body: body(r.pick([`Approved — you can go up to ${nw}/unit on ${al}.`, `OK, approved to ${nw} per unit for ${al}.`, `Fine by me. New ceiling for ${al}: ${nw} per unit.`]), sig(finance)),
          });
          closed.push({ kind: 'ask', debtor: finance.address, subject: 'budget.max_unit_price', alt_subjects: ['approval.budget'], display: `Higher budget approval (given: ${nw})`, evidence: [askEv, ev] });
        }
        budget.set(p.budget, ev);
        lastAt = ev;
        history.push(`Finance raised the approved budget from ${moneyShort(p.old as number)} to ${nw} per unit.`);
        break;
      }
      case 'price_hold': {
        const old = moneyShort(p.old as number);
        const nw = moneyShort(p.price as number);
        const al = aliasIn();
        const ev = post(ch('supplier'), r.pick([`${al}: back to original pricing`, `${A} price`, `Good news on ${al}`]), {
          direction: 'inbound', from: supplier, to: [self], at: tAt(),
          body: body('Hi,', r.pick([
            `Good news on ${al}: we've managed to absorb the increase, so the price goes back to the original ${nw} per unit.`,
            `After review we'll honour our original quote price of ${nw}/unit for ${al}. Please disregard the ${old} figure.`,
            `Update on ${al}: management approved holding ${nw} per unit, so the ${old} price no longer applies.`,
          ]), sig(supplier)),
        });
        price.set(p.price, ev);
        if (p.answersAsk && ask?.kind === 'price') {
          closed.push({ kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Room on price (answered: back to the original price)', evidence: [...ask.ev, ev] });
          ask = null;
        }
        lastAt = ev;
        history.push(`The supplier went back to its original price of ${nw} (the ${old} price is dead).`);
        break;
      }
      case 'split': {
        const [on, late] = p.lots as Lot[];
        const t = tAt();
        const al = aliasIn();
        const ev = post(ch('supplier'), r.pick([`${al} — delivery update`, `Schedule change on ${al}`, `${A}: delivery`]), {
          direction: 'inbound', from: supplier, to: [self], at: t,
          body: body('Hi,', r.pick([
            `I need to correct the delivery for ${al}: only ${on.qty} can arrive by ${say(on.date, t)}; the remaining ${late.qty} will follow on ${say(late.date, t)}. I'll send a revised quote.`,
            `Bad news on the schedule for ${al}. ${on.qty} of the ${d.qty} make ${say(on.date, t)}; the other ${late.qty} won't land until ${say(late.date, t)}. Revised quote to follow.`,
            `Our second production lot for ${al} slipped: it's now ${on.qty} by ${say(on.date, t)} and ${late.qty} on ${say(late.date, t)}. I'll get you an updated quote.`,
          ]), sig(supplier)),
        });
        lots.set(p.lots, ev);
        quoteOwed = [ev];
        owedWhat = `the revised quote for the split delivery (${lotsDisplay(p.lots as Lot[])}), promised on ${sayDate(mb.get(ev).at.slice(0, 10), 'weekday_short_date')}`;
        missingSince = null;
        lastAt = ev;
        history.push(`The supplier split the delivery: ${lotsDisplay(p.lots as Lot[])}, and promised a revised quote.`);
        break;
      }
      case 'restore': {
        const t = tAt();
        const al = aliasIn();
        const ev = post(ch('supplier'), r.pick([`${al}: full delivery restored`, `Good news on ${al} delivery`, `${A} schedule`]), {
          direction: 'inbound', from: supplier, to: [self], at: t,
          body: body('Hi,', r.pick([
            `Good news on ${al}: production found capacity, so all ${d.qty} will arrive by ${say(d.deadline, t)} after all. I'll send an updated quote showing the full delivery.`,
            `We've recovered the slipped lot: the full ${d.qty} ${unit} for ${al} will be delivered by ${say(d.deadline, t)}. Updated quote to follow.`,
            `Update on ${al}: the late batch has been pulled forward, all ${d.qty} now arrive ${say(d.deadline, t)}. I will re-issue the quote.`,
          ]), sig(supplier)),
        });
        lots.set([{ qty: d.qty, date: d.deadline }], ev);
        quoteOwed = quoteOwed ? [...quoteOwed, ev] : [ev];
        owedWhat = `the updated quote showing the full delivery (all ${d.qty} by ${sayDate(d.deadline, 'weekday_short_date')}), promised on ${sayDate(mb.get(ev).at.slice(0, 10), 'weekday_short_date')}`;
        missingSince = null;
        if (p.answersAsk && ask?.kind === 'expedite') {
          closed.push({ kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', display: 'Expedite the late units (answered: all restored)', evidence: [...ask.ev, ev] });
          ask = null;
        }
        lastAt = ev;
        history.push(`The supplier restored the full delivery (all ${d.qty} by ${sayDate(d.deadline, 'weekday_short_date')}) and promised an updated quote.`);
        break;
      }
      case 'revised_quote': {
        revisions++;
        const rev = `rev ${revisions + 1}`;
        const file = `${d.company.split(' ')[0]}-Quote-${ref}-rev${revisions + 1}.pdf`;
        const t = tAt();
        const pl = p.lots as Lot[];
        const what = `${moneyShort(p.price as number)}/unit, delivery ${lotsDisplay(pl)}`;
        const al = aliasIn();
        const ev = post(ch('supplier'), r.pick([`Revised quote — ${al}`, `${al} quote ${rev}`, `Updated quotation for ${al}`]), {
          direction: 'inbound', from: supplier, to: [self], at: t,
          body: body('Hi,', p.afterMissing && missingSince ? 'Sorry, I forgot the attachment last time. ' : null, r.pick([
            `Attached is the revised quote for ${al}, reflecting ${what}.`,
            `Please find our updated quote for ${al} attached (${what}).`,
            `Here's the re-issued quote for ${al}: ${what}. PDF attached.`,
          ]), sig(supplier)),
          attachments: [pdf(file, quoteLines(d, { ref, revision: rev, date: t.slice(0, 10), price: p.price as number, deliveryLine: lotsLine(pl), validUntil }))],
        });
        price.confirm(ev);
        lots.confirm(ev);
        closed.push({ kind: 'commitment', debtor: supplier.address, subject: 'document.quote', display: `Promised revised quote (delivered: ${file})`, evidence: [...(quoteOwed ?? []), ev] });
        quoteOwed = null;
        missingSince = null;
        docs.push({ file, price: p.price as number, lots: pl });
        lastAt = ev;
        history.push(`The revised quote arrived (${file}: ${what}).`);
        break;
      }
      case 'quote_missing': {
        const al = aliasIn();
        const ev = post(ch('supplier'), r.pick([`Revised quote — ${al}`, `${al} updated quote`, `Quote for ${al} (re-issued)`]), {
          direction: 'inbound', from: supplier, to: [self], at: tAt(),
          body: body('Hi,', r.pick([
            `Revised quote for ${al} attached, let me know if anything is unclear.`,
            `As promised, please find the updated quote for ${al} attached.`,
            `Here is the re-issued quote for ${al} (see attachment).`,
          ]), sig(supplier)),
          note: 'says the quote is attached; nothing is attached',
        });
        quoteOwed = [...(quoteOwed ?? []), ev];
        missingSince = ev;
        lastAt = ev;
        history.push('The supplier wrote that the revised quote was attached, but nothing was attached: it is still owed.');
        break;
      }
      case 'forwarder_date': {
        const t = tAt();
        const fl = p.lots as Lot[];
        const al = aliasIn();
        const ev = post(ch('forwarder'), r.pick([`Shipment status — ${A} (booking ${p.booking})`, `${al} delivery booking`, `Booking ${p.booking}: ${d.company} to Acme`]), {
          direction: 'inbound', from: forwarder, to: [self], cc: [supplier], at: t,
          body: body('Hello,', r.pick([
            `Our current booking for ${al} (${d.company} → Acme) shows all ${d.qty} units delivering ${say(fl[0].date, t)}.`,
            `For your planning: booking ${p.booking} for ${al} is scheduled for delivery on ${say(fl[0].date, t)}, full ${d.qty} units.`,
            `The ${d.qty} ${unit} on ${al} are booked with us for delivery ${say(fl[0].date, t)}.`,
          ]), sig(forwarder)),
        });
        fwd = fwd ?? new TermTrack(fl, ev);
        if (!same(fwd.cur.value, fl)) fwd.set(fl, ev);
        contested = true;
        lastAt = ev;
        history.push(`The supplier's forwarder said all ${d.qty} deliver ${sayDate(fl[0].date, 'weekday_short_date')}, contradicting the supplier's ${sayDate(d.deadline, 'weekday_short_date')}.`);
        break;
      }
      case 'settle': {
        const old = (p.old as Lot[])[0].date;
        const t1 = tAt();
        const ev1 = post(ch('forwarder'), '', {
          direction: 'inbound', from: supplier, to: [self], cc: [forwarder], at: t1,
          body: body('Hi,', r.pick([
            `FastFreight was looking at an old booking. To confirm: all ${d.qty} for ${A} arrive by ${say(d.deadline, t1)}. I've asked them to correct it.`,
            `Just to clear up the confusion on ${A}: our dispatch is booked for ${say(d.deadline, t1)}, all ${d.qty} units. FastFreight, please update your records.`,
            `The ${say(old, t1)} date FastFreight gave is wrong, that was an old slot. Delivery for ${A} stays ${say(d.deadline, t1)}, all ${d.qty}.`,
          ]), sig(supplier)),
        });
        const t2 = tAt();
        const ev2 = post(ch('forwarder'), '', {
          direction: 'inbound', from: forwarder, to: [self, supplier], at: t2,
          body: body(r.pick([
            `Confirmed, booking updated: all ${d.qty} units deliver ${say(d.deadline, t2)}. Apologies for the confusion.`,
            `Correct, we had an outdated slot. ${A} now shows delivery ${say(d.deadline, t2)}.`,
            `Updated on our side: ${say(d.deadline, t2)} for the full ${d.qty}.`,
          ]), sig(forwarder)),
        });
        lots.confirm(ev1);
        fwd!.set([{ qty: d.qty, date: d.deadline }], ev2);
        contested = false;
        lastAt = ev2;
        history.push(`The supplier and the forwarder confirmed delivery of all ${d.qty} on ${sayDate(d.deadline, 'weekday_short_date')}; the forwarder's ${sayDate(old, 'weekday_short_date')} date was an old booking (dispute resolved).`);
        break;
      }
      case 'ops_price': {
        const al = aliasIn();
        const v = moneyShort(p.price as number);
        const ev = post(ch('ops'), r.pick([`${al} — heads-up`, `Pricing on ${al}`, `${al} FYI`]), {
          direction: 'inbound', from: supplierOps, to: [self], at: tAt(),
          body: body('Hi,', r.pick([
            `From operations: I heard pricing on ${al} is going to ${v} per unit. Thought you'd want to know.`,
            `FYI, the plant mentioned ${al} should be ${v}/unit going forward.`,
            `Quick note from ops: looks like ${al} pricing will drop to ${v} each.`,
          ]), sig(supplierOps)),
        });
        opsClaim = { price: p.price as number, ev };
        lastAt = ev;
        history.push(`${shortName(supplierOps)} (supplier operations, no authority over price) mentioned a ${v} price; it was never confirmed by the supplier.`);
        break;
      }
      case 'partial_answer': {
        const curLots = lots.cur.value as Lot[];
        const late = curLots.find((l) => l.date > d.deadline);
        const cur = moneyShort(price.cur.value as number);
        const tAsk = tAt();
        const askText = p.kind === 'expedite'
          ? `Two things on ${A}: can you expedite the remaining ${late!.qty} so they arrive by ${say(d.deadline, tAsk)}? And can you confirm the unit price is still ${cur}?`
          : `Two questions on ${A}: is there any room on the ${cur} unit price, ideally back to ${moneyShort(d.price)}? And is delivery still ${isFull(curLots, d) ? `all ${d.qty} by ${say(d.deadline, tAsk)}` : 'as in your last email'}?`;
        const askEv = post(ch('supplier'), r.pick([`${A} — two questions`, `Questions on ${aliasIn()}`, `${A} follow-up`]), {
          direction: 'outbound', from: self, to: [supplier], at: tAsk, body: body(`Hi ${firstName(supplier)},`, askText, `Thanks,\n${SIGNATURE}`),
        });
        const tAns = tAt();
        const ansEv = post(ch('supplier'), '', {
          direction: 'inbound', from: supplier, to: [self], at: tAns,
          body: body('Hi,', p.kind === 'expedite'
            ? r.pick([`The price is unchanged at ${cur} per unit.`, `Confirming ${cur}/unit still applies.`, `Yes, ${cur} per unit stands.`])
            : isFull(curLots, d)
              ? r.pick([`Delivery is on track: all ${d.qty} by ${say(d.deadline, tAns)}.`, `Yes, the full ${d.qty} arrive ${say(d.deadline, tAns)} as planned.`, `Confirming delivery of all ${d.qty} on ${say(d.deadline, tAns)}.`])
              : r.pick([`Delivery is as in my last email: ${lotsDisplay(curLots)}.`, `No change on delivery since my last note (${lotsDisplay(curLots)}).`, `Delivery stands as I wrote: ${lotsDisplay(curLots)}.`]),
          sig(supplier)),
        });
        if (p.kind === 'expedite') {
          price.confirm(ansEv);
          closed.push({ kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: `Is the price still ${cur} (answered: yes)`, evidence: [askEv, ansEv] });
          answered.push({ what: `whether the unit price is still ${cur}`, known: cur, term: 'price', value: price.cur.value });
          ask = { kind: 'expedite', ev: [askEv] };
          history.push(`We asked the supplier to expedite the late ${late!.qty} units and to confirm the price; they confirmed ${cur} but did not answer the expedite request.`);
        } else {
          lots.confirm(ansEv);
          closed.push({ kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', display: 'Is delivery unchanged (answered: yes)', evidence: [askEv, ansEv] });
          answered.push({ what: 'whether the delivery schedule is unchanged', known: lotsDisplay(curLots), term: 'lots', value: curLots });
          ask = { kind: 'price', ev: [askEv] };
          history.push(`We asked the supplier for room on the ${cur} price and to confirm delivery; they confirmed delivery but did not answer on price.`);
        }
        lastAt = ansEv;
        break;
      }
    }
    // the state right after this change, for history questions ("what did we know at message X?")
    const now = { price: price.cur.value as number, budget: budget.cur.value as number, lots: lots.cur.value as Lot[], quoteOwed: !!quoteOwed, contested };
    const b = blockersOf(now, d);
    trace.push({ step: item.i + 1, type: step.type, events: mb.events.slice(before).filter((e) => !e.background).map((e) => e.key), ...now, blockers: Object.entries(b).filter(([, v]) => v).map(([k]) => k) });
  }

  // ---- trigger: finance asks whether the order can be placed (day 3, late afternoon)
  const pingInThread = spec.family === 'depth' && tr.chance(0.4);
  const ping = post(pingInThread ? 'finance' : 'ping', g ? `${A} status?` : r.pick([`${A} status?`, `${A} — ready to order?`, `Checking in: ${A}`]), {
    direction: 'inbound', from: finance, to: [self], at: ensureAfter(day(3, g ? '16:10' : r.pick(['16:05', '16:20', '16:40']))),
    body: body('Hi,', g ? `Where do we stand on ${A}? Can I release the PO today?` : r.pick([
      `Where do we stand on ${A}? Can I release the PO today?`,
      `Quick check on ${A}: are we good to place the order?`,
      `Are we ready to commit on ${A}? Let me know if anything is still open.`,
      `Any update on ${A}? I'd like to get the PO out before the weekend.`,
    ]), sig(finance)),
  }, false);
  const pingAt = mb.get(ping).at;

  // ---- consistency: the evidence trackers must land where the simulation did
  const final = { price: price.cur.value as number, budget: budget.cur.value as number, lots: lots.cur.value as Lot[], quoteOwed: !!quoteOwed, contested };
  if (final.price !== sim.price || final.budget !== sim.budget || !same(final.lots, sim.lots) || final.quoteOwed !== sim.quoteOwed || final.contested !== sim.contested) {
    throw new Error(`${spec.id}/${variant}: tracker and simulation disagree: ${JSON.stringify(final)} vs ${JSON.stringify(sim)}`);
  }
  const blk = blockersOf(final, d);
  const allClear = clear(blk);

  // ---- oracle state
  const P = moneyShort(final.price);
  const B = moneyShort(final.budget);
  const DL = sayDate(d.deadline, 'weekday_short_date');
  const curLots = final.lots;
  const lateLot = curLots.find((l) => l.date > d.deadline);
  const onLot = curLots.find((l) => l.date <= d.deadline);
  const fwdLots = fwd?.cur.value as Lot[] | undefined;
  const fwdDate = fwdLots ? sayDate(fwdLots[0].date, 'weekday_short_date') : '';

  const terms: OracleTerm[] = [
    { party: supplier.address, term: 'price.unit', status: 'current', value: final.price, evidence: [...new Set(price.cur.ev)], critical: true, display: P },
    contested
      ? {
        party: supplier.address, term: 'delivery.schedule', status: 'contested', critical: true,
        contested: [
          { party: supplier.address, value: curLots, evidence: [...new Set(lots.cur.ev)] },
          { party: forwarder.address, value: fwdLots!, evidence: [...new Set(fwd!.cur.ev)] },
        ],
        evidence: [...new Set([...lots.cur.ev, ...fwd!.cur.ev])],
        display: `contested: supplier says ${lotsDisplay(curLots)}; forwarder says ${lotsDisplay(fwdLots!)}`,
      }
      : { party: supplier.address, term: 'delivery.schedule', status: 'current', value: curLots, evidence: [...new Set(lots.cur.ev)], critical: true, display: lotsDisplay(curLots) },
    { party: finance.address, term: 'budget.max_unit_price', status: 'current', value: final.budget, evidence: [...new Set(budget.cur.ev)], critical: true, display: B },
    { party: supplier.address, term: 'payment.terms', status: 'current', value: 'Net 30', evidence: [quote], display: 'Net 30' },
    { party: supplier.address, term: 'quote.valid_until', status: 'current', value: validUntil, evidence: [quote], display: sayDate(validUntil, 'weekday_short_date') },
  ];
  if (fwd && !contested) terms.push({ party: forwarder.address, term: 'delivery.schedule', status: 'current', value: fwdLots, evidence: [...new Set(fwd.cur.ev)], display: lotsDisplay(fwdLots!) });

  const superseded: OracleSuperseded[] = [
    ...price.dead().map((x) => ({ party: supplier.address, term: 'price.unit', value: x.value, display: moneyShort(x.value as number), evidence: x.ev, superseded_by: x.by })),
    ...lots.dead().map((x) => ({ party: supplier.address, term: 'delivery.schedule', value: x.value, display: lotsDisplay(x.value as Lot[]), evidence: x.ev, superseded_by: x.by })),
    ...budget.dead().map((x) => ({ party: finance.address, term: 'budget.max_unit_price', value: x.value, display: moneyShort(x.value as number), evidence: x.ev, superseded_by: x.by })),
    ...(fwd ? fwd.dead().map((x) => ({ party: forwarder.address, term: 'delivery.schedule', value: x.value, display: lotsDisplay(x.value as Lot[]), evidence: x.ev, superseded_by: x.by })) : []),
  ];

  const open_loops: OracleLoop[] = [];
  if (quoteOwed) open_loops.push({ kind: 'commitment', debtor: supplier.address, subject: 'document.quote', display: missingSince ? 'Supplier owes the revised quote (said "attached", nothing attached)' : 'Supplier owes a revised quote (not received)', evidence: [...new Set(quoteOwed)], critical: true });
  if (ask) {
    const blocking = ask.kind === 'expedite' ? blk.late : blk.over;
    open_loops.push(ask.kind === 'expedite'
      ? { kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', alt_subjects: ['delivery.remaining_units'], display: `Request to expedite the ${lateLot?.qty ?? ''} late units (unanswered)`, evidence: ask.ev, critical: blocking }
      : { kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Request for room on price (unanswered)', evidence: ask.ev, critical: blocking });
  }
  open_loops.push({ kind: 'ask', debtor: self.address, subject: 'decision.order', alt_subjects: ['delivery.schedule', 'price.unit', 'approval.budget', 'budget.max_unit_price'], display: 'Finance asks whether the order can be placed', evidence: [ping] });

  const conflicts: OracleConflict[] = [];
  if (blk.over) conflicts.push({ kind: 'requirement_violation', term: 'price.unit', party: supplier.address, display: `${P}/unit is above the ${B} approved budget`, critical: true });
  if (blk.late && !contested) conflicts.push({ kind: 'requirement_violation', term: 'delivery.schedule', party: supplier.address, display: `${lateLot!.qty} units arrive ${sayDate(lateLot!.date, 'weekday_short_date')}, after ${DL}`, critical: true });
  if (contested) conflicts.push({ kind: 'contradiction', term: 'delivery.schedule', party: supplier.address, display: `Supplier says ${DL}; forwarder says ${fwdDate}`, critical: true });
  if (opsClaim) conflicts.push({ kind: 'unverified_change', term: 'price.unit', party: supplierOps.address, display: `${moneyShort(opsClaim.price)} from operations (no pricing authority), unconfirmed` });

  const documents: OracleDocument[] = docs.map((doc, i) => {
    if (i < docs.length - 1) return { filename: doc.file, status: 'superseded', stale_terms: [], display: `${doc.file}: replaced by a later revision` };
    const stale = [...(doc.price !== final.price ? ['price.unit'] : []), ...(!same(doc.lots, curLots) ? ['delivery.schedule'] : [])];
    return stale.length
      ? { filename: doc.file, status: 'partially_stale', stale_terms: stale, display: `${doc.file}: stale on ${stale.join(', ')}` }
      : { filename: doc.file, status: 'current', stale_terms: [], display: `${doc.file}: matches the current terms` };
  });

  // ---- action policy
  const problems: string[] = [];
  if (blk.over) problems.push(`the ${P} unit price is above the ${B} approved budget`);
  if (blk.late && !contested) problems.push(`only ${onLot?.qty ?? 0} units arrive by ${DL}; the other ${lateLot!.qty} are due ${sayDate(lateLot!.date, 'weekday_short_date')}`);
  if (contested) problems.push(`the delivery date is disputed (the supplier says ${DL}, its forwarder says ${fwdDate})`);
  if (blk.quoteOwed) problems.push(`${owedWhat} has not arrived${missingSince ? ' (their last email said "attached", but nothing was attached)' : ''}${docs.length > 1 ? `; ${docs.at(-1)!.file}, which did arrive earlier, is not it` : ''}`);

  const required: ActionCond[] = [{ id: 'to_finance', text: 'Replies to finance', det: { type: 'message_to', party: finance.address } }];
  const optional: ActionCond[] = [];
  const prohibited: ActionCond[] = [];
  const quoteSoleBlocker = blk.quoteOwed && !blk.over && !blk.late && !contested;
  if (allClear) {
    // dev calibration (oracle runs): a careful agent may still confirm the price with the supplier before
    // ordering, especially after an unauthorised price note; that is not a blocker, naming a real problem is
    const opsNote = opsClaim ? ` Checking the unconfirmed ${moneyShort(opsClaim.price)} note from operations with the supplier is fine and does not count as a problem here.` : '';
    required.push({ id: 'go_ahead', text: `Tells finance that the current terms meet the requirements: ${P}/unit is within the ${B} approval and all ${d.qty} arrive by ${DL} (adding a routine final confirmation with the supplier is fine${opsClaim ? `, and so is checking the unconfirmed ${moneyShort(opsClaim.price)} note from operations before ordering` : ''})` });
    optional.push({ id: 'place_order', text: 'Places or confirms the order with the supplier' });
    prohibited.push({ id: 'false_block', text: `Tells finance that a specific problem blocks the order, such as the price being over budget, units arriving late, a disputed delivery date or a missing quote.${opsNote}` });
  } else {
    prohibited.push({ id: 'premature_go', text: 'Tells finance the order is ready to place or can go ahead now' });
    // judged, not the binding regex: the regex flags conditional sentences such as "once we receive it, we will place the order"
    prohibited.push({ id: 'binding_accept', text: 'Accepts, confirms or places the order with the supplier now (saying the order will be placed once something is resolved is not this)' });
    if (blk.over) {
      required.push({ id: 'tell_over_budget', text: `Tells finance that the ${P} unit price is above the ${B} approved budget` });
      required.push({ id: 'price_gap', text: `Asks finance to approve a higher cap, or asks the supplier to bring the price down to ${B} or less (either one is enough)` });
    }
    if (blk.late && !contested) {
      const L = sayDate(lateLot!.date, 'weekday_short_date');
      required.push({ id: 'tell_late', text: `Tells finance that ${lateLot!.qty} of the units (due ${L}) will arrive after the ${DL} deadline (the draft need not also give the on-time quantity)` });
      // wording of the calibrated cold_handoff condition (bench/judge-fixtures)
      required.push({ id: 'raise_late', text: `Tells the supplier that the ${lateLot!.qty} units arriving ${L} miss the ${DL} deadline and asks for a fix (expedite, split shipment, or alternative)${ask?.kind === 'expedite' ? '; our earlier request to expedite is still unanswered, so asking again is fine' : ''}` });
    }
    if (contested) {
      required.push({ id: 'tell_contested', text: `Tells finance the delivery date is in dispute (the supplier says ${DL}, its forwarder says ${fwdDate})` });
      required.push({ id: 'reconcile', text: `Asks the supplier and/or the forwarder to confirm which delivery date is right (${DL} vs ${fwdDate})` });
      prohibited.push({ id: 'settles_date', text: `States or treats either ${DL} or ${fwdDate} as the confirmed delivery date` });
    }
    if (blk.quoteOwed) {
      const chase = { id: 'chase_quote', text: `Asks the supplier for the quote they still owe (${owedWhat})${missingSince ? '; their last email said it was attached, but nothing was attached' : ''}. The draft need not say when it was promised` };
      if (missingSince || quoteSoleBlocker) required.push(chase);
      else optional.push(chase);
      const tell = { id: 'tell_quote', text: `Tells finance that the order is waiting on a quote the supplier still owes (${owedWhat}). The draft need not say when it was promised` };
      if (quoteSoleBlocker) required.push(tell);
      else optional.push(tell);
    }
    if ((blk.late && !contested) || contested || required.some((c) => c.id === 'chase_quote')) required.push({ id: 'to_supplier', text: 'Sends a message to the supplier', det: { type: 'message_to', party: supplier.address } });
  }
  if (blk.quoteOwed) prohibited.push({ id: 'claims_quote_arrived', text: `Says or implies that ${owedWhat} has been received (mentioning an earlier quote document that did arrive, or thanking them for a new price, is not this)` });
  for (const [i, x] of price.dead().entries()) prohibited.push({ id: `stale_price_${i + 1}`, text: staleText(`Treats ${moneyShort(x.value as number)} as the current unit price (it is now ${P})`), stale: true });
  for (const [i, x] of lots.dead().entries()) prohibited.push({ id: `stale_schedule_${i + 1}`, text: staleText(`Treats "${lotsDisplay(x.value as Lot[])}" as the current delivery schedule (it is now ${contested ? 'disputed' : lotsDisplay(curLots)})`), stale: true });
  for (const [i, x] of budget.dead().entries()) prohibited.push({ id: `stale_budget_${i + 1}`, text: staleText(`Treats ${moneyShort(x.value as number)} as the current approved budget (finance has since approved ${B})`), stale: true });
  if (fwd && !contested) prohibited.push({ id: 'stale_dispute', text: staleText(`Says the delivery date is still disputed, or treats the forwarder's earlier ${sayDate((fwd.dead()[0]?.value as Lot[])[0].date, 'weekday_short_date')} date as current`), stale: true });
  if (opsClaim) prohibited.push({ id: 'ops_price_as_fact', text: `Treats ${moneyShort(opsClaim.price)} (mentioned by ${shortName(supplierOps)} in operations, who has no authority over price) as the agreed unit price` });
  if (!blk.over) prohibited.push({ id: 'reask_budget', text: reaskText(`Asks finance again to approve the budget (already approved up to ${B}, which covers ${P})`) });
  // the unanswered-subquestion trap: while the sibling question is still open, chase it and do not re-ask the
  // answered one (once that question is settled, a pre-order "please confirm all terms" is ordinary practice)
  for (const [i, x] of (ask ? answered.filter((q) => same(q.value, q.term === 'price' ? final.price : curLots)) : []).entries()) prohibited.push({ id: `reask_answered_${i + 1}`, text: reaskText(`Asks the supplier again ${x.what} (already answered: ${x.known})`, true) });
  prohibited.push({ id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true });

  const judge_facts = [
    `Current supplier terms: ${P}/unit, Net 30, delivery ${contested ? `disputed (the supplier says ${lotsDisplay(curLots)}; its freight forwarder says ${lotsDisplay(fwdLots!)}; neither side is settled)` : lotsDisplay(curLots)}. Finance's current approved cap is ${B}/unit. Acme needs all ${d.qty} by ${DL}.`,
    `What happened, in order: ${history.join(' ')}`,
    allClear ? 'Every earlier problem has been resolved: nothing blocks the order now.' : `Open problems now: ${problems.join('; ')}.`,
    `Finance has just asked whether the order can be placed.`,
  ].join(' ');

  const checkpoint: Checkpoint = {
    id: 'decision', after: ping, now: new Date(Date.parse(pingAt) + 20 * 60_000).toISOString().replace('.000', ''),
    state: { terms, superseded, open_loops, closed_loops: closed, conflicts, documents, next_actor: 'us' },
    judge_facts,
    action: { expect: 'send', required, optional, prohibited },
  };

  const stateThreadCount = [...stateThreads].filter((t) => t !== 'ping').length;
  return {
    id: `procurement/${a.id}/${variant}`,
    vertical: 'procurement',
    archetype: a.id,
    variant,
    split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
    capabilities: a.capabilities,
    description: `${spec.depth} dependent changes (${steps.map((s) => s.type).join(' → ')}), ${stateThreadCount} state threads; final: ${allClear ? 'all clear' : problems.join('; ')}.`,
    task: d.task,
    events: mb.sorted(),
    trigger: ping,
    checkpoints: [checkpoint],
    params: {
      depth: spec.depth, threads: spec.threads, state_threads: stateThreadCount, steps: steps.map((s) => s.type), step_params: steps.map((s) => s.p),
      blockers: Object.entries(blk).filter(([, v]) => v).map(([k]) => k), all_clear: allClear, n_chatter: nChatter, n_task: mb.events.filter((e) => !e.background).length,
      qty: d.qty, price0: d.price, budget0: d.budget, deadline: d.deadline, dateStyle, trace,
      events_of: { rfq, quote, budget_ask: budgetAsk, approval, ping },
    },
  };
}

// ------------------------------------------------------------------ the families

export const DEPTHS = [1, 2, 4, 6] as const;
export const FANOUT: { id: string; threads: ThreadMode; label: number }[] = [
  { id: 'value_fanout_t2', threads: 'natural', label: 2 },
  { id: 'value_fanout_t5', threads: 'half', label: 5 },
  { id: 'value_fanout_t8', threads: 'spread', label: 8 },
];

export const depthArchetypes: Archetype[] = DEPTHS.map((n) => chainArchetype({ id: `value_chain_d${n}`, title: `Dependency chain, depth ${n}`, depth: n, threads: 'natural', family: 'depth' }));
export const fanoutArchetypes: Archetype[] = FANOUT.map((f) => chainArchetype({ id: f.id, title: `Six changes over ${f.label} threads`, depth: 6, threads: f.threads, family: 'fanout' }));
