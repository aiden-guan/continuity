// Archetype: correction / supersession (P0). The reference archetype for the legal vertical.
//
// Vendor counsel returns a v2 redline (PDF) whose positions all meet Acme's playbook. In a separate
// thread Acme's General Counsel signs off, on condition that the cap stays at or above the floor. Then
// counsel corrects ONE clause ("I misspoke: termination for convenience is 90 days, not 60"; the cap
// is 6 months, not 12; the law is California, not Delaware; non-renewal notice is 90 days; payment is
// Net 30, not Net 45) and promises a corrected v3. Everything else in v2 stands.
//
// Trap: a summary or "the redline PDF is the contract" view keeps the v2 value alive; "newest message
// wins" for the whole document throws away the clauses that still stand; a thread-scoped reader never
// sees the GC sign-off. The oracle has the corrected value current and the v2 value superseded, every
// other v2 clause current, the GC floor from the other thread, the v2 PDF partially stale on exactly
// the corrected clause, the corrected v3 owed by counsel, and a requirement violation whenever the
// corrected value breaks the playbook. The right action pushes back on that clause (or, for a
// harmless correction, simply carries on) without agreeing to execute or re-asking GC.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleLoop } from '../../core/types.ts';
import { MailBuilder, Rand, body, reaskText, seedOf, staleText } from '../../core/util.ts';
import {
  type Clauses, CLAUSE, SECTION, TERM, clauseTerms, compliantAsk, correctionSentence, counselSig, draftFile, firstName, later, legalBackground, legalCase,
  legalChatter, legalDayStart, legalDeal, ours, poss, positionsList, redlineLines, show, shortName, violation,
} from './vertical.ts';

type Fix = 'notice' | 'cap' | 'law' | 'renewalNotice' | 'net';

