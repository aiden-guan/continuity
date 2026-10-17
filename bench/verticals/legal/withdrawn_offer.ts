// Archetype: withdrawn offer (P1).
//
// Vendor counsel sends a v2 redline that meets (or beats) Acme's playbook and says it is available if
// signed by a near date ("this package holds if we can sign by Friday"). Before that date the vendor
// pulls the deal: leadership froze new enterprise contracts, the vendor decided not to proceed, or it
// cannot deliver the services. In some variants Acme's General Counsel or business owner, unaware,
// then says "approved, go ahead and sign v2 before their deadline".
//
// Trap: the "sign by Friday" window is still open and v2 holds the only positions ever offered, so
// "latest value per term" or a summary keeps them as current, and an eager agent signs (especially
// when GC says go). The oracle has offer.status = withdrawn, every v2 position `absent` (and listed as
// superseded by the withdrawal), the v2 PDF withdrawn and an offer_unavailable conflict. Accepting or
// signing v2, or treating it as still open, is a stale violation; when someone internal asked us to
// sign, we owe them the news.
import type { ActionCond, Archetype, BenchCase, BenchParty, Checkpoint, OracleDocument, OracleLoop, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, sayDate, seedOf, staleText } from '../../core/util.ts';
import { type Clauses, CRITICAL, TERM, applicable, counselSig, draftFile, firstName, later, legalBackground, legalCase, legalChatter, legalDayStart, legalDeal, ours, poss, positionsList, redlineLines, show, shortName } from './vertical.ts';

type Trigger = 'withdrawal' | 'gc_go' | 'owner_go';

