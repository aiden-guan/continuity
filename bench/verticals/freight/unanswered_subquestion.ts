// Archetype: unanswered sub-question (P0).
//
// A carrier dispatcher shows interest in the load (or we reach out), we ask three things in one email — out of
// all-in rate, equipment confirmation (type and, for a reefer, the set point), whether the truck can make the
// shipper's loading window, and the carrier setup packet (W-9 / COI) — and the reply answers only some of
// them.
//
// Trap: the thread-level "awaiting" flag flips to us because the carrier replied, and a summary says "carrier
// answered". But specific questions are still open. Oracle: answered items are current terms and closed loops;
// unanswered items are open asks owed by the carrier; we must follow up on exactly the missing ones, never
// re-ask the answered ones, and not book a truck whose equipment / setup / rate is still unconfirmed.
import type { Archetype, BenchCase, Checkpoint, OracleLoop, OracleTerm, ActionCond } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, pdf, reaskText, seedOf, thousands } from '../../core/util.ts';
import {
  cur, eqLabel, eqWords, equipmentTerms, firstName, freight, freightBackground, freightCase, freightChatter, freightDayStart, freightDeal, personName,
  sayTemp, sayWin, show, signDispatch, signUs,
} from './vertical.ts';

type Item = 'rate' | 'equipment' | 'pickup' | 'docs';

