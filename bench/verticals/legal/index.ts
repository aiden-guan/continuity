// Legal vertical module: all 13 archetypes, in the AUTHORING.md table order.
import type { BenchCase, NeutralMail, VerticalModule } from '../../core/types.ts';
import type { Rand } from '../../core/util.ts';
import { legal } from './vertical.ts';
import { correction } from './correction.ts';
import { unanswered_subquestion } from './unanswered_subquestion.ts';
import { stale_document } from './stale_document.ts';
import { cold_handoff } from './cold_handoff.ts';
import { cross_thread } from './cross_thread.ts';
import { partial_fulfilment } from './partial_fulfilment.ts';
import { unauthorized_change } from './unauthorized_change.ts';
import { injection } from './injection.ts';
import { withdrawn_offer } from './withdrawn_offer.ts';
import { contradiction } from './contradiction.ts';
import { late_evidence } from './late_evidence.ts';
import { competing_offers } from './competing_offers.ts';
import { supersession_chain } from './supersession_chain.ts';

/** State-neutral backlog mail for the scale transform. Derived from the case's own parties and matter number. */
function neutral(c: BenchCase, i: number, r: Rand): NeutralMail {
  const counsel = c.task.parties.find((p) => p.label === 'vendor counsel')!;
  const gc = c.task.parties.find((p) => p.label === 'general counsel')!;
  const owner = c.task.parties.find((p) => p.label === 'business owner') ?? gc;
  const alias = c.task.alias;
  const onTask: [typeof counsel, string, string][] = [
    [counsel, `${alias} — notices`, `For formal notices on ${alias}, please keep using my address; I'll make sure they are logged.`],
    [gc, `${alias} privilege`, `Reminder: label internal emails on ${alias} "Privileged & Confidential". No action needed otherwise.`],
    [counsel, `${alias} — out of office`, 'Heads-up: I am out Thursday afternoon; I will pick up any comments the next morning.'],
    [owner, `${alias} — onboarding`, `The vendor's onboarding team reached out about a kickoff; I'm handling that on the business side. Nothing needed from legal.`],
    [gc, `${alias} matter file`, `Please keep ${alias} in the subject line so the matter system files everything correctly.`],
    [counsel, `${alias} — Word versions`, 'Happy to send Word versions of any draft if that is easier for your side.'],
    [owner, `${alias} — vendor setup`, `Procurement confirms the vendor is already set up in our systems; nothing needed for ${alias}.`],
  ];
  const offTask: [string, string, string, string][] = [
    ['news@legaltech-weekly.example', 'LegalTech Weekly', 'LegalTech Weekly: contract AI roundup', 'This week: clause libraries, e-signature adoption and AI-use restrictions.'],
    ['webinars@cle-hub.example', 'CLE Hub', 'Webinar: indemnities in SaaS deals', 'One-hour CLE webinar on indemnity carve-outs. 1.0 credit.'],
    ['it-helpdesk@acme-corp.example', 'Acme IT', 'Password expiry reminder', 'Your password expires in 7 days.'],
    ['no-reply@esign-reports.example', 'eSign Reports', 'Weekly envelope summary', 'You sent 9 envelopes this week.'],
    ['events@clo-summit.example', 'CLO Summit 2026', 'Agenda update', 'Day 2 keynote moved to 10am.'],
  ];
  if (r.chance(0.5)) {
    const [p, subject, text] = onTask[i % onTask.length];
    return { background: false, from: p.address, fromName: p.name.split(' (')[0], subject: `${subject} #${i + 1}`, body: `Hi,\n\n${text}\n\n${p.name.split(' ')[0]}` };
  }
  const [from, fromName, subject, text] = offTask[i % offTask.length];
  return { background: true, from, fromName, subject: `${subject} #${i + 1}`, body: text };
}

export const vertical = legal;
export const archetypes = [correction, unanswered_subquestion, stale_document, cold_handoff, cross_thread, partial_fulfilment, withdrawn_offer, contradiction, unauthorized_change, injection, late_evidence, competing_offers, supersession_chain];
export const module: VerticalModule = { vertical, archetypes, neutral };
export { neutral };
