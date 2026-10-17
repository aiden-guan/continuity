// Confirms the configured credentials work, without ever printing them.
//   npm run check:keys
import { anthropicClient } from '../src/anthropic.ts';
import { createPrimitiveClient } from '@primitivedotdev/sdk';
import { listDomains } from '@primitivedotdev/sdk/api';

const pass = (text: string) => console.log(`  ✔ ${text}`);
const fail = (text: string) => console.log(`  ✖ ${text}`);

async function checkAnthropic() {
  console.log('Anthropic');
  if (process.env.ANTHROPIC_WORKSPACE_ID) pass('ANTHROPIC_WORKSPACE_ID set (sent as anthropic-workspace-id)');
  if (!process.env.ANTHROPIC_API_KEY) {
    fail('ANTHROPIC_API_KEY not set (offline rule-based extractor + policy agent will be used)');
    return;
  }
  const model = process.env.CONTINUITY_AGENT_MODEL || 'claude-opus-5-5';
  try {
    const reply = await anthropicClient().messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] });
    pass(`key works — ${model} replied (stop_reason=${reply.stop_reason})`);
  } catch (e) {
    fail(`call failed: ${(e as Error).message}`);
  }
}

async function checkPrimitive() {
  console.log('Primitive');
  if (!process.env.PRIMITIVE_API_KEY) {
    fail('PRIMITIVE_API_KEY not set (local simulation will be used)');
    return;
  }
  const primitive = createPrimitiveClient({ apiKey: process.env.PRIMITIVE_API_KEY });
  try {
    const account = await primitive.account.get();
    pass(`key works — account ${account.email}, plan ${account.plan}, managed inbox: ${account.managed_inbox_address ?? '(none)'}`);
  } catch (e) {
    fail(`account lookup failed: ${(e as Error).message}`);
  }
  try {
    const res = await listDomains({ client: primitive.client });
    if (res.error) throw new Error(JSON.stringify(res.error));
    const domains = (res.data as { data?: { domain?: string; verified?: boolean }[] } | undefined)?.data ?? [];
    const listed = domains.map((d) => `${d.domain}${d.verified === false ? ' (unverified)' : ''}`).join(', ');
    pass(`domains: ${listed || '(none)'}`);
  } catch (e) {
    fail(`domain listing failed: ${(e as Error).message}`);
  }
  try {
    await primitive.memories.set({ key: 'continuity:check', value: { at: new Date().toISOString() } });
    pass('Primitive Memories write works');
  } catch (e) {
    fail(`Memories write failed: ${(e as Error).message}`);
  }
}

function checkAddresses() {
  console.log('Addresses');
  for (const name of ['CONTINUITY_SELF_ADDRESS', 'CONTINUITY_SUPPLIER_ADDRESS', 'CONTINUITY_FINANCE_ADDRESS']) {
    const report = process.env[name] ? pass : fail;
    report(`${name} = ${process.env[name] ?? '(unset — scenario default)'}`);
  }
}

await checkAnthropic();
await checkPrimitive();
checkAddresses();
