// Sender authentication: is the From address of an inbound email really who it claims to be?
//
// Authority (finance sets the budget, the supplier sets price and delivery) is granted by address,
// and the From header is typed by the sender. So authority needs proof: Primitive's SPF/DKIM/DMARC
// results, anchored to the From domain by the SDK's isTrustedSender (DMARC pass, DMARC domain = From
// domain, From strictly parses to exactly that one address — display-name tricks fail).
//
// Limits: DMARC proves the domain, not the mailbox. Two parties on one shared domain cannot be told
// apart by it. Forwarded / mailing-list mail usually fails (Primitive exposes no ARC results).
import { isTrustedSender } from '@primitivedotdev/sdk';

export type SenderAuthStatus = 'pass' | 'fail' | 'unknown';
export interface SenderAuth {
  status: SenderAuthStatus;
  /** SDK TrustReason ('trusted', 'auth-suspicious', 'auth-unknown', 'dmarc-temperror', ...) or 'dkim-aligned-no-dmarc' */
  reason: string;
  detail: string[];
  domain: string | null;
  dmarc: string | null;
  dmarc_policy: string | null;
  /** transient (DNS temperror): a later delivery could pass */
  retryable: boolean;
}

/**
 * Domains without a DMARC record are common among small suppliers. Their mail can still be proven by a
 * passing DKIM signature from exactly the From domain (CONTINUITY_DKIM_WITHOUT_DMARC=0 to disable).
 */
const dkimWithoutDmarc = () => process.env.CONTINUITY_DKIM_WITHOUT_DMARC !== '0';

/** `event` is an email.received webhook payload (or an EmailDetail adapted with `detailAsEvent`). */
export function senderAuthOf(event: Record<string, any>, from: string): SenderAuth {
  const auth = event?.email?.auth ?? null;
  const domain = from.includes('@') ? from.slice(from.lastIndexOf('@') + 1) : '';
  const base = { domain: domain || null, dmarc: auth?.dmarc ?? null, dmarc_policy: auth?.dmarcPolicy ?? null };
  if (!domain) return { status: 'fail', reason: 'from-header-invalid', detail: ['no From address'], retryable: false, ...base };
  let t = isTrustedSender(event as never, { domain, sender: from });
  if (!t.trusted && t.reason === 'auth-unknown' && auth?.dmarc === 'none' && dkimWithoutDmarc() && alignedDkim(auth, domain)) {
    // no DMARC record, but DKIM signed by exactly the From domain: evaluate as if that domain's DMARC passed via DKIM,
    // so the SDK's strict From parsing and sender checks still apply
    const asDmarc = { ...event, email: { ...event.email, auth: { ...auth, dmarc: 'pass', dmarcFromDomain: domain, dmarcDkimAligned: true } } };
    const viaDkim = isTrustedSender(asDmarc as never, { domain, sender: from });
    if (viaDkim.trusted) return { status: 'pass', reason: 'dkim-aligned-no-dmarc', detail: [`no DMARC record for ${domain}; DKIM signature by ${domain} verified`], retryable: false, ...base };
    t = viaDkim;
  }
  const status: SenderAuthStatus = t.trusted ? 'pass'
    : t.reason === 'auth-suspicious' || t.reason.startsWith('from-') || t.reason === 'sender-mismatch' || t.reason === 'dmarc-domain-mismatch' ? 'fail'
    : 'unknown';
  return { status, reason: t.reason, detail: t.auth.reasons, retryable: t.retryable, ...base };
}

function alignedDkim(auth: Record<string, any>, domain: string): boolean {
  return Array.isArray(auth.dkimSignatures) && auth.dkimSignatures.some((s: Record<string, any>) =>
    s?.result === 'pass' && String(s.domain ?? '').trim().toLowerCase() === domain
    && (s.algo === 'ed25519-sha256' || (s.algo === 'rsa-sha256' && typeof s.keyBits === 'number' && s.keyBits >= 1024)));
}

/** EmailDetail carries the same `auth` object as the webhook; give it the webhook's shape for the SDK. */
export const detailAsEvent = (d: Record<string, any>) => ({ email: { auth: d.auth, headers: { from: d.from_header ?? '' } } });

/** Read the stored verdict (JSON); values stored before this existed were plain strings. */
export function parseSenderAuth(v: string | null | undefined): SenderAuth | null {
  if (!v) return null;
  try { const o = JSON.parse(v); if (o && typeof o.status === 'string') return o; } catch { /* legacy */ }
  const legacy: Record<string, SenderAuthStatus> = { authenticated: 'pass', pass: 'pass', fail: 'fail' };
  return { status: legacy[v] ?? 'unknown', reason: `legacy:${v}`, detail: [], domain: null, dmarc: v, dmarc_policy: null, retryable: false };
}

/** enforce (default): unauthenticated senders get no authority. flag: they keep it, but every such email is flagged. */
export const senderAuthMode = (): 'enforce' | 'flag' => (process.env.CONTINUITY_SENDER_AUTH === 'flag' ? 'flag' : 'enforce');
