// Typed term values shared by every domain pack: validation into canonical form, and how a value reads
// in briefings. A pack declares each term's type; the resolver only ever stores canonical values, so
// "the same value" is a string comparison.
//
//   money     11.4                      (USD)
//   number    500
//   percent   80                        (meaning 80%)
//   date      "2026-10-23"
//   datetime  "2026-10-23T14:00"        (local time of the deal, no zone)
//   window    {start, end}              (two local datetimes, start <= end)
//   schedule  [{qty, date}, …]          (delivery lots, nightly room blocks, installments; one entry per date)
//   text      "Net 30"
//   enum      one of the term's values
import { isCalendarIso, prettyDate } from '../extract/dates.ts';
import type { TermDef } from './pack.ts';

export interface Lot { qty: number; date: string }
export interface Window { start: string; end: string }

const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ]((?:[01]\d|2[0-3]):[0-5]\d)(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const round2 = (n: number) => Math.round(n * 100) / 100;

function numeric(value: unknown): number | null {
  const digits = typeof value === 'string' ? value.replace(/[$,%\s]/g, '') : null;
  // Number('') is 0: a blank or symbol-only string is no number at all
  const n = typeof value === 'number' ? value : digits ? Number(digits) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** "2026-10-23T14:00" from a local or zoned datetime string; null otherwise. */
export function normalizeDatetime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(LOCAL);
  return m && isCalendarIso(m[1]) ? `${m[1]}T${m[2]}` : null;
}

/** Validate a proposed value against its term and put it in canonical form; null when unusable. */
export function normalizeTyped(def: TermDef, value: unknown): unknown | null {
  switch (def.type) {
    case 'money':
    case 'number':
    case 'percent': {
      const n = numeric(value);
      if (n === null) return null;
      const range = def.range ?? (def.type === 'percent' ? 'nonnegative' : 'positive');
      if (range === 'positive' && n <= 0) return null;
      if (range === 'nonnegative' && n < 0) return null;
      if (def.type === 'percent' && n > 100) return null; // a share: a 150% discount is no discount
      return round2(n);
    }
    case 'date':
      return typeof value === 'string' && isCalendarIso(value.trim().slice(0, 10)) ? value.trim().slice(0, 10) : null;
    case 'datetime':
      return normalizeDatetime(value);
    case 'window': {
      const w = value as Partial<Window> | null;
      if (!w || typeof w !== 'object') return null;
      const start = normalizeDatetime(w.start);
      const end = normalizeDatetime(w.end);
      return start && end && start <= end ? { start, end } : null;
    }
    case 'enum': {
      const v = typeof value === 'string' ? value.trim().toLowerCase() : null;
      return v !== null && def.values?.includes(v) ? v : null;
    }
    case 'text':
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    case 'schedule': {
      if (!Array.isArray(value) || !value.length) return null;
      const byDate = new Map<string, number>();
      for (const lot of value as Record<string, unknown>[]) {
        const qty = numeric(lot?.qty);
        const date = String(lot?.date ?? '').slice(0, 10);
        if (qty === null || qty <= 0 || !isCalendarIso(date)) return null;
        byDate.set(date, round2((byDate.get(date) ?? 0) + qty)); // lots on the same day are one lot
      }
      return [...byDate].map(([date, qty]) => ({ qty, date })).sort((a, b) => a.date.localeCompare(b.date));
    }
  }
}

export const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const clock = (dt: string) => dt.slice(11, 16);

/** How a value reads in briefings: "$11.40", "300 units Fri Oct 23 + 200 units Wed Oct 28", "Wed Nov 18 06:00–10:00". */
export function displayTyped(def: TermDef, value: unknown): string {
  switch (def.type) {
    case 'money': return usd(Number(value));
    case 'percent': return `${value}%`;
    case 'date': return prettyDate(String(value));
    case 'datetime': return `${prettyDate(String(value).slice(0, 10))} ${clock(String(value))}`;
    case 'window': {
      const w = value as Window;
      const sameDay = w.start.slice(0, 10) === w.end.slice(0, 10);
      return `${prettyDate(w.start.slice(0, 10))} ${clock(w.start)}–${sameDay ? '' : `${prettyDate(w.end.slice(0, 10))} `}${clock(w.end)}`;
    }
    case 'schedule': {
      const unit = def.unit ?? 'units';
      return (value as Lot[]).map((l) => (unit === '$' ? `${usd(l.qty)} ${prettyDate(l.date)}` : `${l.qty} ${unit} ${prettyDate(l.date)}`)).join(' + ');
    }
    default: return String(value);
  }
}

/**
 * Apply a partial update ("the remaining 200 now arrive Fri") to a schedule. A lot of exactly that size
 * moves. Otherwise, if exactly one larger lot sits on another date, it is split ("of the 500 due Friday,
 * the remaining 200 arrive Monday" → 300 Friday + 200 Monday). Anything else is ambiguous: null.
 */
export function mergePartialLots(current: Lot[], update: Lot[]): Lot[] | null {
  const lots = current.map((l) => ({ ...l }));
  for (const u of update) {
    const same = lots.find((l) => l.qty === u.qty && l.date !== u.date);
    if (same) {
      same.date = u.date;
      continue;
    }
    const larger = lots.filter((l) => l.qty > u.qty && l.date !== u.date);
    if (larger.length !== 1) return null;
    larger[0].qty -= u.qty;
    lots.push({ qty: u.qty, date: u.date });
  }
  return normalizeTyped({ key: 'lots', type: 'schedule', description: '', topics: [] }, lots) as Lot[];
}

/**
 * Merge a per-night update into a block ("Wednesday night drops to 45 rooms"): the named dates take the
 * new quantities and every other date keeps its own. Used where each lot is a separate night, not a
 * share of one total.
 */
export function mergeNights(current: Lot[], update: Lot[]): Lot[] {
  const byDate = new Map(current.map((l) => [l.date, l.qty]));
  for (const u of update) byDate.set(u.date, u.qty);
  return [...byDate].map(([date, qty]) => ({ qty, date })).sort((a, b) => a.date.localeCompare(b.date));
}
