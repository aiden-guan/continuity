// Small resilience primitives for the interpretation step (no dependencies).

/** At most `max` jobs run at once; the rest wait in FIFO order. */
export function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Circuit breaker: after `threshold` consecutive transient failures it opens for `cooldownMs`,
 * so an outage costs one fast fallback per event instead of a full deadline each. After the
 * cooldown one trial call is let through (half-open); success closes it, failure re-opens it.
 */
export class Breaker {
  #failures = 0;
  #openUntil = 0;
  #trial = false;
  threshold: number;
  cooldownMs: number;
  now: () => number;
  constructor(threshold = 3, cooldownMs = 60_000, now = () => Date.now()) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
  }

  /** May a call go through now? */
  allow(): boolean {
    if (this.#failures < this.threshold) return true;
    if (this.now() < this.#openUntil || this.#trial) return false;
    this.#trial = true; // half-open: exactly one trial
    return true;
  }
  success() { this.#failures = 0; this.#trial = false; }
  failure() {
    this.#failures++;
    this.#trial = false;
    if (this.#failures >= this.threshold) this.#openUntil = this.now() + this.cooldownMs;
  }
  get state(): 'closed' | 'open' | 'half-open' {
    if (this.#failures < this.threshold) return 'closed';
    return this.now() < this.#openUntil ? 'open' : 'half-open';
  }
}

/**
 * Outages and overload (timeouts, connection errors, 408/409/429/5xx) count against the breaker;
 * bad output (refusal, JSON parse error, 400) does not — retrying elsewhere would not help it.
 */
export function isTransient(err: unknown): boolean {
  const e = err as { name?: string; status?: number; code?: string } | null;
  if (!e) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError' || e.name === 'APIUserAbortError') return true;
  if (typeof e.status === 'number') return e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(e.code ?? '');
}

/** Settles like `p`, but rejects as soon as `signal` aborts — even if whatever produces `p` ignores the signal. */
export function withDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
