// Archetype: late evidence (P1).
//
// Vendor counsel sends the v2 redline (copying an Acme colleague), then corrects one clause in a
// follow-up sent only to us: the initial term, the non-renewal notice, the payment terms, the
// confidentiality survival or the termination notice (still within playbook), sometimes with a
// corrected v3 attached. A day or two later the colleague (the business owner, or the General Counsel
// reviewing for sign-off), who never saw the correction, forwards the ORIGINAL v2 email with its old
// date header and the old PDF, and says they are acting on it ("I've budgeted for the 36-month term",
// "I've set the non-renewal reminder 60 days out").
//
// Trap: the forward is the newest message and repeats the old value verbatim, so recency-based state
// or a summary refreshed on the latest message resurrects it. The oracle keeps the corrected value
// current, the old value superseded (the forward is just a copy of the superseded evidence), the old
// PDF stale on that clause, any v3 current, and an open ask: we owe the colleague a correction.
import type { ActionCond, Archetype, BenchCase, BenchParty, Checkpoint, OracleDocument, OracleLoop } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, sayDate, seedOf, staleText } from '../../core/util.ts';
import { type Clauses, CLAUSE, SECTION, TERM, clauseTerms, correctionSentence, counselSig, draftFile, firstName, later, legalBackground, legalCase, legalChatter, legalDayStart, legalDeal, ours, poss, positionsList, redlineLines, show, shortName } from './vertical.ts';

type Fix = 'term' | 'renewalNotice' | 'net' | 'conf' | 'notice';

