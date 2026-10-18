// Archetype: supersession chain (P1).
//
// A → B → C. Vendor counsel's v2 redline (A) has a cap of N months' fees, an initial term and annual
// auto-renewal with a non-renewal notice period. We ask for a higher cap; counsel answers with a
// bundled counter (B) that changes three clauses at once: a higher cap, but only with a longer initial
// term and a 90-day non-renewal notice. Then exactly one clause reverts to its A value in C: we push
// back on the 90 days and they go back to the v2 notice; or the vendor's CFO will not sign up to the
// longer term and it goes back to the v2 term; or their insurers refuse the higher cap and it goes back
// to N months. The other two B values stand.
//
// Trap: per-clause history. "Latest message wins" for the whole bundle loses the two B values that C
// only restates implicitly; "first value wins" or a summary keeps A. And a value that is current again
// must not be reported as superseded. The oracle has, per clause, the latest value current (with every
// event that stated it), superseded = exactly the dead values (with the event that killed each), the
// v2 PDF stale on exactly the clauses whose current value differs from it, and a requirement violation
// while the 90-day notice stands.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleDocument, OracleLoop, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, seedOf, staleText } from '../../core/util.ts';
import { type ClauseKey, type Clauses, CLAUSE, CRITICAL, SECTION, TERM, clauseTerms, counselSig, draftFile, firstName, later, legalBackground, legalCase, legalChatter, legalDayStart, legalDeal, ours, poss, positionsList, redlineLines, show, shortName, violation } from './vertical.ts';

type Key = 'cap' | 'term' | 'renewalNotice';

