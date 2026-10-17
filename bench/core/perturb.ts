// The robustness transform: the same case wrapped in real-world email messiness. Signatures, mobile
// footers, legal disclaimers, "[EXTERNAL]" gateway tags and banners, ticket-system headers, HTML-to-text
// artifacts (non-breaking spaces, "&amp;", hard wraps, stray "*" emphasis, bullet glyphs), greeting and
// closing variation, plus background mail a real inbox collects: out-of-office auto-replies, read
// receipts, delivery notifications, an unrelated forwarded thread and newsletters with tracking junk.
//
// Meaning is preserved by construction and then checked (`assertMeaningPreserved`):
// - Every original event keeps its key, timestamp, sender, recipients, threading, auth and attachments.
//   The oracle, checkpoints, task and trigger are untouched.
// - Text inserted into an existing message never contains a fact token (a digit, a currency amount, a
//   weekday, a month name or a relative-date word). Signatures therefore carry no phone numbers or
//   street addresses; contact details with digits only appear in added background mail (out-of-office
//   replies), and even there no digit run may equal one that occurs anywhere in the case.
// - Rewrites of the author's own text only touch whitespace, a salutation word, "&", bullet glyphs and
//   "*" around plain lowercase words, never a token. Wraps never break next to a number or a date word.
// - Added mail is background (not task state), lands strictly between two existing events before the
//   trigger, so the trigger stays the newest task event and no checkpoint moves.
//
// The same sender- and domain-level treatment is applied to task and background mail alike, so the mess
// itself never hints at which mail belongs to the task.
import { isDeepStrictEqual } from 'node:util';
import type { BenchCase, BenchEvent, BenchParty } from './types.ts';
import { Rand, addDays, sayDate, seedOf } from './util.ts';

export type MessLevel = 1 | 2 | 3;

// ------------------------------------------------------------------ fact tokens (the guard's vocabulary)

const cap = (w: string) => `[${w[0].toUpperCase()}${w[0].toLowerCase()}]${w.slice(1)}`;
const WEEKDAYS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAYS_ABBR = ['Mon', 'Tues', 'Tue', 'Wed', 'Thurs', 'Thur', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sept', 'Sep', 'Oct', 'Nov', 'Dec'];
const RELATIVE = ['today', 'tomorrow', 'tonight', 'yesterday', 'weekend', 'next week', 'this week', 'last week', 'end of day', 'end of week'];

const TOKEN_RE = new RegExp(
  [
    '[$€£]\\d[\\d,]*(?:\\.\\d+)?', // money
    '\\d+(?:[.,:/-]\\d+)*%?', // numbers, ISO and numeric dates, times, percentages
    `\\b(?:${WEEKDAYS_FULL.map(cap).join('|')})\\b`, // weekdays (any case of the first letter)
    `\\b(?:${WEEKDAYS_ABBR.join('|')})\\b\\.?`,
    `\\b(?:${MONTHS_FULL.join('|')}|${MONTHS_ABBR.join('|')})\\b\\.?`, // months (capitalised)
    `\\b(?:${RELATIVE.map((w) => w.split(' ').map(cap).join('\\s+')).join('|')})\\b`,
    '\\b(?:EOD|COB|EOW)\\b',
  ].join('|'),
  'g',
);

/** Every number / amount / date / weekday / relative-date token in a text, in order, whitespace-normalised. */
export function factTokens(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => m[0].replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase());
}

const hasFact = (s: string) => /\d/.test(s) || factTokens(s).length > 0;
const MONTH_WORD = new RegExp(`^\\*?(?:${[...MONTHS_FULL, ...MONTHS_ABBR].join('|')})\\.?,?$`);

/** Text we insert into an existing message must be fact-free; a template that is not is a bug. */
function fixed(s: string): string {
  if (hasFact(s)) throw new Error(`perturb: template introduces a fact token: ${JSON.stringify(s)}`);
  return s;
}
/** Dynamic lines (names, companies, domains): drop any line that would introduce a fact token. */
const clean = (lines: (string | null | undefined | false)[]) => lines.filter((l): l is string => !!l && !hasFact(l));

// ------------------------------------------------------------------ the guard

/**
 * Throws unless `messed` is a meaning-preserving perturbation of `orig`: same task, oracle, checkpoints
 * and trigger; every original event present in the same order with the same metadata, attachments, and
 * exactly the same sequence of fact tokens in its subject and body; every added event is background,
 * keyed `b<n>`, and lies strictly between its original neighbours; and no task event follows the trigger
 * that did not before.
 */