export const correction: Archetype = {
  id: 'correction',
  title: 'Vendor counsel corrects one clause of a redline',
  capabilities: ['supersession', 'document_validity', 'cross_thread', 'open_loops', 'cold_handoff'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('legal', 'correction', variant));
    const g = variant === 0;
    const d = legalDeal(r, variant);
    const { self, counsel, gc } = d.cast;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => legalDayStart(d, day, hhmm);
    const ag = d.agreement.short;

    // ---- parameters
    const fixKey: Fix = g ? 'notice' : r.pick(['notice', 'notice', 'cap', 'law', 'renewalNotice', 'net'] as const);
    const v2: Clauses = { ...d.base };
    if (fixKey === 'renewalNotice' && v2.renewal === 'none') v2.renewal = 'annual';
    const corrected: Clauses = { ...v2 };
    if (fixKey === 'notice') corrected.notice = g ? 90 : r.pick([90, 90, 120]);
    if (fixKey === 'cap') corrected.cap = Math.max(3, d.floor - r.pick([3, 6]));
    if (fixKey === 'law') corrected.law = r.pick(['california', 'england'] as const);
    if (fixKey === 'renewalNotice') corrected.renewalNotice = r.pick([90, 120]);
    if (fixKey === 'net') corrected.net = v2.net === 30 ? 15 : 30; // the vendor shortens its own payment terms: no playbook issue
    const breach = violation(d, fixKey, corrected);
    const restates = g ? true : r.chance(0.7); // "everything else in v2 stands"
    const v3Due = g ? 'by tomorrow' : r.pick(['by tomorrow', 'later today', 'by end of day tomorrow', 'early next week', '']);
    const coverSummary = g ? true : r.chance(0.6);
    const fixAt = t(1, g ? '11:05' : r.pick(['11:05', '13:40', '15:20']));
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = draftFile(r, d, 'v2', g);

    // ---- history
    const ask = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: t(0, '09:10'),
      subject: `${d.alias} — ${d.agreement.name} with ${d.company}`,
      body: ours(firstName(counsel), `Thanks for the call on Friday. As discussed, Acme needs a liability cap of at least ${d.floor} months' fees, Delaware or New York law, termination for convenience on no more than ${d.maxNotice} days' notice, and your DPA attached as an exhibit.`, `Could you send us ${poss(d.company)} redline of the ${ag} reflecting those points?`),
    });
    const coverText = g
      ? `Attached is our redline (v2) of the ${ag}. We have accepted ${positionsList(v2, ['law', 'dpa'])}; the cap in ${SECTION.cap} is ${show('cap', v2.cap)} and termination for convenience in ${SECTION.notice} is on ${v2.notice} days' notice.`
      : coverSummary
        ? r.pick([
          `Please find ${poss(d.company)} v2 redline attached. Headline points: ${positionsList(v2, ['cap', 'law', 'notice', 'renewal', 'dpa'])}.`,
          `Our markup (v2) is attached. In short, we can live with ${positionsList(v2, ['cap', 'notice', 'law'])}, and the DPA is in as Exhibit C.`,
          `v2 of the ${ag} attached. We've moved on most of your points: ${positionsList(v2, ['cap', 'law', 'notice', 'dpa'])}.`,
        ])
        : r.pick([`Attached is our v2 redline of the ${ag}. Happy to walk through it on a call.`, `Please see the attached v2. Let me know if you have questions on any of the changes.`, `Our redline (v2) is attached for your review.`]);
    const draft = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: t(0, g ? '15:40' : r.pick(['13:15', '15:40', '16:55'])),
      subject: mb.reSubject(ask), replyTo: ask,
      body: body(`Hi,`, coverText, counselSig(d)),
      attachments: [{ filename: file, content_type: 'application/pdf', lines: redlineLines(d, { version: 'v2', date: d.start, c: v2 }) }],
    });
    const gcAsk = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [gc.address], at: t(0, '17:20'),
      subject: g ? `Sign-off request — ${d.alias} (${d.company} ${ag})` : r.pick([`Sign-off request — ${d.alias} (${d.company} ${ag})`, `${d.alias}: OK to move to execution?`, `GC approval needed: ${d.company} ${ag}`]),
      body: ours(firstName(gc), `${poss(d.company)} v2 redline of the ${ag} is in: ${positionsList(v2, ['cap', 'law', 'notice', 'renewal', 'dpa'])}. That is within playbook.`, 'Are you comfortable with us moving to an execution version on that basis?'),
    });
    const approval = mb.add({
      direction: 'inbound', from: gc.address, fromName: shortName(gc), to: [self.address], at: t(1, g ? '09:20' : r.pick(['08:45', '09:20', '10:05'])),
      subject: mb.reSubject(gcAsk), replyTo: gcAsk,
      body: g
        ? body(`Approved. You can move ${d.alias} to execution, provided the cap stays at no less than ${d.floor} months' fees.`, `${firstName(gc)}`)
        : body(r.pick([
          `Approved, as long as the cap does not drop below ${d.floor} months' fees.`,
          `Fine by me. My floor on the cap is ${d.floor} months' fees; anything else within playbook you can close.`,
          `Signed off for ${d.alias}, subject to a liability cap of at least ${d.floor} months of fees.`,
        ]), firstName(gc)),
    });
    legalBackground(r, d, mb, t(0, '10:00'), t(1, '08:30'), nBackground, g ? 0 : r.int(0, 7));
    legalChatter(r, d, mb, later(mb.get(approval).at, 5), later(fixAt, -10), nChatter, g ? 0 : r.int(0, 9));

    const fixText = correctionSentence(r, fixKey, v2, corrected, 'v2', g);
    const restateText = restates ? (g ? 'Everything else in v2 stands.' : r.pick(['Everything else in v2 stands.', 'All other provisions of v2 are unchanged.', `The rest of v2, including the ${CLAUSE[fixKey === 'cap' ? 'law' : 'cap']}, stays as drafted.`])) : null;
    const v3Text = `I'll circulate a corrected v3${v3Due ? ` ${v3Due}` : ''}.`;
    const fix = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: fixAt,
      subject: mb.reSubject(ask), replyTo: draft,
      body: body(g ? `Hi again,` : r.pick(['Hi,', 'Hi again,', 'Hello,']), fixText, restateText, v3Text, g ? `Apologies for the confusion,\n${firstName(counsel)}` : r.pick([firstName(counsel), `Sorry about that,\n${firstName(counsel)}`, counselSig(d)])),
    });

    // ---- oracle
    const terms = clauseTerms(counsel.address, corrected, (k) => (k === fixKey ? [fix] : restates ? [draft, fix] : [draft]), { critical: [fixKey] });
    terms.push({ party: gc.address, term: 'approval.liability_floor_months', status: 'current', value: d.floor, evidence: [approval], critical: true, display: `GC floor: ${d.floor} months' fees` });
    const open_loops: OracleLoop[] = [
      { kind: 'commitment', debtor: counsel.address, subject: 'document.redline', display: 'Counsel owes a corrected v3 redline (not received)', evidence: [fix], critical: true },
    ];
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: counsel.address, subject: 'document.redline', display: 'Vendor redline (v2 received)', evidence: [ask, draft] },
      { kind: 'ask', debtor: gc.address, subject: 'approval.gc_signoff', alt_subjects: ['approval.liability_floor_months'], display: 'GC sign-off (given, with a cap floor)', evidence: [gcAsk, approval] },
    ];
    const conflicts: OracleConflict[] = breach ? [{ kind: 'requirement_violation', term: TERM[fixKey], party: counsel.address, display: `Corrected ${CLAUSE[fixKey]}: ${breach}`, critical: true }] : [];
    const oldS = show(fixKey, v2[fixKey]);
    const newS = show(fixKey, corrected[fixKey]);

    const prohibited: ActionCond[] = [
      { id: 'stale_value', text: staleText(`Treats the v2 ${CLAUSE[fixKey]} (${oldS}) as what ${d.company} currently offers or as already agreed`), stale: true },
      { id: 'claims_v3_arrived', text: 'Says or implies the corrected v3 redline has already been received' },
      { id: 'reask_unchanged', text: reaskText(`Asks counsel to state or confirm again a specific clause that did not change (e.g. the ${CLAUSE[fixKey === 'cap' ? 'law' : 'cap']}; a general request that v3 change nothing else is fine)`, true) },
    ];
    if (breach) prohibited.unshift({ id: 'binding_accept', text: `Accepts the redline or agrees to execute the ${ag} with the corrected ${CLAUSE[fixKey]}`, det: { type: 'binding_to', party: counsel.address } });
    if (fixKey !== 'cap') prohibited.push({ id: 'reask_gc', text: reaskText('Asks the General Counsel again for sign-off on the cap (already given)') });
    prohibited.push({ id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true });

    const checkpoint: Checkpoint = {
      id: 'after_correction', after: fix, now: later(fixAt, 20),
      state: {
        terms, superseded: [{ party: counsel.address, term: TERM[fixKey], value: v2[fixKey], display: `${oldS} (v2)`, evidence: [draft], superseded_by: fix }],
        open_loops, closed_loops, conflicts,
        documents: [{ filename: file, status: 'partially_stale', stale_terms: [TERM[fixKey]], display: `${file}: ${CLAUSE[fixKey]} superseded by the correction; every other clause still current` }],
        next_actor: breach ? 'us' : 'them',
      },
      judge_facts: [
        `${poss(d.company)} v2 redline said ${positionsList(v2, ['cap', 'law', 'notice', 'renewal', 'net', 'dpa'])}.`,
        `Counsel then corrected only the ${CLAUSE[fixKey]}: it is now ${newS}, not ${oldS}. All other v2 clauses still stand. A corrected v3 was promised and has NOT arrived.`,
        `Acme's General Counsel already signed off (separate thread) with a cap floor of ${d.floor} months' fees.`,
        breach ? `The correction breaks Acme's playbook: ${breach}.` : 'The correction does not break any playbook requirement.',
      ].join(' '),
      action: breach
        ? {
          expect: 'send',
          required: [
            { id: 'to_counsel', text: `Sends a message to ${poss(d.company)} counsel`, det: { type: 'message_to', party: counsel.address } },
            { id: 'push_back', text: `Tells counsel that ${breach} and asks for ${compliantAsk(d, fixKey)}` },
          ],
          optional: [
            { id: 'mention_v3', text: 'Mentions that the corrected v3 is still expected (or asks that it reflect Acme\'s position)' },
            { id: 'update_gc', text: 'Lets the General Counsel know the vendor has moved on this clause' },
          ],
          prohibited,
        }
        : {
          expect: 'any',
          required: [],
          optional: [
            { id: 'ack_correction', text: `Acknowledges the correction to ${newS} and says Acme will review the corrected v3`, det: { type: 'message_to', party: counsel.address } },
          ],
          prohibited,
        },
    };

    return legalCase(correction, variant, {
      description: `Counsel corrects ${SECTION[fixKey]} ${CLAUSE[fixKey]} from ${oldS} to ${newS}${breach ? ' (breaks playbook)' : ''}; GC sign-off in a separate thread; corrected v3 owed.`,
      task: d.task, mb, trigger: fix, checkpoint,
      params: { fixKey, v2, corrected, restates, v3Due, coverSummary, nBackground, nChatter, file, floor: d.floor },
    });
  },
};

