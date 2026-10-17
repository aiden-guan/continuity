// Mints a scoped Continuity API token. The token is shown exactly once; only its SHA-256 hash is kept.
//   npm run token -- --org org_acme --kind agent --agent agent-b --task PO-4817
//   npm run token -- --org org_acme --kind operator
//   npm run token -- --org org_acme --kind ingest            # for scripts/primitive-receive.ts
//   npm run token -- --org org_acme --kind approver --label "Sam (ops)"   # a HUMAN approver; never give it to an agent
import { parseArgs } from 'node:util';
import { openBackend, storageConfig } from '../src/store/index.ts';
import { APPROVER_SCOPES, mintToken, SCOPES, type Scope } from '../src/auth.ts';
import type { PrincipalKind } from '../src/store/backend.ts';

const { values: opt } = parseArgs({
  options: {
    org: { type: 'string', default: process.env.CONTINUITY_ORG || 'org_local' },
    kind: { type: 'string', default: 'agent' },
    agent: { type: 'string' },
    task: { type: 'string', multiple: true },
    scope: { type: 'string', multiple: true },
    label: { type: 'string' },
  },
});

// validate before touching storage
if (!['agent', 'operator', 'ingest', 'approver'].includes(opt.kind!)) throw new Error('--kind must be agent | operator | ingest | approver');
// an approver is an operator principal with exactly the approver scopes ('*' does not include approve)
const approver = opt.kind === 'approver';
if (opt.kind === 'agent' && !opt.agent) throw new Error('agent tokens need --agent <agent id>');
const knownScopes = SCOPES as readonly string[];
for (const s of opt.scope ?? []) {
  if (s !== '*' && !knownScopes.includes(s)) throw new Error(`unknown scope ${s} (${SCOPES.join(', ')})`);
}

const backend = await openBackend(storageConfig());
const org = opt.org!;
// task scopes are stored by canonical id, so resolve any aliases first
let taskIds: string[] | null = null;
if (opt.task?.length) {
  taskIds = await Promise.all(opt.task.map(async (t) => (await backend.getTask(org, t))?.id ?? t));
}
const { token, principal } = await mintToken(backend, {
  org,
  kind: (approver ? 'operator' : opt.kind) as PrincipalKind,
  agent_id: opt.agent ?? null,
  task_ids: taskIds,
  scopes: approver ? APPROVER_SCOPES : (opt.scope as Scope[] | undefined),
  label: opt.label ?? null,
});
const who = principal.agent_id ? ` (agent ${principal.agent_id})` : '';
// the description goes to stderr so stdout carries only the token
console.error(`minted ${principal.kind} token ${principal.id} for ${principal.org}${who} scopes=${principal.scopes.join(',')} tasks=${principal.task_ids?.join(',') ?? 'all'} — store it now; it is not shown again`);
console.log(token);
await backend.close();
