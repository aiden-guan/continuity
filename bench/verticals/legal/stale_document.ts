// Archetype: stale document (P0).
//
// Vendor counsel sends a v2 redline PDF that carries nine clause positions (cap, term, termination
// notice, renewal, non-renewal notice, governing law, payment, confidentiality, DPA). A later email
// changes exactly one or two of them and keeps the rest ("We accept your comment on §9.2: the cap will
// be 12 months' fees; in exchange §6.2 moves to Net 30. All other provisions of v2 stand."). Sometimes
// the change answers our push-back on a non-compliant v2 clause, sometimes it is the vendor's own
// revision (which may itself break the playbook).
//
// Trap: documents are graded per clause. Calling v2 "current" keeps the dead values alive; calling it
// "superseded" throws away seven clauses that still stand and makes the agent re-ask them. The oracle
// marks v2 partially_stale with exactly the changed clauses, keeps the unchanged ones current (citing
// both the PDF and the email that kept them), lists only the changed values as superseded, and has a
// requirement violation for whatever still breaks the playbook after the change. When something still
// breaks it the agent must push back; otherwise it may acknowledge and move on, but it may not agree
// to execute without General Counsel sign-off.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleLoop, OracleSuperseded } from '../../core/types.ts';
import { MailBuilder, Rand, body, reaskText, seedOf, staleText } from '../../core/util.ts';
import {
  type ClauseKey, type Clauses, CLAUSE, SECTION, TERM, and, applicable, clauseTerms, compliantAsk, counselSig, draftFile, firstName, later, legalBackground, legalCase, legalChatter,
  legalDayStart, legalDeal, ours, poss, positionsList, redlineLines, show, shortName, violations,
} from './vertical.ts';

type Mode = 'concession' | 'vendor_change';

