// Who may call the API. A caller sends `Authorization: Bearer ctk_...`; we keep only the SHA-256
// of that token. Each principal lives in exactly one organization and can optionally be narrowed
// to a set of tasks and to a single agent identity. This is about API permissions only — whether
// a mail sender may *assert* a task term is a separate idea (participants[].authority).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Backend, Principal, PrincipalKind } from './store/backend.ts';

// `approve` decides held commitments and verifications. It is a HUMAN credential: agents are never given
// it, and the operator wildcard '*' does not imply it — it has to be granted by name.
export const SCOPES = ['context:read', 'evidence:read', 'send', 'agent:write', 'tasks:write', 'ingest', 'approve'] as const;
export type Scope = (typeof SCOPES)[number] | '*';

/** Scopes '*' does not cover. */
const EXPLICIT_ONLY: Scope[] = ['approve'];

/** What each kind of principal gets when no explicit scopes are requested. */
export const DEFAULT_SCOPES: Record<PrincipalKind, Scope[]> = {
  agent: ['context:read', 'evidence:read', 'send', 'agent:write'],
  operator: ['*'],
  ingest: ['ingest'],
};

/** A human approver: reads state and evidence, decides approvals, and nothing else (cannot send as an agent). */
export const APPROVER_SCOPES: Scope[] = ['approve', 'context:read', 'evidence:read'];

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Create a principal and return the plaintext token once; only its hash is persisted. */
export async function mintToken(
  backend: Backend,
  p: { org: string; kind: PrincipalKind; agent_id?: string | null; scopes?: Scope[]; task_ids?: string[] | null; label?: string | null },
) {
  // approval is a human credential: an agent that could approve would decide its own held commitments
  if (p.kind === 'agent' && p.scopes && p.scopes.includes('approve')) throw new Error('agent tokens cannot hold the approve scope');
  const secret = randomBytes(24).toString('base64url');
  const token = `ctk_${secret}`;
  const principal: Principal = {
    id: `pr_${randomUUID().slice(0, 12)}`,
    org: p.org,
    kind: p.kind,
    agent_id: p.agent_id ?? null,
    scopes: p.scopes ?? DEFAULT_SCOPES[p.kind],
    task_ids: p.task_ids ?? null,
    label: p.label ?? null,
  };
  await backend.ensureOrg(p.org);
  await backend.createPrincipal(principal, hashToken(token));
  return { token, principal };
}

export function hasScope(p: Principal, s: Scope) {
  if (EXPLICIT_ONLY.includes(s)) return p.scopes.includes(s);
  return p.scopes.includes('*') || p.scopes.includes(s);
}

/** A principal without a task list may touch every task in its org. */
export function canTask(p: Principal, taskId: string) {
  return !p.task_ids || p.task_ids.includes(taskId);
}

/** With auth switched off (offline/local only) every request runs as this local operator, who is also the
 *  person at the console — so it may approve. */
export const localPrincipal = (org: string): Principal => ({
  id: 'local',
  org,
  kind: 'operator',
  agent_id: null,
  scopes: ['*', 'approve'],
  task_ids: null,
  label: 'local (auth off)',
});

/** A bind address only this machine can reach. */
export const isLoopback = (host: string) => ['127.0.0.1', '::1', 'localhost'].includes(host) || /^127\./.test(host);

/** The Host header names this machine. An open (auth off) server must not answer a DNS-rebinding page, which sends its own host. */
export function loopbackHostHeader(req: IncomingMessage): boolean {
  const h = String(req.headers.host ?? '').toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  return name === 'localhost' || name === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(name);
}
