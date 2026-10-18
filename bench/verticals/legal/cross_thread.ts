// Archetype: cross-thread fact (P1).
//
// Vendor counsel sends the near-final v3 positions in one thread; the decisive second fact arrives in a
// brand-new thread (not a reply) that is linked to the matter only by its number, written however the
// sender likes ("LGL-4417", "LGL 4417", "matter 4417"). Usually it is the General Counsel's sign-off
// with a cap floor; in some variants it is counsel's v3 itself that arrives as a fresh email while the
// sign-off is threaded. The same counsel and the same GC are also handling a look-alike matter (two
// digits swapped: the vendor's order form for another project) with a 6-month cap, California law and
// a higher GC floor, mailed in the same hours.
//
// Trap: a thread-scoped agent never sees the sign-off ("waiting on GC") or never sees v3; a keyword /
// RAG agent pulls the look-alike matter's numbers and concludes the cap is below the floor or the law
// is wrong. The oracle puts both facts in one task state, v3 within playbook and the GC floor met, no
// conflict; the right action moves the agreement forward with counsel without re-asking GC.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleLoop } from '../../core/types.ts';
import { MailBuilder, Rand, body, reaskText, seedOf } from '../../core/util.ts';
import {
  type ClauseKey, type Clauses, aliasForms, clauseTerms, counselSig, draftFile, firstName, later, legalBackground, legalCase, legalChatter, legalDayStart, legalDeal, lookalikeAlias, lookalikeProject, ours,
  poss, positionsList, redlineLines, shortName,
} from './vertical.ts';

