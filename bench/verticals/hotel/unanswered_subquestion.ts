// Archetype: unanswered sub-question (P0).
//
// The hotel quotes availability and a rate. We then ask three things in one email (from attrition,
// comp ratio, cutoff, F&B minimum, meeting-room rental). The sales manager replies warmly and answers
// only one or two of them; the rest are silently skipped.
//
// Trap: a thread-level "awaiting" flag flips to "you" because the hotel replied, and a summary says
// "hotel answered our questions". The oracle keeps one open ask per skipped item and closes the answered
// ones: the right follow-up chases exactly the missing items and never re-asks the answered ones. In some
// variants the answered attrition is below Acme's minimum, which must also be pushed back on.
import type { Archetype, BenchCase, Checkpoint, ActionCond, OracleLoop, OracleConflict } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, reaskText, sayDate, seedOf } from '../../core/util.ts';
import {
  AGENT_SIGN, TERM_LABEL, blockDisplay, blockProse, firstName, hotel, hotelBackground, hotelChatter, hotelDayStart, hotelDeal, pct, plainName,
  rfpBody, show, signoff, term, violation,
} from './vertical.ts';

type Item = 'attrition.allowance' | 'concession.comp_ratio' | 'cutoff.date' | 'fnb.minimum' | 'meeting.room_rental';

