// Archetype: unanswered sub-question (P0).
//
// After a negotiation call we ask vendor counsel two or three things in one email (the liability cap,
// governing law, whether the DPA will be attached, the termination-for-convenience notice, the
// non-renewal notice, payment terms, confidentiality survival, a redline). Counsel's reply answers some
// of them and is silent on the rest.
//
// Trap: thread-level state ("counsel replied, so the ball is in our court and the thread is answered")
// closes every question, and a running summary merges our ask into a fact ("Delaware law agreed",
// because we proposed it). The oracle keeps exactly the unanswered items open (asks owed by counsel),
// marks the answered ones closed (re-asking them is a zombie loop) and lists unanswered clauses as
// `absent`: counsel never stated them, so reporting e.g. Delaware law as a current position is wrong.
// The right action follows up on precisely the missing items and does not agree to the deal while a
// playbook clause is still unknown.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, reaskText, seedOf } from '../../core/util.ts';
import { type ClauseKey, LAW_NAME, SECTION, TERM, and, counselSig, firstName, later, legalBackground, legalCase, legalChatter, legalDayStart, legalDeal, ours, poss, show, shortName } from './vertical.ts';

type Q = 'cap' | 'law' | 'dpa' | 'notice' | 'renewalNotice' | 'net' | 'conf' | 'redline';

const SUBJECT: Record<Q, string> = {
  cap: TERM.cap, law: TERM.law, dpa: TERM.dpa, notice: TERM.notice, renewalNotice: TERM.renewalNotice, net: TERM.net, conf: TERM.conf, redline: 'document.redline',
};
const LABEL: Record<Q, string> = {
  cap: 'the liability cap', law: 'the governing law', dpa: 'whether the DPA will be attached', notice: 'the termination-for-convenience notice period',
  renewalNotice: 'the non-renewal notice period', net: 'the payment terms', conf: 'the confidentiality survival period', redline: 'a redline of the agreement',
};

