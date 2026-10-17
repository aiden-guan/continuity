// Live inbound from Primitive, no public webhook URL required.
//
// Long-polls the Primitive inbox (`client.inbox.stream()` → GET /v1/emails?since&wait), pulls each
// email's detail with `getEmail`, and hands it to the running Continuity server. The stream cursor is
// saved in Primitive Memories, so a restarted receiver carries on from where it stopped.
//
//   PRIMITIVE_API_KEY=prim_... CONTINUITY_URL=http://localhost:4100 npm run receive
//
// (Or: point a Primitive webhook endpoint at POST {CONTINUITY_URL}/webhooks/primitive and set
// PRIMITIVE_WEBHOOK_SECRET; the server checks signatures with the SDK.)
import { createPrimitiveClient } from '@primitivedotdev/sdk';
import { getEmail } from '@primitivedotdev/sdk/api';

const apiKey = process.env.PRIMITIVE_API_KEY;
if (!apiKey) {
  console.error('PRIMITIVE_API_KEY is required for live receive (local mode uses the simulator instead).');
  process.exit(1);
}
const continuityUrl = process.env.CONTINUITY_URL || 'http://localhost:4100';
// only mail sent to the agent's own inbox counts as task communication (other inboxes in the org share the stream)
const selfAddress = (process.env.CONTINUITY_SELF_ADDRESS || '').toLowerCase();
const CURSOR_KEY = 'continuity:inbox-cursor';
// RECEIVE_SINCE=<ISO time>: skip mail received earlier (the live demo begins every run from a clean slate)
const notBefore = process.env.RECEIVE_SINCE ? Date.parse(process.env.RECEIVE_SINCE) : 0;
const primitive = createPrimitiveClient({ apiKey });

async function loadCursor(): Promise<string | undefined> {
  try {
    const saved = await primitive.memories.get(CURSOR_KEY);
    return (saved.value as { since?: string } | null)?.since;
  } catch {
    return undefined; // nothing saved yet
  }
}

function saveCursor(cursor: string) {
  return primitive.memories.set({ key: CURSOR_KEY, value: { since: cursor, at: new Date().toISOString() } });
}

async function main() {
  const since = await loadCursor();
  console.log(`[receive] streaming Primitive inbox${since ? ` from cursor ${since}` : ' from the beginning'} → ${continuityUrl}`);
  for await (const email of primitive.inbox.stream({ since, waitSeconds: 30 })) {
    const notForUs = selfAddress && email.to.toLowerCase() !== selfAddress;
    if (notForUs || Date.parse(email.receivedAt) < notBefore) {
      await saveCursor(email.cursor);
      continue;
    }
    const detail = await getEmail({ client: primitive.client, path: { id: email.id } });
    const body = (detail.data as { data?: unknown } | undefined)?.data;
    if (!body) {
      // skip it without advancing the cursor
      console.warn(`[receive] could not fetch ${email.id}`, detail.error);
      continue;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.CONTINUITY_TOKEN) headers.authorization = `Bearer ${process.env.CONTINUITY_TOKEN}`;
    const res = await fetch(`${continuityUrl}/ingest/primitive-email`, { method: 'POST', headers, body: JSON.stringify(body) });
    console.log(`[receive] ${email.id} "${email.subject}" → ${res.status} ${await res.text()}`);
    if (res.ok) await saveCursor(email.cursor);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
