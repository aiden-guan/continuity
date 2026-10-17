// The deterministic offline extractor. It is deliberately conservative: it proposes only what surface
// patterns support, marks hedged language as low-confidence, never takes facts from questions, and skips
// quoted reply history. Term patterns come from the task's domain pack. Speech acts (questions, requests,
// commitments), hedges, corrections and quarantining instruction-like text are generic. The LLM extractor
// (llm.ts) returns the same Proposal shape.
import { domainFor, topicKeysFor, type DomainPack, type HeuristicSentence } from '../domain/pack.ts';
import '../domain/index.ts';
import type { ExtractInput, Extractor, Proposal, ProposedClaim, ProposedObligation } from './types.ts';
import { emptyProposal } from './types.ts';

const QUOTE_HEADER = [/^\s*On .{3,120}wrote:\s*$/i, /^-{2,}\s*Original Message\s*-{2,}/i, /^From: .+@.+/i];

/** Drop quoted reply history: "> …" lines, and everything after "On <date>, X wrote:". */
export function stripQuoted(body: string): string {
  const kept: string[] = [];
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (QUOTE_HEADER.some((rx) => rx.test(line))) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

export function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

const HEDGE = /\b(probably|might|maybe|perhaps|hopefully|hoping|tentative(?:ly)?|possibly|should be able|may be able|i think|not sure|we'll try|we will try|aim to|ideally)\b/i;
const CORRECTION = /\b(correction|correcting|to correct|apolog(?:y|ies|ize)|my mistake|update[d]?:|revised|revision|actually|instead|no longer|unfortunately|change of plan|changed)\b/i;
const BOILERPLATE = /(let (me|us) know if you have any (other |further )?questions|any questions|hope this helps|thanks in advance|best regards|kind regards)/i;
const INJECTION = /(ignore (all |any )?(previous|prior|above) (instructions|messages)|disregard (the |all )?(previous|prior|above) (instructions|messages|rules)|you are (now )?an? (ai|assistant|agent)|system prompt|as an ai (agent|model)|new instructions:|override (your|the) (rules|instructions)|reveal (your|the) (api key|instructions|prompt))/i;
const COMMITMENT = /\b(?:i'll|i will|we'll|we will|i'm going to|we're going to|i shall|we shall)\s+(?!need\b|have to\b|be able\b|try\b)(.+?)[.!]?$/i;
const REQUEST = /\b(please|kindly|could you|can you|would you|let (?:me|us) know|confirm)\b/i;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+/;

/** "Can you confirm: 1. final unit price? 2. whether all 500 can arrive Friday?" becomes one question per item. */
function questionItems(body: string): { items: string[]; raw: Set<string> } {
  const items: string[] = [];
  const raw = new Set<string>();
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].trim();
    if (!/[:?]\s*$/.test(header) || !/\b(confirm|can you|could you|please|let me know|questions?)\b/i.test(lines[i])) continue;
    const listed: string[] = [];
    for (let j = i + 1; j < lines.length && LIST_ITEM.test(lines[j]); j++) listed.push(lines[j]);
    if (listed.length < 2) continue;
    const lead = header.replace(/[:]\s*$/, '');
    for (const line of listed) items.push(`${lead} — ${line.replace(LIST_ITEM, '').trim().replace(/\?*$/, '?')}`);
    raw.add(header);
    for (const line of listed) raw.add(line.trim());
  }
  return { items, raw };
}

function addObligation(p: Proposal, o: ProposedObligation): void {
  if (!p.obligations.some((x) => x.kind === o.kind && x.text === o.text)) p.obligations.push(o);
}