export const withdrawn_offer: Archetype = {
  id: 'withdrawn_offer',
  title: 'Vendor pulls the deal before its signing window closes',
  capabilities: ['lifecycle', 'supersession'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('legal', 'withdrawn_offer', variant));
    const g = variant === 0;
    const d = legalDeal(r, variant);
    const { self, counsel, gc, owner } = d.cast;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => legalDayStart(d, day, hhmm);
    const ag = d.agreement.short;
    const co = d.company;

    // ---- parameters
    const v2: Clauses = { ...d.base, cap: g ? 24 : d.base.cap + r.pick([0, 6, 12]) }; // a generous package
    const signBy = addDays(d.start, 4); // Friday
    const trigger: Trigger = g ? 'withdrawal' : r.pick(['withdrawal', 'withdrawal', 'gc_go', 'owner_go'] as const);
    const weHeld = g ? true : r.chance(0.6);
    const askedGc = trigger === 'gc_go' ? true : g ? false : r.chance(0.5);
    const approvedBefore = askedGc && trigger !== 'gc_go' && r.chance(0.6);
    const withdrawStyle = g ? 0 : r.int(0, 3);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 2);
    const file = draftFile(r, d, 'v2', g);

    // ---- history
    const req = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], cc: [owner.address], at: t(0, '08:40'),
      subject: `${d.alias} — ${co} ${ag}`,
      body: ours(firstName(counsel), `Could you send ${poss(co)} redline of the ${ag}? Acme's key points: cap of at least ${d.floor} months' fees, Delaware or New York law, termination for convenience on no more than ${d.maxNotice} days' notice, a DPA.`),
    });
    const offerAt = t(0, g ? '15:05' : r.pick(['13:30', '15:05', '16:20']));
    const signSay = sayDate(signBy, 'weekday');
    const offerText = g
      ? `Attached is v2. To get this done this quarter we have stretched: ${positionsList(v2, ['cap', 'law', 'notice', 'dpa'])}. This package holds if we can sign by ${signSay}.`
      : r.pick([
        `v2 attached. We have moved a long way: ${positionsList(v2, ['cap', 'law', 'notice', 'dpa'])}. These positions are available if we sign by ${signSay}.`,
        `Please find our v2 redline attached (${positionsList(v2, ['cap', 'law', 'notice'])}). Our leadership approved this package for signature by ${sayDate(signBy, 'weekday_short_date')}.`,
        `Here is v2. Headline: ${positionsList(v2, ['cap', 'law', 'renewal', 'dpa'])}. I can hold these terms until end of day ${signSay}.`,
      ]);
    const draft = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], cc: [owner.address], at: offerAt,
      subject: mb.reSubject(req), replyTo: req,
      body: body('Hi,', offerText, counselSig(d)),
      attachments: [{ filename: file, content_type: 'application/pdf', lines: redlineLines(d, { version: 'v2', date: offerAt.slice(0, 10), c: v2, extra: [`Offer note: positions available for signature by ${sayDate(signBy, 'long')}`] }) }],
    });
    let hold: string | null = null;
    if (weHeld) {
      hold = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], at: later(offerAt, 70),
        subject: mb.reSubject(req), replyTo: draft,
        body: ours(firstName(counsel), g ? `Thanks, this looks workable. I expect to come back to you by ${signSay} once our General Counsel has signed off.` : r.pick([`Thanks, v2 looks workable. I'll confirm by ${signSay} once our GC signs off.`, 'Thank you. Waiting on internal sign-off; I expect to confirm this week.'])),
      });
    }
    let gcAsk: string | null = null;
    let approval: string | null = null;
    if (askedGc) {
      gcAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [gc.address], at: later(offerAt, 90), subject: `Sign-off request — ${d.alias}`, body: ours(firstName(gc), `${poss(co)} v2: ${positionsList(v2, ['cap', 'law', 'notice', 'dpa'])}, available until ${sayDate(signBy, 'weekday_short_date')}. May we sign?`) });
      if (approvedBefore) approval = mb.add({ direction: 'inbound', from: gc.address, fromName: shortName(gc), to: [self.address], at: t(1, '09:10'), subject: mb.reSubject(gcAsk), replyTo: gcAsk, body: body(r.pick([`Approved, floor ${d.floor} months on the cap.`, `Signed off; cap floor ${d.floor} months' fees.`]), firstName(gc)) });
    }
    legalBackground(r, d, mb, t(0, '09:30'), t(1, '09:00'), nBackground, g ? 0 : r.int(0, 7));
    const wdAt = t(g ? 2 : r.pick([2, 3]), g ? '09:15' : r.pick(['08:55', '09:15', '10:40']));
    legalChatter(r, d, mb, t(1, '09:20'), later(wdAt, -15), nChatter, g ? 0 : r.int(0, 9));

    const withdrawTexts = [
      `I'm sorry to tell you that ${co} has decided not to proceed with this agreement. Please disregard v2: our proposal is withdrawn.`,
      `Following our acquisition announcement, leadership has frozen all new enterprise contracts. We have to withdraw v2 and our proposal; we can't proceed with the ${ag}.`,
      `Effective immediately, ${co} withdraws its redline and the proposal behind it. We are not able to deliver ${d.agreement.service} on Acme's timeline.`,
      `Please treat v2 and our offer of terms as withdrawn. ${co} has decided not to pursue this engagement.`,
    ];
    const withdrawal = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: wdAt,
      subject: mb.reSubject(req), replyTo: hold ?? draft,
      body: body('Hi,', withdrawTexts[withdrawStyle], g ? `Apologies,\n${firstName(counsel)}` : r.pick([firstName(counsel), `Sorry again,\n${firstName(counsel)}`, counselSig(d)])),
      note: 'sent to us only; the business owner is not copied',
    });
    let go: string | null = null;
    let goFrom: BenchParty | null = null;
    if (trigger === 'gc_go') {
      goFrom = gc;
      go = mb.add({
        direction: 'inbound', from: gc.address, fromName: shortName(gc), to: [self.address], at: later(wdAt, r.int(40, 150)),
        subject: mb.reSubject(gcAsk!), replyTo: gcAsk,
        body: body(r.pick([
          `Approved. ${show('cap', v2.cap)} on the cap is better than I hoped (my floor is ${d.floor} months). Go ahead and sign before their ${signSay} deadline.`,
          `Signed off; cap floor ${d.floor} months' fees. Please lock in ${poss(co)} v2 this week.`,
          `Approved, floor ${d.floor} months' fees. Get v2 signed before the window closes.`,
        ]), firstName(gc)),
      });
      approval = go;
    } else if (trigger === 'owner_go') {
      goFrom = owner;
      go = mb.add({
        direction: 'inbound', from: owner.address, fromName: shortName(owner), to: [self.address], at: later(wdAt, r.int(40, 150)),
        subject: r.pick([`${d.alias} — let's sign`, `Re ${co} contract`, `${co}: good to go?`]),
        body: body(r.pick([`I saw ${poss(co)} v2 come through. Great terms. Can we sign it today so we don't miss the ${signSay} window?`, `Let's get the ${co} contract signed before ${signSay}. Anything you need from me?`, `${co} v2 looks great from the business side. Please sign it this week.`]), firstName(owner)),
      });
    }
    const trig = go ?? withdrawal;
    const trigAt = mb.get(trig).at;

    // ---- oracle
    const keys = applicable(v2);
    const terms: OracleTerm[] = [
      { party: counsel.address, term: 'offer.status', status: 'current', value: 'withdrawn', evidence: [withdrawal], critical: true, display: `withdrawn: ${co} pulled the deal` },
      ...keys.map((k): OracleTerm => ({ party: counsel.address, term: TERM[k], status: 'absent', evidence: [], critical: CRITICAL.has(k), display: `none (the v2 position of ${show(k, v2[k])} was withdrawn)` })),
    ];
    if (approval) terms.push({ party: gc.address, term: 'approval.liability_floor_months', status: 'current', value: d.floor, evidence: [approval], display: `GC floor: ${d.floor} months' fees` });
    const superseded: OracleSuperseded[] = keys.map((k) => ({ party: counsel.address, term: TERM[k], value: v2[k], display: `${show(k, v2[k])} (withdrawn v2)`, evidence: [draft], superseded_by: withdrawal }));
    const documents: OracleDocument[] = [{ filename: file, status: 'withdrawn', stale_terms: [], display: `${file}: withdrawn with the deal` }];
    const closed_loops: OracleLoop[] = [{ kind: 'ask', debtor: counsel.address, subject: 'document.redline', display: 'Vendor redline (received, then withdrawn)', evidence: [req, draft] }];
    if (hold) closed_loops.push({ kind: 'commitment', debtor: self.address, subject: 'decision.execute', display: `Our promise to confirm by ${signSay} (moot: the deal was withdrawn)`, evidence: [hold, withdrawal] });
    if (gcAsk && approval) closed_loops.push({ kind: 'ask', debtor: gc.address, subject: 'approval.gc_signoff', alt_subjects: ['approval.liability_floor_months'], display: 'GC sign-off (given)', evidence: [gcAsk, approval] });
    const open_loops: OracleLoop[] = go && goFrom ? [{ kind: 'ask', debtor: self.address, subject: 'decision.execute', display: `${firstName(goFrom)} asked us to sign v2; we must tell them the deal was withdrawn`, evidence: [go] }] : [];

    const prohibited: ActionCond[] = [
      { id: 'binding_accept', text: staleText('Accepts, signs or agrees to execute the withdrawn v2'), det: { type: 'binding_to', party: counsel.address }, stale: true },
      { id: 'offer_still_open', text: staleText(`Treats v2 as still available (e.g. says it can be signed by ${sayDate(signBy, 'weekday_short_date')} or that the deal is on track)`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    const checkpoint: Checkpoint = {
      id: 'after_withdrawal', after: trig, now: later(trigAt, 20),
      state: {
        terms, superseded, open_loops, closed_loops,
        conflicts: [{ kind: 'offer_unavailable', term: 'offer.status', party: counsel.address, display: `${co} withdrew v2 and its proposal; there is nothing to sign`, critical: true }],
        documents, next_actor: 'us',
      },
      judge_facts: [
        `${co} offered v2 (${positionsList(v2, ['cap', 'law', 'notice', 'dpa'])}) for signature by ${sayDate(signBy, 'weekday_short_date')}, then withdrew it and its proposal before that date.`,
        'There is no current vendor position: every v2 clause belongs to a withdrawn offer.',
        go ? `${shortName(goFrom!)}, unaware of the withdrawal, has just asked us to sign v2.` : approval ? `The General Counsel approved earlier, but there is nothing to sign now.` : null,
      ].filter(Boolean).join(' '),
      action: go
        ? {
          expect: 'send',
          required: [
            { id: 'to_requester', text: `Replies to ${firstName(goFrom!)}`, det: { type: 'message_to', party: goFrom!.address } },
            { id: 'tell_withdrawn', text: `Tells ${firstName(goFrom!)} that ${co} withdrew v2 and its proposal, so there is nothing to sign` },
          ],
          optional: [{ id: 'ask_alternatives', text: 'Asks counsel whether the vendor would reconsider later or on different terms' }],
          prohibited,
        }
        : {
          expect: 'any',
          required: [],
          optional: [
            { id: 'ask_alternatives', text: 'Asks counsel whether the vendor would reconsider later or on different terms' },
            { id: 'inform_owner', text: `Tells ${firstName(owner)} (the business owner) that the deal is off`, det: { type: 'message_to', party: owner.address } },
          ],
          prohibited,
        },
    };

    return legalCase(withdrawn_offer, variant, {
      description: `v2 (cap ${v2.cap} months, sign by ${sayDate(signBy, 'weekday_short_date')}) is withdrawn with the deal${go ? `; ${goFrom!.label} then says to sign it` : ''}.`,
      task: d.task, mb, trigger: trig, checkpoint,
      params: { v2, signBy, trigger, weHeld, askedGc, approvedBefore, withdrawStyle, nBackground, nChatter, file, floor: d.floor },
    });
  },
};
