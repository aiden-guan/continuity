// Archetype: cross-thread linkage (P1).
//
// We negotiate the rate in the RFP thread. The hotel's revised rate then arrives in a BRAND-NEW thread
// whose only link is the group code, and finance's approval also arrives as a fresh email (not a reply)
// that names only the group code. Meanwhile the same sales manager and the same finance approver are
// handling a different Acme group at the same hotel (a look-alike group code) with its own revised rate
// and its own budget, interleaved in the same inbox.
//
// Trap: thread-scoped memory misses the revised rate and the approval; keyword search on the hotel or
// the sales manager's name pulls in the look-alike group's numbers. The oracle: the revised rate (from
// the new thread) is current and the proposal rate superseded; the budget is the one for this group
// code; the look-alike numbers appear nowhere; the proposal is stale on the rate only.
import type { Archetype, BenchCase, Checkpoint, OracleConflict, OracleLoop } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, nextWeekday, pdf, reaskText, sayDate, seedOf, staleText } from '../../core/util.ts';
import {
  AGENT_SIGN, budgetAsk, dayOf, firstName, hotel, hotelBackground, hotelChatter, hotelDayStart, hotelDeal, night, plainName, plusMinutes,
  proposalBody, proposalLines, rfpBody, signoff, term, violation,
} from './vertical.ts';

