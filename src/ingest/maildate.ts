// RFC 5322 Date header parsing that never throws, and the event-time policy built on it.
// The Date header is written by the sender; Primitive's received_at is written by Primitive.
// So received_at is the trusted record time, and the header is a claim about when the mail was
// written: clamped if it lies in the future, flagged whenever it is missing or malformed.
import { nowIso } from '../clock.ts';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// RFC 5322 §4.3 obsolete zones; military zones are treated as unknown (= UTC), as the RFC says
const ZONES: Record<string, number> = { ut: 0, gmt: 0, utc: 0, z: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420 };
const RE = /^\s*(?:([a-z]{3})[a-z]*\s*,\s*)?(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s-]+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[a-z]{1,5})?\s*$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export type DateIssue = 'missing' | 'unparseable' | 'out_of_range' | 'zone_unknown' | 'weekday_mismatch' | 'obsolete_year';
export interface ParsedMailDate { iso: string | null; offsetMinutes: number | null; issues: DateIssue[] }

export function parseMailDate(raw: string | null | undefined): ParsedMailDate {
  if (!raw || !raw.trim()) return { iso: null, offsetMinutes: null, issues: ['missing'] };
  const s = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  // some producers (and our own sim, via toISOString) send ISO 8601; accept it when it carries a zone
  if (ISO.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? { iso: null, offsetMinutes: null, issues: ['out_of_range'] } : { iso: new Date(t).toISOString(), offsetMinutes: null, issues: [] };
  }
  const m = s.match(RE);
  if (!m) return { iso: null, offsetMinutes: null, issues: ['unparseable'] };
  const [, dow, dd, mon, yy, hh, mi, ss = '0', zone] = m;
  const issues: DateIssue[] = [];
  let year = Number(yy);
  if (yy.length === 2) { year += year < 50 ? 2000 : 1900; issues.push('obsolete_year'); }
  else if (yy.length === 3) { year += 1900; issues.push('obsolete_year'); }
  const month = MONTHS.indexOf(mon.toLowerCase());
  const [day, hour, min, sec] = [dd, hh, mi, ss].map(Number);
  let off = 0;
  if (!zone) issues.push('zone_unknown'); // never fall back to the host's local time zone
  else if (/^[+-]\d{4}$/.test(zone)) {
    const h = Number(zone.slice(1, 3));
    const mm = Number(zone.slice(3));
    if (h > 23 || mm > 59) return { iso: null, offsetMinutes: null, issues: ['out_of_range'] };
    off = (zone[0] === '-' ? -1 : 1) * (h * 60 + mm);
    if (zone === '-0000') issues.push('zone_unknown');
  } else if (zone.toLowerCase() in ZONES) off = ZONES[zone.toLowerCase()];
  else issues.push('zone_unknown');
  if (month < 0 || day < 1 || hour > 23 || min > 59 || sec > 60 || year < 1970 || year > 9999) return { iso: null, offsetMinutes: null, issues: ['out_of_range'] };
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCDate() !== day) return { iso: null, offsetMinutes: null, issues: ['out_of_range'] }; // e.g. 31 Feb
  if (dow && DAYS[date.getUTCDay()] !== dow.toLowerCase()) issues.push('weekday_mismatch');
  const ms = Date.UTC(year, month, day, hour, min, Math.min(sec, 59)) - off * 60_000;
  return { iso: new Date(ms).toISOString(), offsetMinutes: off, issues };
}

/** A Date header more than this far after Primitive's receipt time is clamped to receipt time. */
export const FUTURE_SKEW_MS = 15 * 60_000;

export interface TimeFlag { kind: string; detail: string }

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/**
 * occurred_at / received_at for an inbound email, plus flags for anything that had to be repaired.
 * `dateHeader` undefined means the source carries no Date header at all (REST EmailDetail): that is
 * normal, not an anomaly, so it is not flagged.
 */
export function resolveEventTimes(dateHeader: string | null | undefined, receivedAt: unknown): { occurred_at: string; received_at: string; time_flags: TimeFlag[] } {
  const flags: TimeFlag[] = [];
  let received = isoOrNull(receivedAt);
  if (!received) {
    received = nowIso();
    flags.push({ kind: 'received_at_missing', detail: `no valid received_at (${JSON.stringify(receivedAt ?? null)}); used ingest time` });
  }
  if (dateHeader === undefined) return { occurred_at: received, received_at: received, time_flags: flags };
  const d = parseMailDate(dateHeader);
  if (!d.iso) {
    const kind = d.issues[0] === 'missing' ? 'date_header_missing' : 'date_header_invalid';
    if (kind === 'date_header_invalid') flags.push({ kind, detail: `unusable Date header ${JSON.stringify(dateHeader)} (${d.issues.join(', ')}); used received_at` });
    return { occurred_at: received, received_at: received, time_flags: flags };
  }
  if (d.issues.includes('zone_unknown')) flags.push({ kind: 'date_header_zone_unknown', detail: `Date header ${JSON.stringify(dateHeader)} has no usable time zone; read as UTC` });
  if (d.issues.includes('weekday_mismatch')) flags.push({ kind: 'date_header_weekday_mismatch', detail: `Date header ${JSON.stringify(dateHeader)} names the wrong weekday` });
  if (Date.parse(d.iso) - Date.parse(received) > FUTURE_SKEW_MS) {
    flags.push({ kind: 'date_header_future', detail: `Date header ${d.iso} is after Primitive received the email (${received}); clamped to received_at` });
    return { occurred_at: received, received_at: received, time_flags: flags };
  }
  return { occurred_at: d.iso, received_at: received, time_flags: flags };
}
