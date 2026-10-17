// Surface patterns the offline extractor shares across packs: amounts with the label they belong to,
// clock times, time windows and dated times. Deliberately conservative: anything ambiguous is skipped
// (the model extractor handles the long tail).
import { findDates, type DateMention } from '../extract/dates.ts';

export const toNumber = (s: string) => Number(s.replace(/[,$\s]/g, ''));

export interface Amount { value: number; index: number; end: number; text: string }

/** Dollar amounts ("$2,540", "$11.40", "$1.2m", "$48k"). */
export function amounts(s: string): Amount[] {
  const out: Amount[] = [];
  for (const m of s.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(k\b|m\b|million\b)?/gi)) {
    const mult = !m[2] ? 1 : /^k/i.test(m[2]) ? 1_000 : 1_000_000;
    out.push({ value: toNumber(m[1]) * mult, index: m.index!, end: m.index! + m[0].length, text: m[0] });
  }
  return out;
}

/**
 * The label an amount belongs to: the closest label pattern either right after it ("$315 fuel") or
 * right before it ("fuel surcharge: $315", "linehaul of $2,225"). `labels` maps a key to its pattern;
 * patterns are tried on a window of `reach` characters, stopping at another amount.
 */
export function labelAmount(s: string, a: Amount, all: Amount[], labels: [string, RegExp][], reach = 28): string | null {
  const next = all.find((x) => x.index > a.index)?.index ?? s.length;
  const prev = [...all].reverse().find((x) => x.index < a.index);
  // after: up to the end of the clause ("$1,825, so all-in is …" does not label $1,825 all-in)
  const tail = s.slice(a.end, Math.min(next, a.end + reach));
  const after = tail.slice(0, (tail.search(/[,;]|\.\s|\s[-–—]\s/) + 1 || tail.length + 1) - 1);
  // before: filler between a label and its amount ("linehaul has to be $1,825") does not count as distance
  const before = s.slice(Math.max(prev ? prev.end : 0, a.index - reach - 12), a.index)
    .replace(/(?:\s*(?:is|are|was|of|at|to|be|now|will|would|has|have|had|goes|go|drops?|moves?|comes?|back|down|up|then|just|only|:|=))+\s*$/i, ' ');
  let best: { key: string; dist: number } | null = null;
  for (const [key, rx] of labels) {
    const r = new RegExp(rx.source, rx.flags.replace('g', ''));
    const ma = after.match(r);
    if (ma && (!best || ma.index! < best.dist)) best = { key, dist: ma.index! };
    // before: the label must be the last thing before the amount
    const mb = [...before.matchAll(new RegExp(r.source, `${r.flags}g`))].pop();
    if (mb) {
      const dist = before.length - (mb.index! + mb[0].length);
      if (!best || dist < best.dist) best = { key, dist };
    }
  }
  return best?.key ?? null;
}

// ------------------------------------------------------------------ clock times

export interface Clock { hhmm: string; index: number; end: number }

const pad = (n: number) => String(n).padStart(2, '0');
const RANGE_JOIN = /^\s*(?:–|—|-|to|until|till|and|thru|through)\s*$/i;

/**
 * Clock times in a sentence: "6am", "2:30pm", "06:00", "noon", and dispatcher military time ("0600")
 * when it is unambiguous: after "@" or as one end of a "0600-1000" range. Years, phone numbers and
 * reference numbers are not times.
 */
export function clocks(s: string): Clock[] {
  const out: Clock[] = [];
  for (const m of s.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/gi)) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (h < 1 || h > 12 || min > 59) continue;
    const pm = /^p/i.test(m[3]);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    out.push({ hhmm: `${pad(h)}:${pad(min)}`, index: m.index!, end: m.index! + m[0].length });
  }
  for (const m of s.matchAll(/\b([01]\d|2[0-3]):([0-5]\d)(?![\d:])/g)) out.push({ hhmm: `${m[1]}:${m[2]}`, index: m.index!, end: m.index! + m[0].length });
  for (const m of s.matchAll(/\b(noon|midnight)\b/gi)) out.push({ hhmm: /noon/i.test(m[1]) ? '12:00' : '00:00', index: m.index!, end: m.index! + m[0].length });
  const military = /(?<![\d$,./])\b([01]\d|2[0-3])([0-5]\d)\b(?![\d%]|[.,]\d)/g;
  const bare = [...s.matchAll(military)];
  for (const m of bare) {
    const at = m.index!;
    const before = s.slice(Math.max(0, at - 3), at);
    const after = s.slice(at + 4, at + 12);
    const paired = /^\s*(?:–|—|-|to)\s*([01]\d|2[0-3])[0-5]\d\b/.test(after)
      || bare.some((o) => o.index! < at && RANGE_JOIN.test(s.slice(o.index! + 4, at)));
    if (!/@\s*$/.test(before) && !paired) continue;
    out.push({ hhmm: `${m[1]}:${m[2]}`, index: at, end: at + 4 });
  }
  return out.sort((a, b) => a.index - b.index).filter((c, i, all) => !all.some((o, j) => j < i && c.index < o.end));
}

