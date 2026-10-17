// Action guard for agent-initiated sends. Untrusted inbound content can influence what an LLM
// writes, so outbound actions are checked against *state*, deterministically. Three outcomes:
//  - block: a hard limit. Recipients must be task participants (no exfiltration to addresses found in
//    mail), secrets never leave, and nothing commits us while a hard requirement FAILS — the human
//    set those limits; only changing the task changes them.
//  - hold: a human decides. Every commitment (unless the task allows clean ones to go out on their
//    own), anything carrying payment / wire / bank details, and gray areas: contested terms,
//    requirements still unknown, unverified statements, forged senders, injected text, a send check
//    that could not decide, wording that contradicts the declared intent.
//  - allow: everything else (questions, negotiation, reminders).
//
// Commitment is decided in two layers. The sender DECLARES intent (inform | ask | negotiate | commit);
// that is the control. Text detection is the tripwire: wording that reads as binding is treated as a
// commitment unless the sender declared otherwise — and a declared non-commitment whose text reads
// as binding is refused as a mismatch rather than trusted. Text detection alone can be evaded
// (paraphrase, other languages), which is why declared intent and state checks carry the weight.
//
// The tripwire's phrase list is generic commerce wording (accept, confirm, place the order, approve
// payment); the task's domain pack adds its own binding phrases (DomainPack.bindingPatterns), and the
// name we sign as comes from the task's own participant, not from this file.
import type { CheckResult, Claim, TaskSpec } from '../types.ts';
import { domainFor } from '../domain/pack.ts';
import { BINDING_PATTERNS } from '../domain/procurement.ts';
import '../domain/index.ts';

export type SendIntent = 'inform' | 'ask' | 'negotiate' | 'commit';
export const SEND_INTENTS: SendIntent[] = ['inform', 'ask', 'negotiate', 'commit'];
export type GuardOutcome = 'allow' | 'hold' | 'block';

export interface GuardResult {
  outcome: GuardOutcome;
  /** outcome === 'allow' */
  allowed: boolean;
  /** why it is blocked (hard limits) */
  reasons: string[];
  /** why a human must decide (only when not blocked) */
  hold_reasons: string[];
  /** gray areas worth showing the human, whether or not they caused the hold */
  gray_areas: string[];
  commitment: boolean;
  binding: string[];
  intent: SendIntent | null;
}

export interface GuardContext {
  /** binding phrases from the model send check */
  modelBinding?: string[];
  /** the model send check could not decide (timeout, refusal, error) */
  modelError?: string | null;
  /** task flags (forged sender, injection, extractor fallback) */
  flags?: { kind: string; detail: string }[];
}

/** payment, wire or bank details: where business-email fraud happens */
export const MONEY_DETAILS = /\b(wire (?:instructions|transfer|details|the funds)|wiring instructions|bank (?:account|details|info\w*)|account (?:number|no\.?)|routing (?:number|no\.?)|iban|swift|sort code|remit(?:tance)? (?:to|address|details)|ach details)\b/i;