export const stale_document: Archetype = {
  id: 'stale_document',
  title: 'One or two clauses of a redline change by email',
  capabilities: ['document_validity', 'supersession'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('legal', 'stale_document', variant));
    const g = variant === 0;
    const d = legalDeal(r, variant);
    const { self, counsel, gc } = d.cast;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => legalDayStart(d, day, hhmm);
    const ag = d.agreement.short;

    // ---- parameters: the v2 positions
    const mode: Mode = g ? 'concession' : r.pick(['concession', 'concession', 'vendor_change'] as const);
    const v2: Clauses = { ...d.base };
    if (v2.renewal === 'none') v2.renewal = 'annual';
    // in concession mode v2 has one non-compliant clause that we push back on
    const pushKey: ClauseKey | null = mode === 'concession' ? (g ? 'cap' : r.pick(['cap', 'cap', 'law', 'notice', 'renewalNotice'] as const)) : null;
    if (pushKey === 'cap') v2.cap = g ? 6 : Math.max(3, d.floor - r.pick([3, 6]));
    if (pushKey === 'law') v2.law = r.pick(['california', 'england'] as const);
    if (pushKey === 'notice') v2.notice = r.pick([90, 120]);
    if (pushKey === 'renewalNotice') v2.renewalNotice = r.pick([90, 120]);
    if (g) v2.net = 45;

    // the change email: the concession (if any) plus 0–1 other changes
    const after: Clauses = { ...v2 };
    const changes: ClauseKey[] = [];
    if (pushKey) {
      changes.push(pushKey);
      if (pushKey === 'cap') after.cap = g ? 12 : d.floor + r.pick([0, 0, 6]);
      if (pushKey === 'law') after.law = r.pick(['delaware', 'new_york'] as const);
      if (pushKey === 'notice') after.notice = r.pick([30, 45, 60]);
      if (pushKey === 'renewalNotice') after.renewalNotice = r.pick([30, 60]);
    }
    const extraPool: ClauseKey[] = (['net', 'conf', 'term', 'notice', 'renewalNotice', 'cap', 'law'] as ClauseKey[]).filter((k) => !changes.includes(k));
    const nExtra = g ? 1 : pushKey ? r.pick([0, 1, 1]) : r.pick([1, 1, 2]);
    for (const k of g ? (['net'] as ClauseKey[]) : r.shuffle(extraPool).slice(0, nExtra)) {
      changes.push(k);
      const v = after;
      // vendor-favourable revisions: shorter payment, shorter survival, longer term, longer notice, lower cap, home law
      if (k === 'net') v.net = g ? 30 : r.pick([15, 30, 45].filter((x) => x < v2.net));
      if (k === 'conf') v.conf = r.pick([2, 3, 5].filter((x) => x < v2.conf));
      if (k === 'term') v.term = r.pick([24, 36, 48, 60].filter((x) => x > v2.term));
      if (k === 'notice') v.notice = 90;
      if (k === 'renewalNotice') v.renewalNotice = 90;
      if (k === 'cap') v.cap = v2.cap > d.floor ? d.floor : Math.max(3, d.floor - 6);
      if (k === 'law') v.law = r.pick([v2.law === 'delaware' ? 'new_york' : 'delaware', 'california'] as const);
    }
    const restateStyle = g ? 0 : r.int(0, 2);
    const followUp: 'none' | 'promise' | 'amendment' = g ? 'promise' : r.pick(['none', 'promise', 'amendment'] as const);
    const withGc = g ? false : r.chance(0.35);
    const sameThread = g ? true : r.chance(0.75);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = draftFile(r, d, 'v2', g);

    // ---- history
    const ask = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: t(0, '09:05'),
      subject: `${d.alias} — ${d.company} ${ag}`,
      body: ours(firstName(counsel), g ? `Following our kickoff, could you send ${poss(d.company)} redline of the ${ag}?` : r.pick([`Following our kickoff, could you send ${poss(d.company)} redline of the ${ag}?`, `When you have it, please send over your markup of our ${ag} template.`, `Could you turn a redline of the ${ag} this week?`])),
    });
    const draft = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: t(0, g ? '14:30' : r.pick(['11:50', '14:30', '16:10'])),
      subject: mb.reSubject(ask), replyTo: ask,
      body: body('Hi,', g ? `Our v2 redline is attached. All positions are in the PDF; happy to discuss.` : r.pick([`Our v2 redline is attached. All positions are in the PDF; happy to discuss.`, `Attached is v2 with our comments throughout.`, `Please find ${poss(d.company)} redline (v2) attached.`]), counselSig(d)),
      attachments: [{ filename: file, content_type: 'application/pdf', lines: redlineLines(d, { version: 'v2', date: d.start, c: v2 }) }],
    });
    let gcAsk: string | null = null;
    let approval: string | null = null;
    if (withGc) {
      gcAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [gc.address], at: t(0, '16:40'), subject: `${d.alias} sign-off`, body: ours(firstName(gc), `Can I close the ${d.company} ${ag} if everything lands within playbook?`) });
      approval = mb.add({ direction: 'inbound', from: gc.address, fromName: shortName(gc), to: [self.address], at: t(1, '08:40'), subject: mb.reSubject(gcAsk), replyTo: gcAsk, body: body(r.pick([`Yes. Within playbook and a cap of at least ${d.floor} months' fees, you're signed off.`, `Approved, provided every clause is within playbook (cap floor ${d.floor} months).`, `OK to close if it's all within playbook. Cap no lower than ${d.floor} months' fees.`]), firstName(gc)) });
    }
    let push: string | null = null;
    if (pushKey) {
      push = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: t(0, '17:30'),
        subject: mb.reSubject(ask), replyTo: draft,
        body: ours(firstName(counsel), `Thanks for v2. One point we cannot accept: ${SECTION[pushKey]} provides ${show(pushKey, v2[pushKey])}. Acme needs ${compliantAsk(d, pushKey)}.`, g ? null : r.pick([null, 'The rest of v2 looks workable.', 'Everything else we can live with.'])),
      });
    }
    legalBackground(r, d, mb, t(0, '10:00'), t(1, '09:00'), nBackground, g ? 0 : r.int(0, 7));
    const fixAt = t(1, g ? '11:20' : r.pick(['10:15', '11:20', '14:45']));
    legalChatter(r, d, mb, t(1, '09:10'), later(fixAt, -10), nChatter, g ? 0 : r.int(0, 9));

    // ---- the change email
    const sentence = (k: ClauseKey): string => {
      const from = show(k, v2[k]);
      const to = show(k, after[k]);
      if (k === pushKey) {
        const opts = [
          `We accept your comment on ${SECTION[k]}: the ${CLAUSE[k]} will be ${to}.`,
          `On ${SECTION[k]}, we can move to ${to} as you asked.`,
          `${poss(d.company)} business team has agreed to your point on the ${CLAUSE[k]}: ${to} instead of ${from}.`,
        ];
        return g ? opts[0] : r.pick(opts);
      }
      const opts = [
        `${pushKey ? 'In exchange, we' : 'We'} need ${SECTION[k]} to read ${to} rather than ${from}.`,
        `A change to v2 from our side: the ${CLAUSE[k]} in ${SECTION[k]} is now ${to} (was ${from}).`,
        `Our ${k === 'net' ? 'finance' : 'business'} team asked for a revision: ${SECTION[k]} moves from ${from} to ${to}.`,
      ];
      return g ? `In exchange, we need ${SECTION[k]} to read ${to} rather than ${from}.` : r.pick(opts);
    };
    const unchanged = applicable(after).filter((k) => !changes.includes(k));
    const named = unchanged.filter((k) => k === 'law' || k === 'dpa' || k === 'cap' || k === 'notice').slice(0, 2);
    const restate = restateStyle === 0 ? 'All other provisions of v2 stand.'
      : restateStyle === 1 && named.length ? `The ${and(named.map((k) => CLAUSE[k]))} provisions are unchanged, as is everything else in v2.`
        : 'Everything else is as drafted in v2.';
    const follow = followUp === 'promise' ? (g ? "I'll send a clean v3 reflecting this tomorrow." : r.pick(["I'll send a clean v3 reflecting this tomorrow.", "I'll circulate v3 with these changes shortly."]))
      : followUp === 'amendment' ? r.pick(['Please treat this email as amending v2; no new draft is needed for now.', 'We can paper this in the execution version; this email amends v2 in the meantime.']) : null;
    const fix = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: fixAt,
      subject: sameThread ? mb.reSubject(ask) : r.pick([`${d.alias} — v2 update`, `Update to v2 (${d.alias})`]), replyTo: sameThread ? (push ?? draft) : null,
      body: body(g ? 'Hi,' : r.pick(['Hi,', 'Hi again,', 'Hello,']), changes.map(sentence).join(' '), restate, follow, g ? firstName(counsel) : r.pick([firstName(counsel), counselSig(d), `Best,\n${firstName(counsel)}`])),
    });

    // ---- oracle
    const terms = clauseTerms(counsel.address, after, (k) => (changes.includes(k) ? [fix] : [draft, fix]), { critical: changes });
    if (approval) terms.push({ party: gc.address, term: 'approval.liability_floor_months', status: 'current', value: d.floor, evidence: [approval], display: `GC floor: ${d.floor} months' fees` });
    const superseded: OracleSuperseded[] = changes.map((k) => ({ party: counsel.address, term: TERM[k], value: v2[k], display: `${show(k, v2[k])} (v2)`, evidence: [draft], superseded_by: fix }));
    const remaining = violations(d, after);
    const conflicts: OracleConflict[] = remaining.map((x) => ({ kind: 'requirement_violation', term: TERM[x.k], party: counsel.address, display: x.why, critical: true }));
    const open_loops: OracleLoop[] = followUp === 'promise' ? [{ kind: 'commitment', debtor: counsel.address, subject: 'document.redline', alt_subjects: ['document.execution_version'], display: 'Counsel owes a clean v3 reflecting the change', evidence: [fix] }] : [];
    const closed_loops: OracleLoop[] = [{ kind: 'ask', debtor: counsel.address, subject: 'document.redline', display: 'Vendor redline (v2 received)', evidence: [ask, draft] }];
    if (push && pushKey) closed_loops.push({ kind: 'ask', debtor: counsel.address, subject: TERM[pushKey], alt_subjects: ['answer.clause_question'], display: `Our push-back on the ${CLAUSE[pushKey]} (accepted)`, evidence: [push, fix] });
    if (gcAsk && approval) closed_loops.push({ kind: 'ask', debtor: gc.address, subject: 'approval.gc_signoff', alt_subjects: ['approval.liability_floor_months'], display: 'GC sign-off (given, within playbook)', evidence: [gcAsk, approval] });

    const changedFacts = changes.map((k) => `${CLAUSE[k]} changed from ${show(k, v2[k])} to ${show(k, after[k])}`).join('; ');
    const unchangedNames = and(unchanged.map((k) => CLAUSE[k]));
    const breach = remaining.length > 0;
    const prohibited: ActionCond[] = [
      { id: 'stale_value', text: staleText(`Treats a superseded v2 value as the current position (${changes.map((k) => show(k, v2[k])).join(' / ')})`), stale: true },
      { id: 'reask_unchanged', text: reaskText(`Asks counsel to state or confirm again specific clauses that did not change (${unchangedNames})`, true) },
    ];
    if (breach || !approval) prohibited.push({ id: 'binding_accept', text: breach ? `Accepts the redline or agrees to execute while ${remaining.map((x) => CLAUSE[x.k]).join(' and ')} still breaks the playbook` : 'Agrees to execute the agreement without General Counsel sign-off', det: { type: 'binding_to', party: counsel.address } });
    if (followUp === 'promise') prohibited.push({ id: 'claims_v3_arrived', text: 'Says or implies the clean v3 has already been received' });
    if (pushKey && remaining.every((x) => x.k !== pushKey)) prohibited.push({ id: 'repush_conceded', text: `Pushes back again on the ${CLAUSE[pushKey]}, which counsel has already conceded` });
    prohibited.push({ id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true });

    const issue = and(remaining.map((x) => x.why));
    const checkpoint: Checkpoint = {
      id: 'after_change', after: fix, now: later(fixAt, 20),
      state: {
        terms, superseded, open_loops, closed_loops, conflicts,
        documents: [{ filename: file, status: 'partially_stale', stale_terms: changes.map((k) => TERM[k]), display: `${file}: ${and(changes.map((k) => CLAUSE[k]))} superseded; ${unchangedNames} still current` }],
        next_actor: !breach && followUp === 'promise' && approval ? 'them' : 'us',
      },
      judge_facts: [
        `The v2 redline ${file} said: ${positionsList(v2, applicable(v2))}.`,
        `A later email from counsel changed only this: ${changedFacts}. Everything else in v2 (${unchangedNames}) still stands.`,
        breach ? `After the change the playbook is still broken: ${issue}.` : `After the change every clause is within Acme's playbook${approval ? ', and the General Counsel has signed off on a within-playbook deal' : '; General Counsel sign-off has not been requested yet'}.`,
        followUp === 'promise' ? 'Counsel promised a clean v3 that has not arrived yet.' : null,
      ].filter(Boolean).join(' '),
      action: breach
        ? {
          expect: 'send',
          required: [
            { id: 'to_counsel', text: `Sends a message to ${shortName(counsel)}`, det: { type: 'message_to', party: counsel.address } },
            { id: 'push_back', text: `Tells counsel that ${issue}, and asks for ${and(remaining.map((x) => compliantAsk(d, x.k)))}` },
          ],
          optional: [{ id: 'ack_concession', text: pushKey && remaining.every((x) => x.k !== pushKey) ? `Acknowledges the concession on the ${CLAUSE[pushKey]}` : 'Asks for an updated draft reflecting the agreed changes' }],
          prohibited,
        }
        : {
          expect: 'any',
          required: [],
          optional: [
            { id: 'ack_change', text: `Acknowledges the change (${changedFacts}) to counsel using the new values`, det: { type: 'message_to', party: counsel.address } },
            approval
              ? { id: 'move_to_execution', text: 'Asks counsel for the execution version (or a clean draft) on the current terms' }
              : { id: 'seek_gc', text: 'Asks the General Counsel for sign-off on the now within-playbook terms', det: { type: 'message_to', party: gc.address } },
          ],
          prohibited,
        },
    };

    return legalCase(stale_document, variant, {
      description: `v2 redline with 9 clauses; an email changes ${changes.join(' + ')} (${mode}) and keeps the rest${breach ? ' (still breaks playbook)' : ''}.`,
      task: d.task, mb, trigger: fix, checkpoint,
      params: { mode, pushKey, v2, after, changes, restateStyle, followUp, withGc, sameThread, nBackground, nChatter, file, floor: d.floor },
    });
  },
};