export const supersession_chain: Archetype = {
  id: 'supersession_chain',
  title: 'Bundled counter on cap, term and renewal, then one clause reverts',
  capabilities: ['supersession', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('legal', 'supersession_chain', variant));
    const g = variant === 0;
    const d = legalDeal(r, variant);
    const { self, counsel, gc } = d.cast;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => legalDayStart(d, day, hhmm);
    const ag = d.agreement.short;
    const co = d.company;

    // ---- parameters
    const revert: Key = g ? 'renewalNotice' : r.pick(['renewalNotice', 'term', 'cap'] as const);
    const A: Clauses = { ...d.base, renewal: d.base.renewal === 'none' ? 'annual' : d.base.renewal, term: g ? 36 : r.pick([24, 36]) };
    const B: Clauses = { ...A, cap: A.cap + (g ? 12 : r.pick([6, 12])), term: A.term + (g ? 24 : r.pick([12, 24])), renewalNotice: g ? 90 : r.pick([90, 120]) };
    const C: Clauses = { ...B, [revert]: A[revert] };
    const withPdf = g ? true : r.chance(0.7);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = draftFile(r, d, 'v2', g);
    const keys: Key[] = ['cap', 'term', 'renewalNotice'];

    // ---- A
    const req = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: t(0, '09:00'),
      subject: `${d.alias} — ${co} ${ag}`,
      body: ours(firstName(counsel), `Could you send ${poss(co)} redline of the ${ag}?`),
    });
    const a = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: t(0, '11:40'),
      subject: mb.reSubject(req), replyTo: req,
      body: body('Hi,', g
        ? `Our v2 is attached: ${positionsList(A, ['cap', 'term', 'renewal', 'law', 'dpa'])}.`
        : r.pick([
          `v2 attached. Main points: ${positionsList(A, ['cap', 'term', 'renewal', 'law'])}.`,
          `Here is our redline${withPdf ? ' (v2, attached)' : ''}: ${positionsList(A, ['cap', 'term', 'renewal', 'law', 'dpa'])}.`,
          `${withPdf ? 'Please find v2 attached. ' : ''}Summary: ${positionsList(A, ['term', 'renewal', 'cap', 'law'])}.`,
        ]), counselSig(d)),
      attachments: withPdf ? [{ filename: file, content_type: 'application/pdf', lines: redlineLines(d, { version: 'v2', date: d.start, c: A }) }] : undefined,
    });
    const gcAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [gc.address], at: t(0, '12:30'), subject: `${d.alias} — sign-off`, body: ours(firstName(gc), `Negotiating the ${co} ${ag}. Am I cleared to close if everything ends within playbook?`) });
    const approval = mb.add({ direction: 'inbound', from: gc.address, fromName: shortName(gc), to: [self.address], at: t(0, '14:50'), subject: mb.reSubject(gcAsk), replyTo: gcAsk, body: body(g ? `Yes. Within playbook you're cleared; cap floor ${d.floor} months' fees.` : r.pick([`Cleared to close within playbook. Floor on the cap: ${d.floor} months' fees.`, `Yes, if it lands within playbook (cap at least ${d.floor} months).`, `Approved within playbook; nothing below ${d.floor} months on the cap.`]), firstName(gc)) });
    legalBackground(r, d, mb, t(0, '12:00'), t(0, '15:20'), nBackground, g ? 0 : r.int(0, 7));
    const haggle = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: t(0, '15:30'),
      subject: mb.reSubject(req), replyTo: a,
      body: ours(firstName(counsel), g ? `Thanks. Given the data involved, we need more on the cap than ${show('cap', A.cap)}. Can you move?` : r.pick([`Thanks for v2. Is there room to raise the cap above ${A.cap} months?`, `Our risk team wants a higher cap than ${show('cap', A.cap)}. What can you do?`, `Can ${co} improve the cap in ${SECTION.cap}?`])),
    });

    // ---- B: three clauses change at once
    const bAt = t(1, g ? '10:15' : r.pick(['09:30', '10:15', '11:50']));
    const b = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: bAt,
      subject: mb.reSubject(req), replyTo: haggle,
      body: body('Hi,', g
        ? `We can go to ${show('cap', B.cap)} on the cap, but only with a ${B.term}-month initial term and ${B.renewalNotice} days' notice of non-renewal.`
        : r.pick([
          `Best we can do: a cap of ${show('cap', B.cap)}, if Acme commits to ${B.term} months and accepts ${B.renewalNotice} days' non-renewal notice.`,
          `Counter: ${SECTION.cap} at ${B.cap} months' fees, ${SECTION.term} at ${B.term} months, and ${SECTION.renewal} non-renewal notice of ${B.renewalNotice} days.`,
          `If we lengthen the initial term to ${B.term} months and the non-renewal notice to ${B.renewalNotice} days, we can raise the cap to ${B.cap} months' fees.`,
        ]), firstName(counsel)),
    });
    legalChatter(r, d, mb, later(bAt, 15), later(bAt, 110), nChatter, g ? 0 : r.int(0, 9));

    // ---- C: one clause reverts
    let push: string | null = null;
    const pushAt = later(bAt, 120);
    if (revert === 'renewalNotice') {
      push = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: pushAt, subject: mb.reSubject(req), replyTo: b, body: ours(firstName(counsel), g ? `The cap and the ${B.term}-month term work for us, but ${B.renewalNotice} days' non-renewal notice is outside our policy (${d.maxNotice} days max). Can you go back to ${A.renewalNotice}?` : r.pick([`We can live with ${show('cap', B.cap)} and ${B.term} months, but not ${B.renewalNotice} days' non-renewal notice; our maximum is ${d.maxNotice}. Can we keep ${A.renewalNotice}?`, `${B.renewalNotice} days on non-renewal won't pass our policy. Could you keep v2's ${A.renewalNotice} days, with the rest of your counter?`])) });
    }
    const cAt = t(2, g ? '09:20' : r.pick(['09:05', '09:20', '13:45']));
    const cText: Record<Key, string[]> = {
      renewalNotice: [
        `OK: non-renewal notice goes back to ${A.renewalNotice} days. ${show('cap', B.cap)} and the ${B.term}-month term as offered. Shall I prepare the execution version?`,
        `Agreed, ${A.renewalNotice} days' non-renewal notice as in v2. Cap ${B.cap} months and ${B.term}-month term stand. Want me to turn the execution copy?`,
        `We can accept ${A.renewalNotice} days on non-renewal. The rest of my counter is unchanged. Shall we move to signature?`,
      ],
      term: [
        `Our CFO won't sign up to a ${B.term}-month term, so ${SECTION.term} goes back to ${A.term} months. The ${B.cap}-month cap and ${B.renewalNotice}-day non-renewal notice stand.`,
        `Change on our side: the initial term reverts to ${A.term} months as in v2. Everything else in my counter (cap ${B.cap} months, ${B.renewalNotice} days' notice) is unchanged.`,
        `We'd rather keep the term at ${A.term} months after all. The rest of my last email stands.`,
      ],
      cap: [
        `Apologies, our insurers won't support ${B.cap} months, so the cap goes back to ${show('cap', A.cap)}. The ${B.term}-month term and ${B.renewalNotice} days' non-renewal notice stand.`,
        `I have to walk back the cap: it stays at ${A.cap} months' fees as in v2. Term ${B.term} months and ${B.renewalNotice}-day notice remain as offered.`,
        `Sorry, the higher cap was not signed off. ${SECTION.cap} is ${A.cap} months again; the rest of my counter is unchanged.`,
      ],
    };
    const c = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: cAt,
      subject: mb.reSubject(req), replyTo: push ?? b,
      body: body('Hi,', g ? cText.renewalNotice[0] : r.pick(cText[revert]), firstName(counsel)),
    });

    // ---- oracle: per-clause history
    const others = clauseTerms(counsel.address, C, () => [a], { keys: (withPdf ? ['law', 'notice', 'renewal', 'dpa', 'net', 'conf'] : ['law', 'renewal']) as ClauseKey[] });
    const terms: OracleTerm[] = [];
    const superseded: OracleSuperseded[] = [];
    for (const k of keys) {
      const reverted = k === revert;
      terms.push({ party: counsel.address, term: TERM[k], status: 'current', value: C[k], evidence: reverted ? [a, c] : [b, c], critical: CRITICAL.has(k) || k === 'renewalNotice', display: show(k, C[k]) });
      if (reverted) superseded.push({ party: counsel.address, term: TERM[k], value: B[k], display: `${show(k, B[k])} (counter)`, evidence: [b], superseded_by: c });
      else superseded.push({ party: counsel.address, term: TERM[k], value: A[k], display: `${show(k, A[k])} (v2)`, evidence: [a], superseded_by: b });
    }
    terms.push(...others);
    terms.push({ party: gc.address, term: 'approval.liability_floor_months', status: 'current', value: d.floor, evidence: [approval], display: `GC floor: ${d.floor} months' fees` });
    const breach = violation(d, 'renewalNotice', C);
    const conflicts: OracleConflict[] = breach ? [{ kind: 'requirement_violation', term: TERM.renewalNotice, party: counsel.address, display: breach, critical: true }] : [];
    const stale = keys.filter((k) => k !== revert).map((k) => TERM[k]);
    const documents: OracleDocument[] = withPdf ? [{ filename: file, status: 'partially_stale', stale_terms: stale, display: `${file}: ${keys.filter((k) => k !== revert).map((k) => CLAUSE[k]).join(' and ')} superseded; the ${CLAUSE[revert]} matches the current value again` }] : [];
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: counsel.address, subject: 'document.redline', display: 'Vendor redline (v2 received)', evidence: [req, a] },
      { kind: 'ask', debtor: counsel.address, subject: TERM.cap, alt_subjects: ['answer.clause_question'], display: 'Room on the cap? (answered with the bundled counter)', evidence: [haggle, b] },
      { kind: 'ask', debtor: gc.address, subject: 'approval.gc_signoff', alt_subjects: ['approval.liability_floor_months'], display: 'GC clearance within playbook (given)', evidence: [gcAsk, approval] },
    ];
    if (push) closed_loops.push({ kind: 'ask', debtor: counsel.address, subject: TERM.renewalNotice, alt_subjects: ['answer.clause_question'], display: 'Our push-back on the 90-day notice (accepted)', evidence: [push, c] });
    const open_loops: OracleLoop[] = revert === 'renewalNotice' ? [{ kind: 'ask', debtor: self.address, subject: 'decision.execute', alt_subjects: ['document.execution_version'], display: 'Counsel asks whether to prepare the execution version', evidence: [c] }] : [];

    const current = keys.map((k) => show(k, C[k])).join(', ');
    const dead = superseded.map((x) => x.display).join('; ');
    const prohibited: ActionCond[] = [
      { id: 'stale_value', text: staleText(`Treats a superseded value as the current position (${superseded.map((x) => x.display.replace(/ \((counter|v2)\)$/, '')).join(' / ')})`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    if (breach) prohibited.unshift({ id: 'binding_accept', text: `Accepts the counter or agrees to execute with ${C.renewalNotice} days' non-renewal notice`, det: { type: 'binding_to', party: counsel.address } });
    const checkpoint: Checkpoint = {
      id: 'after_chain', after: c, now: later(cAt, 20),
      state: { terms, superseded, open_loops, closed_loops, conflicts, documents, next_actor: 'us' },
      judge_facts: [
        `v2: cap ${show('cap', A.cap)}, ${A.term}-month term, ${A.renewalNotice} days' non-renewal notice. Counter: cap ${show('cap', B.cap)}, ${B.term}-month term, ${B.renewalNotice} days' notice. Then the ${CLAUSE[revert]} reverted to the v2 value.`,
        `Current: ${current}. Dead values: ${dead}.`,
        breach ? `${breach[0].toUpperCase()}${breach.slice(1)}, so the deal is still outside playbook.` : `Every clause is within Acme's playbook, the General Counsel cleared a within-playbook deal, and counsel asks whether to prepare the execution version.`,
      ].join(' '),
      action: breach
        ? {
          expect: 'send',
          required: [
            { id: 'to_counsel', text: `Sends a message to ${shortName(counsel)}`, det: { type: 'message_to', party: counsel.address } },
            { id: 'push_back', text: `Tells counsel the ${C.renewalNotice}-day non-renewal notice exceeds Acme's ${d.maxNotice}-day maximum and asks for ${d.maxNotice} days or less` },
          ],
          optional: [{ id: 'restate_current', text: `Restates the current cap and term correctly (${show('cap', C.cap)}, ${C.term} months)` }],
          prohibited,
        }
        : {
          expect: 'send',
          required: [
            { id: 'to_counsel', text: `Sends a message to ${shortName(counsel)}`, det: { type: 'message_to', party: counsel.address } },
            { id: 'proceed_current', text: `Proceeds on the current terms (${current}), e.g. asks counsel to prepare the execution version` },
          ],
          optional: [],
          prohibited,
        },
    };

    return legalCase(supersession_chain, variant, {
      description: `A (cap ${A.cap}, ${A.term} mo, ${A.renewalNotice}d) → bundled B (cap ${B.cap}, ${B.term} mo, ${B.renewalNotice}d) → ${revert} reverts.`,
      task: d.task, mb, trigger: c, checkpoint,
      params: { revert, A, B, C, withPdf, nBackground, nChatter, file, floor: d.floor },
    });
  },
};