export interface TimeRange { from: string; to: string; index: number; end: number }

/** "6am–10am", "6am to 10am", "between 6am and 10am", "0600-1000", "06:00–10:00". */
export function timeRanges(s: string): TimeRange[] {
  const cs = clocks(s);
  const out: TimeRange[] = [];
  for (let i = 0; i + 1 < cs.length; i++) {
    const [a, b] = [cs[i], cs[i + 1]];
    const join = s.slice(a.end, b.index);
    if (!RANGE_JOIN.test(join)) continue;
    if (/^\s*and\s*$/i.test(join) && !/\bbetween\s*$/i.test(s.slice(Math.max(0, a.index - 9), a.index))) continue;
    out.push({ from: a.hhmm, to: b.hhmm, index: a.index, end: b.end });
    i++;
  }
  return out;
}

/** The date mention closest to a span (preferring one in the same clause). */
export function nearestDate(dates: DateMention[], index: number, end: number): DateMention | null {
  let best: DateMention | null = null;
  let dist = Infinity;
  for (const d of dates) {
    const de = d.index + d.text.length;
    const gap = de <= index ? index - de : d.index >= end ? d.index - end : 0;
    if (gap < dist) {
      dist = gap;
      best = d;
    }
  }
  return dist <= 40 ? best : null;
}

export interface Dated { kind: 'window' | 'datetime'; value: { start: string; end: string } | string; index: number; end: number }

/** Time windows and single dated times in a sentence, each with its date resolved against the message date. */
export function datedTimes(s: string, refIso: string): Dated[] {
  const dates = findDates(s, refIso);
  const out: Dated[] = [];
  const ranges = timeRanges(s);
  for (const r of ranges) {
    const d = nearestDate(dates, r.index, r.end);
    if (!d) continue;
    out.push({ kind: 'window', value: { start: `${d.iso}T${r.from}`, end: `${d.iso}T${r.to}` }, index: Math.min(r.index, d.index), end: Math.max(r.end, d.index + d.text.length) });
  }
  for (const c of clocks(s)) {
    if (ranges.some((r) => c.index >= r.index && c.index < r.end)) continue;
    const d = nearestDate(dates, c.index, c.end);
    if (!d) continue;
    out.push({ kind: 'datetime', value: `${d.iso}T${c.hhmm}`, index: Math.min(c.index, d.index), end: Math.max(c.end, d.index + d.text.length) });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** The text of the clause before `index` (back to the previous sentence break, semicolon or comma). */
export function leadOf(s: string, index: number, max = 60): string {
  const head = s.slice(Math.max(0, index - max), index);
  const cut = Math.max(head.lastIndexOf(';'), head.lastIndexOf('. '), head.lastIndexOf(', '));
  return cut >= 0 ? head.slice(cut + 1) : head;
}

/** A value line in a document or form: "Remit to: Ridgeline Transport LLC, PO Box 2290" → the value. */
export function fieldValue(s: string, label: RegExp): string | null {
  const m = s.match(new RegExp(`^\\s*(?:${label.source})\\s*[:#]\\s*(.+?)\\s*$`, label.flags.replace('g', '')));
  return m ? m[1].trim() : null;
}

const BANK_ACCOUNT = /\b([A-Z][A-Za-z&.]*(?:\s+[A-Z][A-Za-z&.]*){0,4}\s+(?:Bank|Trust|Credit Union|Savings|Bancorp|Financial)(?:\s+[A-Z][A-Za-z&.]*){0,2}),?\s+(?:account|acct\.?)\s+(?:ending(?: in)?|no\.?\s*\S*?|#\s*\S*?)\s*(\d{4})\b/;

/** A bank account as people write it ("First Harbor Bank account ending 4471"), normalised to that form. */
export function bankAccount(s: string): { value: string; index: number } | null {
  const m = s.match(BANK_ACCOUNT);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').replace(/^(?:Pay|Wire|Remit|Send|To|Use|At|Via|Our|The|New)\s+/, '');
  return { value: `${name} account ending ${m[2]}`, index: m.index! };
}