export type BindingLabel = 'binding' | 'conditional';
export interface BindingHit { phrase: string; sentence: string; label: BindingLabel; why?: string }

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Generic commitment phrasings. `self` is the alternation of names we sign as ("acme"), if any. */
function commitPatterns(self: string): RegExp[] {
  const subject = self ? `we|i|${self}` : 'we|i';
  return [
    new RegExp(`\\b(?:${subject})(?:'re| are| am|'m|'ve| have)?\\s+(?:hereby\\s+|now\\s+|happy to\\s+|pleased to\\s+|glad to\\s+)?(?:accept|agree|approve|confirm|commit|authori[sz]e|proceed|place|release|issue)\\w*\\b`, 'i'),
    /\b(?:we|i)(?:'ll| will| shall)\s+(?:take|buy|purchase|order|go with|proceed)\b/i,
    /\b(?:we|i)(?:'d| would)\s+like\s+to\s+(?:place|order|proceed|confirm|accept|go ahead)\b/i,
    /\b(?:offer|quote|proposal|terms|order|po|invoice|price)\s+(?:is|are|has been|have been)\s+(?:hereby\s+)?(?:accepted|approved|confirmed|agreed)\b/i,
    /\b(?:accept(?:s|ed)?|confirm(?:s|ed)?|approve[sd]?)\s+(?:it\b|(?:your|the|this|our)\s+(?:(?:revised|updated|new|current|final)\s+)?(?:offer|quote|proposal|order|terms|deal|purchase|invoice)\b)/i,
    /\b(?:fine|ok|okay) (?:by|with|for) us\b|\bplease arrange (?:the )?(?:delivery|shipment|shipping)\b|^ship (?:it|them)\b|\bgo for it\b|\b(?:move|moving) forward (?:at|with)\b|\block(?:ing)? in\b|\baward(?:ed|ing)? (?:the |this )?(?:order|contract|business)\b|\bbinding (?:purchase )?order\b/i,
    /^(?:yes[,!]?\s*)?(?:accepted|agreed|confirmed|approved|deal|done|it'?s a deal|you have a deal|let'?s do it|sounds good|works for us|we(?:'re| are) good to go|good to go)\b/i,
    /\byou have a deal\b|\bit'?s a deal\b|\bcount us in\b|\bacceptable to us\b|\bwe(?:'re| are) (?:committed|good to go)\b/i,
    /\b(?:please\s+)?(?:go ahead|proceed)(?:\s+(?:and|with)\b|[.!]|$)/i,
    /\bplease\s+(?:ship|book|dispatch|invoice|process the order|send the invoice)\b/i,
    /\b(?:order confirmation|confirm(?:ing)? the order|place (?:an|the|our) order|placing (?:an|the|our|this) order|purchase order (?:is )?(?:confirmed|released|issued)|released the (?:purchase )?order|invoice against)\b/i,
    /\b(?:approve|authori[sz]e|release|wire|remit)\w*\s+(?:the\s+)?(?:payment|funds|invoice)\b|\bpayment (?:has been|is|was) (?:authori[sz]ed|approved|released|sent)\b|\bapproved the invoice\b/i,
    /\b[A-Z][a-z]+\s+(?:hereby\s+)?(?:accepts|agrees|confirms)\b/,
    /\bconsider (?:it|this|po[- ]?\S*) (?:done|placed|confirmed|accepted|approved|ordered)\b|\b(?:formal|our) acceptance\b|\bthe deal is on\b|\bwe(?:'re| are) in\b|\blet(?:'s| us) proceed\b|\bsign(?:ing)? off on\b/i,
    /^(?:please\s+|kindly\s+)?(?:book|dispatch|process)\s+(?:the|our|all|it|them|\d+)\b|\b(?:please|kindly)\s+(?:book|dispatch|process)\s+(?:the|our|all|it|them|\d+)\b/i,
  ];
}
const GENERIC = commitPatterns('');

// negation must be in the same clause, before the phrase ("we cannot accept"; not "no problem, we accept")
const NEG = /\b(?:not|no|never|cannot|can't|cant|won't|wont|don't|dont|doesn't|isn't|aren't|unable|without|hold off|refuse|decline|neither|nor|yet to)\b|n't\b/i;
// reported speech / requests: describing what someone else asked is not our commitment
const REPORTED = /\b(?:asking|asked|ask|requests?|requested|requesting|told|telling|tells|wants? us to|instruct\w*|said|says|wrote|claim\w*)\b/i;
// conditional / subordinate markers earlier in the same sentence
const COND = /\b(?:if|unless|once|until|provided(?: that)?|subject to|pending|before|whether|in order to|so (?:that )?we can|must|needs? to|has to|have to|should)\b/i;
// leading phrases that look subordinate but are not conditions ("Before anything else: we accept")
const NOT_COND = /^(?:before (?:anything|everything)(?: else)?|first(?:ly| of all)?|to be clear|for the record|in short|to confirm|just so you know)$/i;
// Latin look-alikes (Cyrillic/Greek) and invisible characters used to slip past text matching
const CONFUSABLE: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ԁ: 'd', ѕ: 's', А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', ο: 'o', α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ρ: 'p', τ: 't', υ: 'u', Α: 'A', Ε: 'E', Ι: 'I', Κ: 'K', Ο: 'O', Ρ: 'P', Τ: 'T' };

export const canonicalText = (s: string) => s.normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '').replace(/[Ͱ-ϿЀ-ӿ]/g, (c) => CONFUSABLE[c] ?? c).replace(/[‘’]/g, "'");

/** Quoted reply history is dropped; inline quotations are kept but can only count as conditional. */
function prepare(body: string): string {
  return canonicalText(body)
    .split('\n').filter((l) => !/^\s*>/.test(l)).join('\n')
    .replace(/\n\s*On .{5,200}wrote:\s*$/s, '');
}

/** A pack pattern for per-clause matching: no global/sticky flag, so `match` reports the index. */
function single(rx: RegExp): RegExp {
  return rx.flags.includes('g') || rx.flags.includes('y') ? new RegExp(rx.source, rx.flags.replace(/[gy]/g, '')) : rx;
}

export interface BindingOptions {
  /** extra binding phrasings (the task's domain pack) */
  patterns?: RegExp[];
  /** names we sign as ("Acme"): "Acme is happy to proceed" commits us */
  selfNames?: string[];
}

/** Phrases that commit us, sentence by sentence, labelled binding or conditional. */
export function classifyBinding(body: string, opts: BindingOptions = {}): BindingHit[] {
  const names = (opts.selfNames ?? []).map((n) => n.trim()).filter(Boolean).map(escapeRx);
  const commit = [...(names.length ? commitPatterns(names.join('|')) : GENERIC), ...(opts.patterns ?? []).map(single)];
  const hits: BindingHit[] = [];
  const sentences = prepare(body).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const quoted = /"[^"]*"|“[^”]*”/g;
    const inQuotes = (i: number) => [...sentence.matchAll(quoted)].some((q) => i >= q.index! && i < q.index! + q[0].length);
    const clauses = sentence.split(/\s*(?:[,;:]|\s[—–-]\s|\bbut\b)\s*/i).filter(Boolean);
    let offset = 0;
    for (const [ci, clause] of clauses.entries()) {
      // a question only if this clause carries the "?" ("We accept your offer, ok?" is a tag, not a question)
      const isQuestion = /\?\s*$/.test(clause) || (ci === clauses.length - 1 && /\?\s*$/.test(sentence));
      const at = sentence.indexOf(clause, offset);
      offset = at + clause.length;
      for (const rx of commit) {
        const m = clause.match(rx);
        if (!m) continue;
        const before = clause.slice(0, m.index);
        if (NEG.test(before) || NEG.test(m[0]) || REPORTED.test(before)) continue; // "we cannot accept", "they asked us to approve"
        // asking the recipient to approve/confirm is a request — except money, which is never waved through
        if (/^(?:accept|confirm|approv)/i.test(m[0]) && !/payment|funds|invoice/i.test(m[0]) && /\b(?:please|kindly|could you|can you|would you|will you)\s+$/i.test(before)) continue;
        // a condition in this clause, or a leading subordinate clause ("If finance approves, we accept")
        const lead = clauses.slice(0, ci).filter((c) => !NOT_COND.test(c.trim()));
        const conditional = COND.test(before) || lead.some((c) => COND.test(c));
        let why: string | null = null;
        if (isQuestion) why = 'question';
        else if (inQuotes(at + (m.index ?? 0))) why = 'quoted';
        else if (conditional) why = 'conditional';
        hits.push({ phrase: m[0], sentence, label: why ? 'conditional' : 'binding', ...(why ? { why } : {}) });
        break;
      }
    }
  }
  return hits;
}