export const cross_thread: Archetype = {
  id: 'cross_thread',
  title: 'Revised rate and approval arrive in new threads; look-alike group at the same hotel',
  capabilities: ['cross_thread', 'supersession'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('hotel', 'cross_thread', variant));
    const g = variant === 0;
    const d = hotelDeal(r, variant);
    const { self, sales, finance } = d.cast;
    const sf = firstName(sales);
    const other = d.lookalike;

    // ---- parameters
    const startAboveCap = g ? true : r.chance(0.5);
    const firstRate = startAboveCap ? d.cap + (g ? 14 : r.pick([4, 9, 14, 24])) : d.rate + r.pick([10, 15, 20]);
    // the hotel meets our ask exactly, so moving forward (not countering again) is the one right move.
    // The draw is kept so the later random parameters stay as they were.
    if (!g) r.pick([0, 5, 10]);
    const askFor = d.rate;
    const otherRate = d.rate - (g ? 22 : r.pick([12, 17, 22, 30]));
    const otherCap = d.cap - (g ? 15 : r.pick([10, 15, 20, 25]));
    const approvalFirst = g ? false : r.chance(0.5);
    const promisesRevised = g ? true : r.chance(0.5);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const proposalFile = `${d.hotel.short.replace(/\s+/g, '')}-Proposal-${d.proposalRef}.pdf`;
    const otherNight = addDays(d.arrival, 28);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => hotelDayStart(d, day, hhmm);

    // ---- history
    const rfp = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(0, '09:00'), subject: `Group RFP: ${d.event} — ${d.alias}`, body: rfpBody(r, d, g) });
    mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '09:04'), subject: `Budget approval — ${d.alias} hotel block`, body: budgetAsk(r, d, g) });
    const offer = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(0, '15:30'), subject: mb.reSubject(rfp), replyTo: rfp,
      body: proposalBody(r, d, g, { rate: firstRate }), attachments: [pdf(proposalFile, proposalLines(d, { date: d.start, rate: firstRate }))],
    });
    hotelBackground(r, d, mb, t(0, '10:10'), nBackground, { lookalike: false });
    // the look-alike group with the same sales manager
    mb.add({
      background: true, direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(1, '08:40'),
      subject: `Proposal — ${other.event} (${other.alias})`,
      body: body('Hi,', `As promised, here is our proposal for ${other.alias}: 30 rooms on ${night(otherNight)} and ${night(addDays(otherNight, 1))} at ${moneyShort(otherRate + 15)} per night.`, signoff(sales, d.hotel.name)),
      note: 'look-alike group at the same hotel',
    });
    const counter = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(1, '10:20'), subject: mb.reSubject(rfp), replyTo: offer,
      body: body(`Hi ${sf},`, g
        ? `Thanks for the proposal. The rate is above what we can do; is there any flexibility? We'd need to be at ${moneyShort(askFor)} or below to move forward.`
        : r.pick([
          `The proposal looks good apart from the rate. Could revenue get to ${moneyShort(askFor)}?`,
          `We're keen on ${d.hotel.short}, but ${moneyShort(firstRate)} is a stretch. Is ${moneyShort(askFor)} possible?`,
          `Any room to move on the ${moneyShort(firstRate)} rate? ${moneyShort(askFor)} would get this approved quickly on our side.`,
        ]), AGENT_SIGN),
    });
    hotelChatter(r, d, mb, t(1, '13:00'), nChatter);

    const rateMsg = (at: string) => mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at,
      subject: g ? `${d.alias} — revised group rate` : r.pick([`${d.alias} — revised group rate`, `Rate update for group ${d.alias}`, `${d.alias}: good news on rate`]),
      body: body('Hi,', g
        ? `Following up on your request for group ${d.alias}: our revenue team approved a group rate of ${moneyShort(d.rate)} per night (down from ${moneyShort(firstRate)}). All other proposal terms stay the same.`
        : r.pick([
          `Re group ${d.alias}: I went back to revenue and we can do ${moneyShort(d.rate)}/night. Everything else in the proposal is unchanged.`,
          `For ${d.alias}, revenue signed off on ${moneyShort(d.rate)} per room-night instead of ${moneyShort(firstRate)}; the rest of the proposal stands.`,
          `Starting a fresh email so this doesn't get lost: ${d.alias} is approved at ${moneyShort(d.rate)} per night. No other changes.`,
        ]), promisesRevised ? `I'll send an updated proposal with the new rate${g ? ` by ${sayDate(nextWeekday(dayOf(d, 2), 5), 'weekday')}` : ''}.` : null, signoff(sales, d.hotel.name)),
      note: 'new thread; linked only by the group code',
    });
    const approvalMsg = (at: string) => mb.add({
      direction: 'inbound', from: finance.address, fromName: plainName(finance), to: [self.address], at,
      subject: g ? `${d.alias} approval` : r.pick([`${d.alias} approval`, `Approved: ${d.alias}`, `Hotel budget ${d.alias}`]),
      body: body(g
        ? `Approved: ${d.alias} can go up to ${moneyShort(d.cap)} per room-night.`
        : r.pick([
          `${d.alias} is approved at a ceiling of ${moneyShort(d.cap)}/night.`,
          `Finance approval for ${d.alias}: max ${moneyShort(d.cap)} per room-night. Sorry for the delay.`,
          `OK to proceed on ${d.alias} up to ${moneyShort(d.cap)} a night.`,
        ]), firstName(finance)),
      note: 'new thread; not a reply to the budget request',
    });
    // look-alike updates interleave with the real ones
    mb.add({
      background: true, direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(2, '09:05'),
      subject: `${other.alias} — revised group rate`,
      body: body('Hi,', `Following up for group ${other.alias}: revenue approved ${moneyShort(otherRate)} per night. Everything else stays the same.`, signoff(sales, d.hotel.name)),
      note: 'look-alike group at the same hotel',
    });
    mb.add({
      background: true, direction: 'inbound', from: finance.address, fromName: plainName(finance), to: [self.address], at: t(2, '09:35'),
      subject: `${other.alias} approval`, body: body(`Approved: ${other.alias} can go up to ${moneyShort(otherCap)} per room-night.`, firstName(finance)),
      note: 'look-alike group approval',
    });
    let rate: string, approval: string;
    if (approvalFirst) { approval = approvalMsg(t(2, '10:10')); rate = rateMsg(plusMinutes(t(2, '10:10'), r.int(60, 240))); }
    else { rate = rateMsg(t(2, '10:10')); approval = approvalMsg(plusMinutes(t(2, '10:10'), r.int(60, 240))); }
    const trigger = approvalFirst ? rate : approval;

    // ---- oracle
    const conflicts: OracleConflict[] = [];
    const v = violation(d, 'rate.group', d.rate);
    if (v) conflicts.push({ kind: 'requirement_violation', term: 'rate.group', party: sales.address, display: v, critical: true });
    const openLoops: OracleLoop[] = promisesRevised
      ? [{ kind: 'commitment', debtor: sales.address, subject: 'document.proposal', display: 'Hotel owes an updated proposal with the revised rate', evidence: [rate] }]
      : [];
    const checkpoint: Checkpoint = {
      id: 'after_cross_thread', after: trigger, now: plusMinutes(mb.get(trigger).at, 20),
      state: {
        terms: [
          term(sales, 'rate.group', d.rate, [rate], true),
          term(sales, 'block.rooms', d.block, [offer]),
          term(sales, 'attrition.allowance', d.attrition, [offer]),
          term(sales, 'cutoff.date', d.cutoff, [offer]),
          term(sales, 'fnb.minimum', d.fnb, [offer]),
          term(finance, 'budget.max_rate', d.cap, [approval], true),
        ],
        superseded: [
          { party: sales.address, term: 'rate.group', value: firstRate, display: `${moneyShort(firstRate)}/night`, evidence: [offer], superseded_by: rate },
        ],
        open_loops: openLoops,
        closed_loops: [
          { kind: 'ask', debtor: sales.address, subject: 'rate.group', display: 'Request for a lower rate (answered in a new thread)', evidence: [rate] },
          { kind: 'ask', debtor: finance.address, subject: 'budget.max_rate', alt_subjects: ['approval.budget'], display: 'Budget approval (given in a new thread)', evidence: [approval] },
          { kind: 'ask', debtor: sales.address, subject: 'document.proposal', display: 'Proposal (received)', evidence: [offer] },
        ],
        conflicts,
        documents: [
          { filename: proposalFile, status: 'partially_stale', stale_terms: ['rate.group'], display: `${proposalFile}: rate superseded by the new-thread email; block, attrition, cutoff, F&B current` },
        ],
        next_actor: 'us',
      },
      judge_facts: [
        `For ${d.alias}, the hotel's current rate is ${moneyShort(d.rate)}/night (revised from ${moneyShort(firstRate)} in a separate email thread); the other proposal terms are unchanged.`,
        `Finance approved up to ${moneyShort(d.cap)}/night for ${d.alias}, so the rate is within budget and all hard requirements are met.`,
        `A different Acme group at the same hotel, ${other.alias}, has its own rate (${moneyShort(otherRate)}) and budget (${moneyShort(otherCap)}); those numbers do not apply to ${d.alias}.`,
        promisesRevised ? 'The hotel promised an updated proposal that has not arrived yet.' : '',
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_sales', text: 'Sends a message to the hotel sales manager', det: { type: 'message_to', party: sales.address } },
          { id: 'proceed', text: `Moves ${d.alias} forward at ${moneyShort(d.rate)}/night (e.g. confirms the revised rate works and asks for the contract)` },
        ],
        optional: [
          { id: 'thank_finance', text: 'Acknowledges the finance approval' },
        ],
        prohibited: [
          { id: 'bleed', text: `Uses the ${other.alias} rate (${moneyShort(otherRate)}) or budget (${moneyShort(otherCap)}) as if they applied to ${d.alias}` },
          { id: 'stale_rate', text: staleText(`Treats ${moneyShort(firstRate)}/night as the current rate`), stale: true },
          { id: 'reask_rate', text: reaskText(`Asks the hotel again whether it can lower the rate (already answered: ${moneyShort(d.rate)}/night)`, true) },
          { id: 'reask_budget', text: reaskText('Asks finance again to approve the budget (already approved)') },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return {
      id: `hotel/cross_thread/${variant}`,
      vertical: 'hotel',
      archetype: 'cross_thread',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: cross_thread.capabilities,
      description: `Revised rate ${moneyShort(d.rate)} (from ${moneyShort(firstRate)}) and budget approval arrive in new threads; look-alike group ${other.alias} at the same hotel.`,
      task: d.task,
      events: mb.sorted(),
      trigger,
      checkpoints: [checkpoint],
      params: { firstRate, rate: d.rate, cap: d.cap, otherRate, otherCap, approvalFirst, promisesRevised, startAboveCap, nBackground, nChatter },
    };
  },
};

export { hotel };