export function assertMeaningPreserved(orig: BenchCase, messed: BenchCase): void {
  const fail = (msg: string): never => { throw new Error(`${messed.id}: meaning not preserved: ${msg}`); };
  if (orig.trigger !== messed.trigger) fail(`trigger ${orig.trigger} → ${messed.trigger}`);
  if (!isDeepStrictEqual(orig.checkpoints, messed.checkpoints)) fail('checkpoints / oracle changed');
  if (!isDeepStrictEqual(orig.task, messed.task)) fail('task changed');
  if (orig.vertical !== messed.vertical || orig.archetype !== messed.archetype || orig.variant !== messed.variant || orig.split !== messed.split) fail('case identity changed');

  const origKeys = new Set(orig.events.map((e) => e.key));
  const byKey = new Map(messed.events.map((e) => [e.key, e]));
  if (byKey.size !== messed.events.length) fail('duplicate event keys');
  const seq = messed.events.filter((e) => origKeys.has(e.key)).map((e) => e.key);
  if (!isDeepStrictEqual(seq, orig.events.map((e) => e.key))) fail('original events reordered or missing');

  const meta = ['direction', 'from', 'fromName', 'to', 'cc', 'at', 'replyTo', 'quoteParent', 'attachments', 'background', 'auth'] as const;
  for (const o of orig.events) {
    const m = byKey.get(o.key)!;
    for (const f of meta) if (!isDeepStrictEqual(o[f], m[f])) fail(`${o.key}.${f} changed`);
    for (const f of ['subject', 'body'] as const) {
      const a = factTokens(o[f]);
      const b = factTokens(m[f]);
      if (!isDeepStrictEqual(a, b)) {
        const i = a.findIndex((t, k) => t !== b[k]);
        const at = i < 0 ? a.length : i;
        fail(`${o.key}.${f} fact tokens differ at #${at}: expected ${JSON.stringify(a.slice(at, at + 3))}, got ${JSON.stringify(b.slice(at, at + 3))}`);
      }
    }
  }

  const trigIdx = messed.events.findIndex((e) => e.key === messed.trigger);
  for (let i = 0; i < messed.events.length; i++) {
    const e = messed.events[i];
    if (origKeys.has(e.key)) continue;
    if (!e.background) fail(`added event ${e.key} is not background`);
    if (!/^b\d+$/.test(e.key)) fail(`added event key ${e.key} is not b<n>`);
    if (i > trigIdx) fail(`added event ${e.key} lies after the trigger`);
    const prev = messed.events.slice(0, i).reverse().find((x) => origKeys.has(x.key));
    const next = messed.events.slice(i + 1).find((x) => origKeys.has(x.key));
    if ((prev && !(Date.parse(prev.at) < Date.parse(e.at))) || (next && !(Date.parse(e.at) < Date.parse(next.at)))) fail(`added event ${e.key} is not strictly between its neighbours`);
    if (e.replyTo && !(messed.events.findIndex((x) => x.key === e.replyTo) < i)) fail(`added event ${e.key} replies to a later message`);
  }
  const after = (c: BenchCase) => c.events.slice(c.events.findIndex((e) => e.key === c.trigger) + 1).filter((e) => !e.background).map((e) => e.key);
  if (!isDeepStrictEqual(after(orig), after(messed))) fail('task events after the trigger changed');
}

// ------------------------------------------------------------------ level knobs

interface Knobs {
  tagP: number; bannerP: number; // gateway: subject tag / body banner on external inbound mail (per case)
  sigSenderP: number; sigMsgP: number; mobileP: number; // signatures and mobile footers
  disclaimerP: number; longDisclaimer: boolean; // per sender domain
  greetP: number; pleasP: number; closeP: number; // salutation variation, top-posted pleasantry, closing line
  ticketP: number; // one counterparty writes through a ticket system
  wrapP: number; nbspP: number; nbspRate: number; nbspDates: boolean; emphP: number; ampP: number; entityP: number; bullets: boolean;
  outboundCaps: boolean; selfFooterP: number;
  notices: [number, number]; forward: boolean; newsletters: [number, number];
}