/** Binding phrases that are not negated, conditional, quoted or questions. Defaults to the procurement pack's extras. */
export function bindingPhrases(body: string, patterns: RegExp[] = BINDING_PATTERNS, selfNames: string[] = []): string[] {
  return classifyBinding(body, { patterns, selfNames }).filter((h) => h.label === 'binding').map((h) => h.phrase);
}

/** The names we sign as on this task: the first word of our own participant's name and label ("Acme"). */
export function selfNamesOf(task: TaskSpec): string[] {
  const self = task.participants.find((p) => p.role === 'self');
  const words = [self?.name, self?.label].map((s) => s?.match(/^[A-Za-z][\w&-]+/)?.[0]).filter((w): w is string => !!w && !/^(?:we|us|our|the)$/i.test(w));
  return [...new Set(words.map((w) => w.toLowerCase()))];
}

/** Binding phrases for a task: generic wording, the task's pack, and the name we sign as. */
export function taskBindingPhrases(task: TaskSpec, body: string): string[] {
  return bindingPhrases(body, domainFor(task).bindingPatterns, selfNamesOf(task));
}

const SECRET = /\b(prim_[A-Za-z0-9_]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|ctk_[A-Za-z0-9_-]{16,}|api[_ -]?key\s*[:=])/i;

const GRAY_FLAGS: Record<string, string> = {
  sender_unauthenticated: 'an unauthenticated sender wrote on this deal',
  sender_impersonates_us: 'someone sent mail pretending to be us',
  prompt_injection_suspected: 'instructions were hidden in incoming text',
  extractor_fallback: 'an email was read by the fallback rules, not the model',
};

