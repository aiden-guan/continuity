// The server clock. In local simulation it can be moved so scenario dates ("Friday") stay meaningful.
let skewMs = 0;

export function now(): Date {
  return new Date(Date.now() + skewMs);
}

export function nowIso(): string {
  return now().toISOString();
}

/** Pretend the current time is `iso` from now on. */
export function setSimTime(iso: string): void {
  skewMs = Date.parse(iso) - Date.now();
}
