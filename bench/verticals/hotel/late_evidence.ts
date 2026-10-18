// Archetype: late evidence (P1).
//
// The hotel's first proposal (v1) is negotiated down: a revised proposal (rev 2) lowers the rate and
// sometimes raises the attrition allowance. Afterwards an OLD copy of v1 arrives again: Acme finance
// forwards it asking whether its rate is the one to set up the master account with (golden), or the
// hotel's sales coordinator sends it "for your records" by mistake. The forwarded copy is newer in the
// inbox but older in substance (its own date line and proposal number say so).
//
// Trap: "newest message wins" and attachment-recency both resurrect v1's rate. The oracle: rev 2 values
// stay current, v1's values stay superseded, the v1 PDF is superseded and rev 2 is current; finance's
// question is an open ask on us, answered with the rev 2 rate.
import type { ActionCond, Archetype, BenchCase, BenchParty, Checkpoint, OracleLoop, OracleSuperseded } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, pdf, reaskText, sayDate, seedOf, staleText } from '../../core/util.ts';
import {
  AGENT_SIGN, addParty, approvalBody, budgetAsk, dayOf, firstName, hotel, hotelBackground, hotelChatter, hotelDayStart, hotelDeal, pct, plainName,
  proposalBody, proposalLines, rfpBody, signoff, term,
} from './vertical.ts';