const LEVELS: Record<MessLevel, Knobs> = {
  1: {
    tagP: 0.5, bannerP: 0, sigSenderP: 0.5, sigMsgP: 0.8, mobileP: 0.1, disclaimerP: 0, longDisclaimer: false,
    greetP: 0.3, pleasP: 0.15, closeP: 0.2, ticketP: 0,
    wrapP: 0, nbspP: 0, nbspRate: 0, nbspDates: false, emphP: 0, ampP: 0, entityP: 0, bullets: false,
    outboundCaps: false, selfFooterP: 0, notices: [1, 1], forward: false, newsletters: [0, 0],
  },
  2: {
    tagP: 0.8, bannerP: 0.5, sigSenderP: 0.8, sigMsgP: 0.9, mobileP: 0.2, disclaimerP: 0.5, longDisclaimer: false,
    greetP: 0.5, pleasP: 0.35, closeP: 0.35, ticketP: 0.3,
    wrapP: 0.4, nbspP: 0.4, nbspRate: 0.08, nbspDates: false, emphP: 0.25, ampP: 0.5, entityP: 0, bullets: true,
    outboundCaps: false, selfFooterP: 0.5, notices: [2, 3], forward: false, newsletters: [0, 0],
  },
  3: {
    tagP: 1, bannerP: 0.8, sigSenderP: 1, sigMsgP: 1, mobileP: 0.3, disclaimerP: 0.9, longDisclaimer: true,
    greetP: 0.7, pleasP: 0.6, closeP: 0.5, ticketP: 0.6,
    wrapP: 0.8, nbspP: 0.7, nbspRate: 0.15, nbspDates: true, emphP: 0.5, ampP: 1, entityP: 0.3, bullets: true,
    outboundCaps: true, selfFooterP: 1, notices: [3, 4], forward: true, newsletters: [1, 2],
  },
};

// ------------------------------------------------------------------ text pools (all fact-free; `fixed` enforces it)

const TAGS = ['[EXTERNAL]', '[EXT]', '[External]', 'EXTERNAL:'];
const BANNERS = [
  'CAUTION: This email originated from outside of the organization. Do not click links or open attachments unless you recognize the sender and know the content is safe.',
  '[EXTERNAL EMAIL] Use caution when opening attachments, clicking links, or responding to this email.',
  'This message came from outside your organization.',
  'External sender. Think before you click.',
];
const PLEASANTRIES = ["Hope you're well!", 'Hope all is well on your end.', 'I hope this email finds you well.', "Hope you're keeping well.", 'Hope things are going smoothly on your side.'];
const CLOSINGS = ['Best regards,', 'Kind regards,', 'Thanks,', 'Best,', 'Cheers,', 'Regards,', 'Many thanks,'];
const MOBILE = ['Sent from my iPhone', 'Sent from my iPad', 'Sent from Outlook for iOS', 'Get Outlook for Android', 'Sent from my Galaxy', 'Sent from Yahoo Mail on Android'];
const SHORT_DISCLAIMERS = [
  'CONFIDENTIALITY: This message and any attachments are intended only for the named recipient and may contain confidential information. If you received it in error, please notify the sender and delete it.',
  'This email is confidential and may be privileged. If you are not the intended recipient, please let us know and delete this message.',
  'The information in this email is confidential and intended solely for the addressee.',
];
const LONG_DISCLAIMERS = [
  'CONFIDENTIALITY NOTICE: The information contained in this electronic mail message and any attachments is confidential, may be legally privileged, and is intended solely for the use of the individual or entity to whom it is addressed. If you are not the intended recipient, you are hereby notified that any review, dissemination, distribution, copying or other use of this communication is strictly prohibited. If you have received this message in error, please notify the sender immediately by reply email and permanently delete the original and all copies. Email transmission cannot be guaranteed to be secure or free of viruses. Any views or opinions expressed are solely those of the author and do not necessarily represent those of the company.',
  'This e-mail, including any attachments, is confidential and may be subject to legal professional privilege. It is intended only for the addressee(s). If you are not an intended recipient, please contact the sender by return e-mail and delete all copies; you must not copy, disclose or distribute its contents. We process personal data in accordance with our privacy notice, which is available on our website.',
  'IMPORTANT: The contents of this email and any attachments are confidential. They are intended for the named recipient(s) only. If you have received this email by mistake, please notify the sender immediately and do not disclose the contents to anyone or make copies thereof. Our company accepts no liability for any damage caused by any virus transmitted by this email. Please consider the environment before printing this email.',
];
const TICKET_HEADER = '##- Please type your reply above this line -##';
const BULLETS = ['•', '·', '◦'];

const TITLES: [RegExp, string[]][] = [
  [/driver/, ['Driver', 'Owner Operator']],
  [/dispatch|carrier/, ['Dispatcher', 'Fleet Coordinator', 'Carrier Operations']],
  [/receiv|consignee|warehouse|dock/, ['Receiving Coordinator', 'Dock Supervisor']],
  [/forward|freight|logist/, ['Export Coordinator', 'Logistics Specialist']],
  [/financ|budget|account|treasur/, ['Finance Business Partner', 'Senior Accountant', 'FP&A Analyst']],
  [/legal|counsel/, ['Senior Counsel', 'Legal Operations Manager']],
  [/ops|operation/, ['Operations Lead', 'Operations Manager']],
  [/supplier|vendor|sales|hotel|revenue/, ['Account Manager', 'Senior Sales Manager', 'Key Account Executive', 'Customer Success Lead']],
];
const GENERIC_TITLES = ['Coordinator', 'Operations Specialist', 'Customer Service'];

