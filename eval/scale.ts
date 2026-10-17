// How do the compiled briefing and the raw transcript grow as a negotiation gets longer?
// Builds deterministic synthetic histories (seeded random), quoting replies the way real mail clients do.
//
//   node eval/scale.ts
import { Harness } from '../src/sim/harness.ts';
import { defaultAddresses, procurementTask, quoteV1 } from '../src/sim/scenario.ts';
import { estimateTokens } from '../src/compiler/compile.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

const addr = defaultAddresses();

// A tiny linear congruential generator, so every run produces the same histories.
let seed = 7;
function random() {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
}

// Operational mail that carries no terms.
const CHATTER = [
  'Quick update on PO-4817: production is on track.',
  'FYI our QA team finished inspecting the first batch for PO-4817.',
  'PO-4817: boards ship in ESD trays, 50 per tray.',
  'Our carrier confirmed pickup slots for PO-4817.',
  'Reminder that our office closes early on Friday.',
  'Certificates of conformance for PO-4817 will be included.',
  'PO-4817: we updated the labeling to include your part number.',
  'Thanks for the call earlier regarding PO-4817.',
];

// Pick the next supplier message. The order of random() calls matters for reproducibility.
function nextSupplierBody(price: { value: number }): string {
  const roll = random();
  if (roll < 0.65) return CHATTER[Math.floor(random() * CHATTER.length)];
  if (roll < 0.8) {
    const step = random() < 0.5 ? -0.02 : 0.02;
    price.value = Math.round((price.value + step) * 100) / 100;
    return `Revised pricing for PO-4817: we can now do $${price.value.toFixed(2)} per unit.`;
  }
  if (roll < 0.9) return 'Can you confirm the delivery address for PO-4817?';
  return `Correction: only ${300 + Math.floor(random() * 3) * 50} units can arrive Friday. The other units won't arrive until Wednesday, Oct 28.`;
}

async function buildHistory(extraMessages: number) {
  seed = 7;
  const h = new Harness(structuredClone(procurementTask(addr)));
  // every message is 20 minutes after the previous one
  let clock = Date.parse('2026-10-19T09:00:00Z');
  const tick = () => new Date((clock += 20 * 60_000)).toISOString();

  const rfq = await h.out(addr.supplier, 'RFQ — PO-4817', 'Hi Dana, can you deliver all 500 units by Friday, Oct 23, and what is your unit price? Please send a formal quote.', tick());
  await h.out(addr.finance, 'Budget — PO-4817', 'Could you approve a budget of up to $11.50 per unit for PO-4817?', tick());
  const replySubject = `Re: ${rfq.subject}`;
  let previous = await h.in({
    from: addr.supplier, fromName: 'Dana', to: addr.self, subject: replySubject,
    body: 'We can deliver 500 units Friday (Oct 23) at $11.40 each. Quote attached.', at: tick(), threadKey: 's', inReplyTo: rfq.messageId,
    attachments: [{ filename: 'Q-2291.pdf', content_type: 'application/pdf', bytes: quoteV1() }],
  });

  const price = { value: 11.4 };
  for (let i = 0; i < extraMessages; i++) {
    const body = nextSupplierBody(price);
    // the supplier keeps replying on the same thread, quoting the previous message
    previous = await h.in({ from: addr.supplier, fromName: 'Dana', to: addr.self, subject: replySubject, body, at: tick(), threadKey: 's', inReplyTo: previous.messageId });
    if (random() < 0.3) {
      await h.out(addr.supplier, replySubject, 'Thanks Dana, noted. The delivery address is our Fremont dock.', tick(), { messageId: previous.messageId });
    }
  }
  return h;
}

const rows: { messages: number; transcript: number; briefing: number; ratio: string }[] = [];
for (const n of [5, 10, 25, 50, 100, 200]) {
  const h = await buildHistory(n);
  const transcript = estimateTokens(h.transcriptText());
  const briefing = estimateTokens(h.briefing('fresh-agent'));
  rows.push({ messages: h.store.eventsForTask(h.task.id).length, transcript, briefing, ratio: (briefing / transcript).toFixed(2) });
}

console.log('\nmessages  transcript≈tok  briefing≈tok  briefing/transcript');
for (const row of rows) {
  const cells = [
    String(row.messages).padStart(8),
    String(row.transcript).padStart(14),
    String(row.briefing).padStart(12),
    row.ratio.padStart(8),
  ];
  console.log(cells.join('  '));
}

mkdirSync('eval/results', { recursive: true });
writeFileSync('eval/results/scale.json', JSON.stringify(rows, null, 1));
console.log('\n(token counts are chars/4 estimates; transcript includes quoted reply history as real mail clients send it)');