export const late_evidence: Archetype = {
  id: 'late_evidence',
  title: 'Old proposal forwarded after the revision',
  capabilities: ['late_evidence', 'supersession', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('hotel', 'late_evidence', variant));
    const g = variant === 0;
    const d = hotelDeal(r, variant);
    const { self, sales, finance } = d.cast;
    const sf = firstName(sales);

    // ---- parameters
    const carrier: 'finance' | 'coordinator' = g ? 'finance' : r.pick(['finance', 'finance', 'coordinator'] as const);
    const r1 = d.rate + (g ? 20 : r.pick([10, 15, 20, 30]));
    const attritionChanged = g ? true : r.chance(0.5) && d.attrition >= 10;
    const a1 = attritionChanged ? d.attrition - 5 : d.attrition;
    const style = g ? 0 : r.int(0, 2);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 1 : r.int(0, 3);
    const v1File = `${d.hotel.short.replace(/\s+/g, '')}-Proposal-${d.proposalRef}.pdf`;
    const v2File = `${d.hotel.short.replace(/\s+/g, '')}-Proposal-${d.proposalRef}-rev2.pdf`;
    const v1Lines = proposalLines(d, { date: d.start, rate: r1, attrition: a1 });

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => hotelDayStart(d, day, hhmm);

    // ---- history
    const rfp = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(0, '09:00'), subject: `Group RFP: ${d.event} — ${d.alias}`, body: rfpBody(r, d, g) });
    const ask = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '09:05'), subject: `Budget approval — ${d.alias} hotel block`, body: budgetAsk(r, d, g) });
    const v1 = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(0, '14:10'), subject: mb.reSubject(rfp), replyTo: rfp,
      body: proposalBody(r, d, g, { rate: r1, attrition: a1 }), attachments: [pdf(v1File, v1Lines)],
    });
    hotelBackground(r, d, mb, t(0, '10:00'), nBackground);
    const approval = mb.add({ direction: 'inbound', from: finance.address, fromName: plainName(finance), to: [self.address], at: t(1, '09:20'), subject: mb.reSubject(ask), replyTo: ask, body: approvalBody(r, d, g) });
    const counter = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(1, '10:45'), subject: mb.reSubject(rfp), replyTo: v1,
      body: body(`Hi ${sf},`, attritionChanged
        ? `Thanks for the proposal. To get this approved we'd need ${moneyShort(d.rate)}/night and ${pct(d.attrition)} attrition. Can you get there?`
        : `Thanks! Is there any flexibility on the rate? ${moneyShort(d.rate)} would make this an easy yes on our side.`, AGENT_SIGN),
    });
    const v2 = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(2, '11:30'), subject: mb.reSubject(rfp), replyTo: counter,
      body: body('Hi,', [
        `Good news: revenue approved ${moneyShort(d.rate)}/night${attritionChanged ? ` and ${pct(d.attrition)} attrition` : ''}. The revised proposal (rev 2) is attached and replaces the earlier version.`,
        `We can do it! Rev 2 of the proposal is attached with the rate at ${moneyShort(d.rate)}${attritionChanged ? ` and attrition at ${pct(d.attrition)}` : ''}. Everything else is as before.`,
        `Attached is our updated proposal: ${moneyShort(d.rate)} per night${attritionChanged ? `, ${pct(d.attrition)} attrition` : ''}. Please use this version going forward.`,
      ][style], signoff(sales, d.hotel.name)),
      attachments: [pdf(v2File, proposalLines(d, { date: dayOf(d, 2), revision: 'rev 2' }))],
    });
    hotelChatter(r, d, mb, t(2, '13:00'), nChatter);

    const fwdHeader = `---------- Forwarded message ---------\nFrom: ${plainName(sales)} <${sales.address}>\nDate: ${sayDate(d.start, 'long')}\nSubject: Re: Group RFP: ${d.event} — ${d.alias}`;
    let late: string;
    let coordinator: BenchParty | null = null;
    if (carrier === 'finance') {
      late = mb.add({
        direction: 'inbound', from: finance.address, fromName: plainName(finance), to: [self.address], at: t(3, '10:05'), subject: `Fwd: Re: Group RFP: ${d.event} — ${d.alias}`,
        body: body([
          `Hi, I'm setting up the master account for ${d.alias}. Found this proposal in the shared inbox; is ${moneyShort(r1)} the rate I should use?`,
          `Before I set up the PO for ${d.alias}: the attached proposal says ${moneyShort(r1)}/night. Can you confirm that's the rate?`,
          `Is this still the right rate (${moneyShort(r1)}) for ${d.alias}? Want to get the master account right.`,
        ][style], firstName(finance), fwdHeader),
        attachments: [pdf(v1File, v1Lines)],
        note: 'older proposal forwarded after the revision',
      });
    } else {
      coordinator = { address: `groupsales@${d.hotel.domain}`, name: `Group Sales Coordinator (${d.hotel.name})`, role: 'counterparty', label: 'hotel sales coordinator', authority: [], group: 'hotel' };
      addParty(d, coordinator);
      late = mb.add({
        direction: 'inbound', from: coordinator.address, fromName: 'Group Sales Coordinator', to: [self.address], at: t(3, '10:05'), subject: `Fwd: Re: Group RFP: ${d.event} — ${d.alias}`,
        body: body('Hello,', `On behalf of ${sf}, attaching the proposal for ${d.alias} for your records.`, `Group Sales Coordinator\n${d.hotel.name}`, fwdHeader),
        attachments: [pdf(v1File, v1Lines)],
        note: 'older proposal re-sent after the revision',
      });
    }

    // ---- oracle
    const superseded: OracleSuperseded[] = [
      { party: sales.address, term: 'rate.group', value: r1, display: `${moneyShort(r1)}/night`, evidence: [v1], superseded_by: v2 },
    ];
    if (attritionChanged) superseded.push({ party: sales.address, term: 'attrition.allowance', value: a1, display: pct(a1), evidence: [v1], superseded_by: v2 });
    const openLoops: OracleLoop[] = carrier === 'finance'
      ? [{ kind: 'ask', debtor: self.address, subject: 'rate.group', display: `Finance asks which rate to use for the master account (answer: ${moneyShort(d.rate)})`, evidence: [late], critical: true }]
      : [];
    const required: ActionCond[] = carrier === 'finance'
      ? [
        { id: 'to_finance', text: 'Replies to finance', det: { type: 'message_to', party: finance.address } },
        { id: 'correct_rate', text: `Tells finance the current rate is ${moneyShort(d.rate)}/night, not the ${moneyShort(r1)} in the forwarded copy (which is the outdated original proposal)` },
      ]
      : [];
    const checkpoint: Checkpoint = {
      id: 'after_late_copy', after: late, now: t(3, '10:30'),
      state: {
        terms: [
          term(sales, 'rate.group', d.rate, [v2], true),
          term(sales, 'attrition.allowance', d.attrition, attritionChanged ? [v2] : [v1, v2], attritionChanged),
          term(sales, 'block.rooms', d.block, [v1, v2]),
          term(sales, 'cutoff.date', d.cutoff, [v1, v2]),
          term(sales, 'fnb.minimum', d.fnb, [v1, v2]),
          term(finance, 'budget.max_rate', d.cap, [approval]),
        ],
        superseded,
        open_loops: openLoops,
        closed_loops: [
          { kind: 'ask', debtor: sales.address, subject: 'rate.group', display: 'Request for a better rate (answered by rev 2)', evidence: [v2] },
          ...(attritionChanged ? [{ kind: 'ask' as const, debtor: sales.address, subject: 'attrition.allowance', display: 'Request for more attrition (answered by rev 2)', evidence: [v2] }] : []),
          { kind: 'ask', debtor: finance.address, subject: 'budget.max_rate', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [approval] },
        ],
        conflicts: [],
        documents: [
          { filename: v1File, status: 'superseded', stale_terms: [], display: `${v1File}: original proposal, replaced by rev 2 (the forwarded copy is the same old version)` },
          { filename: v2File, status: 'current', stale_terms: [], display: `${v2File}: current` },
        ],
        next_actor: 'us',
      },
      judge_facts: [
        `The current proposal is rev 2: ${moneyShort(d.rate)}/night${attritionChanged ? `, ${pct(d.attrition)} attrition` : ''}. The original proposal (${moneyShort(r1)}/night${attritionChanged ? `, ${pct(a1)} attrition` : ''}) was replaced.`,
        `The ${carrier === 'finance' ? 'proposal finance just forwarded' : "coordinator's attachment"} is a copy of the ORIGINAL proposal dated ${sayDate(d.start, 'long')}, so its values are outdated.`,
        carrier === 'finance' ? `Finance is asking which rate to use; the answer is ${moneyShort(d.rate)}/night.` : 'Nothing is owed to anyone because of the re-sent copy; the next step (asking for the contract at the rev 2 terms) is Acme\'s.',
      ].join(' '),
      action: {
        expect: carrier === 'finance' ? 'send' : 'any',
        required,
        optional: carrier === 'finance'
          ? [{ id: 'attach_rev2', text: 'Attaches, forwards or offers to send finance the revised proposal (rev 2), or says where to find it; only naming rev 2 does not count' }]
          : [{ id: 'flag_old_copy', text: 'Tells the hotel that the copy sent is the outdated original and that rev 2 is the current proposal' }],
        prohibited: [
          { id: 'stale_rate', text: staleText(`Treats ${moneyShort(r1)}/night (from the old copy) as the current rate`), stale: true },
          ...(attritionChanged ? [{ id: 'stale_attrition', text: staleText(`Treats ${pct(a1)} attrition as current`), stale: true }] : []),
          { id: 'reask_rate', text: reaskText(`Asks the hotel to confirm the rate again (rev 2's ${moneyShort(d.rate)}/night is settled; asking the hotel to send rev 2 or to correct its own records is fine)`) },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return {
      id: `hotel/late_evidence/${variant}`,
      vertical: 'hotel',
      archetype: 'late_evidence',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: late_evidence.capabilities,
      description: `Rev 2 sets ${moneyShort(d.rate)} (from ${moneyShort(r1)}); the original proposal is forwarded afterwards by ${carrier}.`,
      task: d.task,
      events: mb.sorted(),
      trigger: late,
      checkpoints: [checkpoint],
      params: { carrier, r1, rate: d.rate, attritionChanged, a1, style, nBackground, nChatter },
    };
  },
};

export { hotel };
