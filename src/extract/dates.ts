// Dates in business email. Explicit calendar dates beat weekday names; a weekday name means its next
// occurrence on or after the message date; overlapping mentions are counted once.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface DateMention {
  /** YYYY-MM-DD */
  iso: string;
  /** Character offset in the searched text. */
  index: number;
  text: string;
  /** A calendar date, as opposed to a weekday or "tomorrow". */
  explicit: boolean;
}

const two = (n: number) => String(n).padStart(2, '0');
const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);

export function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

/** The UTC day for year/month(0-based)/day, or null when that day doesn't exist ("Feb 30", month 13). */
export function calendarDay(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day ? d : null;
}

/** "2026-10-23" names a real calendar day (the regex alone accepts "2026-13-45"). */
export function isCalendarIso(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return !!m && calendarDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])) !== null;
}

/** "Fri" */
export function weekdayName(iso: string): string {
  return capitalize(WEEKDAYS[noon(iso).getUTCDay()].slice(0, 3));
}

/** "Fri Oct 23" */
export function prettyDate(iso: string): string {
  const d = noon(iso);
  return `${weekdayName(iso)} ${capitalize(MONTHS[d.getUTCMonth()])} ${d.getUTCDate()}`;
}

const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY = '(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?';

/** All dates mentioned in `text`, resolved against the message time `referenceIso`, in text order. */
export function findDates(text: string, referenceIso: string): DateMention[] {
  const ref = new Date(referenceIso);
  const refDay = () => new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  const found: DateMention[] = [];
  const spans: [number, number][] = [];

  const add = (m: RegExpExecArray, date: Date | string, explicit: boolean) => {
    const start = m.index, end = m.index + m[0].length;
    if (spans.some(([a, b]) => start < b && end > a)) return;
    spans.push([start, end]);
    found.push({ iso: typeof date === 'string' ? date : isoDate(date), index: start, text: m[0], explicit });
  };
  const each = (rx: RegExp, fn: (m: RegExpExecArray) => void) => {
    for (let m = rx.exec(text); m; m = rx.exec(text)) fn(m);
  };
  // a date without a year is in the message's year, unless that is more than 60 days in the past
  const yearOf = (month: number, day: number) => {
    const y = ref.getUTCFullYear();
    return Date.UTC(y, month, day) < ref.getTime() - 60 * 864e5 ? y + 1 : y;
  };

  // [weekday,] month day[, year]   e.g. "Friday, Oct 23", "Wednesday (Oct 28)", "October 28, 2026"
  each(new RegExp(`\\b(?:${WEEKDAY},?\\s*\\(?\\s*)?${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\)?`, 'gi'), (m) => {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    const day = Number(m[3]);
    const date = calendarDay(m[4] ? Number(m[4]) : yearOf(month, day), month, day);
    if (date) add(m, date, true);
  });
  // 2026-10-28
  each(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => {
    if (isCalendarIso(m[0])) add(m, m[0], true);
  });
  // 10/28 or 10/28/26
  each(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m) => {
    const month = Number(m[1]) - 1, day = Number(m[2]);
    if (month > 11 || day > 31) return;
    const year = !m[3] ? yearOf(month, day) : m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const date = calendarDay(year, month, day);
    if (date) add(m, date, true);
  });
  // "Friday", "next Wednesday"
  each(new RegExp(`\\b(next\\s+)?${WEEKDAY}\\b`, 'gi'), (m) => {
    const target = WEEKDAYS.findIndex((w) => w.startsWith(m[2].slice(0, 3).toLowerCase()));
    const d = refDay();
    let ahead = (target - d.getUTCDay() + 7) % 7;
    if (m[1] && ahead === 0) ahead = 7;
    d.setUTCDate(d.getUTCDate() + ahead);
    add(m, d, false);
  });
  // "today", "tomorrow"
  each(/\b(today|tomorrow)\b/gi, (m) => {
    const d = refDay();
    if (m[1].toLowerCase() === 'tomorrow') d.setUTCDate(d.getUTCDate() + 1);
    add(m, d, false);
  });

  return found.sort((a, b) => a.index - b.index);
}
