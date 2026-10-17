// Finance vertical module: all 13 archetypes, in the AUTHORING.md table order.
import type { BenchCase, NeutralMail, VerticalModule } from '../../core/types.ts';
import type { Rand } from '../../core/util.ts';
import { finance } from './vertical.ts';
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
  const ar = c.task.parties.find((p) => p.label === 'vendor AR')!;
  const controller = c.task.parties.find((p) => p.label === 'controller')!;
  const alias = c.task.alias;
  const onTask: [typeof ar, string, string][] = [
    [ar, `${alias} remittance`, `When you pay ${alias}, please quote the invoice number on the remittance advice.`],
    [controller, `${alias} coding`, `Reminder: please code ${alias} to cost center ${4000 + ((i * 37) % 1000)}.`],
    [ar, `${alias} portal`, `FYI a copy of ${alias} is also available in our customer portal.`],
    [controller, 'Payment run cut-off', 'Reminder: the payment run cut-off is 2pm on run days.'],
    [ar, 'Out of office', 'Quick note: I am out Thursday afternoon; a colleague will monitor the AR inbox.'],
  ];
  const offTask: [string, string, string, string][] = [
    ['deals@ap-automation.example', 'PayFlow AP Automation', 'Webinar: touchless invoice processing', 'Join our webinar on Thursday.'],
    ['news@cfo-weekly.example', 'CFO Weekly', 'CFO Weekly: working-capital outlook', 'DPO creeps up across industries.'],
    ['it-helpdesk@acme-corp.example', 'Acme IT', 'Password expiry reminder', 'Your password expires in 7 days.'],
    ['treasury@acme-corp.example', 'Acme Treasury', 'Positive pay file accepted', 'No exceptions on yesterday\'s file.'],
  ];
  if (r.chance(0.5)) {
    const [p, subject, text] = onTask[i % onTask.length];
    return { background: false, from: p.address, fromName: p.name.split(' (')[0], subject: `${subject} #${i + 1}`, body: `${text}\n\n${p.name.split(' ')[0]}` };
  }
  const [from, fromName, subject, text] = offTask[i % offTask.length];
  return { background: true, from, fromName, subject: `${subject} #${i + 1}`, body: text };
}

export const vertical = finance;
export const archetypes = [correction, unanswered_subquestion, stale_document, cold_handoff, cross_thread, partial_fulfilment, withdrawn_offer, contradiction, unauthorized_change, injection, late_evidence, competing_offers, supersession_chain];
export const module: VerticalModule = { vertical, archetypes, neutral };
export { neutral };