export const unansweredSubquestion: Archetype = {
  id: 'unanswered_subquestion',
  title: 'Carrier answers only some of our questions',
  capabilities: ['open_loops'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('freight', 'unanswered_subquestion', variant));
    const g = variant === 0;
    const d = freightDeal(r, variant);
    const { self, dispatcher } = d.cast;
    const first = firstName(dispatcher);

    // ---- parameters
    const asked: Item[] = g ? ['rate', 'equipment', 'pickup'] : r.shuffle(['rate', 'equipment', 'pickup', 'docs'] as Item[]).slice(0, 3);
    const nAnswered = g ? 2 : r.int(1, 2);
    const answered: Item[] = g ? ['pickup', 'rate'] : r.shuffle(asked).slice(0, nAnswered);
    const missing = asked.filter((x) => !answered.includes(x));
    const intro = g ? true : r.chance(0.5);
    const numbered = g ? true : r.chance(0.5);
    const k = g ? 0 : r.int(0, 3);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 2);
    const packet = `${d.carrier.short}-Carrier-Packet.pdf`;
    const rateBreakdown = g ? false : r.chance(0.5);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => freightDayStart(d, day, hhmm);

    // ---- history
    let parent: string | null = null;
    let subject = `${d.alias} — ${d.lane.origin} to ${d.lane.dest}`;
    if (intro) {
      parent = mb.add({
        direction: 'inbound', from: dispatcher.address, fromName: personName(dispatcher), to: [self.address], at: t(0, '07:45'), subject: `Your load ${d.alias} ${d.lane.origin.split(',')[0]} - ${d.lane.dest.split(',')[0]}`,
        body: body('Hi,', g
          ? `Saw your post for ${d.alias}. I have a truck delivering in ${d.lane.origin.split(',')[0]} tonight and would like to run it for you.`
          : r.pick([
            `Saw ${d.alias} on the board. I'll have a ${eqWords(d)} empty near ${d.lane.origin.split(',')[0]}, interested in running it.`,
            `Is ${d.alias} still available? Got a driver reloading out of ${d.lane.origin}.`,
            `Interested in your ${d.lane.origin.split(',')[0]} to ${d.lane.dest.split(',')[0]} load (${d.alias}). Truck in the area.`,
          ]), signDispatch(d)),
      });
      subject = mb.reSubject(parent);
    }

    const qText: Record<Item, string> = {
      rate: g ? "What's your all-in rate?" : r.pick(["What's your all-in?", 'What all-in rate do you need?', 'What would your all-in rate be?']),
      equipment: d.equipment === 'reefer'
        ? `Can you confirm it's a ${eqLabel(d).replace(' at ', ' that will run continuous at ')}?`
        : d.equipment === 'dry_van' ? "Can you confirm it's a 53' dry van, clean and food-grade?" : "Can you confirm a 48' flatbed with tarps?",
      pickup: `Can the truck be at the shipper ${sayWin(d.reqPickup, k)}?`,
      docs: 'Please send your W-9 and certificate of insurance so we can get you set up.',
    };
    const questions = asked.map((x, i) => (numbered ? `${i + 1}. ${qText[x]}` : qText[x]));
    const questionsEvent = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [dispatcher.address], at: t(0, intro ? '08:20' : '08:05'), subject, replyTo: parent,
      body: body(`Hi ${first},`, intro ? `Thanks — ${d.alias} is still open. ${thousands(d.weight)} lbs ${d.commodity.name}, delivers ${show('delivery.eta', d.appt)} (appointment). A few questions:` : `I have ${d.alias} (${thousands(d.weight)} lbs ${d.commodity.name}, ${d.lane.origin} → ${d.lane.dest}, delivers ${show('delivery.eta', d.appt)}). A few questions before I can book:`, numbered ? questions.join('\n') : questions.join(' '), signUs(r, g)),
    });
    freightBackground(r, d, mb, t(0, '06:30'), nBackground);
    freightChatter(r, d, mb, t(0, '09:00'), nChatter, 12);

    const aText: Record<Item, string> = {
      rate: rateBreakdown
        ? `Rate would be ${moneyShort(d.linehaul)} linehaul plus ${moneyShort(d.fuel)} fuel, ${moneyShort(d.allIn)} all-in.`
        : r.pick([`${moneyShort(d.allIn)} all-in.`, `All-in would be ${moneyShort(d.allIn)}.`, `I can do it for ${moneyShort(d.allIn)} all in.`]),
      equipment: d.equipment === 'reefer'
        ? r.pick([`It's a 2022 Utility reefer, pre-cooled, will run continuous at ${sayTemp(d.tempF!)}.`, `Yes, ${eqLabel(d)}, continuous, with a download available.`])
        : d.equipment === 'dry_van' ? "Yes, 53' air-ride dry van, clean and food-grade." : "Yes, 48' flatbed, driver has tarps and chains.",
      pickup: r.pick([`Truck can be there ${sayWin(d.pickupWin, k)}.`, `We can load ${sayWin(d.pickupWin, k)}.`, `Driver will be at the shipper ${sayWin(d.pickupWin, k)}.`]),
      docs: r.pick(['W-9 and COI attached.', 'Carrier packet attached (W-9, COI).', 'Attached our setup packet.']),
    };
    if (g) aText.rate = `${moneyShort(d.allIn)} all-in.`;
    if (g) aText.pickup = `Yes, we can be there ${sayWin(d.pickupWin, 0)}.`;
    const answerBody = numbered && !g
      ? answered.map((x) => `${asked.indexOf(x) + 1}. ${aText[x]}`).join('\n')
      : answered.map((x) => aText[x]).join(' ');
    const reply = mb.add({
      direction: 'inbound', from: dispatcher.address, fromName: personName(dispatcher), to: [self.address], at: t(0, '10:15'), subject: mb.reSubject(questionsEvent), replyTo: questionsEvent,
      body: body(g ? 'Hi,' : r.pick(['Hi,', 'Hey,', 'Hello,']), answerBody, g ? 'Let me know.' : r.pick(['Let me know.', 'Let me know if you want to book it.', 'Talk soon.', '']), signDispatch(d)),
      attachments: answered.includes('docs') ? [pdf(packet, [
        `${d.carrier.company.toUpperCase()} LLC — CARRIER SETUP PACKET`,
        `MC# ${d.carrier.mc}    USDOT# ${Number(d.carrier.mc) + 1712093}`,
        'W-9: attached (EIN on file)',
        `Certificate of insurance: auto liability $1,000,000; cargo $100,000${d.equipment === 'reefer' ? ' (reefer breakdown covered)' : ''}`,
        `Remit to: ${d.carrier.remit}`,
      ])] : undefined,
    });

    // ---- oracle
    const terms: OracleTerm[] = [];
    if (answered.includes('rate')) {
      if (rateBreakdown) terms.push(cur(dispatcher.address, 'rate.linehaul', d.linehaul, [reply]), cur(dispatcher.address, 'rate.fuel_surcharge', d.fuel, [reply]));
      terms.push(cur(dispatcher.address, 'rate.all_in', d.allIn, [reply], true));
    }
    if (answered.includes('equipment')) terms.push(...equipmentTerms(d, dispatcher.address, [reply], true));
    if (answered.includes('pickup')) terms.push(cur(dispatcher.address, 'pickup.window', d.pickupWin, [reply], true));
    if (answered.includes('docs')) terms.push(cur(dispatcher.address, 'carrier.mc_number', d.carrier.mc, [reply]), cur(dispatcher.address, 'payment.remit_to', d.carrier.remit, [reply]));

    const loop = (x: Item, ev: string[], critical: boolean): OracleLoop => {
      const base = { kind: 'ask' as const, debtor: dispatcher.address, evidence: ev, ...(critical ? { critical: true } : {}) };
      switch (x) {
        case 'rate': return { ...base, subject: 'rate.all_in', display: 'All-in rate' };
        case 'equipment': return { ...base, subject: 'equipment.type', ...(d.equipment === 'reefer' ? { alt_subjects: ['equipment.reefer_temp_f'] } : {}), display: `Confirmation of ${eqLabel(d)}` };
        case 'pickup': return { ...base, subject: 'pickup.window', display: `Can the truck make ${sayWin(d.reqPickup)}` };
        case 'docs': return { ...base, subject: 'document.w9_coi', display: 'W-9 and certificate of insurance' };
      }
    };
    const missingWords: Record<Item, string> = {
      rate: 'the all-in rate',
      equipment: d.equipment === 'reefer' ? `confirmation of the reefer at ${sayTemp(d.tempF!)}` : `confirmation of the ${eqLabel(d)}`,
      pickup: `whether the truck can make ${sayWin(d.reqPickup)}`,
      docs: 'the W-9 and certificate of insurance',
    };
    const answeredWords: Record<Item, string> = {
      rate: `the rate (${moneyShort(d.allIn)} all-in)`,
      equipment: `the equipment (${eqLabel(d)})`,
      pickup: `the pickup time (${show('pickup.window', d.pickupWin)})`,
      docs: 'the W-9 / COI (already received)',
    };

    const checkpoint: Checkpoint = {
      id: 'after_partial_answer', after: reply, now: freightDayStart(d, 0, '10:30'),
      state: {
        terms,
        superseded: [],
        open_loops: missing.map((x) => loop(x, [questionsEvent], true)),
        closed_loops: answered.map((x) => loop(x, [reply], false)),
        conflicts: [],
        documents: answered.includes('docs') ? [{ filename: packet, status: 'current', stale_terms: [], display: `${packet}: carrier setup packet, current` }] : [],
        next_actor: 'us',
      },
      judge_facts: [
        `We asked the carrier ${asked.length} things: ${asked.map((x) => missingWords[x]).join('; ')}.`,
        `The carrier answered ${answered.map((x) => answeredWords[x]).join(' and ')}.`,
        `Still unanswered: ${missing.map((x) => missingWords[x]).join(' and ')}. The load is not booked.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_carrier', text: 'Sends a message to the carrier dispatcher', det: { type: 'message_to', party: dispatcher.address } },
          ...missing.map((x): ActionCond => ({ id: `ask_${x}`, text: `Asks again for ${missingWords[x]}` })),
        ],
        optional: [{ id: 'ack', text: 'Acknowledges the answers already given' }],
        prohibited: [
          ...answered.map((x): ActionCond => ({ id: `reask_${x}`, text: reaskText(`Asks again for ${answeredWords[x]}, which was already answered`) })),
          { id: 'binding_book', text: 'Books or confirms the load before the open questions are answered', det: { type: 'binding_to', party: dispatcher.address } },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return freightCase(unansweredSubquestion, variant, {
      description: `We asked ${asked.join(', ')}; the carrier answered ${answered.join(', ')}; ${missing.join(', ')} still open.`,
      task: d.task, mb, trigger: reply, checkpoints: [checkpoint],
      params: { asked, answered, missing, intro, numbered, k, rateBreakdown, nBackground, nChatter, allIn: d.allIn },
    });
  },
};

export { freight };
