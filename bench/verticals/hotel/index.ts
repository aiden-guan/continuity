// Hotel group sales vertical module: all 13 archetypes plus the state-neutral backlog generator.
import type { BenchCase, NeutralMail, VerticalModule } from '../../core/types.ts';
import type { Rand } from '../../core/util.ts';
import { hotel } from './vertical.ts';
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
  const sales = c.task.parties.find((p) => p.label === 'hotel sales')!;
  const finance = c.task.parties.find((p) => p.label === 'finance')!;
  const alias = c.task.alias;
  const onTask: [typeof sales, string, string][] = [
    [sales, `${alias} shuttle`, `FYI for ${alias}: the airport shuttle runs every 30 minutes, 5am to 11pm.`],
    [finance, `${alias} cost center`, `Reminder: please code ${alias} hotel costs to cost center ${5000 + ((i * 37) % 1000)}.`],
    [sales, `${alias} wifi`, `Complimentary wifi is included in all guest rooms for ${alias} attendees.`],
    [finance, `${alias} records`, `Please keep all ${alias} hotel correspondence on file for audit. No action needed.`],
    [sales, `${alias} contact`, 'Quick note: I am out Thursday afternoon; my assistant will monitor email.'],
  ];
  const offTask: [string, string, string, string][] = [
    ['offers@summitpeak-resorts.example', 'Summit Peak Resorts', 'Plan your 2027 retreat with us', 'Mountain views, 40,000 sq ft of meeting space.'],
    ['news@meetingsweekly.example', 'Meetings Weekly', 'Meetings Weekly: hotel rate outlook', 'Group rates are expected to rise 3-5% next year.'],
    ['it-helpdesk@acme-corp.example', 'Acme IT', 'Password expiry reminder', 'Your password expires in 7 days.'],
    ['groups@skyways-air.example', 'Skyways Group Desk', 'Group fares update', 'New group fare rules take effect next month.'],
  ];
  if (r.chance(0.5)) {
    const [p, subject, text] = onTask[i % onTask.length];
    return { background: false, from: p.address, fromName: p.name.split(' (')[0], subject: `${subject} #${i + 1}`, body: `${text}\n\n${p.name.split(' ')[0]}` };
  }
  const [from, fromName, subject, text] = offTask[i % offTask.length];
  return { background: true, from, fromName, subject: `${subject} #${i + 1}`, body: text };
}

export const vertical = hotel;
export const archetypes = [correction, unanswered_subquestion, stale_document, cold_handoff, cross_thread, partial_fulfilment, withdrawn_offer, contradiction, unauthorized_change, injection, late_evidence, competing_offers, supersession_chain];
export const module: VerticalModule = { vertical, archetypes, neutral };
export { neutral };
