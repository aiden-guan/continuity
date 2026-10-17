// LIVE MODE: acts as the scripted supplier and finance over real Primitive mail, using two other inboxes
// on your domain (e.g. supplier@<you>.primitive.email and finance@<you>.primitive.email). It reacts to
// what the agent really sends, answering in-thread through Primitive's reply API:
//   RFQ to supplier           → offer + quote PDF
//   budget request to finance → approval
//   (after both, + delay)      → supplier correction + promise of revised quote (2nd reply on the RFQ)
//   delivery pushback          → expedite offer + revised quote PDF
//
// Safe to restart: each stage looks at Primitive's reply_count first and sends with its own
// Idempotency-Key, so running it again never sends a stage twice. (With a shared key, Primitive would
// treat a second reply to the same inbound email as a replay of the first and not send it.)
//
//   npm run live:counterparty        (CORRECTION_DELAY_SECONDS defaults to 20)
import { createPrimitiveClient, type ReplyInput, type SendResult } from '@primitivedotdev/sdk';
import { getEmail } from '@primitivedotdev/sdk/api';
import { counterparty, defaultAddresses, quoteV1, quoteV2 } from '../src/sim/scenario.ts';

const apiKey = process.env.PRIMITIVE_API_KEY;
if (!apiKey) {
  console.error('PRIMITIVE_API_KEY required');
  process.exit(1);
}
const addr = defaultAddresses();
const correctionDelayMs = Number(process.env.CORRECTION_DELAY_SECONDS || 20) * 1000;
const primitive = createPrimitiveClient({ apiKey });
const pdf = (filename: string, bytes: Buffer) => ({ filename, content_type: 'application/pdf', content_base64: bytes.toString('base64') });
const log = (text: string) => console.log(`[counterparty] ${text}`);
const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

type Replyable = { id: string; reply: (i: ReplyInput, o?: { idempotencyKey?: string }) => Promise<SendResult> };

/** How many replies Primitive has already recorded for an inbound email. */
async function repliesSoFar(id: string): Promise<number> {
  const detail = await getEmail({ client: primitive.client, path: { id } });
  return (detail.data as { data?: { reply_count?: number } } | undefined)?.data?.reply_count ?? 0;
}

async function replyOnce(email: Replyable, stage: string, input: ReplyInput) {
  const sent = await email.reply(input, { idempotencyKey: `continuity-counterparty:${email.id}:${stage}` });
  if (sent.idempotentReplay) log(`${stage}: Primitive reports an idempotent replay (already sent earlier) — nothing new sent`);
  else log(`${stage}: sent (${sent.id}, ${sent.status})`);
}

// story progress
let rfq: Replyable | null = null;
let offered = false;
let approved = false;
let corrected = false;
let resolved = false;

/** Once the offer and the approval are both out, send the supplier's correction (once, after a delay). */
async function maybeCorrect() {
  if (!offered || !approved || corrected || !rfq) return;
  corrected = true;
  if ((await repliesSoFar(rfq.id)) >= 2) {
    log('correction already sent earlier');
    return;
  }
  log(`supplier will send the correction in ${correctionDelayMs / 1000}s (kill the agent now for the demo)`);
  await new Promise((resolve) => setTimeout(resolve, correctionDelayMs));
  await replyOnce(rfq, 'supplier-correction', { text: counterparty.supplierCorrection(addr, { messageId: null, subject: '', references: [] }).body });
}

async function onSupplierMail(email: Replyable, already: number) {
  if (!rfq) {
    rfq = email;
    if (already === 0) {
      await replyOnce(email, 'supplier-offer', {
        text: counterparty.supplierOffer(addr, { messageId: null, subject: '' }).body,
        attachments: [pdf('Northwind-Quote-Q-2291.pdf', quoteV1())],
      });
    } else {
      log('offer already sent earlier');
    }
    offered = true;
    void maybeCorrect();
    return;
  }
  if (corrected && !resolved) {
    resolved = true;
    if (already !== 0) {
      log('resolution already sent earlier');
      return;
    }
    await replyOnce(email, 'supplier-resolution', {
      text: 'Understood on the Friday deadline. We can air-freight the remaining 200 units so all 500 arrive Friday, Oct 23. That brings the unit price to $11.48 per unit. Revised quote attached (Q-2291 rev 2).\n\nDana',
      attachments: [pdf('Northwind-Quote-Q-2291-rev2.pdf', quoteV2())],
    });
  }
}

async function onFinanceMail(email: Replyable, already: number) {
  if (already === 0) await replyOnce(email, 'finance-approval', { text: counterparty.financeApproval(addr, { messageId: null, subject: '' }).body });
  else log('approval already sent earlier');
  approved = true;
  void maybeCorrect();
}

async function main() {
  log(`playing supplier=${addr.supplier} finance=${addr.finance}; reacting to mail from ${addr.self}`);
  for await (const email of primitive.inbox.stream({ waitSeconds: 30 })) {
    if (!same(email.from, addr.self)) continue; // only the agent's mail gets a response
    const already = await repliesSoFar(email.id);
    if (same(email.to, addr.supplier)) await onSupplierMail(email, already);
    else if (same(email.to, addr.finance) && !approved) await onFinanceMail(email, already);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
