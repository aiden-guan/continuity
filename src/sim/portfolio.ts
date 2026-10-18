// A synthetic portfolio of home purchases for the portfolio demo and tests: N deals in one backend, built
// from a few archetypes (smooth, appraisal gap resolved / fell through, closing slip resolved / fell
// through, seller took another offer, and deals still in flight). Every email goes through the real
// pipeline; our agent's emails are written by the offline policy agent, except the withdrawal that ends a
// failed deal (a human decision, scripted here). Ported from samrocksnature's b615ab7.
import type { Backend } from '../store/backend.ts';
import { MemoryBackend } from '../store/memory-backend.ts';
import { DEFAULT_ORG } from '../engine/engine.ts';
import { heuristicExtractor } from '../extract/heuristic.ts';
import { prettyDate } from '../extract/dates.ts';
import { usd } from '../domain/real-estate.ts';
import { setSimTime } from '../clock.ts';
import { Harness } from './harness.ts';
import { makePdf } from './pdf.ts';
import { agentTurn, newStory } from './deal-story.ts';
import type { SimEmail } from './scenario.ts';
import type { TaskSpec } from '../types.ts';

export type Archetype = 'smooth' | 'gap_resolved' | 'gap_fell_through' | 'slip_resolved' | 'slip_fell_through' | 'other_offer' | 'open_gap' | 'open_slip_overdue' | 'open_waiting';
const MIX: [Archetype, number][] = [['smooth', 25], ['gap_resolved', 14], ['gap_fell_through', 12], ['slip_resolved', 10], ['slip_fell_through', 10], ['other_offer', 6], ['open_gap', 9], ['open_slip_overdue', 8], ['open_waiting', 6]];
const STREETS = ['Elm St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Birch Rd', 'Willow Way', 'Pine Ct', 'Harbor Blvd', 'Lakeview Ter', 'Summit Pl', 'Ridge Rd', 'Meadow Ln'];
const BROKERS = [['Jordan Lee', 'crestline-realty'], ['Maria Santos', 'bayside-homes'], ['Chris Park', 'northgate-realty'], ['Dana Brooks', 'keystone-properties'], ['Sam Ortiz', 'evergreen-realty'], ['Lee Wong', 'harborview-re']];
const LENDERS = ['summit-mortgage', 'coastal-lending', 'firstline-bank'];
const INSPECTORS = ['keyhole-inspections', 'trueframe-inspect', 'brightpath-home'];
/** "Today" for a generated portfolio: in-flight deals are mid-way, finished ones are weeks old. */
export const TODAY = '2026-10-27T08:00:00Z';