export const late_evidence: Archetype = {
  id: 'late_evidence',
  title: 'An old copy of a corrected redline is forwarded after the correction',
  capabilities: ['late_evidence', 'supersession', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('legal', 'late_evidence', variant));
    const g = variant === 0;
    const d = legalDeal(r, variant);
    const { self, counsel, gc, owner } = d.cast;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => legalDayStart(d, day, hhmm);
    const ag = d.agreement.short;
    const co = d.company;

    // ---- parameters
    const fixKey: Fix = g ? 'term' : r.pick(['term', 'renewalNotice', 'net', 'conf', 'notice'] as const);
    const colleague: BenchParty = g ? owner : fixKey === 'term' || fixKey === 'net' ? r.pick([owner, owner, gc]) : r.pick([owner, gc]);
    const v2: Clauses = { ...d.base };
    if (g) v2.term = 36;
    if (fixKey === 'renewalNotice' && v2.renewal === 'none') v2.renewal = 'annual';
    const fixed: Clauses = { ...v2 };
    if (fixKey === 'term') fixed.term = g ? 24 : r.pick([12, 24, 36, 48].filter((x) => x !== v2.term));
    if (fixKey === 'renewalNotice') fixed.renewalNotice = r.pick([30, 45, 60].filter((x) => x !== v2.renewalNotice));
    if (fixKey === 'net') fixed.net = r.pick([30, 45, 60].filter((x) => x !== v2.net));
    if (fixKey === 'conf') fixed.conf = r.pick([3, 5, 7].filter((x) => x !== v2.conf));
    if (fixKey === 'notice') fixed.notice = r.pick([30, 45, 60].filter((x) => x !== v2.notice));
    const revised: 'attached' | 'promised' | 'none' = g ? 'attached' : r.pick(['attached', 'attached', 'promised', 'none'] as const);
    const ourAck = g ? false : r.chance(0.5);
    const fwdDay = g ? 2 : r.int(2, 3);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const v2file = draftFile(r, d, 'v2', g);
    const v3file = v2file.replace('v2', 'v3');

    // ---- history
    const req = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], cc: [colleague.address], at: t(0, '08:30'),
      subject: `${d.alias} — ${co} ${ag}`,
      body: ours(firstName(counsel), `Could you send ${poss(co)} redline of the ${ag}? Copying ${firstName(colleague)}${colleague === gc ? ', our General Counsel' : `, who owns the ${co} relationship on our side`}.`),
    });
    const draftAt = t(0, g ? '11:20' : r.pick(['11:20', '13:05', '14:40']));
    const draftBody = body('Hi,', g
      ? `Our v2 is attached: ${positionsList(v2, ['term', 'cap', 'law', 'notice', 'renewal', 'dpa'])}.`
      : r.pick([
        `v2 attached. Key positions: ${positionsList(v2, ['term', 'cap', 'law', 'notice', 'renewal', 'net'])}.`,
        `Please find ${poss(co)} v2 redline attached (${positionsList(v2, [fixKey, 'cap', 'law', 'dpa'])}).`,
        `Here is v2. In summary: ${positionsList(v2, ['cap', fixKey, 'law', 'notice'])}.`,
      ]), counselSig(d));
    const v2Lines = redlineLines(d, { version: 'v2', date: d.start, c: v2 });
    const draft = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], cc: [colleague.address], at: draftAt,
      subject: mb.reSubject(req), replyTo: req, body: draftBody,
      attachments: [{ filename: v2file, content_type: 'application/pdf', lines: v2Lines }],
    });
    legalBackground(r, d, mb, t(0, '09:00'), t(1, '09:00'), nBackground, g ? 0 : r.int(0, 7));

    const fixAt = t(1, g ? '09:40' : r.pick(['09:10', '09:40', '13:25']));
    const fix = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: fixAt,
      subject: mb.reSubject(req), replyTo: draft,
      body: body('Hi,', correctionSentence(r, fixKey, v2, fixed, 'v2', g), g ? 'Everything else stands.' : r.pick(['Everything else stands.', 'No other changes.', 'All other clauses are as drafted.']),
        revised === 'attached' ? 'Corrected v3 attached.' : revised === 'promised' ? "I'll send a corrected v3 shortly." : null, firstName(counsel)),
      attachments: revised === 'attached' ? [{ filename: v3file, content_type: 'application/pdf', lines: redlineLines(d, { version: 'v3', date: addDays(d.start, 1), c: fixed }) }] : undefined,
      note: 'sent to us only; the colleague was not copied',
    });
    if (ourAck) mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: later(fixAt, 50), subject: mb.reSubject(req), replyTo: fix, body: ours(firstName(counsel), 'Thanks for flagging, noted.'), note: 'state-neutral' });
    const fwdAt = t(fwdDay, g ? '10:05' : r.pick(['08:50', '10:05', '14:15']));
    legalChatter(r, d, mb, t(1, '15:00'), later(fwdAt, -20), nChatter, g ? 0 : r.int(0, 9));

    // ---- the late copy
    const oldS = show(fixKey, v2[fixKey]);
    const newS = show(fixKey, fixed[fixKey]);
    const ownerComment: Record<Fix, string[]> = {
      term: [`Great news below. I've budgeted for a ${v2.term}-month commitment per the draft and told finance. Can you confirm?`, `Per the attached, I'm planning on a ${v2.term}-month initial term. Shout if that changed.`, `Finance is asking: we're locked in for ${v2.term} months, right? That's what the draft says.`],
      renewalNotice: [`I've put a reminder in the calendar to send non-renewal notice ${v2.renewalNotice} days before each renewal, per below. OK?`, `Per the attached, we need to give ${v2.renewalNotice} days' notice to stop renewal; I've briefed procurement.`, `Just to check: ${v2.renewalNotice} days' notice to stop auto-renewal, as below?`],
      net: [`I've told AP to set ${co} up on Net ${v2.net} per the attached. Correct?`, `Setting up the vendor record with Net ${v2.net} payment terms, as per below.`, `AP wants the payment terms; I'll give them Net ${v2.net} from the draft unless you say otherwise.`],
      conf: [`For our records retention plan I'm assuming ${v2.conf} years of confidentiality survival, per below.`, `Infosec asked how long confidentiality survives; I told them ${v2.conf} years per the attached.`, `Is it still ${v2.conf} years on confidentiality? That's what the draft says.`],
      notice: [`I told the steering group we can exit on ${v2.notice} days' notice if the pilot fails, per the draft below. Right?`, `Per the attached we can terminate for convenience on ${v2.notice} days' notice; I've put that in the business case.`, `Confirming we can get out on ${v2.notice} days' notice, as below?`],
    };
    const gcComment = [
      `Reviewing the attached v2 for my final sign-off. ${SECTION[fixKey]} at ${oldS} is fine with me. Anything else I should look at?`,
      `I'm signing off on the basis of this draft (${CLAUSE[fixKey]}: ${oldS}). Let me know if it has moved.`,
      `Found this in my inbox; I'll approve on these terms (${CLAUSE[fixKey]} ${oldS}) unless you tell me otherwise.`,
    ];
    const comment = colleague === gc ? (g ? gcComment[0] : r.pick(gcComment)) : g ? ownerComment[fixKey][0] : r.pick(ownerComment[fixKey]);
    const hh = Number(draftAt.slice(11, 13));
    const header = [
      '---------- Forwarded message ---------',
      `From: ${shortName(counsel)} <${counsel.address}>`,
      `Date: ${sayDate(draftAt.slice(0, 10), 'weekday').slice(0, 3)}, ${sayDate(draftAt.slice(0, 10), 'month_day').replace(/^(\w{3})\w*/, '$1')}, 2026 at ${hh % 12 || 12}:${draftAt.slice(14, 16)} ${hh >= 12 ? 'PM' : 'AM'}`,
      `Subject: ${mb.get(draft).subject}`,
      `To: ${self.address}`,
      `Cc: ${colleague.address}`,
    ].join('\n');
    const fwd = mb.add({
      direction: 'inbound', from: colleague.address, fromName: shortName(colleague), to: [self.address], at: fwdAt,
      subject: `Fwd: ${mb.get(draft).subject}`,
      body: body('Hi,', comment, firstName(colleague), `${header}\n\n${draftBody}`),
      attachments: [{ filename: v2file, content_type: 'application/pdf', lines: v2Lines }],
      quoteParent: false,
      note: 'late copy of the original (pre-correction) v2',
    });

    // ---- oracle
    const terms = clauseTerms(counsel.address, fixed, (k) => (k === fixKey ? [fix] : [draft, fix, fwd]), { critical: [fixKey] });
    const open_loops: OracleLoop[] = [
      { kind: 'ask', debtor: self.address, subject: TERM[fixKey], alt_subjects: ['answer.clause_question'], display: `${firstName(colleague)} is acting on the old ${CLAUSE[fixKey]} (${oldS}) and needs the corrected value`, evidence: [fwd], critical: true },
    ];
    if (revised === 'promised') open_loops.push({ kind: 'commitment', debtor: counsel.address, subject: 'document.redline', display: 'Counsel owes a corrected v3', evidence: [fix] });
    const closed_loops: OracleLoop[] = [{ kind: 'ask', debtor: counsel.address, subject: 'document.redline', display: 'Vendor redline (v2 received)', evidence: [req, draft] }];
    const documents: OracleDocument[] = [{ filename: v2file, status: 'partially_stale', stale_terms: [TERM[fixKey]], display: `${v2file}: ${CLAUSE[fixKey]} superseded by the correction; other clauses current` }];
    if (revised === 'attached') documents.push({ filename: v3file, status: 'current', stale_terms: [], display: `${v3file}: current` });

    const prohibited: ActionCond[] = [
      { id: 'confirms_old', text: staleText(`Confirms or repeats ${oldS} as the current ${CLAUSE[fixKey]}`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    if (revised === 'promised') prohibited.push({ id: 'claims_v3_arrived', text: 'Says the corrected v3 has already been received' });
    const checkpoint: Checkpoint = {
      id: 'after_late_copy', after: fwd, now: later(fwdAt, 20),
      state: { terms, superseded: [{ party: counsel.address, term: TERM[fixKey], value: v2[fixKey], display: `${oldS} (v2)`, evidence: [draft, fwd], superseded_by: fix }], open_loops, closed_loops, conflicts: [], documents, next_actor: 'us' },
      judge_facts: [
        `${poss(co)} v2 said ${CLAUSE[fixKey]} ${oldS}; counsel later corrected it to ${newS}${revised === 'attached' ? ' (with a corrected v3)' : ''}. Everything else in v2 stands.`,
        `${shortName(colleague)} has just forwarded the ORIGINAL v2 (dated before the correction) and is acting on ${oldS}; they never saw the correction.`,
        `The corrected value ${newS} is current and still within Acme's playbook.`,
        revised === 'promised' ? 'The corrected v3 has not arrived yet.' : null,
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_colleague', text: `Replies to ${firstName(colleague)}`, det: { type: 'message_to', party: colleague.address } },
          { id: 'corrects_colleague', text: `Tells ${firstName(colleague)} the current ${CLAUSE[fixKey]} is ${newS}, not ${oldS} (the forwarded v2 is outdated)` },
        ],
        optional: [{ id: 'points_to_revision', text: revised === 'attached' ? 'Points them to (or forwards) the corrected v3' : 'Mentions that counsel corrected the draft by email' }],
        prohibited,
      },
    };

    return legalCase(late_evidence, variant, {
      description: `${CLAUSE[fixKey]} corrected ${oldS} → ${newS}; ${colleague.label} later forwards the pre-correction v2 and acts on it.`,
      task: d.task, mb, trigger: fwd, checkpoint,
      params: { fixKey, colleague: colleague.label, v2, fixed, revised, ourAck, fwdDay, nBackground, nChatter, v2file, v3file },
    });
  },
};