export function guardSend(task: TaskSpec, to: string, body: string, checks: CheckResult[], claims: Claim[], intent: SendIntent | null = null, ctx: GuardContext = {}): GuardResult {
  const reasons: string[] = [];
  const hold: string[] = [];
  const gray: string[] = [];
  const party = task.participants.find((p) => p.address.toLowerCase() === to.toLowerCase());
  if (!party || party.role === 'self') reasons.push(`recipient ${to} is not a participant of task ${task.alias}`);
  if (SECRET.test(body)) reasons.push('message appears to contain a credential');
  const binding = [...taskBindingPhrases(task, body), ...(ctx.modelBinding ?? [])];
  // commitments only matter toward counterparties; internal mail (e.g. to finance) cannot commit us to them
  const toCounterparty = party?.role === 'counterparty';
  const commitment = toCounterparty && (intent === 'commit' || binding.length > 0);

  // gray areas: shown to the human, and they stop a commitment from ever going out on its own
  const contested = claims.filter((c) => c.status === 'contested');
  if (contested.length) gray.push(`contested terms: ${[...new Set(contested.map((c) => c.key))].join(', ')}`);
  const unknown = checks.filter((c) => c.status === 'unknown');
  if (unknown.length) gray.push(`requirements not yet known: ${unknown.map((c) => c.label).join('; ')}`);
  for (const c of claims.filter((x) => x.status === 'proposed')) {
    if (body.includes(c.display)) gray.push(`the draft relies on an unverified statement: ${c.key} = ${c.display} (${c.supersede_reason ?? 'not applied'})`);
  }
  for (const kind of new Set((ctx.flags ?? []).map((f) => f.kind))) if (GRAY_FLAGS[kind]) gray.push(GRAY_FLAGS[kind]);

  if (toCounterparty) {
    const failing = checks.filter((c) => c.status === 'fail');
    if (commitment && failing.length) {
      const why = failing.map((c) => `${c.label}: ${c.status}${c.detail ? ` — ${c.detail}` : ''}`).join('; ');
      reasons.push(`binding language blocked: requirements not met (${why})`);
    }
    if (binding.length && intent && intent !== 'commit') {
      const why = `intent mismatch: declared "${intent}" but the text reads as a commitment (${binding.map((b) => `"${b}"`).join(', ')})`;
      // with a failing requirement the commitment itself is blocked; otherwise a human decides what was meant
      if (failing.length) reasons.push(`${why}; declare intent "commit" or rephrase`);
      else hold.push(why);
    }
    if (ctx.modelError) hold.push(`the wording check could not decide (${ctx.modelError})`);
  }
  if (MONEY_DETAILS.test(body)) hold.push('the draft contains payment / wire / bank details — always confirmed by a human');
  if (commitment) {
    const mode = task.approval?.commitments ?? 'human';
    if (mode === 'human') hold.push('commitment: on this deal a human approves every commitment the agent drafts');
    else if (gray.length) hold.push(`commitment with gray areas: ${gray.join('; ')}`);
  } else {
    // a non-binding email only stops for a gray area it actually depends on
    hold.push(...gray.filter((g) => g.startsWith('the draft relies on')));
  }
  let outcome: GuardOutcome = 'allow';
  if (reasons.length) outcome = 'block';
  else if (hold.length) outcome = 'hold';
  return { outcome, allowed: outcome === 'allow', reasons, hold_reasons: outcome === 'block' ? [] : hold, gray_areas: gray, commitment, binding, intent };
}
