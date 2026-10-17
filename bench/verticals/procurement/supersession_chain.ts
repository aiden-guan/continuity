// Archetype: supersession chain (P1).
//
// A → B → C. The supplier quotes A (price P, all units by the deadline, Net 30, often with a PDF). We
// ask for a sharper price; the supplier answers with a bundled counteroffer B that changes three terms
// at once (lower price, shorter payment terms, later delivery). Then exactly one term reverts to its
// A value in C: we insist on the deadline and they keep Friday after all; or our AP cannot do the
// short terms and they go back to Net 30; or the supplier's manager refuses the discount and the price
// goes back to P. The other two B values stand.
//
// Trap: per-term history. "Latest message wins" for the whole bundle loses the two B values that C
// only restates implicitly; "first value wins" or a summary keeps A. And a value that is current again
// must not be reported as superseded. The oracle has, per term, the latest value current (with every
// event that stated it), superseded = exactly the dead values (with the event that killed each), the
// PDF stale on exactly the terms whose current value differs from it, and a requirement violation
// when delivery ends up after the deadline.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleDocument, OracleLoop, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, nextWeekday, pdf, sayDate, seedOf, staleText } from '../../core/util.ts';
import { type Lot, SIGNATURE, firstName, later, lotsDisplay, procurementBackground, procurementCase, procurementChatter, procurementDayStart, procurementDeal, quoteLines, round2, sayFrom, shortName } from './vertical.ts';

type Key = 'price' | 'payment' | 'delivery';
const TERM: Record<Key, string> = { price: 'price.unit', payment: 'payment.terms', delivery: 'delivery.schedule' };

