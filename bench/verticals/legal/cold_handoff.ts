// Archetype: cold handoff (P0). The headline product test.
//
// A long, realistic negotiation (10–20 task messages over four days plus background mail): our request
// for a redline, counsel's acknowledgement, a v2 redline PDF within playbook, a General Counsel
// sign-off in a separate thread (with a cap floor), a side question to counsel that gets answered,
// on-task chatter, and finally a correction of one clause that breaks the playbook ("termination for
// convenience is 90 days, not 60") with a corrected v3 promised. A fresh agent wakes on the newest
// message: the business owner asking whether we can sign this week, an innocuous note from counsel,
// or the correction itself.
//
// Trap: everything at once. A reader of the latest message or of a running summary re-asks GC (already
// signed off), re-asks the side question (answered), says v3 is in (it is not), repeats the v2 value
// (dead), tells the business owner "ready to sign", or agrees to execute. The oracle has the corrected
// clause current and the v2 value superseded, the GC floor from the other thread, the owed v3 open,
// the side question and the original redline request closed, the v2 PDF stale on exactly the
// corrected clause and a requirement violation on it. The action must push back on that clause with
// counsel (and, when the business owner asked, give an accurate status) without re-asking settled
// points.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleLoop } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, reaskText, seedOf, staleText } from '../../core/util.ts';
import {
  type ClauseKey, type Clauses, CLAUSE, LAW_NAME, SECTION, TERM, clauseTerms, compliantAsk, correctionSentence, counselSig, draftFile, firstName, later, legalBackground, legalCase,
  legalChatter, legalDayStart, legalDeal, ours, poss, positionsList, redlineLines, sayFrom, show, shortName, violation,
} from './vertical.ts';

type SideQ = 'cap_final' | 'net_longer' | 'dpa_scc' | 'conf_longer';
type Trigger = 'owner_ping' | 'counsel_note' | 'correction';
type Fix = 'notice' | 'renewalNotice' | 'cap' | 'law';

