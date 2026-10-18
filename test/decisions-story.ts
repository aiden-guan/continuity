// A procurement story whose state depends on human decisions as much as on email: payment-term changes
// rejected, superseded and verified by phone, a commitment approved and sent, and a card left to expire.
// Shared by the replay tests and the SQLite importer test (any backend, any org).
import { Harness } from '../src/sim/harness.ts';
import { counterparty, defaultAddresses, procurementTask, type SimEmail } from '../src/sim/scenario.ts';
import { heuristicExtractor } from '../src/extract/heuristic.ts';
import { LocalSimTransport } from '../src/transport/transport.ts';
import { Continuity } from '../src/service.ts';
import { APPROVER_SCOPES } from '../src/auth.ts';
import { setSimTime } from '../src/clock.ts';
import type { Backend, Principal } from '../src/store/backend.ts';

const a = defaultAddresses();
const supplierMail = (body: string, at: string): SimEmail => ({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 'PO-4817 terms', body, at, threadKey: 'terms' });

export async function decisionStory(backend: Backend, org: string) {
  const h = new Harness(procurementTask(a), heuristicExtractor, '2026-10-19T08:55:00Z', { backend, org });
  await h.ready;
  const service = new Continuity({ backend, extractor: heuristicExtractor, transport: new LocalSimTransport(), webhookSecret: null, ingestOrg: org });
  const human: Principal = { id: 'pr_human', org, kind: 'operator', agent_id: null, scopes: APPROVER_SCOPES, task_ids: null, label: 'Alex' };
  // a refusal must be the expected one (409 superseded, 410 expired), never some other failure
  const refused = (status: number) => [() => { throw new Error(`expected a ${status} refusal`); }, (e: { status?: number }) => { if (e.status !== status) throw e; }] as const;
  const verifyCards = async () => (await service.approvals(org, { taskId: 'PO-4817' })).filter((x) => x.kind === 'verify_change');
  try {
    // every procurement check passes
    setSimTime('2026-10-19T12:00:00Z');
    const rfq = await h.out(a.supplier, 'RFQ: 500 x AX-200 — PO-4817', 'Hi Dana, can you deliver all 500 units by Friday, Oct 23, and what is your unit price?', '2026-10-19T09:00:00Z');
    const fin = await h.out(a.finance, 'Budget approval request — PO-4817', 'Could you approve a budget of up to $11.50 per unit for PO-4817?', '2026-10-19T09:01:00Z');
    await h.in({ ...counterparty.supplierOffer(a, { messageId: rfq.messageId, subject: rfq.subject }), body: 'We can deliver 500 units Friday (Oct 23) at $11.40 each.', attachments: [] });
    await h.in(counterparty.financeApproval(a, { messageId: fin.messageId, subject: fin.subject }));

    // payment terms: the first statement applies; a change is held, and a human rejects it
    await h.in(supplierMail('Our payment terms are Net 30.', '2026-10-19T13:00:00Z'));
    await h.in(supplierMail('Update: our payment terms are now Net 10.', '2026-10-19T14:00:00Z'));
    setSimTime('2026-10-19T14:30:00Z');
    await service.decide(org, 'PO-4817', (await verifyCards())[0].id, { option: 'reject' }, human);

    // two more changes: the older card is refused as superseded, the newer one verified by phone
    await h.in(supplierMail('Correction: payment terms Net 20.', '2026-10-19T15:00:00Z'));
    const net15 = await h.in(supplierMail('Sorry — final payment terms are Net 15.', '2026-10-19T16:00:00Z'));
    setSimTime('2026-10-19T16:30:00Z');
    const [older, newer] = await verifyCards();
    await service.decide(org, 'PO-4817', older.id, { option: 'verified' }, human).then(...refused(409));
    await service.decide(org, 'PO-4817', newer.id, { option: 'verified' }, human);

    // a commitment, approved and sent
    const held = await service.send(org, 'PO-4817', { agent_id: 'agent-x', to: a.supplier, body: 'We accept your offer for PO-4817: 500 units Fri Oct 23 at $11.40 per unit.', intent: 'commit' }) as { approval_id: string };
    const approved = await service.decide(org, 'PO-4817', held.approval_id, { option: 'approve' }, human) as { sent: { event_id: string } };
    const later = await h.in(supplierMail('Thanks, order confirmed on our side.', '2026-10-19T17:00:00Z'));

    // a second commitment nobody decides in time
    const late = await service.send(org, 'PO-4817', { agent_id: 'agent-x', to: a.supplier, body: 'We also accept the extended warranty.', intent: 'commit' }) as { approval_id: string };
    setSimTime('2026-10-22T12:00:00Z');
    await service.decide(org, 'PO-4817', late.approval_id, { option: 'approve' }, human).then(...refused(410));

    await h.refresh();
    return { h, service, taskId: h.task.id, net15: net15.event.id, sent: approved.sent.event_id, later: later.event.id };
  } finally {
    setSimTime(new Date().toISOString());
  }
}