function extractFromText(text: string, input: ExtractInput, fromAttachment: string | null, p: Proposal, pack: DomainPack): void {
  const { event, senderRole } = input;
  const ref = event.occurred_at;
  const body = fromAttachment ? text : stripQuoted(text);
  const correction = !fromAttachment && CORRECTION.test(body);
  const state = pack.heuristic?.begin();

  const claim: HeuristicSentence['claim'] = (c) => {
    const defaults = { mode: c.mode ?? (correction ? 'correction' : 'assert'), from_attachment: fromAttachment, confidence: c.hedged ? 0.45 : (c.confidence ?? 0.8) };
    p.claims.push({ ...defaults, ...c } as ProposedClaim);
  };
  const fulfillment: HeuristicSentence['fulfillment'] = (f) => {
    (p.fulfillments ??= []).push({ confidence: 0.8, ...f });
  };

  // a numbered question list is read item by item instead of line by line
  const listed = fromAttachment ? { items: [], raw: new Set<string>() } : questionItems(body);
  const partOfList = (s: string) => [...listed.raw].some((r) => r === s || r.endsWith(s) || r.startsWith(s));

  for (const s of [...sentences(body).filter((x) => !partOfList(x)), ...listed.items]) {
    if (INJECTION.test(s)) {
      // quarantine: instruction-like text is recorded as a flag and never becomes state
      p.injection_flags.push({ evidence: s.slice(0, 240) });
      continue;
    }
    const isQuestion = s.endsWith('?');
    const hedged = HEDGE.test(s);
    pack.heuristic?.sentence({ text: s, isQuestion, hedged, senderRole, fromAttachment, ref, claim, fulfillment }, state);

    if (fromAttachment) continue; // obligations come from message bodies, not documents
    if (BOILERPLATE.test(s)) continue;

    const topics = topicKeysFor(pack, s);
    if (isQuestion) {
      if (/^(?:can|could) you confirm\b[^?]*:\s*$/i.test(s)) continue; // a list header; the items are the questions
      if (topics.length || s.split(/\s+/).length >= 5) {
        addObligation(p, { kind: 'question', debtor: 'recipient', text: s, topic_keys: topics, expects_artifact: null, evidence: s, confidence: 0.75 });
      }
      continue;
    }
    const promise = s.match(COMMITMENT);
    if (promise && !hedged) {
      const action = promise[1].replace(/\s+/g, ' ').trim();
      addObligation(p, { kind: 'commitment', debtor: 'sender', text: action, topic_keys: topics, expects_artifact: expectsArtifact(action), evidence: s, confidence: 0.8 });
      continue;
    }
    if (REQUEST.test(s) && topics.length) {
      const expects = /\b(send|share|attach|forward)\b/i.test(s) ? expectsArtifact(s) : null;
      addObligation(p, { kind: 'request', debtor: 'recipient', text: s, topic_keys: topics, expects_artifact: expects, evidence: s, confidence: 0.7 });
    }
  }
  pack.heuristic?.end(state, claim);
}

const DOCUMENT_WORD = /\b(quote|quotation|invoice|contract|spec(?:ification)?|document|po|purchase order|certificate of insurance|coi|w-9|w9|tax form)\b/i;
const SENDING_WORD = /\b(send|share|attach|forward|provide|get you|email|issue|upload)\b/i;

/** The kind of document a promise or request is about, when it is about sending one. */
export function expectsArtifact(text: string): string | null {
  const m = text.match(DOCUMENT_WORD);
  if (!m || !SENDING_WORD.test(text)) return null;
  const word = m[1].toLowerCase();
  if (word.startsWith('quot')) return 'quote';
  if (word === 'po' || word === 'purchase order') return 'po';
  if (word.startsWith('spec')) return 'document';
  if (word === 'coi' || word === 'certificate of insurance') return 'insurance_certificate';
  if (word === 'w-9' || word === 'w9' || word === 'tax form') return 'tax_form';
  return word;
}

export function classifyArtifact(filename: string, text: string): { kind: string; version_label: string | null } {
  const hay = `${filename}\n${text.slice(0, 2000)}`;
  let kind = 'document';
  if (/quot/i.test(hay)) kind = 'quote';
  else if (/invoice/i.test(hay)) kind = 'invoice';
  else if (/purchase order|\bPO\b/.test(hay)) kind = 'po';
  else if (/certificate of (?:liability )?insurance|\bCOI\b/i.test(hay)) kind = 'insurance_certificate';
  else if (/\bW-?9\b|request for taxpayer/i.test(hay)) kind = 'tax_form';
  const version = hay.match(/\b(rev(?:ision)?\.?\s*\d+|v\d+(?:\.\d+)?)\b/i);
  return { kind, version_label: version ? version[1] : null };
}

export const heuristicExtractor: Extractor = {
  name: 'heuristic-v1',
  async extract(input: ExtractInput): Promise<Proposal> {
    const pack = domainFor(input.task);
    const p = emptyProposal();
    for (const a of input.attachments) {
      p.artifacts.push({ filename: a.filename, ...classifyArtifact(a.filename, a.text) });
      extractFromText(a.text, input, a.filename, p, pack);
    }
    extractFromText(input.event.body_text, input, null, p, pack);
    return p;
  },
};