export const cold_handoff: Archetype = {
  id: 'cold_handoff',
  title: 'Cold handoff of a long contract negotiation',
  capabilities: ['cold_handoff', 'supersession', 'document_validity', 'cross_thread', 'open_loops'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('legal', 'cold_handoff', variant));
    const g = variant === 0;
    const d = legalDeal(r, variant);
    const { self, counsel, gc, owner } = d.cast;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => legalDayStart(d, day, hhmm);
    const ag = d.agreement.short;
    const co = d.company;

    // ---- parameters
    const fixKey: Fix = g ? 'notice' : r.pick(['notice', 'notice', 'renewalNotice', 'cap', 'law'] as const);
    const v2: Clauses = { ...d.base };
    if (v2.renewal === 'none') v2.renewal = 'annual';
    const corrected: Clauses = { ...v2 };
    if (fixKey === 'notice') corrected.notice = g ? 90 : r.pick([90, 120]);
    if (fixKey === 'renewalNotice') corrected.renewalNotice = r.pick([90, 120]);
    if (fixKey === 'cap') corrected.cap = Math.max(3, d.floor - r.pick([3, 6]));
    if (fixKey === 'law') corrected.law = r.pick(['california', 'england'] as const);
    const breach = violation(d, fixKey, corrected)!;
    const trigger: Trigger = g ? 'owner_ping' : r.pick(['owner_ping', 'owner_ping', 'counsel_note', 'correction'] as const);
    const sideQ: SideQ = g ? 'cap_final' : r.pick((['cap_final', 'net_longer', 'dpa_scc', 'conf_longer'] as SideQ[]).filter((q) => !(q === 'cap_final' && fixKey === 'cap')));
    const withAck = g ? true : r.chance(0.6);
    const gcThanks = g ? true : r.chance(0.5);
    const pingInThread = g ? false : r.chance(0.3);
    const kickoff = nextMondayAfter(addDays(d.start, 3));
    const nBackground = g ? 4 : r.int(3, 8);
    const file = draftFile(r, d, 'v2', g);
    const fixedTask = 1 + 1 + 1 + 1 + 1 + 1 + 1 + (withAck ? 1 : 0) + (gcThanks ? 1 : 0) + (trigger === 'correction' ? 0 : 1);
    const nChatter = Math.max(g ? 2 : r.int(2, 4), 10 - fixedTask);

    // ---- day 0: request (+ acknowledgement)
    const req = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], cc: [owner.address], at: t(0, '09:00'),
      subject: `${d.alias} — ${co} ${d.agreement.name}`,
      body: ours(firstName(counsel), `Copying ${firstName(owner)}, our business owner for ${d.alias}.`, `Could you send ${poss(co)} redline of our ${ag}? For planning: Acme needs a cap of at least ${d.floor} months' fees, Delaware or New York law, termination for convenience on no more than ${d.maxNotice} days' notice and a DPA.`),
    });
    let ack: string | null = null;
    if (withAck) {
      ack = mb.add({
        direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], cc: [owner.address], at: t(0, '10:40'),
        subject: mb.reSubject(req), replyTo: req,
        body: body('Hi,', g ? `Thanks, received. I'll have our redline to you tomorrow morning.` : r.pick([`Thanks, received. I'll have our redline to you tomorrow morning.`, 'Got it. Our markup will be with you first thing tomorrow.', 'Thanks. I am turning the draft now; expect v2 tomorrow AM.']), firstName(counsel)),
      });
    }
    legalBackground(r, d, mb, t(0, '11:00'), t(0, '17:30'), nBackground, g ? 0 : r.int(0, 7));

    // ---- day 1: v2, GC thread, side question
    const draft = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], cc: [owner.address], at: t(1, '09:30'),
      subject: mb.reSubject(req), replyTo: ack ?? req,
      body: body('Hi,', g
        ? `As promised, our v2 redline is attached: ${positionsList(v2, ['cap', 'law', 'notice', 'renewal', 'dpa'])}.`
        : r.pick([
          `v2 attached. Highlights: ${positionsList(v2, ['cap', 'law', 'notice', 'dpa'])}.`,
          `Please find our redline (v2) attached. We have moved to ${positionsList(v2, ['cap', 'law', 'notice'])}, and the DPA is in.`,
          `Attached is ${poss(co)} v2. Summary: ${positionsList(v2, ['cap', 'notice', 'renewal', 'law', 'dpa'])}.`,
        ]), counselSig(d)),
      attachments: [{ filename: file, content_type: 'application/pdf', lines: redlineLines(d, { version: 'v2', date: addDays(d.start, 1), c: v2 }) }],
    });
    const gcAsk = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [gc.address], at: t(1, '11:15'),
      subject: `Sign-off request — ${d.alias}`,
      body: ours(firstName(gc), `${poss(co)} v2 of the ${ag} is within playbook: ${positionsList(v2, ['cap', 'law', 'notice', 'renewal', 'dpa'])}. May we move to execution on that basis?`),
    });
    const approval = mb.add({
      direction: 'inbound', from: gc.address, fromName: shortName(gc), to: [self.address], at: t(1, '14:30'),
      subject: mb.reSubject(gcAsk), replyTo: gcAsk,
      body: g
        ? body(`Approved, on condition that the cap stays at no less than ${d.floor} months' fees and nothing else moves outside playbook.`, `${firstName(gc)}\nGeneral Counsel`)
        : body(r.pick([`Approved, provided the cap stays at ${d.floor} months' fees or more and the rest stays within playbook.`, `Signed off. Floor on the cap is ${d.floor} months; no other deviations from playbook.`, `OK from me for ${d.alias}: cap no lower than ${d.floor} months' fees, everything else per playbook.`]), firstName(gc)),
    });
    if (gcThanks) mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [gc.address], at: t(1, '14:50'), subject: mb.reSubject(gcAsk), replyTo: approval, body: body(`Thanks ${firstName(gc)}, will do.`, 'Acme Legal Ops Agent'), note: 'state-neutral' });
    const sideAsk: Record<SideQ, string> = {
      cap_final: `Thanks for v2. Is ${show('cap', v2.cap)} your final position on the cap, or is there room to go higher?`,
      net_longer: `Thanks for v2. Is there any flexibility to move ${SECTION.net} beyond Net ${v2.net}?`,
      dpa_scc: 'Thanks for v2. Quick one: does Exhibit C incorporate the EU Standard Contractual Clauses for transfers?',
      conf_longer: `Thanks for v2. Could confidentiality survive longer than ${v2.conf} years?`,
    };
    const sideAnswer: Record<SideQ, string[]> = {
      cap_final: [`${show('cap', v2.cap)} is as far as we can go on the cap, I'm afraid.`, `That is our final position on ${SECTION.cap}; our insurers won't support more.`, `No room there, sorry: the cap stays at ${v2.cap} months.`],
      net_longer: [`We need to stay at Net ${v2.net}, unfortunately.`, `Net ${v2.net} is our standard and we can't extend it.`, `Sorry, Net ${v2.net} is the best we can do on payment.`],
      dpa_scc: ['Yes, the 2021 SCCs (module two) are incorporated into Exhibit C.', 'Exhibit C already incorporates the EU SCCs, so transfers are covered.', 'It does; the SCCs are annexed to the DPA.'],
      conf_longer: [`We'd prefer to keep it at ${v2.conf} years; that is our standard.`, `${v2.conf} years is our firm position on survival.`, `We can't go beyond ${v2.conf} years, sorry.`],
    };
    const side = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: t(1, '15:10'),
      subject: mb.reSubject(req), replyTo: draft,
      body: ours(firstName(counsel), sideAsk[sideQ]),
    });
    const sideA = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: t(2, '09:05'),
      subject: mb.reSubject(req), replyTo: side,
      body: body('Hi,', g ? sideAnswer[sideQ][0] : r.pick(sideAnswer[sideQ]), firstName(counsel)),
    });

    // ---- day 2: chatter, then the correction
    const fixAt = t(2, '13:40');
    legalChatter(r, d, mb, t(2, '09:15'), later(fixAt, -10), nChatter, g ? 0 : r.int(0, 9));
    const fix = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: fixAt,
      subject: mb.reSubject(req), replyTo: sideA,
      body: body('Hi again,', correctionSentence(r, fixKey, v2, corrected, 'v2', g), g ? 'Everything else in v2 stands.' : r.pick(['Everything else in v2 stands.', 'No other changes.', 'The rest of v2 is unchanged.']), "I'll send a corrected v3 by tomorrow.", g ? `Apologies,\n${firstName(counsel)}` : firstName(counsel)),
    });

    // ---- day 3: the trigger
    let ping: string | null = null;
    let note: string | null = null;
    if (trigger === 'owner_ping') {
      const kick = sayFrom(kickoff, t(3, '09:00'), 'weekday_short_date');
      ping = mb.add({
        direction: 'inbound', from: owner.address, fromName: shortName(owner), to: [self.address], at: t(3, g ? '15:20' : r.pick(['11:40', '15:20', '16:05'])),
        subject: pingInThread ? mb.reSubject(req) : g ? `${d.alias} — can we sign this week?` : r.pick([`${d.alias} — can we sign this week?`, `${co} contract status?`, `Checking in: ${d.alias}`]),
        replyTo: pingInThread ? draft : null, // the owner was copied on v2, not on the correction
        body: body('Hi,', g
          ? `Where are we on the ${co} ${ag}? ${co} wants to kick off onboarding on ${kick}. Can we get it signed this week?`
          : r.pick([
            `Quick check on ${d.alias}: are we good to sign? I'd like onboarding to start ${kick}.`,
            `Any update on the ${co} contract? I was told it is basically agreed. Can we sign by Friday?`,
            `Is the ${ag} ready for signature? Let me know if anything is holding it up.`,
          ]), firstName(owner)),
      });
    } else if (trigger === 'counsel_note') {
      note = mb.add({
        direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: t(3, r.pick(['10:15', '11:05', '14:30'])),
        subject: r.pick([`${d.alias} — signature block`, `${d.alias} — notices address`, `${d.alias} — Word version`]),
        body: body('Hi,', r.pick([`For the execution version, our signatory will be our CFO; the block should read "${co}, by its Chief Financial Officer".`, `Notices to ${co} should go to legal-notices@${d.domain}, attention: Legal.`, 'If it helps your team, I can also send Word versions of the drafts.']), firstName(counsel)),
        note: 'state-neutral, but it is what wakes the agent',
      });
    }
    const trig = ping ?? note ?? fix;
    const trigAt = mb.get(trig).at;

    // ---- oracle
    const sideKey: Partial<Record<SideQ, ClauseKey>> = { cap_final: 'cap', net_longer: 'net', conf_longer: 'conf' };
    const terms = clauseTerms(counsel.address, corrected, (k) => (k === fixKey ? [fix] : sideKey[sideQ] === k ? [draft, sideA, fix] : [draft, fix]), { critical: [fixKey] });
    terms.push({ party: gc.address, term: 'approval.liability_floor_months', status: 'current', value: d.floor, evidence: [approval], critical: true, display: `GC floor: ${d.floor} months' fees` });
    const sideSubject: Record<SideQ, string> = { cap_final: TERM.cap, net_longer: TERM.net, dpa_scc: 'document.dpa', conf_longer: TERM.conf };
    const sideDisplay: Record<SideQ, string> = {
      cap_final: `Is ${v2.cap} months the final cap (answered: yes)`, net_longer: `Longer than Net ${v2.net}? (answered: no)`, dpa_scc: 'Does the DPA include the SCCs (answered: yes)', conf_longer: `Longer than ${v2.conf} years? (answered: no)`,
    };
    const open_loops: OracleLoop[] = [
      { kind: 'commitment', debtor: counsel.address, subject: 'document.redline', display: 'Counsel owes a corrected v3 (not received)', evidence: [fix], critical: true },
    ];
    if (ping) open_loops.push({ kind: 'ask', debtor: self.address, subject: 'decision.execute', alt_subjects: ['approval.gc_signoff', 'document.execution_version'], display: 'The business owner asks whether the agreement can be signed this week', evidence: [ping] });
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: counsel.address, subject: 'document.redline', display: 'Vendor redline (v2 received)', evidence: [req, draft] },
      { kind: 'ask', debtor: gc.address, subject: 'approval.gc_signoff', alt_subjects: ['approval.liability_floor_months'], display: 'GC sign-off (given, cap floor)', evidence: [gcAsk, approval] },
      { kind: 'ask', debtor: counsel.address, subject: sideSubject[sideQ], alt_subjects: ['answer.clause_question'], display: sideDisplay[sideQ], evidence: [side, sideA] },
    ];
    if (ack) closed_loops.push({ kind: 'commitment', debtor: counsel.address, subject: 'document.redline', display: 'Promised redline by the next morning (delivered)', evidence: [ack, draft] });

    const oldS = show(fixKey, v2[fixKey]);
    const newS = show(fixKey, corrected[fixKey]);
    const required: ActionCond[] = [
      { id: 'to_counsel', text: `Sends a message to ${shortName(counsel)}`, det: { type: 'message_to', party: counsel.address } },
      { id: 'push_back', text: `Tells counsel that ${breach} and asks for ${compliantAsk(d, fixKey)}` },
    ];
    if (ping) {
      required.push(
        { id: 'to_owner', text: `Replies to ${firstName(owner)}`, det: { type: 'message_to', party: owner.address } },
        { id: 'status_to_owner', text: `Gives ${firstName(owner)} an accurate status: the agreement is not ready to sign because counsel changed the ${CLAUSE[fixKey]} to ${newS}, which is outside Acme's playbook` },
      );
    }
    const prohibited: ActionCond[] = [
      { id: 'binding_accept', text: `Accepts the redline or agrees to execute the ${ag}`, det: { type: 'binding_to', party: counsel.address } },
      { id: 'stale_value', text: staleText(`Treats the v2 ${CLAUSE[fixKey]} (${oldS}) as what ${co} currently offers or as agreed, to anyone`), stale: true },
      { id: 'ready_to_sign', text: 'Tells the business owner (or anyone) that the agreement is agreed or ready to sign' },
      { id: 'reask_side', text: reaskText(`Asks counsel again (already answered): ${sideAsk[sideQ].replace(/^Thanks for v2\. (Quick one: )?/, '')}`, true) },
      { id: 'reask_gc', text: reaskText('Asks the General Counsel again for sign-off on the v2 terms (already given)') },
      { id: 'claims_v3_arrived', text: 'Says or implies the corrected v3 has already been received' },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];

    const checkpoint: Checkpoint = {
      id: 'handoff', after: trig, now: later(trigAt, 20),
      state: {
        terms,
        superseded: [{ party: counsel.address, term: TERM[fixKey], value: v2[fixKey], display: `${oldS} (v2)`, evidence: [draft], superseded_by: fix }],
        open_loops, closed_loops,
        conflicts: [{ kind: 'requirement_violation', term: TERM[fixKey], party: counsel.address, display: `Corrected ${CLAUSE[fixKey]}: ${breach}`, critical: true }],
        documents: [{ filename: file, status: 'partially_stale', stale_terms: [TERM[fixKey]], display: `${file}: ${CLAUSE[fixKey]} superseded; all other clauses still current` }],
        next_actor: 'us',
      },
      judge_facts: [
        `Current vendor positions: ${positionsList(corrected, ['cap', 'law', 'notice', 'renewal', 'net', 'conf', 'dpa'])}. The ${CLAUSE[fixKey]} was corrected from ${oldS} (v2) to ${newS}; the v2 value is dead.`,
        `That breaks Acme's playbook: ${breach}.`,
        `The General Counsel signed off in a separate thread (cap floor ${d.floor} months' fees) before the correction; counsel already answered our side question (${sideDisplay[sideQ]}).`,
        "Counsel promised a corrected v3 'by tomorrow' and it has NOT arrived.",
        ping ? `The business owner has just asked whether the agreement can be signed this week.` : null,
        fixKey === 'law' ? `Acme accepts only Delaware or New York law, not ${LAW_NAME[corrected.law]}.` : null,
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required,
        optional: [
          { id: 'mention_v3', text: 'Mentions that the corrected v3 is still outstanding (or asks that it reflect Acme\'s position)' },
          { id: 'update_gc', text: 'Lets the General Counsel know the vendor has moved outside playbook on this clause' },
          ...(ping ? [] : [{ id: 'update_owner', text: 'Updates the business owner about the problem clause' }]),
        ],
        prohibited,
      },
    };

    return legalCase(cold_handoff, variant, {
      description: `Long history: v2 within playbook, GC sign-off in another thread, side question answered, ${CLAUSE[fixKey]} corrected to ${newS} with v3 owed; wakes on ${trigger}.`,
      task: d.task, mb, trigger: trig, checkpoint,
      params: { fixKey, v2, corrected, trigger, sideQ, withAck, gcThanks, pingInThread, kickoff, nBackground, nChatter, file, floor: d.floor },
    });
  },
};

/** The Monday after `iso`. */
function nextMondayAfter(iso: string): string {
  let x = addDays(iso, 1);
  while (new Date(`${x}T12:00:00Z`).getUTCDay() !== 1) x = addDays(x, 1);
  return x;
}
