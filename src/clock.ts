// The server clock. In local simulation it can be moved so scenario dates ("Friday") stay meaningful.
//
// Stored times have ONE format: Date#toISOString(), 'YYYY-MM-DDTHH:mm:ss.sssZ' (UTC, always
// millisecond precision, fixed width). Every producer and every backend reader returns that form, so
// equal instants are equal strings and string order is time order. Code that orders or compares full
// timestamps still goes through compareIso (or Date.parse), so a value from outside (an API caller, an old row)
// can never sort wrongly: '…:00Z' and '…:00.000Z' are the same second, but 'Z' > '.' as strings.
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

/** The canonical stored form of a timestamp; a value that is not a time is returned unchanged. */
export function canonicalIso(v: string | Date): string {
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? String(v) : new Date(t).toISOString();
}

/** Comparator for ISO timestamps by instant, whatever their format; unparseable values sort as strings. */
export function compareIso(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a.localeCompare(b) : x - y;
}
