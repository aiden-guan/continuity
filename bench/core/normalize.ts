// Canonical forms for values, so "11.4", "$11.40" and 11.40 compare equal and two lot lists that say
// the same thing in a different order match. Used by the scorer and by case validation.
import type { ValueType, VerticalSpec } from './types.ts';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const round2 = (n: number) => Math.round(n * 100) / 100;

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function datetime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(' ', 'T');
  if (ISO_LOCAL.test(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  return m ? m[1] : null;
}

/** Canonical value, or null when the value is not a valid instance of the type. */
export function normalize(type: ValueType, value: unknown, values?: string[]): unknown | null {
  switch (type) {
    case 'money':
    case 'number':
    case 'percent': {
      const n = num(value);
      return n === null ? null : round2(n);
    }
    case 'date': {
      if (typeof value !== 'string') return null;
      const day = value.trim().slice(0, 10);
      return ISO_DAY.test(day) ? day : null;
    }
    case 'datetime':
      return datetime(value);
    case 'window': {
      const w = value as { start?: unknown; end?: unknown } | null;
      if (!w || typeof w !== 'object') return null;
      const start = datetime(w.start);
      const end = datetime(w.end);
      return start && end ? { start, end } : null;
    }
    case 'lots': {
      if (!Array.isArray(value) || !value.length) return null;
      const byDate = new Map<string, number>();
      for (const lot of value as Record<string, unknown>[]) {
        const qty = num(lot?.qty);
        const date = typeof lot?.date === 'string' ? lot.date.slice(0, 10) : '';
        if (qty === null || qty <= 0 || !ISO_DAY.test(date)) return null;
        byDate.set(date, (byDate.get(date) ?? 0) + qty);
      }
      return [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, qty]) => ({ qty, date }));
    }
    case 'text':
      // case, spacing and punctuation are not meaning: "Net-30" = "net 30", "Bank, acct. 4471" = "bank acct 4471"
      return typeof value === 'string' && value.trim() ? value.toLowerCase().replace(/[^a-z0-9/%$]+/g, ' ').trim() || null : null;
    case 'enum': {
      const v = typeof value === 'string' ? value.trim().toLowerCase() : null;
      return v && (!values || values.includes(v)) ? v : null;
    }
  }
}

export function termType(vertical: VerticalSpec, key: string): { type: ValueType; values?: string[] } | null {
  const t = vertical.terms.find((x) => x.key === key);
  return t ? { type: t.type, values: t.values } : null;
}

/** Parse an agent's value_json (falling back to the raw string) and normalise it for `key`. */
export function normalizeReported(vertical: VerticalSpec, key: string, valueJson: string): unknown | null {
  const t = termType(vertical, key);
  if (!t) return null;
  let parsed: unknown = valueJson;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    // a bare string like Net 30 or 2026-10-23 is fine
  }
  return normalize(t.type, parsed, t.values);
}

export const sameCanonical = (a: unknown, b: unknown) => a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
