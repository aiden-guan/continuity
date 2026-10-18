// Registers the PO-4817 task with a running Continuity server, using whichever addresses are configured.
//   CONTINUITY_SELF_ADDRESS=procurement@you.primitive.email CONTINUITY_SUPPLIER_ADDRESS=... CONTINUITY_FINANCE_ADDRESS=... node scripts/create-task.ts
import { defaultAddresses, procurementTask } from '../src/sim/scenario.ts';

const base = process.env.CONTINUITY_URL || 'http://localhost:4100';
const spec = procurementTask(defaultAddresses());
const token = process.env.CONTINUITY_TOKEN;
const headers: Record<string, string> = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
const res = await fetch(`${base}/tasks`, { method: 'POST', headers, body: JSON.stringify(spec) });
console.log(res.status, await res.text());