/** Deterministic PRNG (mulberry32): the same seed builds the same portfolio. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86_400_000).toISOString();
const long = (iso: string) => { const d = new Date(iso); return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const at = (iso: string, hh: number) => `${iso.slice(0, 10)}T${String(hh).padStart(2, '0')}:00:00Z`;

export interface PortfolioDeal { task_id: string; alias: string; item: string; archetype: Archetype; emails: number }

export async function buildPortfolio(n = 200, seed = 42): Promise<{ backend: MemoryBackend; org: string; deals: PortfolioDeal[] }> {
  const backend = new MemoryBackend();
  return { backend, org: DEFAULT_ORG, deals: await fillPortfolio(backend, DEFAULT_ORG, n, seed) };
}

/** Generate `n` deals into an org of any backend. `onDeal` reports progress. */
export async function fillPortfolio(backend: Backend, org: string, n = 200, seed = 42, onDeal?: (i: number) => void): Promise<PortfolioDeal[]> {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const total = MIX.reduce((s, [, w]) => s + w, 0);
  const archetypeFor = (): Archetype => {
    let r = rand() * total;
    for (const [k, w] of MIX) if ((r -= w) < 0) return k;
    return 'smooth';
  };
  const out: PortfolioDeal[] = [];
  for (let i = 0; i < n; i++) {
    const kind = archetypeFor();
    const open = kind.startsWith('open_');
    // finished deals started 2-8 weeks ago; in-flight deals are mid-way through their first ten days
    const start = open ? addDays('2026-10-17T09:00:00Z', Math.floor(rand() * 3)) : addDays('2026-09-01T09:00:00Z', Math.floor(rand() * 45));
    const list = Math.round((550_000 + rand() * 850_000) / 5_000) * 5_000;
    const item = `${10 + Math.floor(rand() * 980)} ${pick(STREETS)}`;
    const [broker, firm] = pick(BROKERS);
    const a = {
      self: 'buyers-agent@harbor-homes.primitive.email', listing: `${broker.split(' ')[0].toLowerCase()}@${firm}.example`,
      buyer: `buyer${1000 + i}@clients.example`, lender: `appraisals@${pick(LENDERS)}.example`, inspector: `reports@${pick(INSPECTORS)}.example`,
    };
    const closeBy = addDays(start, 35 + Math.floor(rand() * 10));
    const ceiling = Math.round(list * 1.01);
    const task: TaskSpec = {
      id: `deal_${1000 + i}`, alias: `D-${1000 + i}`, item, domain: 'real_estate', self_address: a.self,
      goal: `Buy ${item} for our buyer: price no more than ${usd(ceiling)} and within the appraisal, closing by ${long(closeBy)}.`,
      participants: [
        { address: a.self, name: 'Harbor Homes Buyer Agent', role: 'self', label: 'buyer agent (us)', authority: ['decision.', 'deal.'] },
        { address: a.listing, name: `${broker} (listing agent)`, role: 'counterparty', label: 'listing agent', authority: ['price.', 'closing.', 'contingency.', 'decision.', 'deal.'], group: 'seller' },
        { address: a.buyer, name: `Buyer ${1000 + i}`, role: 'internal', label: 'buyer', authority: ['budget.'] },
        { address: a.lender, name: 'Lender', role: 'internal', label: 'lender', authority: ['appraisal.'] },
        { address: a.inspector, name: 'Inspector', role: 'internal', label: 'inspector', authority: ['inspection.'] },
      ],
      requirements: [
        { key: 'requirement.max_price', value: ceiling, display: usd(ceiling), hard: true },
        { key: 'requirement.close_by', value: closeBy.slice(0, 10), display: prettyDate(closeBy.slice(0, 10)), hard: true },
        { key: 'requirement.opening_offer', value: Math.round(list * 0.95), display: usd(list * 0.95), hard: false },
      ],
    };
    setSimTime(start);
    const h = new Harness(task, heuristicExtractor, start, { backend, org });
    await h.ready;
    const s = newStory();
    const ref = (to: string) => {
      const r = s.sent.get(to);
      return { inReplyTo: r?.messageId ?? null, references: r ? [...r.references, r.messageId] : [], subject: r ? (/^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`) : `${task.alias} — ${item}` };
    };
    let emails = 0;
    const mail = async (who: 'listing' | 'buyer' | 'lender' | 'inspector', when: string, body: string, attachments?: SimEmail['attachments']) => {
      setSimTime(when);
      emails++;
      return h.in({ from: a[who], fromName: who, to: a.self, at: when, threadKey: `${task.id}:${who}`, body, attachments, ...ref(a[who]) });
    };
    const turn = async (when: string) => {
      await agentTurn(h, s, 'agent', when);
      emails += s.decisions.agent.messages.length;
    };
    const pdf = (price: number, closing: string, rev: number) => [{
      filename: `Counter-${task.alias}${rev > 1 ? `-rev${rev}` : ''}.pdf`, content_type: 'application/pdf',
      bytes: makePdf([`SELLER COUNTER OFFER #${rev}`, `Property: ${item}    Ref: ${task.alias}`, `Purchase price: ${usd(price)}`, `Closing date: ${long(closing)}`]),
    }];
    const done = () => {
      out.push({ task_id: task.id, alias: task.alias, item, archetype: kind, emails });
      onDeal?.(i);
    };

    // the counter stays within the ceiling (list × 1.01)
    const counter = Math.min(Math.round((list * (0.97 + rand() * 0.04)) / 1_000) * 1_000, Math.floor(ceiling / 1_000) * 1_000);
    const gap = Math.round((10_000 + rand() * 35_000) / 1_000) * 1_000;
    const appraisal = kind.includes('gap') ? counter - gap : counter + Math.round(rand() * 20) * 1_000;
    const slip = addDays(closeBy, 10 + Math.floor(rand() * 10));
    const withdraw = async (when: string, reason: string) => {
      setSimTime(when);
      emails++;
      const r = ref(a.listing);
      s.sent.set(a.listing, await h.out(a.listing, r.subject, `Our buyer is withdrawing from ${item}: ${reason}.`, when, r.inReplyTo ? { messageId: r.inReplyTo, references: r.references.slice(0, -1) } : null));
    };

    await turn(at(start, 9));
    if (kind === 'other_offer') {
      await mail('listing', at(addDays(start, 2), 11), `Unfortunately the seller has accepted another offer on ${item}.`);
      done();
      continue;
    }
    await mail('listing', at(addDays(start, 1), 10), `Thanks for the offer on ${item}. The seller counters at ${usd(counter)} with closing on ${long(closeBy)}.\nThe inspection contingency runs until ${long(addDays(start, 10))}.`, pdf(counter, closeBy, 1));
    await mail('buyer', at(addDays(start, 1), 19), `Yes, I'm comfortable going up to ${usd(ceiling)} for ${item}.`);
    await mail('inspector', at(addDays(start, 2), 8), `The home inspection for ${item} is scheduled for ${long(addDays(start, 4))}. I'll send the inspection report by ${long(addDays(start, 7))}.`);
    if (kind === 'open_waiting') { done(); continue; } // the lender has gone quiet
    await mail('lender', at(addDays(start, 5), 14), `The appraisal for ${item} came in at ${usd(appraisal)}.`);
    if (kind.includes('slip')) await mail('listing', at(addDays(start, 6), 9), `Correction: the seller's purchase of their next home slipped, so closing needs to move to ${long(slip)}.\nI'll send a revised counter reflecting the new date.`);
    await turn(at(addDays(start, 7), 9)); // raise what failed (or nothing, if all is well)
    if (kind === 'open_gap' || kind === 'open_slip_overdue') { done(); continue; }
    await mail('inspector', at(addDays(start, 7), 16), `Attached is the inspection report for ${item}. No major defects.`, [{ filename: `Inspection-Report-${task.alias}.pdf`, content_type: 'application/pdf', bytes: makePdf([`HOME INSPECTION REPORT: ${item}`, 'No major defects.']) }]);
    if (kind === 'gap_resolved') await mail('listing', at(addDays(start, 9), 11), `The seller agrees to ${usd(appraisal)}. Revised counter attached.`, pdf(appraisal, closeBy, 2));
    if (kind === 'slip_resolved') await mail('listing', at(addDays(start, 9), 11), `The seller will keep the ${long(closeBy)} closing after all. Revised counter attached.`, pdf(counter, closeBy, 2));
    if (kind === 'gap_fell_through') {
      await mail('listing', at(addDays(start, 9), 11), `The seller won't go below ${usd(counter)}.`);
      await withdraw(at(addDays(start, 10), 9), 'the appraisal gap could not be closed');
    } else if (kind === 'slip_fell_through') {
      await mail('listing', at(addDays(start, 9), 11), `The seller cannot close before ${long(slip)}.`);
      await withdraw(at(addDays(start, 10), 9), 'the seller could not meet the closing date');
    } else {
      await turn(at(addDays(start, 10), 9)); // accept
    }
    done();
  }
  setSimTime(TODAY);
  return out;
}