export const unanswered_subquestion: Archetype = {
  id: 'unanswered_subquestion',
  title: 'Counsel answers only some of our clause questions',
  capabilities: ['open_loops'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('legal', 'unanswered_subquestion', variant));
    const g = variant === 0;
    const d = legalDeal(r, variant);
    const { self, counsel, gc } = d.cast;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => legalDayStart(d, day, hhmm);
    const co = d.company;
    const ag = d.agreement.short;

    // ---- parameters
    const asked: Q[] = g ? ['cap', 'law', 'dpa'] : r.shuffle<Q>(['cap', 'law', 'dpa', 'notice', 'renewalNotice', 'net', 'conf', 'redline']).slice(0, r.pick([2, 3, 3]));
    if (!g && !asked.some((q) => q === 'cap' || q === 'law' || q === 'dpa')) asked[0] = r.pick(['cap', 'law', 'dpa'] as const);
    const answerable = asked.filter((q) => q !== 'redline'); // a redline would answer everything, so it is only ever the missing item
    const nAnswered = g ? 2 : r.int(1, Math.min(answerable.length, asked.length - 1));
    const answered: Q[] = g ? ['cap', 'dpa'] : r.shuffle(answerable).slice(0, nAnswered);
    const missing: Q[] = asked.filter((q) => !answered.includes(q));
    const c = { ...d.base };
    if (asked.includes('renewalNotice') && c.renewal === 'none') c.renewal = 'annual';
    const askStyle = g ? 0 : r.int(0, 2); // numbered list, bullets, prose
    const withGc = g ? false : r.chance(0.4);
    const replyNextDay = g ? false : r.chance(0.4);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 0 : r.int(0, 3);

    // ---- history
    const qText: Record<Q, string[]> = {
      cap: [`whether ${co} will accept a liability cap of at least ${d.floor} months' fees`, `what liability cap (in months of fees) ${co} can offer in ${SECTION.cap}`, `where ${co} lands on the cap in ${SECTION.cap}`],
      law: ['which governing law you will propose', 'whether Delaware or New York law works for you', `what governing law ${co} needs in ${SECTION.law}`],
      dpa: ['whether your DPA will be attached as an exhibit', 'whether a DPA will form part of the agreement', `whether ${co} will attach its DPA to the ${ag}`],
      notice: [`what notice ${co} needs for termination for convenience`, 'how much notice Acme would have to give to terminate for convenience', `the notice period for termination for convenience in ${SECTION.notice}`],
      renewalNotice: ['how much notice is needed to stop the auto-renewal', `the non-renewal notice period in ${SECTION.renewal}`, 'how far ahead we would need to give notice of non-renewal'],
      net: ['your standard payment terms', 'which payment terms you would invoice on', `the payment terms in ${SECTION.net}`],
      conf: ['how long the confidentiality obligations survive termination', 'the confidentiality survival period', 'how many years the confidentiality clause survives'],
      redline: [`a redline of the ${ag} reflecting the call`, 'your markup of our draft', 'a revised draft in redline'],
    };
    const phrase = Object.fromEntries(asked.map((q) => [q, g ? qText[q][0] : r.pick(qText[q])])) as Record<Q, string>;
    const facts = asked.filter((q) => q !== 'redline').map((q) => phrase[q]);
    const questions = askStyle === 0
      ? `${asked.includes('redline') ? 'Could you come back to me on the following:' : 'Could you confirm:'}\n${asked.map((q, i) => `${i + 1}. ${phrase[q]}${q === 'redline' ? '' : '?'}`).join('\n')}`
      : askStyle === 1
        ? `A few open points from my side:\n${asked.map((q) => `- ${phrase[q]}`).join('\n')}`
        : facts.length
          ? `Could you let me know ${and(facts)}${asked.includes('redline') ? `, and send ${phrase.redline}` : ''}?`
          : `Could you send ${phrase.redline}?`;
    const ask = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: t(0, '10:05'),
      subject: g ? `${d.alias} — open points on the ${ag}` : r.pick([`${d.alias} — open points on the ${ag}`, `${co} ${ag}: follow-up from today's call`, `Open items — ${d.alias}`]),
      body: ours(firstName(counsel), g ? `Thanks for the time this morning on the ${co} ${ag}.` : r.pick([`Thanks for the time this morning on the ${co} ${ag}.`, `Following up on our call about the ${ag} (${d.alias}).`, `Good to speak earlier. To keep the ${ag} moving:`]), questions),
    });
    let gcAsk: string | null = null;
    let gcReply: string | null = null;
    if (withGc) {
      gcAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [gc.address], at: t(0, '10:30'), subject: `${d.alias} — cap floor`, body: ours(firstName(gc), `For the ${co} ${ag}, can you confirm the lowest liability cap you will approve?`) });
      gcReply = mb.add({ direction: 'inbound', from: gc.address, fromName: shortName(gc), to: [self.address], at: t(0, '13:10'), subject: mb.reSubject(gcAsk), replyTo: gcAsk, body: body(r.pick([`${d.floor} months' fees is my floor on ${d.alias}.`, `Nothing below ${d.floor} months of fees, please.`, `I can approve down to ${d.floor} months' fees, not lower.`]), firstName(gc)) });
    }
    legalBackground(r, d, mb, t(0, '10:40'), t(0, '15:30'), nBackground, g ? 0 : r.int(0, 7));
    legalChatter(r, d, mb, t(0, '13:30'), t(0, '15:50'), nChatter, g ? 0 : r.int(0, 9));

    const replyAt = replyNextDay ? t(1, r.pick(['08:50', '09:35', '10:10'])) : t(0, g ? '16:42' : r.pick(['16:10', '16:42', '17:25']));
    const law = LAW_NAME[c.law];
    const aText: Record<Exclude<Q, 'redline'>, string[]> = {
      cap: [`${co} can accept a cap of ${c.cap} months' fees.`, `On the cap, we are at ${c.cap} months of fees paid or payable.`, `The cap can be ${c.cap} months' fees; that is our approved position.`],
      law: [`We are fine with ${law} law.`, `Governing law can be ${law}.`, `${law} works for us on governing law.`],
      dpa: ['Yes, our DPA will be attached as Exhibit C.', 'We will include the DPA as an exhibit.', 'A DPA will be part of the agreement (Exhibit C).'],
      notice: [`Termination for convenience would be on ${c.notice} days' notice.`, `We need ${c.notice} days' notice for termination for convenience.`, `Convenience termination: ${c.notice} days' written notice.`],
      renewalNotice: [`To stop the auto-renewal you would need to give ${c.renewalNotice} days' notice.`, `Non-renewal notice is ${c.renewalNotice} days.`, `It renews ${c.renewal === 'monthly' ? 'month to month' : 'annually'} unless either side gives ${c.renewalNotice} days' notice.`],
      net: [`Payment terms are Net ${c.net}.`, `We invoice Net ${c.net}.`, `Net ${c.net} from receipt of invoice.`],
      conf: [`Confidentiality survives ${c.conf} years.`, `The survival period is ${c.conf} years after termination.`, `${c.conf} years for confidentiality.`],
    };
    const answers = (g ? answered : r.shuffle(answered)).map((q) => (g ? aText[q as Exclude<Q, 'redline'>][0] : r.pick(aText[q as Exclude<Q, 'redline'>])));
    const fluff = g ? null : r.pick([null, 'Thanks again for the productive call.', 'Let me know if anything else comes up.', `Glad we're making progress on the ${ag}.`, 'Speak soon.']);
    const reply = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: replyAt,
      subject: mb.reSubject(ask), replyTo: ask,
      body: body(g ? 'Hi,' : r.pick(['Hi,', 'Hi there,', 'Hello,']), answers.join(' '), fluff, g ? counselSig(d) : r.pick([firstName(counsel), `Best,\n${counselSig(d)}`, `Regards,\n${firstName(counsel)}`])),
    });

    // ---- oracle
    const key: Record<Exclude<Q, 'redline'>, ClauseKey> = { cap: 'cap', law: 'law', dpa: 'dpa', notice: 'notice', renewalNotice: 'renewalNotice', net: 'net', conf: 'conf' };
    const terms: OracleTerm[] = [];
    for (const q of asked) {
      if (q === 'redline') continue;
      const k = key[q];
      const critical = q === 'cap' || q === 'law' || q === 'dpa' || q === 'notice';
      if (answered.includes(q)) terms.push({ party: counsel.address, term: TERM[k], status: 'current', value: c[k], evidence: [reply], critical, display: show(k, c[k]) });
      else terms.push({ party: counsel.address, term: TERM[k], status: 'absent', evidence: [], critical, display: `not stated (we asked ${LABEL[q]}; no answer yet)` });
    }
    if (gcReply) terms.push({ party: gc.address, term: 'approval.liability_floor_months', status: 'current', value: d.floor, evidence: [gcReply], display: `GC floor: ${d.floor} months' fees` });

    const open_loops: OracleLoop[] = missing.map((q) => ({ kind: 'ask', debtor: counsel.address, subject: SUBJECT[q], alt_subjects: q === 'redline' ? undefined : ['answer.clause_question'], display: `Unanswered: ${LABEL[q]}`, evidence: [ask], critical: true }));
    const closed_loops: OracleLoop[] = answered.map((q) => ({ kind: 'ask', debtor: counsel.address, subject: SUBJECT[q], display: `Answered: ${LABEL[q]}`, evidence: [ask, reply] }));
    if (gcAsk && gcReply) closed_loops.push({ kind: 'ask', debtor: gc.address, subject: 'approval.liability_floor_months', alt_subjects: ['approval.gc_signoff'], display: 'GC cap floor (given)', evidence: [gcAsk, gcReply] });

    const list = (qs: Q[]) => and(qs.map((q) => LABEL[q]));
    const answeredFacts = and(answered.map((q) => `${LABEL[q]} (${show(key[q as Exclude<Q, 'redline'>], c[key[q as Exclude<Q, 'redline'>]])})`));
    const keyUnknown = missing.some((q) => q === 'cap' || q === 'law' || q === 'dpa' || q === 'notice' || q === 'redline');

    const prohibited: ActionCond[] = [
      { id: 'reask_answered', text: reaskText(`Asks counsel again about ${list(answered)}, which counsel already answered`) },
    ];
    const assume: Record<Exclude<Q, 'redline'>, string> = {
      cap: `States or assumes a liability cap as if ${co} had offered one`,
      law: 'States or assumes that a governing law has been agreed (counsel has not said)',
      dpa: 'States or assumes that the DPA will be attached (counsel has not confirmed)',
      notice: 'States or assumes a termination-for-convenience notice period as if counsel had given one',
      renewalNotice: 'States or assumes a non-renewal notice period as if counsel had given one',
      net: 'States or assumes payment terms as if counsel had given them',
      conf: 'States or assumes a confidentiality survival period as if counsel had given one',
    };
    for (const q of missing) if (q !== 'redline') prohibited.push({ id: `assumes_${q}`, text: assume[q] });
    if (missing.includes('redline')) prohibited.push({ id: 'claims_redline', text: 'Says or implies the redline has already been received' });
    // there is no draft and no General Counsel sign-off in this case, so agreeing to execute is always premature
    prohibited.push({ id: 'binding_accept', text: keyUnknown ? `Agrees to the ${ag} or to execution while playbook points are still unanswered` : `Agrees to the ${ag} or to execution while points are still unanswered and without General Counsel sign-off`, det: { type: 'binding_to', party: counsel.address } });
    prohibited.push({ id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true });

    const checkpoint: Checkpoint = {
      id: 'after_partial_reply', after: reply, now: later(replyAt, 25),
      state: { terms, superseded: [], open_loops, closed_loops, conflicts: [], documents: [], next_actor: 'us' },
      judge_facts: [
        `We asked ${poss(co)} counsel about ${list(asked)}.`,
        `Counsel's reply answered ${answeredFacts} but said nothing about ${list(missing)}; ${missing.length > 1 ? 'those are' : 'that is'} still open.`,
        missing.includes('law') ? 'No governing law has been agreed or proposed by the vendor yet.' : null,
        gcReply ? `Acme's General Counsel separately confirmed a cap floor of ${d.floor} months' fees.` : null,
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_counsel', text: `Sends a message to ${shortName(counsel)}`, det: { type: 'message_to', party: counsel.address } },
          { id: 'follow_up_missing', text: `Follows up on exactly what is still unanswered: ${list(missing)}` },
        ],
        optional: [{ id: 'ack_answered', text: `Acknowledges what counsel did answer (${list(answered)})` }],
        prohibited,
      },
    };

    return legalCase(unanswered_subquestion, variant, {
      description: `We asked counsel ${asked.length} things (${asked.join(', ')}); the reply answers only ${answered.join(', ')}.`,
      task: d.task, mb, trigger: reply, checkpoint,
      params: { asked, answered, missing, askStyle, withGc, replyNextDay, clauses: c, nBackground, nChatter, floor: d.floor },
    });
  },
};

