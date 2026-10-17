// Freight vertical module: the vocabulary, all 13 archetypes, and state-neutral backlog mail.
import type { BenchCase, NeutralMail, VerticalModule } from '../../core/types.ts';
import type { Rand } from '../../core/util.ts';
import { freight } from './vertical.ts';
import { correction } from './correction.ts';
import { unansweredSubquestion } from './unanswered_subquestion.ts';
import { staleDocument } from './stale_document.ts';
import { coldHandoff } from './cold_handoff.ts';
import { crossThread } from './cross_thread.ts';
import { partialFulfilment } from './partial_fulfilment.ts';
import { withdrawnOffer } from './withdrawn_offer.ts';
import { contradiction } from './contradiction.ts';
import { unauthorizedChange } from './unauthorized_change.ts';
import { injection } from './injection.ts';
import { lateEvidence } from './late_evidence.ts';
import { competingOffers } from './competing_offers.ts';
import { supersessionChain } from './supersession_chain.ts';

/** State-neutral backlog mail for the scale transform. Derived from the case's own parties and alias. */
function neutral(c: BenchCase, i: number, r: Rand): NeutralMail {
  const dispatcher = c.task.parties.find((p) => p.label === 'carrier dispatch')!;
  const ops = c.task.parties.find((p) => p.label === 'ops')!;
  const alias = c.task.alias;
  const onTask: [typeof dispatcher, string, string][] = [
    [dispatcher, `${alias} after hours`, `If you can't reach me after 6pm on ${alias}, our night dispatch line is 555-01${String(10 + ((i * 7) % 90)).padStart(2, '0')}.`],
    [ops, `${alias} customer ref`, `Customer reference for ${alias} is SO-${100000 + ((i * 7919) % 900000)}. Please make sure it is on the BOL. No other action needed.`],
    [dispatcher, `${alias} driver gear`, 'FYI our trucks carry load locks and straps as standard.'],
    [ops, `${alias} receiving notes`, 'FYI the receiver requires drivers to check in at the guard shack with the PO and load number.'],
    [dispatcher, `${alias} contact`, "I'm out Friday afternoon; my colleague covers my board and has all the details."],
  ];
  const offTask: [string, string, string, string][] = [
    ['alerts@freightboard-pro.example', 'FreightBoard Pro', 'Hot lanes this week', 'Reefer demand is up out of the West Coast. Post your trucks now.'],
    ['news@diesel-index.example', 'Diesel Index Weekly', 'Diesel prices this week', 'On-highway diesel was flat week over week.'],
    ['it@acme-logistics.example', 'Acme IT', 'Password expiry reminder', 'Your TMS password expires in 7 days.'],
    ['events@freight-expo.example', 'Freight Expo 2026', 'Agenda update', 'The day 2 keynote moved to 10am.'],
  ];
  if (r.chance(0.5)) {
    const [p, subject, text] = onTask[i % onTask.length];
    return { background: false, from: p.address, fromName: p.name.split(' (')[0], subject: `${subject} #${i + 1}`, body: `${text}\n\n${p.name.split(' ')[0]}` };
  }
  const [from, fromName, subject, text] = offTask[i % offTask.length];
  return { background: true, from, fromName, subject: `${subject} #${i + 1}`, body: text };
}

export const vertical = freight;
export const archetypes = [
  correction, unansweredSubquestion, staleDocument, coldHandoff, crossThread, partialFulfilment, withdrawnOffer,
  contradiction, unauthorizedChange, injection, lateEvidence, competingOffers, supersessionChain,
];
export const module: VerticalModule = { vertical, archetypes, neutral };
export { neutral };
