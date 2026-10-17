// Deterministic guard on agent-initiated sends. Untrusted inbound mail can steer what an LLM
// writes, so every outbound action is checked against *state*:
//  - recipients must be known task participants (no exfiltration to addresses picked up from mail)
//  - binding language toward a counterparty (accepting an order, approving payment) is blocked
//    while a hard requirement fails or a claim is contested — that call belongs to a human.
//  - credentials never leave.
import type { CheckResult, Claim, TaskSpec } from '../types.ts';
import { domainFor } from '../domain/pack.ts';
import { BINDING_PATTERNS } from '../domain/procurement.ts';
import '../domain/index.ts';

export interface GuardResult { allowed: boolean; reasons: string[] }

/** A binding phrase preceded (within ~40 chars) by one of these is negated or conditional. */
const NEGATION = /\b(not|cannot|can't|can not|won't|will not|unable to|don't|do not|couldn't|could not|before we|until we|if we|once we|ready to|so (?:that )?we can|in order to|able to|asking|asked|requests?|requesting|telling|told|wants? us to)\b[^.!?]{0,40}$/i;

const SECRET = /\b(prim_[A-Za-z0-9_]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|api[_ -]?key\s*[:=])/i;

/** Make sure a pattern can be used with matchAll (which requires the global flag). */
function globalCopy(rx: RegExp): RegExp {
  const flags = rx.flags.includes('g') ? rx.flags : `${rx.flags}g`;
  return new RegExp(rx.source, flags);
}

/** Binding phrases that are neither negated nor conditional ("we cannot accept the offer", "once we accept"). */
export function bindingPhrases(body: string, patterns: RegExp[] = BINDING_PATTERNS): string[] {
  const matches = patterns.flatMap((rx) => [...body.matchAll(globalCopy(rx))]);
  const found: string[] = [];
  for (const m of matches) {
    const start = m.index!;
    const lead = body.slice(Math.max(0, start - 40), start + m[0].length);
    if (!NEGATION.test(lead)) found.push(m[0]);
  }
  return found;
}

export function guardSend(task: TaskSpec, to: string, body: string, checks: CheckResult[], claims: Claim[]): GuardResult {
  const reasons: string[] = [];
  const recipient = to.toLowerCase();
  const party = task.participants.find((p) => p.address.toLowerCase() === recipient);
  if (!party || party.role === 'self') reasons.push(`recipient ${to} is not a participant of task ${task.alias}`);
  if (SECRET.test(body)) reasons.push('message appears to contain a credential');

  // binding language matters only toward counterparties; internal mail (e.g. to finance) cannot commit us to them
  if (party?.role === 'counterparty' && bindingPhrases(body, domainFor(task).bindingPatterns).length) {
    const failing = checks.filter((c) => c.status !== 'pass');
    const contested = claims.filter((c) => c.status === 'contested');
    if (failing.length) {
      const why = failing.map((c) => `${c.label}: ${c.status}${c.status === 'fail' ? ` — ${c.detail}` : ''}`).join('; ');
      reasons.push(`binding language blocked: requirements not met (${why})`);
    }
    if (contested.length) {
      reasons.push(`binding language blocked: contested terms (${contested.map((c) => c.key).join(', ')})`);
    }
  }
  return { allowed: reasons.length === 0, reasons };
}
