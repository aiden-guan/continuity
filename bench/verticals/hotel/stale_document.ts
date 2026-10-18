// Archetype: stale document (P0).
//
// The hotel issues the group contract PDF (rate, nightly block, attrition, cutoff, F&B minimum, meeting
// rental, comps, deposit, cancellation). A later email changes exactly one or two of its terms, either
// because we asked (attrition / cutoff) or because the hotel changed its own terms (deposit, F&B
// minimum), and says everything else in the contract stands. Either an amended contract is promised,
// or the hotel says to sign the contract as issued.
//
// Trap: per-term document validity. Marking the whole contract current (and signing it as issued) binds
// Acme to a dead term; marking it obsolete throws away the eight terms that still hold. The oracle: the
// contract is partially stale on exactly the changed keys, the changed values are current from the email,
// the old values are superseded, a declined request leaves its term unchanged, and signing the contract
// as issued is a stale violation. An expert planner gets the change written into the contract (amended
// contract or signed addendum) before signing.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleLoop, OracleSuperseded } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, nextWeekday, pdf, reaskText, sayDate, seedOf, staleText } from '../../core/util.ts';
import {
  AGENT_SIGN, TERM_LABEL, daysBefore, firstName, hotel, hotelBackground, hotelChatter, hotelDayStart, hotelDeal, dayOf, pct, plainName, show,
  signoff, term, violation, contractLines,
} from './vertical.ts';

type Changed = 'attrition.allowance' | 'cutoff.date' | 'deposit.due' | 'deposit.amount' | 'fnb.minimum';

