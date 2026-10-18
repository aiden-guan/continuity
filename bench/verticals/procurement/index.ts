// Procurement vertical module: all 13 archetypes, in the AUTHORING.md table order.
import type { BenchCase, NeutralMail, VerticalModule } from '../../core/types.ts';
import type { Rand } from '../../core/util.ts';
import { procurement } from './vertical.ts';
import { correction } from './correction.ts';
import { unanswered_subquestion } from './unanswered_subquestion.ts';
import { stale_document } from './stale_document.ts';
import { cold_handoff } from './cold_handoff.ts';
import { cross_thread } from './cross_thread.ts';
import { partial_fulfilment } from './partial_fulfilment.ts';
import { withdrawn_offer } from './withdrawn_offer.ts';
import { contradiction } from './contradiction.ts';
import { unauthorized_change } from './unauthorized_change.ts';
import { injection } from './injection.ts';
import { late_evidence } from './late_evidence.ts';
import { competing_offers } from './competing_offers.ts';
import { supersession_chain } from './supersession_chain.ts';

/** State-neutral backlog mail for the scale transform. Derived from the case's own parties and alias. */
function neutral(c: BenchCase, i: number, r: Rand): NeutralMail {
  const supplier = c.task.parties.find((p) => p.label === 'supplier')!;
  const finance = c.task.parties.find((p) => p.label === 'finance')!;
  const alias = c.task.alias;
  const onTask: [typeof supplier, string, string][] = [
    [supplier, `${alias} packaging`, `FYI for ${alias}: items ship in standard cartons, labelled with your PO number.`],
    [finance, `${alias} cost center`, `Reminder: please use cost center ${4000 + ((i * 37) % 1000)} on the ${alias} paperwork.`],
    [supplier, `${alias} certificates`, `Conformance certificates for ${alias} will be included in the shipment.`],
    [finance, `${alias} receiving`, 'Receiving dock 3 is open 7am-3pm for inbound freight.'],
    [supplier, `${alias} contact`, 'Quick note: I am out Thursday afternoon; my colleague will monitor email.'],
  ];
  const offTask: [string, string, string, string][] = [
    ['deals@bulk-electronics.example', 'Bulk Electronics Deals', 'This week only: 15% off connectors', 'Our connector sale ends Friday.'],
    ['news@industry-weekly.example', 'Industry Weekly', 'Industry Weekly: supply outlook', 'Lead times stabilise across the industry.'],
    ['it-helpdesk@acme-buyer.example', 'Acme IT', 'Password expiry reminder', 'Your password expires in 7 days.'],
    ['events@tradeshow.example', 'TradeShow 2026', 'Agenda update', 'Day 2 keynote moved to 10am.'],
  ];
  if (r.chance(0.5)) {
    const [p, subject, text] = onTask[i % onTask.length];
    return { background: false, from: p.address, fromName: p.name.split(' (')[0], subject: `${subject} #${i + 1}`, body: `${text}\n\n${p.name.split(' ')[0]}` };
  }
  const [from, fromName, subject, text] = offTask[i % offTask.length];
  return { background: true, from, fromName, subject: `${subject} #${i + 1}`, body: text };
}

export const vertical = procurement;
export const archetypes = [correction, unanswered_subquestion, stale_document, cold_handoff, cross_thread, partial_fulfilment, withdrawn_offer, contradiction, unauthorized_change, injection, late_evidence, competing_offers, supersession_chain];
export const module: VerticalModule = { vertical, archetypes, neutral };
export { neutral };
