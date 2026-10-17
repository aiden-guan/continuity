// The 42 Elm St story, in-process (tests and the portfolio generator). Our agent's emails are written
// by the offline policy agent from compiled state, exactly as in the demo. Ported from samrocksnature's
// b615ab7. (The forged-sender and wire-fraud beats are in scripts/demo-deal.ts and the tests; the story
// stays clean because the portfolio generator replays it many times.)
import type { Harness } from './harness.ts';
import { policyDecide, type Decision } from '../agent/policy.ts';
import { setSimTime } from '../clock.ts';
import { dealParties as P, type DealAddresses, type Ref } from './real-estate.ts';
import type { SentRecord } from './mailbox.ts';

export interface StoryState { sent: Map<string, SentRecord>; decisions: Record<string, Decision> }

export const newStory = (): StoryState => ({ sent: new Map(), decisions: {} });

/** One agent wake: decide from compiled state, send each message (threaded on the last mail to or from that party). */
export async function agentTurn(h: Harness, s: StoryState, agentId: string, at: string): Promise<Decision> {
  setSimTime(at);
  const d = policyDecide(h.context(agentId));
  for (const m of d.messages) {
    const prev = s.sent.get(m.to);
    const lastIn = [...h.store.eventsForTask(h.task.id)].reverse().find((e) => e.direction === 'inbound' && e.from === m.to);
    const parent = prev ?? (lastIn?.message_id ? { messageId: lastIn.message_id, subject: lastIn.subject, references: lastIn.references } : null);
    const subject = m.subject ?? (parent ? (/^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`) : h.task.alias);
    s.sent.set(m.to, await h.out(m.to, subject, m.body, at, parent ? { messageId: parent.messageId, references: parent.references } : null));
  }
  s.decisions[agentId] = d;
  return d;
}

/** Threading for a party's next email: a reply to the last thing we sent them. */
export function refTo(s: StoryState, to: string, fallbackSubject = 'ELM-42'): Ref {
  const r = s.sent.get(to);
  return { messageId: r?.messageId ?? null, subject: r?.subject ?? fallbackSubject, references: r?.references ?? [] };
}

/** Runs the story up to Agent B's wake (`'before-b'`), through Agent B (`'after-b'`), or to the end. */
export async function runElmStreet(h: Harness, a: DealAddresses, until: 'before-b' | 'after-b' | 'end' = 'end'): Promise<StoryState> {
  await h.ready;
  const s = newStory();
  await agentTurn(h, s, 'agent-a', '2026-10-19T09:00:00Z');
  await h.in(P.listingCounter(a, refTo(s, a.listing)));
  await agentTurn(h, s, 'agent-a', '2026-10-20T10:10:00Z');
  await h.in(P.buyerApproval(a, refTo(s, a.buyer)));
  await h.in(P.inspectorBooking(a));
  await h.in(P.lenderAppraisal(a, refTo(s, a.lender)));
  await h.in(P.listingCorrection(a, refTo(s, a.listing)));
  setSimTime('2026-10-27T09:00:00Z');
  if (until === 'before-b') return s;
  await agentTurn(h, s, 'agent-b', '2026-10-27T09:05:00Z');
  if (until === 'after-b') return s;
  const toListing = s.sent.get(a.listing)!;
  await h.in(P.listingResolution(a, refTo(s, a.listing), toListing.body));
  await h.in(P.inspectorReport(a, s.sent.has(a.inspector) ? refTo(s, a.inspector) : { messageId: null, subject: 'Inspection booked: 42 Elm St (ELM-42)' }));
  await agentTurn(h, s, 'agent-c', '2026-10-28T14:05:00Z');
  return s;
}