// ------------------------------------------------------------------ helpers

const domainOf = (address: string) => address.split('@')[1]?.toLowerCase() ?? '';
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const titleCase = (s: string) => s.split(/[-_.]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

function companyOf(name: string, address: string): string {
  const paren = name.match(/\(([^)]*)\)/)?.[1];
  if (paren) {
    const s = paren.split(',').at(-1)!.trim().replace(/(\s+[a-z][\w-]*)+$/, '');
    if (s) return s;
  }
  return titleCase(domainOf(address).split('.')[0] ?? '');
}

const displayName = (p: BenchParty) => p.name.split(' (')[0];

function outlookDate(isoTs: string): string {
  const d = new Date(isoTs);
  const h = d.getUTCHours();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${sayDate(isoTs, 'long')} ${hh}:${mm}:${ss} ${h >= 12 ? 'PM' : 'AM'} (UTC)`;
}

function junk(r: Rand, n: number): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  let s = '';
  for (let i = 0; i < n; i++) s += abc[r.int(0, abc.length - 1)];
  return s;
}

/** A word next to which a line must never break (and which never gets a non-breaking space by chance). */
const guarded = (w: string) => w !== '' && hasFact(w);

function wrap(text: string, width: number): string {
  return text.split('\n').map((line) => {
    if (line.length <= width) return line;
    // multi-word fact tokens ("next week", "end of day") travel as one word
    const words = line.replace(TOKEN_RE, (m) => m.replace(/ /g, '\u0001')).split(' ');
    const out: string[] = [];
    let cur = words[0];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      const canBreak = !guarded(words[i - 1]) && !guarded(w) && cur.trim() !== '' && w !== '';
      if (canBreak && cur.length + 1 + w.length > width) { out.push(cur); cur = w; } else cur += ` ${w}`;
    }
    out.push(cur);
    return out.join('\n').replace(/\u0001/g, ' ');
  }).join('\n');
}

function nbsp(text: string, r: Rand, rate: number, dates: boolean): string {
  return text.split('\n').map((line) => {
    const w = line.split(' ');
    let out = w[0];
    for (let i = 1; i < w.length; i++) {
      const a = w[i - 1];
      const z = w[i];
      const plain = a && z && !guarded(a) && !guarded(z) && !/^[A-Z]/.test(a) && !/^[A-Z]/.test(z);
      const date = dates && MONTH_WORD.test(a) && /^\d/.test(z);
      out += (plain && r.chance(rate)) || (date && r.chance(0.5)) ? '\u00a0' : ' ';
      out += z;
    }
    return line.trim() && r.chance(rate / 2) ? `${out}\u00a0` : out;
  }).join('\n');
}

function emphasize(text: string, r: Rand, n: number): string {
  const lines = text.split('\n');
  const spots: [number, number][] = [];
  lines.forEach((l, i) => l.split(' ').forEach((w, j) => { if (/^[a-z]{5,}[.,;:!?]?$/.test(w)) spots.push([i, j]); }));
  for (const [i, j] of r.shuffle(spots).slice(0, n)) {
    const words = lines[i].split(' ');
    const m = words[j].match(/^([a-z]+)([.,;:!?]?)$/)!;
    words[j] = `*${m[1]}*${m[2]}`;
    lines[i] = words.join(' ');
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ the transform

interface SenderProfile {
  name: string;
  title: string | null;
  company: string;
  website: string | null;
  style: number;
  signs: boolean;
  device: string;
}

export function withMess(c: BenchCase, level: MessLevel): BenchCase {
  const k = LEVELS[level];
  const r = new Rand(seedOf(c.id, 'mess', level));
  const self = c.task.self_address;
  const selfDomain = domainOf(self);
  const selfParty = c.task.parties.find((p) => p.address === self);
  const parties = new Map(c.task.parties.map((p) => [p.address, p]));
  const caseText = JSON.stringify(c);
  const caseNumbers = new Set(caseText.match(/\d+/g) ?? []);
  const trigIdx = c.events.findIndex((e) => e.key === c.trigger);

  // ---- per-case and per-sender choices
  const gateway = { tag: r.chance(k.tagP) ? r.pick(TAGS) : null, banner: r.chance(k.bannerP) ? r.pick(BANNERS) : null };
  const counterparties = c.task.parties.filter((p) => p.role === 'counterparty');
  const desk = counterparties.length && k.ticketP && r.chance(k.ticketP) ? r.pick(counterparties).address : null;
  const disclaimers = new Map<string, string | null>();
  const disclaimerFor = (address: string) => {
    const d = domainOf(address);
    if (!disclaimers.has(d)) disclaimers.set(d, k.disclaimerP && r.chance(k.disclaimerP) ? fixed(r.pick(k.longDisclaimer ? LONG_DISCLAIMERS : SHORT_DISCLAIMERS)) : null);
    return disclaimers.get(d)!;
  };
  const profiles = new Map<string, SenderProfile>();
  const profileFor = (address: string, fromName: string): SenderProfile => {
    let p = profiles.get(address);
    if (!p) {
      const party = parties.get(address);
      const label = (party?.label ?? '').toLowerCase();
      const pool = TITLES.find(([re]) => re.test(label))?.[1] ?? GENERIC_TITLES;
      const domain = domainOf(address);
      // a title the party already uses ("Group Sales Manager, Desert Willow Resort") wins; role mailboxes have none
      const stated = party?.name.match(/\(([^),]+),[^)]*\)/)?.[1].trim();
      const roleMailbox = !party && !/[._]/.test(address.split('@')[0]);
      const picked = r.pick(pool);
      p = {
        name: fromName,
        title: stated ?? (roleMailbox ? null : picked),
        company: companyOf(party?.name ?? fromName, address),
        website: domain && !hasFact(domain) ? `www.${domain}` : null,
        style: r.int(0, 2),
        signs: r.chance(k.sigSenderP),
        device: r.pick(MOBILE),
      };
      profiles.set(address, p);
    }
    return p;
  };
  const personLike = (e: BenchEvent) => !e.background || parties.has(e.from) || e.from === self || /^[a-z]+[._][a-z]+@/i.test(e.from);
  const external = (e: BenchEvent) => e.direction === 'inbound' && domainOf(e.from) !== selfDomain;

  const signature = (e: BenchEvent, existing: boolean): string => {
    if (e.from === self) {
      const org = (selfParty?.name ?? e.fromName).replace(/\s+Agent$/, '');
      return clean(['--', org, `www.${selfDomain}`]).join('\n');
    }
    const p = profileFor(e.from, e.fromName);
    if (existing) return clean([p.website && `${p.website} | LinkedIn`, fixed('Please consider the environment before printing this email.')]).join('\n');
    const styles = [
      ['--', p.name, p.title ? `${p.title} | ${p.company}` : p.company, p.website],
      [p.title ? `${p.name} | ${p.title}` : p.name, p.company, p.website && `${p.website} | LinkedIn`],
      [p.name, p.title, p.company, p.website && `w: ${p.website}`, fixed('Please consider the environment before printing this email.')],
    ];
    return clean(styles[p.style]).join('\n');
  };

  const messBody = (e: BenchEvent): string => {
    let b = e.body;
    const person = personLike(e);
    // author text: bullets and stray emphasis (whitespace/markup only, never a token)
    if (k.bullets) { const g = r.pick(BULLETS); b = b.replace(/^(\s*)[-*] (?=\S)/gm, `$1${g} `); }
    if (k.emphP && r.chance(k.emphP)) b = emphasize(b, r, level === 3 ? 2 : 1);

    if (person) {
      const paras = b.split('\n\n');
      const greet = paras[0].match(/^(Hi|Hello|Hey|Dear)\b(.*)$/);
      const hasGreeting = !!greet && !paras[0].includes('\n') && paras[0].length <= 40;
      if (hasGreeting && r.chance(k.greetP)) {
        const named = /^\s+[A-Z]/.test(greet![2]) && !/^\s+again\b/.test(greet![2]);
        const options = ['Hi', 'Hello', 'Hey', ...(named ? ['Dear'] : [])].filter((s) => s !== greet![1]);
        paras[0] = `${r.pick(options)}${greet![2]}`;
      }
      if (r.chance(k.pleasP)) paras.splice(hasGreeting ? 1 : 0, 0, fixed(r.pick(PLEASANTRIES)));
      // a closing line before a bare sign-off ("Dana" → "Best regards,\nDana")
      const last = paras.at(-1)!;
      const lastLines = last.split('\n');
      const first = e.fromName.split(/\s+/)[0];
      const isSignoff = paras.length > 1 && lastLines.length <= 3 && lastLines[0].split(/\s+/)[0] === first
        && lastLines.every((l) => l.length <= 60 && !/[,.!?:;]$/.test(l.trim()))
        && !paras.slice(-2).some((p) => p.split('\n').some((l) => /,\s*$/.test(l)));
      if (isSignoff && r.chance(k.closeP)) paras[paras.length - 1] = `${fixed(r.pick(CLOSINGS))}\n${last}`;
      b = paras.join('\n\n');

      // signature or mobile footer
      const lastPara = b.split('\n\n').at(-1)!;
      const existing = lastPara.split('\n').length >= 2 && lastPara.split('\n').some((l) => l.trim() === e.fromName.trim());
      if (e.from === self) {
        if (r.chance(k.selfFooterP)) b += `\n\n${signature(e, false)}`;
      } else if (e.direction === 'inbound' && r.chance(k.mobileP)) {
        b += `\n\n${fixed(profileFor(e.from, e.fromName).device)}`;
      } else if (profileFor(e.from, e.fromName).signs && r.chance(k.sigMsgP)) {
        const s = signature(e, existing);
        if (s) b += `\n\n${s}`;
      }
      const disc = disclaimerFor(e.from);
      if (disc) b += `\n\n${disc}`;
      // ticket system wrapper around the whole message
      if (desk && e.from === desk) {
        const company = profileFor(e.from, e.fromName).company;
        b = `${fixed(TICKET_HEADER)}\n\n${b}${clean([`\n\nThis email is a service from ${company} Support. Reply to this email to add a comment to your request.`]).join('')}`;
      }
    }

    if (k.ampP && r.chance(k.ampP)) b = b.replace(/&(?![a-z]+;)/g, '&amp;');
    if (external(e) && gateway.banner) b = `${fixed(gateway.banner)}\n\n${b}`;
    if (k.wrapP && r.chance(k.wrapP)) b = wrap(b, r.pick([72, 72, 76]));
    if (k.nbspP && r.chance(k.nbspP)) b = nbsp(b, r, k.nbspRate, k.nbspDates);
    if (k.entityP && r.chance(k.entityP)) b = b.replace(/\n\n/g, () => (r.chance(0.5) ? '\n&nbsp;\n' : '\n\n'));
    // level 3 touches every task message at least once
    if (level === 3 && !e.background && b === e.body) b += `\n\n${fixed(r.pick(MOBILE))}`;
    return b;
  };

  const messSubject = (e: BenchEvent, subject = e.subject): string => {
    let s = subject;
    if (k.outboundCaps && e.direction === 'outbound') s = s.replace(/^Re:/, 'RE:').replace(/^Fwd?:/i, 'FW:');
    if (external(e) && gateway.tag) s = `${gateway.tag} ${s}`;
    return s;
  };

  const events: BenchEvent[] = c.events.map((e) => ({ ...e, subject: messSubject(e), body: messBody(e) }));

  // ---- background mail a real inbox collects
  type Draft = Omit<BenchEvent, 'key'>;
  const added: Draft[] = [];
  const at = (i: number) => Date.parse(c.events[i].at);
  /** A whole-second time strictly between event i and event i+1 (i = -1: before the first event). */
  const slotTime = (i: number, frac: number, capMs = Infinity): number | null => {
    const hi = at(i + 1) - 1000;
    const lo = i < 0 ? hi - 3 * 3600_000 : at(i) + 1000;
    if (hi < lo) return null;
    const t = Math.round((lo + Math.min(hi - lo, capMs) * frac) / 1000) * 1000;
    return Math.min(hi, Math.max(lo, t));
  };
  const noCollision = (s: string) => (s.match(/\d+/g) ?? []).every((n) => !caseNumbers.has(n));
  const tryGen = (gen: () => string): string | null => {
    for (let i = 0; i < 30; i++) { const s = gen(); if (noCollision(s)) return s; }
    return null;
  };
  const phone = () => tryGen(() => `+${r.pick([31, 33, 44, 49, 61, 64, 65])} ${r.int(10, 99)} ${r.int(100, 999)} ${r.int(1000, 9999)}`);
  const cities = ['Riverton', 'Lakeside', 'Fairview', 'Greenville', 'Maple Grove', 'Westbrook', 'Ashford'].filter((x) => !caseText.includes(x));
  const street = () => tryGen(() => `${r.int(12, 4890)} ${r.pick(['Harbor Way', 'Commerce Drive', 'Industrial Parkway', 'Market Street', 'Station Road'])}`);

  const anchors = c.events
    .map((e, i) => ({ e, i, rcpt: parties.get(e.to[0]) }))
    .filter((x) => x.i < trigIdx && x.e.direction === 'outbound' && x.rcpt && x.rcpt.address !== self && at(x.i + 1) - at(x.i) >= 4000);
  const nNotices = r.int(k.notices[0], k.notices[1]);
  const ooo = new Set<string>();
  for (const { e, i, rcpt } of r.shuffle(anchors).slice(0, nNotices)) {
    const p = rcpt!;
    const name = c.events.find((x) => x.from === p.address)?.fromName ?? displayName(p);
    const kind = !ooo.has(p.address) && r.chance(0.45) ? 'ooo' : r.pick(['read', 'read', 'delivered'] as const);
    if (kind === 'ooo') {
      const t = slotTime(i, r.next(), 90_000);
      if (t === null) continue;
      ooo.add(p.address);
      const prof = profileFor(p.address, name);
      const tel = phone();
      const st = street();
      added.push({
        direction: 'inbound', from: p.address, fromName: name, to: [self], at: iso(t), replyTo: e.key, quoteParent: false, background: true, auth: 'pass',
        subject: `${r.pick(['Automatic reply', 'Out of Office', 'Auto-Reply'])}: ${events[i].subject}`,
        body: [
          'Thank you for your email.',
          `I am currently out of the office with limited access to email and will reply as soon as I can after I return.${tel ? ` For anything urgent, please call the main office on ${tel}.` : ''}`,
          [name, prof.title ? `${prof.title} | ${prof.company}` : prof.company, st, cities.length ? r.pick(cities) : null, tel && `Tel: ${tel}`, prof.website].filter(Boolean).join('\n'),
        ].join('\n\n'),
        note: 'mess-transform: out-of-office auto-reply (state-neutral)',
      });
    } else if (kind === 'read') {
      const t = slotTime(i, 0.1 + 0.8 * r.next(), 3 * 3600_000);
      if (t === null) continue;
      added.push({
        direction: 'inbound', from: p.address, fromName: name, to: [self], at: iso(t), replyTo: e.key, quoteParent: false, background: true, auth: 'pass',
        subject: `Read: ${events[i].subject}`,
        body: `Your message\n\n  To: ${name} <${p.address}>\n  Subject: ${events[i].subject}\n  Sent: ${outlookDate(e.at)}\n\nwas read on ${outlookDate(iso(t))}.`,
        note: 'mess-transform: read receipt (state-neutral)',
      });
    } else {
      const t = slotTime(i, r.next(), 40_000);
      if (t === null) continue;
      added.push({
        direction: 'inbound', from: `postmaster@${selfDomain}`, fromName: 'Mail Delivery System', to: [self], at: iso(t), replyTo: e.key, quoteParent: false, background: true, auth: 'pass',
        subject: `Delivered: ${events[i].subject}`,
        body: `Your message has been delivered to the following recipients:\n\n${name} (${p.address})\n\nSubject: ${events[i].subject}`,
        note: 'mess-transform: delivery notification (state-neutral)',
      });
    }
  }

  const freeSlots = Array.from({ length: trigIdx + 1 }, (_, j) => j - 1).filter((i) => slotTime(i, 0.5) !== null);
  if (k.forward && freeSlots.length) {
    const names = ['Jordan Blake', 'Sam Okafor', 'Taylor Nguyen', 'Morgan Ellis', 'Casey Lindqvist', 'Robin Achebe'].filter((n) => !n.split(' ').some((w) => caseText.includes(w)));
    const [fwd, other] = r.shuffle(names.length >= 2 ? names : ['Jordan Blake', 'Sam Okafor']);
    const addr = (n: string) => `${n.toLowerCase().replace(' ', '.')}@${selfDomain}`;
    const topics = [
      ['Parking garage access during the lobby renovation', 'The north entrance will be closed while the lobby is renovated. Please use the side door by the loading area and keep your badge visible.', 'Does this apply to visitors too, or only staff?'],
      ['Laptop refresh - please book a slot', 'IT is replacing older laptops this quarter. Please book a slot through the service portal and back up local files first.', 'Booked mine. The portal was slow but it worked.'],
      ['Updated travel and expense policy', 'Economy class remains the default for flights under six hours, and receipts are required for every claim.', 'Thanks. Is the hotel cap per night or per trip?'],
      ['Team offsite - venue shortlist', 'We narrowed the offsite venues down to three. Please vote in the poll so we can book.', 'Voted. The lakeside option looks great.'],
    ];
    const [topic, text0, text1] = r.pick(topics);
    const d1 = addDays(c.events[0].at.slice(0, 10), -r.int(21, 60));
    const d0 = addDays(d1, -r.int(1, 3));
    const sent = (d: string, hh: number, mm: number) => `${sayDate(d, 'long')} ${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
    const gmail = r.chance(0.5);
    const hdr = (from: string, d: string, to: string) => gmail
      ? `---------- Forwarded message ---------\nFrom: ${from} <${addr(from)}>\nDate: ${sent(d, r.int(8, 17), r.int(0, 59))}\nSubject: ${topic}\nTo: ${to}`
      : `-----Original Message-----\nFrom: ${from} <${addr(from)}>\nSent: ${sent(d, r.int(8, 17), r.int(0, 59))}\nTo: ${to}\nSubject: ${topic}`;
    const i = r.pick(freeSlots);
    added.push({
      direction: 'inbound', from: addr(fwd), fromName: fwd, to: [self], at: iso(slotTime(i, r.next())!), quoteParent: false, background: true, auth: 'pass',
      subject: `FW: ${topic}`,
      body: [
        `${r.pick(['Hi team,', 'Hi all,', 'FYI,'])}`,
        'Forwarding in case it is useful. No action needed.',
        fwd.split(' ')[0],
        hdr(other, d1, fwd),
        text1,
        other.split(' ')[0],
        hdr('Facilities Team', d0, 'All Staff'),
        text0,
      ].join('\n\n').replace(`<${addr('Facilities Team')}>`, `<facilities@${selfDomain}>`),
      note: 'mess-transform: forwarded unrelated older thread (state-neutral)',
    });
  }

  const nNews = r.int(k.newsletters[0], k.newsletters[1]);
  const brands = r.shuffle([
    { name: 'Supply Chain Digest', dom: 'supplychaindigest.example', head: 'The week in logistics: port congestion eases', blurb: 'Our editors round up the stories that matter, from carrier capacity to warehouse automation.' },
    { name: 'OfficeHub', dom: 'officehub-mail.example', head: 'Your workspace, upgraded', blurb: 'Discover ergonomic chairs, standing desks and more for your team.' },
    { name: 'TravelPerks for Business', dom: 'travelperks.example', head: 'Members-only offers for business travellers', blurb: 'Unlock exclusive corporate perks across our partner network.' },
    { name: 'Cloudly Workspace', dom: 'cloudly.example', head: 'New: shared inboxes for every team', blurb: 'Assign, tag and track customer email together without forwarding chains.' },
  ]);
  for (let n = 0; n < nNews && freeSlots.length; n++) {
    const b = brands[n % brands.length];
    const link = (path: string) => `https://click.${b.dom}/ls/${path}?upn=${junk(r, r.int(48, 90))}&utm_source=newsletter&utm_medium=email&utm_campaign=${junk(r, 10)}`;
    const i = r.pick(freeSlots);
    added.push({
      direction: 'inbound', from: `news@${b.dom}`, fromName: b.name, to: [self], at: iso(slotTime(i, r.next())!), quoteParent: false, background: true, auth: 'pass',
      subject: b.head,
      body: [
        `${b.blurb} ${'\u200c\u00a0'.repeat(r.int(20, 60))}`,
        `View this email in your browser <${link('view')}>`,
        `[image: ${b.name}] <${link('click')}>`,
        b.head.toUpperCase(),
        b.blurb,
        `Read more <${link('click')}>`,
        `[image: Facebook] <${link('click')}> [image: LinkedIn] <${link('click')}>`,
        `You are receiving this email because you signed up at ${b.dom}.\nUnsubscribe <${link('unsub')}> | Manage preferences <${link('prefs')}>`,
      ].join('\n\n'),
      note: 'mess-transform: newsletter with tracking links (state-neutral)',
    });
  }

  // ---- merge: keys b<next> in time order, then a stable chronological sort
  let nextBg = Math.max(0, ...c.events.filter((e) => /^b\d+$/.test(e.key)).map((e) => Number(e.key.slice(1))));
  // the mail gateway treats added external mail like any other
  const gate = (d: Draft): Draft => (d.direction === 'inbound' && domainOf(d.from) !== selfDomain
    ? { ...d, subject: gateway.tag ? `${gateway.tag} ${d.subject}` : d.subject, body: gateway.banner ? `${gateway.banner}\n\n${d.body}` : d.body }
    : d);
  const extra: BenchEvent[] = added.map(gate).sort((a, b) => a.at.localeCompare(b.at)).map((e) => ({ ...e, key: `b${++nextBg}` }));
  const merged = [...events, ...extra].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    ...c,
    id: `${c.id}@mess${level}`,
    capabilities: [...new Set([...c.capabilities, 'robustness' as const])],
    events: merged,
    params: { ...c.params, mess: level },
  };
}
