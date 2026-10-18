// Spend a model call only on mail that needs one. The model extractor is the expensive part of
// ingestion (one call per email), and much mail does not need it:
//   - our own outbound mail, which our agent wrote plainly (its questions and promises are what the
//     rule extractor recognises best);
//   - inbound mail that carries nothing at all: no attachment, no number, no question, and nothing
//     the rule extractor finds ("Thanks, noted.", "Got it, will check with the team" still goes to
//     the model because of the promise in it).
// Either kind is read by the rule extractor instead; everything else goes to the model as before.
import { heuristicExtractor, stripQuoted } from './heuristic.ts';
import { domainFor } from '../domain/pack.ts';
import '../domain/index.ts';
import type { ExtractInput, Extractor, Proposal } from './types.ts';

export interface RouteOptions {
  /** read our own outbound mail with the rule extractor (all of it) */
  outboundByRules?: boolean;
  /** read with the rule extractor only our outbound mail that asks, requests, promises, offers or accepts nothing */
  outboundPlainByRules?: boolean;
  /** read inbound mail with nothing in it with the rule extractor */
  skipEmpty?: boolean;
}

/**
 * Mail that carries nothing: no attachment, no question, nothing the rule extractor finds, and either no figure at
 * all or no word of the deal's vocabulary ("Quick update on PO-4817: production is on track", "Our carrier confirmed
 * pickup slots"). Reference codes such as PO-4817 are names, not figures, so they do not count as numbers.
 */
export function carriesNothing(input: ExtractInput, rules: Proposal): boolean {
  if (input.attachments.length) return false;
  const found = rules.claims.length + rules.obligations.length + rules.resolutions.length + (rules.fulfillments?.length ?? 0) + rules.injection_flags.length;
  if (found) return false;
  const text = `${input.event.subject}\n${stripQuoted(input.event.body_text)}`.replace(/\b[A-Z]{2,6}-[A-Z0-9]*\d[A-Z0-9]*\b/g, ' ');
  if (/\?/.test(text)) return false;
  if (!/[0-9$€£]/.test(text)) return true;
  // a figure is there: still nothing, unless a word the deal's terms are about appears with it
  const topics = domainFor(input.task).terms.flatMap((t) => t.topics ?? []).filter((w) => w.length > 2 && /[a-z]/i.test(w));
  const lower = text.toLowerCase();
  return !topics.some((w) => lower.includes(w.toLowerCase()));
}

/** Outbound wording that creates state the rule extractor can miss in terse mail: a question or request ("ok to go
 *  to 13.00/ea?"), a promise ("PO going out tonight"), an offer or counter, an acceptance. Any number counts too. */
const OUTBOUND_STATE = /[?0-9$]|\b(please|pls|could|can|would|will|won't|we'll|i'll|let me know|confirm|ok to|okay to|approve|accept|agree|go ahead|proceed|deal|counter|offer|propose|commit|send|sending|going out|book|sign|order|po\b)/i;

/** Our outbound mail that asks, requests, promises, offers and accepts nothing ("Thanks, noted.", "Adding Sam."). */
export function plainOutbound(input: ExtractInput): boolean {
  return input.event.direction === 'outbound' && !input.attachments.length && !OUTBOUND_STATE.test(`${input.event.subject}\n${stripQuoted(input.event.body_text)}`);
}

export function routedExtractor(model: Extractor, opts: RouteOptions): Extractor {
  if (!opts.outboundByRules && !opts.outboundPlainByRules && !opts.skipEmpty) return model;
  const tag = `${opts.outboundByRules ? '+out-rules' : ''}${opts.outboundPlainByRules ? '+out-plain-rules' : ''}${opts.skipEmpty ? '+skip-empty' : ''}`;
  return {
    name: model.name,
    fingerprint: `${model.fingerprint ?? ''}${tag}`,
    async extract(input, callOpts) {
      if (opts.outboundByRules && input.event.direction === 'outbound') return heuristicExtractor.extract(input);
      if (opts.outboundPlainByRules && plainOutbound(input)) return heuristicExtractor.extract(input);
      if (opts.skipEmpty && input.event.direction === 'inbound') {
        const rules = await heuristicExtractor.extract(input);
        if (carriesNothing(input, rules)) return rules;
      }
      return model.extract(input, callOpts);
    },
  };
}

/** The routing chosen by CONTINUITY_EXTRACT_ROUTE (comma list of "outbound-rules", "outbound-plain-rules", "skip-empty"). */
export function routeFromEnv(env = process.env.CONTINUITY_EXTRACT_ROUTE ?? ''): RouteOptions {
  const parts = env.split(',').map((s) => s.trim());
  return { outboundByRules: parts.includes('outbound-rules'), outboundPlainByRules: parts.includes('outbound-plain-rules'), skipEmpty: parts.includes('skip-empty') };
}