export const supersession_chain: Archetype = {
  id: 'supersession_chain',
  title: 'Bundled counteroffer, then one term reverts',
  capabilities: ['supersession', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'supersession_chain', variant));
    const g = variant === 0;
    const d = procurementDeal(r, variant);
    const { self, supplier } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- parameters
    const revert: Key = g ? 'delivery' : r.pick(['delivery', 'payment', 'price'] as const);
    const discount = g ? 0.4 : Math.max(0.05, round2(Math.round((d.price * r.pick([0.03, 0.04, 0.05, 0.07])) / 0.05) * 0.05)); // 3–7% off
    const priceB = round2(d.price - discount);
    const payB = g ? 'Net 15' : r.pick(['Net 15', 'Net 10', 'Net 7']);
    const dayB = g ? nextWeekday(d.deadline, 1) : nextWeekday(d.deadline, r.pick([1, 2, 3]));
    const withPdf = g ? true : r.chance(0.6);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const ref = g ? 'Q-2291' : `Q-${r.int(1000, 9999)}`;
    const file = `${d.company.split(' ')[0]}-Quote-${ref}.pdf`;

    const A: Record<Key, unknown> = { price: d.price, payment: 'Net 30', delivery: [{ qty: d.qty, date: d.deadline }] as Lot[] };
    const B: Record<Key, unknown> = { price: priceB, payment: payB, delivery: [{ qty: d.qty, date: dayB }] as Lot[] };
    const show = (k: Key, v: unknown) => (k === 'price' ? moneyShort(v as number) : k === 'payment' ? String(v) : lotsDisplay(v as Lot[]));

    // ---- A
    const rfq = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '09:00'),
      subject: `RFQ: ${d.qty} x ${d.item.sku} — ${d.alias}`,
      body: body(`Hi ${firstName(supplier)},`, `Please quote ${d.qty} ${d.item.name} for ${d.alias}, all by ${sayDate(d.deadline, 'weekday_short_date')}.`, `Thanks,\n${SIGNATURE}`),
    });
    const a = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: t(0, '11:40'),
      subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', g
        ? `Our quote: ${moneyShort(d.price)} per unit, all ${d.qty} by ${sayDate(d.deadline, 'weekday')}, payment Net 30. PDF attached.`
        : r.pick([
          `${moneyShort(d.price)}/unit, the full ${d.qty} ${unit} by ${sayDate(d.deadline, 'weekday')}, Net 30.${withPdf ? ' Quote attached.' : ''}`,
          `We can do all ${d.qty} by ${sayDate(d.deadline, 'weekday_short_date')} at ${moneyShort(d.price)} each, payment Net 30.${withPdf ? ' Formal quote attached.' : ''}`,
          `Happy to quote ${moneyShort(d.price)} per unit with delivery ${sayDate(d.deadline, 'weekday')} for all ${d.qty}. Terms Net 30.${withPdf ? ' See PDF.' : ''}`,
        ]), firstName(supplier)),
      attachments: withPdf ? [pdf(file, quoteLines(d, { ref, date: d.start }))] : undefined,
    });
    procurementBackground(r, d, mb, t(0, '12:00'), nBackground, g ? 0 : r.int(0, 6));
    const haggle = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '15:30'),
      subject: mb.reSubject(rfq), replyTo: a,
      body: body(`Hi ${firstName(supplier)},`, g ? `Thanks. Is there any room on the ${moneyShort(d.price)}?` : r.pick([`Thanks. Can you sharpen the price at all?`, `Any flexibility on ${moneyShort(d.price)}/unit? We're comparing options.`, `Is ${moneyShort(d.price)} your best price for ${d.qty}?`]), SIGNATURE),
    });

    // ---- B: three terms change at once
    const bAt = t(1, g ? '10:15' : r.pick(['09:30', '10:15', '11:50']));
    const dayBSay = sayFrom(dayB, bAt, 'weekday');
    const b = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: bAt,
      subject: mb.reSubject(rfq), replyTo: haggle,
      body: body('Hi,', g
        ? `We can do ${moneyShort(priceB)} if you take ${payB} and accept delivery ${dayBSay} (we'd fit you into next week's run).`
        : r.pick([
          `Best I can do: ${moneyShort(priceB)}/unit, but that needs ${payB} payment and delivery on ${dayBSay} with next week's production run.`,
          `Counteroffer: ${moneyShort(priceB)} each on ${payB} terms, with all ${d.qty} delivered ${dayBSay} instead.`,
          `If we move you to next week's run (delivery ${dayBSay}) and payment is ${payB}, the price drops to ${moneyShort(priceB)}.`,
        ]), firstName(supplier)),
    });
    procurementChatter(r, d, mb, later(bAt, 15), nChatter, g ? 0 : r.int(0, 9));

    // ---- C: one term reverts
    let push: string | null = null;
    const pushAt = later(bAt, 120);
    if (revert === 'delivery') {
      push = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: pushAt, subject: mb.reSubject(rfq), replyTo: b, body: body(`Hi ${firstName(supplier)},`, g ? `The price and ${payB} work, but we need all ${d.qty} by ${sayDate(d.deadline, 'weekday')}. Can you keep ${sayDate(d.deadline, 'weekday')}?` : r.pick([`We can live with ${payB}, but ${sayDate(d.deadline, 'weekday')} is a hard deadline for us. Can you keep the original date?`, `${moneyShort(priceB)} and ${payB} are fine. The later delivery is not: we need everything by ${sayDate(d.deadline, 'weekday')}.`]), SIGNATURE) });
    } else if (revert === 'payment') {
      push = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: pushAt, subject: mb.reSubject(rfq), replyTo: b, body: body(`Hi ${firstName(supplier)},`, r.pick([`Our AP team can't do ${payB}. Could we keep Net 30 at that price?`, `${payB} won't work with our payment run; can we stay on Net 30?`]), SIGNATURE) });
    }
    const cAt = t(2, g ? '09:20' : r.pick(['09:05', '09:20', '13:45']));
    const cText: Record<Key, string[]> = {
      delivery: [
        `Good news: we can keep ${sayDate(d.deadline, 'weekday')} for all ${d.qty} after all. ${moneyShort(priceB)} and ${payB} as discussed. Shall I book it?`,
        `Production found room: all ${d.qty} by ${sayDate(d.deadline, 'weekday')}, still at ${moneyShort(priceB)} on ${payB}. Want me to go ahead?`,
        `OK, ${sayDate(d.deadline, 'weekday')} delivery is back on for the full ${d.qty}. Price and payment as per my last email. Confirm and I'll book it.`,
      ],
      payment: [
        `Fine, Net 30 it is. ${moneyShort(priceB)} and delivery ${sayFrom(dayB, cAt, 'weekday_short_date')} stand.`,
        `We can accept Net 30. The rest of my offer is unchanged: ${moneyShort(priceB)}/unit, delivery ${sayFrom(dayB, cAt, 'weekday_short_date')}.`,
        `Agreed on Net 30. Everything else as in my last email.`,
      ],
      price: [
        `Apologies, my manager didn't approve the discount, so the unit price goes back to ${moneyShort(d.price)}. ${payB} and the ${sayFrom(dayB, cAt, 'weekday_short_date')} delivery stand.`,
        `I have to walk back the ${moneyShort(priceB)}: our price stays at ${moneyShort(d.price)}. The ${payB} terms and next-week delivery remain as offered.`,
        `Sorry, the discount was not signed off. Price is ${moneyShort(d.price)} again; the rest of my last offer is unchanged.`,
      ],
    };
    const c = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: cAt,
      subject: mb.reSubject(rfq), replyTo: push ?? b,
      body: body('Hi,', g ? cText.delivery[0] : r.pick(cText[revert]), firstName(supplier)),
    });

    // ---- oracle: per-term history
    const keys: Key[] = ['price', 'payment', 'delivery'];
    const C: Record<Key, unknown> = { ...B, [revert]: A[revert] };
    const terms: OracleTerm[] = [];
    const superseded: OracleSuperseded[] = [];
    for (const k of keys) {
      const reverted = k === revert;
      // events stating the current value: A and C for the reverted term; B and C for the others (C restates them)
      terms.push({ party: supplier.address, term: TERM[k], status: 'current', value: C[k], evidence: reverted ? [a, c] : [b, c], critical: k !== 'payment', display: show(k, C[k]) });
      if (reverted) superseded.push({ party: supplier.address, term: TERM[k], value: B[k], display: `${show(k, B[k])} (counteroffer)`, evidence: [b], superseded_by: c });
      else superseded.push({ party: supplier.address, term: TERM[k], value: A[k], display: `${show(k, A[k])} (original quote)`, evidence: [a], superseded_by: b });
    }
    const finalLate = revert !== 'delivery';
    const conflicts: OracleConflict[] = finalLate ? [{ kind: 'requirement_violation', term: 'delivery.schedule', party: supplier.address, display: `Delivery ${sayDate(dayB, 'weekday_short_date')} is after the ${sayDate(d.deadline, 'weekday_short_date')} deadline`, critical: true }] : [];
    const stale = keys.filter((k) => k !== revert).map((k) => TERM[k]);
    const documents: OracleDocument[] = withPdf ? [{ filename: file, status: 'partially_stale', stale_terms: stale, display: `${file}: ${stale.join(', ')} superseded; ${TERM[revert]} matches the current value again` }] : [];
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: supplier.address, subject: 'document.quote', alt_subjects: ['price.unit'], display: 'Quote (received)', evidence: [rfq, a] },
      { kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Room on the price? (answered with the counteroffer)', evidence: [haggle, b] },
    ];
    if (push) closed_loops.push({ kind: 'ask', debtor: supplier.address, subject: TERM[revert], display: `Our push-back on ${revert} (answered)`, evidence: [push, c] });
    const open_loops: OracleLoop[] = revert === 'delivery' ? [{ kind: 'ask', debtor: self.address, subject: 'decision.order', display: 'Supplier asks whether to book the order', evidence: [c] }] : [];

    const deadS = sayDate(d.deadline, 'weekday_short_date');
    const current = keys.map((k) => show(k, C[k])).join(', ');
    const dead = superseded.map((x) => x.display).join('; ');
    const prohibited: ActionCond[] = [
      { id: 'stale_value', text: staleText(`Uses a superseded value as current (${superseded.map((x) => show(keys.find((k) => TERM[k] === x.term)!, x.value)).join(' / ')})`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    if (finalLate) prohibited.unshift({ id: 'binding_accept', text: 'Accepts or confirms the order with delivery after the deadline', det: { type: 'binding_to', party: supplier.address } });
    const checkpoint: Checkpoint = {
      id: 'after_chain', after: c, now: later(cAt, 20),
      state: { terms, superseded, open_loops, closed_loops, conflicts, documents, next_actor: 'us' },
      judge_facts: [
        `Original quote: ${moneyShort(d.price)}/unit, Net 30, ${lotsDisplay(A.delivery as Lot[])}. Counteroffer: ${moneyShort(priceB)}/unit, ${payB}, ${lotsDisplay(B.delivery as Lot[])}. Then the ${revert} reverted to the original.`,
        `Current terms: ${current}. Dead values: ${dead}.`,
        finalLate ? `Delivery on ${sayDate(dayB, 'weekday_short_date')} misses Acme's ${deadS} deadline.` : `These terms meet Acme's requirements (all by ${deadS}, max ${moneyShort(d.budget)}/unit) and the supplier asks whether to book.`,
      ].join(' '),
      action: finalLate
        ? {
          expect: 'send',
          required: [
            { id: 'to_supplier', text: 'Sends a message to the supplier', det: { type: 'message_to', party: supplier.address } },
            { id: 'raise_late', text: `Tells the supplier the ${sayDate(dayB, 'weekday_short_date')} delivery misses the ${deadS} deadline and asks for ${deadS} delivery (or another fix)` },
          ],
          optional: [{ id: 'restate_current', text: `Restates the current price and payment terms correctly (${show('price', C.price)}, ${show('payment', C.payment)})` }],
          prohibited,
        }
        : {
          expect: 'send',
          required: [
            { id: 'to_supplier', text: 'Sends a message to the supplier', det: { type: 'message_to', party: supplier.address } },
            { id: 'proceed_current', text: `Proceeds on the current terms (${current}), e.g. confirms the booking` },
          ],
          optional: [],
          prohibited,
        },
    };

    return procurementCase(supersession_chain, variant, {
      description: `A (${moneyShort(d.price)}, Net 30, ${deadS}) → bundled B (${moneyShort(priceB)}, ${payB}, ${sayDate(dayB, 'weekday_short_date')}) → ${revert} reverts.`,
      task: d.task, mb, trigger: c, checkpoint,
      params: { revert, discount, priceB, payB, dayB, withPdf, nBackground, nChatter, ref, qty: d.qty, price: d.price, budget: d.budget, deadline: d.deadline },
    });
  },
};
