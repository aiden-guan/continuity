// Archetype: late evidence (P1).
//
// The carrier quotes with rate con v1; we negotiate the all-in down (or ask for a later pickup within the shipper's
// window) and the carrier agrees with a revised rate con (rev 2); often we book on rev 2. Later that day an OLD
// copy of v1 resurfaces: Acme ops forwards it from the shared drive asking "this is what we're paying, right?", or
// the carrier's billing desk sends v1 "for your records".
//
// Trap: the forwarded v1 is the newest message with an attachment, so "newest wins" resurrects the old all-in /
// pickup window. Oracle: the rev-2 value stays current and the v1 value is superseded; v1 is a superseded document
// (the copy that just arrived does not change that), rev 2 is current; if ops asked, we owe ops an answer that
// points to rev 2.
import type { Archetype, BenchCase, BenchParty, Checkpoint, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, pdf, reaskText, seedOf, staleText } from '../../core/util.ts';
import {
  cur, dead, equipmentTerms, firstName, freight, freightBackground, freightCase, freightChatter, freightDayStart, freightDeal, hh, hourOf, personName,
  quoteText, rateConFile, rateConLines, rfqBody, sayWin, show, signDispatch, signUs, win, withParties, poss,
} from './vertical.ts';

export const lateEvidence: Archetype = {
  id: 'late_evidence',
  title: 'An old rate con resurfaces after the revision',
  capabilities: ['late_evidence', 'supersession', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('freight', 'late_evidence', variant));
    const g = variant === 0;
    const d = freightDeal(r, variant);
    const { self, dispatcher, ops } = d.cast;
    const disp = dispatcher.address;

    // ---- parameters
    const mode: 'ops_forward' | 'carrier_billing' = g ? 'ops_forward' : r.pick(['ops_forward', 'carrier_billing'] as const);
    const revised: 'rate' | 'pickup' = g ? 'rate' : r.pick(['rate', 'rate', 'pickup'] as const);
    const cut = g ? 150 : r.pick([75, 100, 150, 200]);
    const lh2 = d.linehaul - cut;
    const all2 = lh2 + d.fuel;
    const shift = hourOf(d.reqPickup.end) - hourOf(d.pickupWin.end); // 2–4h, keeps the new window inside the shipper's
    const win2 = win(d.pickupDay, hh(hourOf(d.pickupWin.start) + shift), hh(hourOf(d.pickupWin.end) + shift));
    const booked = g ? true : r.chance(0.6);
    const k = g ? 0 : r.int(0, 3);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 1 : r.int(0, 3);
    const v1 = rateConFile(d);
    const v2 = rateConFile(d, 2);
    const billing: BenchParty = { address: `billing@${d.carrier.domain}`, name: `${d.carrier.company} Billing`, role: 'counterparty', label: 'carrier billing', authority: ['payment.'], group: 'carrier' };

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => freightDayStart(d, day, hhmm);

    // ---- history
    const rfq = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '08:00'), subject: `${d.alias} — ${d.lane.origin} to ${d.lane.dest}`, body: rfqBody(r, d, g, dispatcher) });
    const quote = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(0, '09:30'), subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', quoteText(r, d, g, k), signDispatch(d)), attachments: [pdf(v1, rateConLines(d, { date: d.start }))],
    });
    const counter = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '10:05'), subject: mb.reSubject(quote), replyTo: quote,
      body: body(`Thanks ${firstName(dispatcher)}.`, revised === 'rate'
        ? (g ? `Can you do ${moneyShort(all2)} all-in? That's where my customer is on this lane.` : r.pick([`Any chance you can do ${moneyShort(all2)} all-in?`, `I'm at ${moneyShort(all2)} all-in on this one — can you make that work?`, `Could you meet me at ${moneyShort(all2)} all in?`]))
        : r.pick([`The shipper asked if the truck can come later. Can you do ${sayWin(win2, k)} instead?`, `Could your driver load ${sayWin(win2, k)}? Shipper prefers the later slot.`, `Shipper would like the truck ${sayWin(win2, k)}. Possible?`]), signUs(r, g)),
    });
    const agree = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(0, '11:20'), subject: mb.reSubject(counter), replyTo: counter,
      body: body(revised === 'rate'
        ? (g ? `OK, ${moneyShort(all2)} all-in works (${moneyShort(lh2)} linehaul + ${moneyShort(d.fuel)} fuel). Revised rate con attached — please use rev 2.` : r.pick([`Fine, ${moneyShort(all2)} all-in. Rev 2 attached.`, `We can do ${moneyShort(all2)} all in. Updated rate con attached, rev 2.`, `Deal at ${moneyShort(all2)}. Revised rate con (rev 2) attached; everything else the same.`]))
        : r.pick([`Yes, ${sayWin(win2, k)} works. Revised rate con attached.`, `Driver can do ${sayWin(win2, k)}. Rev 2 attached.`, `No problem, pickup ${sayWin(win2, k)}. Updated rate con attached.`]), firstName(dispatcher)),
      attachments: [pdf(v2, rateConLines(d, { date: d.start, revision: 2, ...(revised === 'rate' ? { linehaul: lh2 } : { pickup: win2 }) }))],
    });
    let book: string | null = null;
    if (booked) {
      book = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '11:45'), subject: mb.reSubject(agree), replyTo: agree,
        body: body(`Great — you're booked on ${d.alias} per rev 2.`, signUs(r, g)),
      });
    }
    freightBackground(r, d, mb, t(0, '11:55'), nBackground);
    freightChatter(r, d, mb, t(0, '12:10'), nChatter);

    const fwd = mode === 'ops_forward'
      ? mb.add({
        direction: 'inbound', from: ops.address, fromName: personName(ops), to: [self.address], at: t(0, '16:05'), subject: `Fwd: ${d.alias} rate con`,
        body: body(g ? `${poss(d.commodity.shipper)} AP asked for the carrier rate con on ${d.alias}. Found this one in the shared drive — this is what we're paying, right?` : r.pick([
          `Customer wants a copy of the carrier rate con for ${d.alias}. Is the attached the right one?`,
          `Found this rate con for ${d.alias} in the load folder. Can I send it to the customer as is?`,
          `Pulling paperwork for ${d.alias} — attached is what I have from ${d.carrier.company}. Still current?`,
        ]), firstName(ops)),
        attachments: [pdf(v1, rateConLines(d, { date: d.start }))], note: 'old copy of v1, dated before the revision',
      })
      : mb.add({
        direction: 'inbound', from: billing.address, fromName: billing.name, to: [self.address], at: t(0, '16:05'), subject: `Rate confirmation — ${d.alias}`,
        body: body('Hello,', r.pick([`Attached is the rate confirmation for load ${d.alias} for your records. Invoice will follow after delivery.`, `Please find attached the rate con on file for ${d.alias}. We'll invoice after delivery.`, `For your records: rate confirmation for ${d.alias} attached.`]), `${d.carrier.company} Billing`),
        attachments: [pdf(v1, rateConLines(d, { date: d.start }))], note: 'old copy of v1 from the carrier billing desk',
      });

    // ---- oracle
    const both = [quote, agree];
    const terms: OracleTerm[] = revised === 'rate'
      ? [cur(disp, 'rate.linehaul', lh2, [agree]), cur(disp, 'rate.fuel_surcharge', d.fuel, both), cur(disp, 'rate.all_in', all2, [agree], true), cur(disp, 'pickup.window', d.pickupWin, both, true)]
      : [cur(disp, 'rate.linehaul', d.linehaul, both), cur(disp, 'rate.fuel_surcharge', d.fuel, both), cur(disp, 'rate.all_in', d.allIn, both, true), cur(disp, 'pickup.window', win2, [agree], true)];
    terms.push(cur(disp, 'delivery.eta', d.appt, both), ...equipmentTerms(d, disp, both), cur(disp, 'payment.terms', d.payTerms, both));
    if (book) terms.push(cur(self.address, 'decision.tender', 'booked', [book]));
    const superseded = revised === 'rate'
      ? [dead(disp, 'rate.all_in', d.allIn, [quote], agree), dead(disp, 'rate.linehaul', d.linehaul, [quote], agree)]
      : [dead(disp, 'pickup.window', d.pickupWin, [quote], agree)];
    const curWords = revised === 'rate' ? `${moneyShort(all2)} all-in` : `pickup ${show('pickup.window', win2)}`;
    const oldWords = revised === 'rate' ? `${moneyShort(d.allIn)} all-in` : `pickup ${show('pickup.window', d.pickupWin)}`;
    const opsAsk = mode === 'ops_forward';
    const needSend = opsAsk || revised === 'rate';
    const checkpoint: Checkpoint = {
      id: 'after_old_copy', after: fwd, now: t(0, '16:20'),
      state: {
        terms,
        superseded,
        open_loops: opsAsk ? [{ kind: 'ask', debtor: self.address, subject: 'document.rate_confirmation', alt_subjects: [revised === 'rate' ? 'rate.all_in' : 'pickup.window'], display: 'Ops asks whether the attached (old) rate con is the current one', evidence: [fwd], critical: true }] : [],
        closed_loops: [
          { kind: 'ask', debtor: disp, subject: 'rate.all_in', display: 'All-in rate (answered)', evidence: [quote] },
          { kind: 'ask', debtor: disp, subject: revised === 'rate' ? 'rate.all_in' : 'pickup.window', display: revised === 'rate' ? 'Counter-offer on the rate (accepted)' : 'Later pickup request (accepted)', evidence: [agree] },
          { kind: 'ask', debtor: disp, subject: 'document.rate_confirmation', display: 'Rate con (received; revised)', evidence: [agree] },
        ],
        conflicts: [],
        documents: [
          { filename: v1, status: 'superseded', stale_terms: [], display: `${v1}: original rate con, replaced by rev 2 (the copy that just arrived is old)` },
          { filename: v2, status: 'current', stale_terms: [], display: `${v2}: current` },
        ],
        next_actor: needSend || !book ? 'us' : 'them',
      },
      judge_facts: [
        `The carrier first quoted ${oldWords} (rate con ${v1}), then agreed to ${curWords} in revision 2 (${v2})${book ? ', and we booked on rev 2' : ''}.`,
        `The copy of ${v1} that ${opsAsk ? 'ops just forwarded' : "the carrier's billing desk just sent"} is the old version and does not change anything: ${curWords} is current, ${oldWords} is dead.`,
        opsAsk ? 'Ops is asking whether that copy is the current rate con; the answer is no, use rev 2.' : '',
        book ? '' : 'The load is not booked yet; rev 2 meets every requirement.',
      ].filter(Boolean).join(' '),
      action: {
        expect: needSend ? 'send' : 'any',
        required: opsAsk
          ? [
            { id: 'to_ops', text: 'Replies to ops', det: { type: 'message_to', party: ops.address } },
            { id: 'point_to_rev2', text: `Tells ops the attached copy is outdated and the current rate con is rev 2 (${curWords})` },
          ]
          : needSend ? [{ id: 'flag_billing', text: `Tells the carrier (billing or dispatch) that the copy is superseded and the agreed terms are rev 2 (${curWords})` }] : [],
        optional: [
          ...(opsAsk ? [{ id: 'send_rev2', text: 'Offers or attaches rev 2 for the customer' }] : [{ id: 'to_billing', text: 'Writes to the carrier billing desk', det: { type: 'message_to' as const, party: billing.address } }]),
          ...(book ? [] : [{ id: 'book', text: `Books the load on rev 2 (${curWords})` }]),
        ],
        prohibited: [
          { id: 'stale_value', text: staleText(`Treats ${oldWords} (the original rate con) as current or confirms the old copy is correct`), stale: true },
          { id: 'renegotiate', text: reaskText('Reopens the negotiation, or asks the carrier to confirm again that the rev 2 terms hold (asking the carrier to update its file or invoice to rev 2 is fine)') },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return freightCase(lateEvidence, variant, {
      description: `Rev 2 changes ${revised === 'rate' ? `the all-in to ${moneyShort(all2)}` : `pickup to ${show('pickup.window', win2)}`}; an old v1 copy arrives later via ${mode}.`,
      task: mode === 'carrier_billing' ? withParties(d.task, billing) : d.task, mb, trigger: fwd, checkpoints: [checkpoint],
      params: { mode, revised, cut, all2, win2, booked, k, nBackground, nChatter, allIn: d.allIn },
    });
  },
};

export { freight };