export const cross_thread: Archetype = {
  id: 'cross_thread',
  title: 'GC sign-off arrives in a new thread linked only by the matter number',
  capabilities: ['cross_thread'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('legal', 'cross_thread', variant));
    const g = variant === 0;
    const d = legalDeal(r, variant);
    const { self, counsel, gc } = d.cast;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => legalDayStart(d, day, hhmm);
    const ag = d.agreement.short;
    const co = d.company;

    // ---- parameters
    const crossFact: 'approval' | 'redline' = g ? 'approval' : r.pick(['approval', 'approval', 'redline'] as const);
    const askedGc = g ? true : crossFact === 'redline' ? true : r.chance(0.6);
    const approvalFirst = g ? false : r.chance(0.4);
    const form = g ? d.alias : r.pick(aliasForms(d.alias).slice(1));
    const look = lookalikeAlias(d.alias);
    const project = lookalikeProject(d.alias);
    const lookFloor = d.floor + 12; // the look-alike matter's floor is above our cap
    const v3: Clauses = { ...d.base, cap: g ? 12 : d.floor + r.pick([0, 0, 6]) };
    const withPdf = g ? false : r.chance(0.5);
    const nBackground = g ? 2 : r.int(2, 5);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = draftFile(r, d, 'v3', g);

    // ---- history
    const req = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: t(0, '09:00'),
      subject: `${d.alias} — ${co} ${ag}: v3`,
      body: ours(firstName(counsel), `Thanks for the call. Could you send v3 of the ${ag} with the positions we agreed?`),
    });
    let gcAsk: string | null = null;
    if (askedGc) {
      gcAsk = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [gc.address], at: t(0, '09:20'),
        subject: g ? `Sign-off request — ${d.alias}` : r.pick([`Sign-off request — ${d.alias}`, `Approval needed: ${co} ${ag}`, `${d.alias} sign-off`]),
        body: ours(firstName(gc), `We are close on the ${co} ${ag} (${d.alias}): ${positionsList(v3, ['cap', 'law', 'notice', 'dpa'])}. Can you sign off?`),
      });
    }
    legalBackground(r, d, mb, t(0, '09:40'), t(0, '12:30'), nBackground, g ? 0 : r.int(0, 7));

    const v3At = approvalFirst ? t(1, r.pick(['10:40', '11:15'])) : t(0, g ? '14:10' : r.pick(['13:30', '14:10', '15:45']));
    const approvalAt = approvalFirst ? t(0, r.pick(['15:20', '16:40'])) : t(1, g ? '09:45' : r.pick(['09:45', '10:30', '11:50']));

    const tpl = g ? -1 : r.int(0, 2);
    const statedKeys: ClauseKey[][] = [['cap', 'law', 'notice', 'dpa'], ['cap', 'notice', 'renewal', 'law', 'dpa'], ['cap', 'law', 'notice', 'dpa']];
    const keys: ClauseKey[] = tpl < 0 ? ['cap', 'law', 'notice', 'renewal', 'dpa'] : statedKeys[tpl];
    const v3Body = g
      ? body('Hi,', `${d.alias}: v3 reflects our call: ${positionsList(v3, keys)}.`, 'If Acme is good with v3, we can prepare the execution version.', counselSig(d))
      : body(r.pick(['Hi,', 'Hello,']), [
        `${crossFact === 'redline' ? `Re ${form}: ` : ''}v3 is ${withPdf ? 'attached' : 'below'}. Positions: ${positionsList(v3, keys)}.`,
        `Here is where v3 lands${crossFact === 'redline' ? ` on ${form}` : ''}: ${positionsList(v3, keys.filter((k) => k !== 'dpa'))}, with the DPA as Exhibit C.`,
        `Final positions for ${form}: ${positionsList(v3, keys)}.${withPdf ? ' Clean v3 attached.' : ''}`,
      ][tpl], r.pick(['Let me know if we can move to signature.', 'If this works, I will send the execution version.', 'Just confirm and we will paper it.']), firstName(counsel));
    const draft = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: v3At,
      subject: crossFact === 'redline' ? r.pick([`${form} — v3`, `v3 for ${form}`, `${form}: final positions`]) : mb.reSubject(req),
      replyTo: crossFact === 'redline' ? null : req,
      body: v3Body,
      attachments: withPdf ? [{ filename: file, content_type: 'application/pdf', lines: redlineLines(d, { version: 'v3', date: v3At.slice(0, 10), c: v3 }) }] : undefined,
    });
    mb.add({
      background: true, direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: later(v3At, approvalFirst ? -r.int(6, 25) : r.int(6, 25)),
      subject: `${look} — ${project} order form`,
      body: body('Hi,', `${look} (${project} order form): our positions are a cap of 6 months' fees and California law.`, firstName(counsel)),
      note: 'look-alike matter with the same counsel (digits swapped): must not bleed in',
    });

    const approvalText = g
      ? `${d.alias}: approved. Cap floor ${d.floor} months' fees.`
      : r.pick([
        `${form} is approved. My floor on the cap is ${d.floor} months' fees.`,
        `Sign-off for ${form}: approved, cap no lower than ${d.floor} months. Go ahead when ready.`,
        `GC approval on ${form}: OK to execute within playbook, floor ${d.floor} months' fees.`,
      ]);
    const approval = mb.add({
      direction: 'inbound', from: gc.address, fromName: shortName(gc), to: [self.address], at: approvalAt,
      subject: crossFact === 'approval' ? (g ? `${d.alias} approval` : r.pick([`${form} approval`, `Approved: ${form}`, `Re ${form}`])) : mb.reSubject(gcAsk!),
      replyTo: crossFact === 'approval' ? null : gcAsk,
      body: body(approvalText.replace(/^./, (x) => x.toUpperCase()), `${firstName(gc)}\nGeneral Counsel`),
    });
    mb.add({
      background: true, direction: 'inbound', from: gc.address, fromName: shortName(gc), to: [self.address], at: later(approvalAt, approvalFirst ? r.int(4, 30) : -r.int(4, 30)),
      subject: `${look} approval`,
      body: body(`${look}: approved, but do not go below a ${lookFloor}-month cap on that one.`, firstName(gc)),
      note: 'look-alike matter approval: higher floor, different matter number',
    });
    const first = v3At < approvalAt ? v3At : approvalAt;
    const second = v3At < approvalAt ? approvalAt : v3At;
    legalChatter(r, d, mb, later(first, 40), later(second, -10), nChatter, g ? 0 : r.int(0, 9));

    const trigger = approvalFirst ? draft : approval;
    const trigAt = approvalFirst ? v3At : approvalAt;

    // ---- oracle
    const stated = clauseTerms(counsel.address, v3, () => [draft], withPdf ? {} : { keys: keys.includes('renewal') ? [...keys, 'renewalNotice'] : keys });
    stated.push({ party: gc.address, term: 'approval.liability_floor_months', status: 'current', value: d.floor, evidence: [approval], critical: true, display: `GC floor: ${d.floor} months' fees` });
    const closed_loops: OracleLoop[] = [{ kind: 'ask', debtor: counsel.address, subject: 'document.redline', display: 'v3 requested (received)', evidence: [req, draft] }];
    if (gcAsk) closed_loops.push({ kind: 'ask', debtor: gc.address, subject: 'approval.gc_signoff', alt_subjects: ['approval.liability_floor_months'], display: 'GC sign-off (given in a separate thread)', evidence: [gcAsk, approval] });
    const open_loops: OracleLoop[] = [{ kind: 'ask', debtor: self.address, subject: 'decision.execute', alt_subjects: ['document.execution_version'], display: 'Counsel is waiting for our go-ahead to prepare the execution version', evidence: [draft] }];

    const prohibited: ActionCond[] = [
      { id: 'reask_gc', text: reaskText('Asks the General Counsel again for sign-off (already given)') },
      { id: 'claims_unapproved', text: 'Tells anyone that GC sign-off is still pending' },
      { id: 'lookalike_bleed', text: `Uses figures from the other matter ${look} (a 6-month cap, California law, or a ${lookFloor}-month floor) for ${d.alias}` },
      { id: 'cap_below_floor', text: `Claims the ${v3.cap}-month cap is below the approved floor or outside playbook` },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    const checkpoint: Checkpoint = {
      id: 'after_both_facts', after: trigger, now: later(trigAt, 20),
      state: {
        terms: stated, superseded: [], open_loops, closed_loops, conflicts: [],
        documents: withPdf ? [{ filename: file, status: 'current', stale_terms: [], display: `${file}: current` }] : [],
        next_actor: 'us',
      },
      judge_facts: [
        `${poss(co)} v3 for ${d.alias}: ${positionsList(v3, ['cap', 'law', 'notice', 'dpa'])}; counsel is waiting for Acme's go-ahead.`,
        `The General Counsel approved ${d.alias} with a cap floor of ${d.floor} months' fees in a ${crossFact === 'approval' ? 'separate, new' : 'separate'} email thread, so v3 is within playbook and approved.`,
        `${look} is a different matter (6-month cap, California law, ${lookFloor}-month floor) and is irrelevant here.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_counsel', text: `Sends a message to ${shortName(counsel)}`, det: { type: 'message_to', party: counsel.address } },
          { id: 'proceed', text: `Moves ${d.alias} forward on the v3 terms (cap ${v3.cap} months' fees): accepts v3, asks for the execution version, or says Acme is ready to sign` },
        ],
        optional: [{ id: 'tell_gc', text: 'Lets the General Counsel know the agreement is going to signature' }],
        prohibited,
      },
    };

    return legalCase(cross_thread, variant, {
      description: `v3 and GC sign-off for ${d.alias} sit in different threads (${crossFact} is a fresh thread, matter written "${form}"); look-alike ${look} in the same inbox.`,
      task: d.task, mb, trigger, checkpoint,
      params: { crossFact, askedGc, approvalFirst, form, look, lookFloor, v3, withPdf, nBackground, nChatter, floor: d.floor },
    });
  },
};