export const unanswered_subquestion: Archetype = {
  id: 'unanswered_subquestion',
  title: 'Hotel answers only some of our questions',
  capabilities: ['open_loops'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('hotel', 'unanswered_subquestion', variant));
    const g = variant === 0;
    const d = hotelDeal(r, variant);
    const { self, sales } = d.cast;
    const sf = firstName(sales);

    // ---- parameters
    const pool: Item[] = ['attrition.allowance', 'concession.comp_ratio', 'cutoff.date', 'fnb.minimum', 'meeting.room_rental'];
    const asked: Item[] = g ? ['attrition.allowance', 'concession.comp_ratio', 'cutoff.date'] : r.shuffle(pool).slice(0, 3);
    const nAnswered = g ? 2 : r.int(1, 2);
    const answered: Item[] = g ? ['attrition.allowance', 'cutoff.date'] : r.shuffle(asked).slice(0, nAnswered);
    const missing = asked.filter((k) => !answered.includes(k));
    const lowAttrition = !g && answered.includes('attrition.allowance') && d.minAttrition >= 10 && r.chance(0.35);
    const values: Record<Item, unknown> = {
      'attrition.allowance': lowAttrition ? d.minAttrition - 5 : d.attrition,
      'concession.comp_ratio': d.comp,
      'cutoff.date': d.cutoff,
      'fnb.minimum': d.fnb,
      'meeting.room_rental': d.meeting,
    };
    const askStyle = g ? 0 : r.int(0, 2);
    const replyStyle = g ? 0 : r.int(0, 2);
    const nBackground = g ? 2 : r.int(2, 8);
    const nChatter = g ? 0 : r.int(0, 4);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => hotelDayStart(d, day, hhmm);

    // ---- history
    const rfp = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(0, '09:10'),
      subject: `Availability & rate: ${d.event} (${d.alias})`,
      body: rfpBody(r, d, g, 'Before we go further, can you confirm availability for that block and your best group rate?'),
    });
    const quote = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(0, '15:40'),
      subject: mb.reSubject(rfp), replyTo: rfp,
      body: body('Hi,', g
        ? `Good news: we have ${blockProse(d.block, 0)} available, and I can offer a group rate of ${moneyShort(d.rate)} per room, per night.`
        : r.pick([
          `Your dates are open. We can do ${blockProse(d.block, r.int(0, 2))} at ${moneyShort(d.rate)}/night.`,
          `Thanks for thinking of us! Availability looks good for ${blockProse(d.block, r.int(0, 2))}, and the group rate would be ${moneyShort(d.rate)} per night.`,
          `I checked with revenue and we can hold ${blockProse(d.block, r.int(0, 2))}. Best group rate: ${moneyShort(d.rate)} per room-night.`,
        ]), signoff(sales, d.hotel.name)),
    });
    hotelBackground(r, d, mb, t(0, '10:30'), nBackground);
    hotelChatter(r, d, mb, t(1, '09:00'), nChatter);

    const askLine: Record<Item, string[]> = {
      'attrition.allowance': ['What attrition allowance can you offer?', 'How much of the block can we release without penalty (attrition)?', 'What is the attrition percentage?'],
      'concession.comp_ratio': ['What comp ratio do you offer (comp rooms per paid room-nights)?', 'Do you offer complimentary rooms, and at what ratio?', 'What would the comp ratio be?'],
      'cutoff.date': ['When would the reservation cutoff be?', 'What cutoff date would apply to the block?', 'How many days before arrival is the cutoff?'],
      'fnb.minimum': ['What F&B minimum would you need for the meeting space?', 'Is there a food & beverage minimum, and how much?', 'What is the F&B minimum?'],
      'meeting.room_rental': ['What is the meeting room rental for the general session and breakouts?', 'Is there a meeting-space rental fee on top of F&B?', 'What would you charge for meeting room rental?'],
    };
    const qs = asked.map((k, i) => (askStyle === 0 ? `${i + 1}. ${askLine[k][0]}` : askLine[k][askStyle]));
    const q = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(1, '11:15'),
      subject: mb.reSubject(rfp), replyTo: quote,
      body: body(`Thanks ${sf}, that works for us so far.`, askStyle === 0 ? `A few questions before we ask for a proposal:\n${qs.join('\n')}` : `A few questions before we ask for a proposal. ${qs.join(' ')}`, AGENT_SIGN),
    });

    const answerLine = (k: Item): string => {
      const v = values[k];
      switch (k) {
        case 'attrition.allowance': return [`Attrition is ${pct(v as number)} of the total block.`, `You can release up to ${pct(v as number)} of the room block without penalty.`, `We allow ${pct(v as number)} attrition.`][replyStyle];
        case 'concession.comp_ratio': return [`Comp ratio is ${v} paid room-nights.`, `We give ${String(v).replace('1 per', 'one comp room-night per')} paid.`, `Comps: ${v}.`][replyStyle];
        case 'cutoff.date': return [`Cutoff would be ${sayDate(v as string, 'long')}.`, `The block cuts off on ${sayDate(v as string, 'month_day')} (${d.cutoffDays} days out).`, `Reservations need to be in by ${sayDate(v as string, 'weekday_long')}.`][replyStyle];
        case 'fnb.minimum': return [`The F&B minimum is ${moneyShort(v as number)} plus service charge and tax.`, `We'd need ${moneyShort(v as number)} in food and beverage.`, `F&B minimum: ${moneyShort(v as number)}++.`][replyStyle];
        case 'meeting.room_rental': return [`Meeting room rental is ${moneyShort(v as number)} for the whole program.`, `Space rental comes to ${moneyShort(v as number)} total.`, `We'd charge ${moneyShort(v as number)} for the meeting rooms.`][replyStyle];
      }
    };
    const reply = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(2, '09:48'),
      subject: mb.reSubject(rfp), replyTo: q,
      body: body(
        g ? `Hi there,` : r.pick(['Hi,', 'Hello!', `Hi again,`]),
        answered.map(answerLine).join(' '),
        g ? `Let me know what else you need. We'd love to host your group!` : r.pick(['Let me know if there is anything else.', 'Looking forward to working with you on this one.', 'We would love to have you here!']),
        g ? `Best,\n${sf}` : signoff(sales, d.hotel.name),
      ),
    });

    // ---- oracle
    const conflicts: OracleConflict[] = [];
    if (lowAttrition) conflicts.push({ kind: 'requirement_violation', term: 'attrition.allowance', party: sales.address, display: violation(d, 'attrition.allowance', values['attrition.allowance'])!, critical: true });
    const openLoops: OracleLoop[] = missing.map((k) => ({ kind: 'ask', debtor: sales.address, subject: k, display: `${TERM_LABEL[k]} (asked, not answered)`, evidence: [q], critical: true }));
    const required: ActionCond[] = [
      { id: 'to_sales', text: 'Sends a message to the hotel sales manager', det: { type: 'message_to', party: sales.address } },
      ...missing.map((k) => ({ id: `chase_${k.split('.')[0]}`, text: `Follows up on the ${TERM_LABEL[k]}, which the hotel has not answered` })),
    ];
    if (lowAttrition) required.push({ id: 'push_attrition', text: `Pushes back on the ${pct(values['attrition.allowance'] as number)} attrition, since Acme needs at least ${pct(d.minAttrition)}` });
    const checkpoint: Checkpoint = {
      id: 'after_partial_answer', after: reply, now: t(2, '10:15'),
      state: {
        terms: [
          term(sales, 'rate.group', d.rate, [quote], true),
          term(sales, 'block.rooms', d.block, [quote], true),
          ...answered.map((k) => term(sales, k, values[k], [reply], true)),
        ],
        superseded: [],
        open_loops: openLoops,
        closed_loops: [
          { kind: 'ask', debtor: sales.address, subject: 'rate.group', display: 'Group rate (answered)', evidence: [quote] },
          { kind: 'ask', debtor: sales.address, subject: 'block.rooms', display: 'Availability (answered)', evidence: [quote] },
          ...answered.map((k): OracleLoop => ({ kind: 'ask', debtor: sales.address, subject: k, display: `${TERM_LABEL[k]} (answered)`, evidence: [reply] })),
        ],
        conflicts,
        documents: [],
        next_actor: 'us',
      },
      judge_facts: [
        `The hotel quoted ${moneyShort(d.rate)}/night for ${blockDisplay(d.block)}.`,
        `We asked about: ${asked.map((k) => TERM_LABEL[k]).join(', ')}.`,
        `The hotel answered ${answered.map((k) => `${TERM_LABEL[k]} (${show(k, values[k])})`).join(' and ')}, and did NOT answer: ${missing.map((k) => TERM_LABEL[k]).join(' and ')}.`,
        lowAttrition ? `Acme requires at least ${pct(d.minAttrition)} attrition, so the ${pct(values['attrition.allowance'] as number)} offered breaks a hard requirement.` : '',
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required,
        optional: [{ id: 'thank', text: 'Acknowledges the answers already given' }],
        prohibited: [
          ...answered.map((k) => ({
            id: `reask_${k.split('.')[0]}`,
            text: reaskText(`Asks the hotel again for the ${TERM_LABEL[k]} (already answered: ${show(k, values[k])}${lowAttrition && k === 'attrition.allowance' ? '; asking the hotel to improve it does not count' : ''})`),
          })),
          { id: 'reask_rate', text: reaskText(`Asks the hotel again for the group rate (already answered: ${moneyShort(d.rate)}/night)`) },
          { id: 'binding_accept', text: 'Accepts the offer or confirms the block with the hotel', det: { type: 'binding_to', party: sales.address } },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return {
      id: `hotel/unanswered_subquestion/${variant}`,
      vertical: 'hotel',
      archetype: 'unanswered_subquestion',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: unanswered_subquestion.capabilities,
      description: `We asked ${asked.length} things; the hotel answered ${answered.join(', ')} and skipped ${missing.join(', ')}.`,
      task: d.task,
      events: mb.sorted(),
      trigger: reply,
      checkpoints: [checkpoint],
      params: { asked, answered, missing, lowAttrition, askStyle, replyStyle, nBackground, nChatter, rate: d.rate },
    };
  },
};

export { hotel };