export const stale_document: Archetype = {
  id: 'stale_document',
  title: 'Email changes one or two terms of the contract',
  capabilities: ['document_validity', 'supersession'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('hotel', 'stale_document', variant));
    const g = variant === 0;
    const d = hotelDeal(r, variant);
    const { self, sales } = d.cast;
    const sf = firstName(sales);

    // ---- parameters
    const mode: 'requested' | 'hotel' = g ? 'requested' : r.pick(['requested', 'hotel'] as const);
    const promise: 'amended' | 'sign_as_is' = g ? 'sign_as_is' : r.pick(['amended', 'sign_as_is'] as const);
    const newCutoffDays = d.cutoffDays > 21 ? 21 : 14;
    const proposed: Record<Changed, unknown> = {
      'attrition.allowance': d.attrition + 5,
      'cutoff.date': addDays(d.arrival, -newCutoffDays),
      'deposit.due': addDays(d.depositDue, -7),
      'deposit.amount': Math.round((d.deposit * 1.5) / 500) * 500,
      'fnb.minimum': d.fnb + (g ? 5000 : Math.max(1500, Math.round((d.fnb * r.pick([0.1, 0.2, 0.3])) / 500) * 500)),
    };
    const old: Record<Changed, unknown> = { 'attrition.allowance': d.attrition, 'cutoff.date': d.cutoff, 'deposit.due': d.depositDue, 'deposit.amount': d.deposit, 'fnb.minimum': d.fnb };
    let requested: Changed[] = [];
    let changed: Changed[];
    let declined: Changed[] = [];
    if (mode === 'requested') {
      requested = ['attrition.allowance', 'cutoff.date'];
      const outcome = g ? 'cutoff_only' : r.pick(['both', 'cutoff_only', 'attrition_only'] as const);
      changed = outcome === 'both' ? requested : outcome === 'cutoff_only' ? ['cutoff.date'] : ['attrition.allowance'];
      declined = requested.filter((k) => !changed.includes(k));
    } else {
      changed = r.pick([['deposit.due'], ['fnb.minimum'], ['deposit.amount', 'deposit.due'], ['fnb.minimum', 'deposit.due']] as Changed[][]);
    }
    const nBackground = g ? 2 : r.int(2, 8);
    const nChatter = g ? 1 : r.int(0, 4);
    const contractFile = `${d.hotel.short.replace(/\s+/g, '')}-Group-Contract-${d.contractRef}.pdf`;
    const style = g ? 0 : r.int(0, 2);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => hotelDayStart(d, day, hhmm);

    // ---- history
    const req = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(0, '09:20'),
      subject: `Contract request — ${d.event} (${d.alias})`,
      body: body(`Hi ${sf},`, g
        ? `Thanks for the call on Friday. We'd like to move forward with ${d.hotel.short} for ${d.event}. Could you send the group contract?`
        : r.pick([
          `We're ready to move ahead with ${d.hotel.short} for ${d.alias}. Please send over the group contract when you can.`,
          `Great speaking with you. Could you draft the group contract for ${d.event} based on the proposal we discussed?`,
          `Next step on our side is legal review, so could you send the contract for ${d.alias}?`,
        ]), AGENT_SIGN),
    });
    const contract = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(0, '16:05'),
      subject: mb.reSubject(req), replyTo: req,
      body: body('Hi,', g
        ? `Wonderful news! The group contract for ${d.event} is attached. Please review, sign and return; the deposit schedule and wire details are in section 8.`
        : r.pick([
          `Attached is the group sales agreement for ${d.alias}. Let me know if you have any questions.`,
          `Here's the contract for ${d.event}. Everything we discussed is in there, including the deposit schedule.`,
          `Please find the contract attached for your review and signature.`,
        ]), signoff(sales, d.hotel.name)),
      attachments: [pdf(contractFile, contractLines(d, { date: d.start }))],
    });
    hotelBackground(r, d, mb, t(0, '11:00'), nBackground);
    hotelChatter(r, d, mb, t(1, '09:30'), nChatter);

    let ask: string | null = null;
    if (mode === 'requested') {
      ask = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(1, '14:00'),
        subject: mb.reSubject(req), replyTo: contract,
        body: body(`Hi ${sf},`, [
          `Legal has reviewed the contract. Two requests: could you raise attrition to ${pct(proposed['attrition.allowance'] as number)}, and move the cutoff to ${sayDate(proposed['cutoff.date'] as string, 'long')} (${newCutoffDays} days out)?`,
          `We're close. Two asks before signing: ${pct(proposed['attrition.allowance'] as number)} attrition instead of ${pct(d.attrition)}, and a cutoff of ${newCutoffDays} days (${sayDate(proposed['cutoff.date'] as string, 'month_day')}) instead of ${d.cutoffDays}.`,
          `Could revenue approve two changes: attrition at ${pct(proposed['attrition.allowance'] as number)}, and cutoff pushed to ${sayDate(proposed['cutoff.date'] as string, 'weekday_long')}?`,
        ][style], AGENT_SIGN),
      });
    }

    const changeDay = dayOf(d, 2);
    const say = (k: Changed): string => {
      const v = proposed[k];
      switch (k) {
        case 'attrition.allowance': return [`Revenue approved ${pct(v as number)} attrition.`, `We can do ${pct(v as number)} attrition.`, `Attrition goes to ${pct(v as number)}.`][style];
        case 'cutoff.date': return [`The cutoff moves to ${sayDate(v as string, 'long')}.`, `We can push the cutoff to ${sayDate(v as string, 'month_day')} (${daysBefore(d, v as string)} days prior).`, `Cutoff is now ${sayDate(v as string, 'weekday_long')}.`][style];
        case 'deposit.due': return [`Our finance team now requires the deposit by ${sayDate(v as string, 'long')} (a week earlier than the contract says).`, `The deposit due date has to move up to ${sayDate(v as string, 'month_day')}.`, `Please note the deposit is now due ${sayDate(v as string, 'weekday_long')}.`][style];
        case 'deposit.amount': return [`The deposit increases to ${moneyShort(v as number)} under our updated group policy.`, `Deposit amount is now ${moneyShort(v as number)}.`, `We need a ${moneyShort(v as number)} deposit rather than ${moneyShort(d.deposit)}.`][style];
        case 'fnb.minimum': return [`Because our 2027 banquet pricing went up, the F&B minimum is now ${moneyShort(v as number)}.`, `The F&B minimum has to go to ${moneyShort(v as number)} (2027 menu pricing).`, `F&B minimum is revised to ${moneyShort(v as number)}.`][style];
      }
    };
    const declineText = declined.map((k) => k === 'attrition.allowance'
      ? `I couldn't get the attrition changed; it stays at ${pct(d.attrition)}.`
      : `The cutoff has to stay at ${sayDate(d.cutoff, 'month_day')}, unfortunately.`).join(' ');
    const amendDay = nextWeekday(changeDay, 5);
    const closing = promise === 'amended'
      ? r.pick([`I'll send an amended contract (rev 2) by ${sayDate(amendDay, 'weekday')}.`, `I'll reissue the contract with the change${changed.length > 1 ? 's' : ''} by ${sayDate(amendDay, 'weekday')}.`, `An amended agreement will follow by ${sayDate(amendDay, 'weekday')}.`])
      : g ? 'You can go ahead and sign the contract as issued; this email confirms the change.' : r.pick(['Feel free to sign the contract as issued; consider this email our confirmation of the change.', 'No need to wait for a new version, just sign what you have and we will honor this email.', 'You can sign the current contract; this email is our agreement on the change.']);
    const change = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(2, '11:25'),
      subject: mb.reSubject(req), replyTo: ask ?? contract,
      body: body(
        g ? `Hi there,` : 'Hi,',
        mode === 'requested' ? `Good news on your requests. ${changed.map(say).join(' ')}${declineText ? ` ${declineText}` : ''}` : `One update on the contract before you sign. ${changed.map(say).join(' ')}`,
        `Everything else in the contract stands. ${closing}`,
        g ? `Thanks,\n${sf}` : signoff(sales, d.hotel.name),
      ),
    });

    // ---- oracle
    const value = (k: string, fallback: unknown) => (changed.includes(k as Changed) ? proposed[k as Changed] : fallback);
    const ev = (k: string) => (changed.includes(k as Changed) ? [change] : declined.includes(k as Changed) ? [contract, change] : [contract]);
    const contractTerms: [string, unknown][] = [
      ['rate.group', d.rate], ['block.rooms', d.block], ['attrition.allowance', d.attrition], ['cutoff.date', d.cutoff], ['fnb.minimum', d.fnb],
      ['meeting.room_rental', d.meeting], ['deposit.amount', d.deposit], ['deposit.due', d.depositDue], ['concession.comp_ratio', d.comp],
    ];
    const superseded: OracleSuperseded[] = changed.map((k) => ({ party: sales.address, term: k, value: old[k], display: show(k, old[k]), evidence: [contract], superseded_by: change }));
    const conflicts: OracleConflict[] = changed
      .map((k) => [k, violation(d, k, proposed[k])] as const)
      .filter(([, v]) => v)
      .map(([k, v]) => ({ kind: 'requirement_violation', term: k, party: sales.address, display: v!, critical: true }));
    const openLoops: OracleLoop[] = promise === 'amended'
      ? [{ kind: 'commitment', debtor: sales.address, subject: 'document.contract', display: 'Hotel owes an amended contract (rev 2) with the change', evidence: [change], critical: true }]
      // the hotel explicitly asks us to sign; that ask stays open until the change is papered and we sign
      : [{ kind: 'ask', debtor: self.address, subject: 'decision.contract', alt_subjects: ['document.contract'], display: 'Hotel is waiting for Acme to sign the contract', evidence: [change] }];
    const closedLoops: OracleLoop[] = [
      { kind: 'ask', debtor: sales.address, subject: 'document.contract', display: 'Group contract (received)', evidence: [contract] },
      ...requested.map((k): OracleLoop => ({ kind: 'ask', debtor: sales.address, subject: k, display: `Request to change the ${TERM_LABEL[k]} (${changed.includes(k) ? 'agreed' : 'declined'})`, evidence: [change] })),
    ];
    const nextActor = conflicts.length || promise === 'sign_as_is' ? 'us' : 'them';
    const changeList = changed.map((k) => `${TERM_LABEL[k]} ${show(k, proposed[k])} (was ${show(k, old[k])})`).join(' and ');
    const required: ActionCond[] = [];
    if (nextActor === 'us') required.push({ id: 'to_sales', text: 'Sends a message to the hotel sales manager', det: { type: 'message_to', party: sales.address } });
    for (const c of conflicts) required.push({ id: `push_${c.term.split('.')[0]}`, text: `Pushes back on the changed ${TERM_LABEL[c.term]}: ${c.display}` });
    if (promise === 'sign_as_is' && !conflicts.length) required.push({ id: 'paper_change', text: `Asks for the change (${changeList}) to be written into the contract, as an amended contract or a signed addendum, before signing` });

    const checkpoint: Checkpoint = {
      id: 'after_change', after: change, now: t(2, '11:45'),
      state: {
        terms: contractTerms.map(([k, v]) => term(sales, k, value(k, v), ev(k), changed.includes(k as Changed) || k === 'rate.group' || k === 'block.rooms')),
        superseded,
        open_loops: openLoops,
        closed_loops: closedLoops,
        conflicts,
        documents: [
          { filename: contractFile, status: 'partially_stale', stale_terms: [...changed], display: `${contractFile}: ${changed.map((k) => TERM_LABEL[k]).join(' and ')} superseded by email; every other term still current` },
        ],
        next_actor: nextActor,
      },
      judge_facts: [
        `The hotel's contract ${contractFile} is still valid except for: ${changeList}, changed by the hotel's later email.`,
        declined.length ? `Acme's request to change the ${declined.map((k) => TERM_LABEL[k]).join(' and ')} was declined; it stays at ${declined.map((k) => show(k, old[k])).join(', ')}.` : '',
        `Unchanged: rate ${moneyShort(d.rate)}/night, the room block, ${changed.includes('fnb.minimum') ? '' : `F&B minimum ${moneyShort(d.fnb)}, `}meeting rental ${moneyShort(d.meeting)}.`,
        conflicts.length ? `Requirement problems: ${conflicts.map((c) => c.display).join('; ')}.` : 'All current terms meet Acme requirements.',
        promise === 'amended' ? 'The hotel promised an amended contract, which has NOT arrived yet.' : 'The hotel said to sign the contract as issued; the issued PDF still shows the old value(s).',
      ].filter(Boolean).join(' '),
      action: {
        expect: nextActor === 'us' ? 'send' : 'any',
        required,
        optional: [{ id: 'ack_change', text: 'Acknowledges the change and confirms the rest of the contract is understood to stand' }],
        prohibited: [
          { id: 'sign_stale', text: staleText('Signs or accepts the contract as issued (which still shows the old value)'), det: { type: 'binding_to', party: sales.address }, stale: true },
          { id: 'stale_value', text: staleText(`Treats the old ${changed.map((k) => `${TERM_LABEL[k]} (${show(k, old[k])})`).join(' / ')} as still in force`), stale: true },
          { id: 'whole_contract_doubt', text: reaskText('Asks the hotel to state, confirm or resend again terms that did not change (rate, block, meeting rental)', true) },
          ...(promise === 'amended' ? [{ id: 'claims_amended', text: 'Says or implies the amended contract has already been received' }] : []),
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return {
      id: `hotel/stale_document/${variant}`,
      vertical: 'hotel',
      archetype: 'stale_document',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: stale_document.capabilities,
      description: `Contract issued; a later email changes ${changed.join(' + ')} (${mode}); ${promise === 'amended' ? 'amended contract promised' : 'hotel says sign as issued'}.`,
      task: d.task,
      events: mb.sorted(),
      trigger: change,
      checkpoints: [checkpoint],
      params: { mode, promise, changed, declined, proposed, nBackground, nChatter, style },
    };
  },
};

export { hotel };
