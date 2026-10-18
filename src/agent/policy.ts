// Offline policy agent. It decides and drafts emails from the compiled context JSON and nothing
// else — no messages, no database, no memory of earlier runs. It uses rules rather than an LLM, so
// the wording comes from templates, but the content is entirely state: which conflict is open,
// which terms are current, what is still owed, what has already been answered.
import type { CompiledContext } from '../compiler/compile.ts';
import { domainFor } from '../domain/index.ts';
import { prettyDate } from '../extract/dates.ts';

/** `intent` is declared to the send guard: "commit" for anything that accepts, confirms, orders or approves payment. */
export interface OutMessage { to: string; subject?: string; body: string; intent?: 'inform' | 'ask' | 'negotiate' | 'commit' }
export interface Decision { action: 'send' | 'wait'; messages: OutMessage[]; rationale: string; relied_on: string[]; /** provider-reported usage (LLM decisions) */ usage?: unknown }

type Action = CompiledContext['suggested_actions'][number];

const requirementValue = (ctx: CompiledContext, key: string) => ctx.requirements.find((r) => r.key === key)?.value;

/** The thing promised in a commitment: "send you the updated quote by Friday" → "updated quote". */
function promisedThing(text: string) {
  return text
    .replace(/^(send|share|provide|get|email|forward)\s+(you\s+|us\s+)?(over\s+)?(a|an|the|our|my)?\s*/i, '')
    .replace(/\s+(by|before|on|later|shortly|today|tomorrow|asap)\b.*$/i, '')
    .trim();
}

/** The text between the first and last double quote of an action line. */
const quotedPart = (s: string) => s.match(/"(.+)"/)?.[1];

function activeTermsOf(ctx: CompiledContext, partyLabel: string) {
  return ctx.current_terms.filter((t) => t.party === partyLabel && t.status === 'active');
}

export function policyDecide(ctx: CompiledContext): Decision {
  // a person has the next move (a held commitment, a detail to verify): wait for them
  if (ctx.next_actor === 'human') return { action: 'wait', messages: [], rationale: ctx.next_actor_reason, relied_on: ctx.pending_approvals.map((p) => p.id) };

  // the domain pack may word things its own way; procurement wording is the default
  const writer = domainFor(ctx.meta.domain).writer ?? {};
  // anything addressable at priority 1 or 2, grouped by recipient in first-seen order
  const actionable = ctx.suggested_actions.filter((a) => a.to_address && a.priority <= 2);
  const perRecipient = new Map<string, Action[]>();
  for (const a of actionable) {
    const list = perRecipient.get(a.to_address!) ?? [];
    perRecipient.set(a.to_address!, [...list, a]);
  }

  const messages: OutMessage[] = [];
  const relied: string[] = [];
  const qty = requirementValue(ctx, 'requirement.quantity') ?? 'the required quantity';
  const deadline = requirementValue(ctx, 'requirement.deliver_all_by');
  const maxPrice = requirementValue(ctx, 'requirement.max_unit_price');
  const alias = ctx.meta.alias;

  for (const [address, acts] of perRecipient) {
    const party = ctx.task.parties.find((p) => p.address === address);
    if (!party) continue;
    // reminders on their own are not a reason to write; wait instead
    const worthWriting = acts.some((a) => a.priority === 1 || a.kind === 'ask_for_terms' || a.kind === 'request_approval');
    if (!worthWriting) continue;

    const firstName = party.name.split(/[\s(]/)[0];
    const lines: string[] = [`Hi ${firstName},`, ''];
    let subject: string | undefined;
    const ofKind = (k: Action['kind']) => acts.filter((a) => a.kind === k);
    const conflictsRaised = ofKind('raise_conflict');
    const accepting = ofKind('accept_offer');

    // acknowledge a change they made since we last wrote
    const theyChanged = ctx.changes_since_last_action.some((c) => c.type === 'claim_superseded' && c.summary.startsWith(party.label));
    if (theyChanged && !accepting.length) lines.push('Thanks for letting us know about the change.');

    for (const a of conflictsRaised) {
      const checkId = a.check_id!;
      relied.push(checkId);
      const late = a.why.split(' — ')[0];
      const own = writer.raiseConflict?.(a, ctx);
      if (own) {
        lines.push(...own);
      } else if (checkId.startsWith('delivery_deadline')) {
        lines.push(`Unfortunately, the updated schedule (${late}) doesn't work for us: all ${qty} need to arrive by ${deadline} — that is a hard requirement for ${alias}.`);
        lines.push(`Can you get the remaining units to us by ${deadline}, for example by expediting the late lot or shipping it separately? If that isn't possible, please tell us the earliest date all ${qty} could arrive so we can decide how to proceed.`);
      } else if (checkId.startsWith('price_budget')) {
        lines.push(`${a.why}. Is there any flexibility on price to bring it to ${maxPrice} per unit or below?`);
      } else if (checkId.startsWith('quantity')) {
        lines.push(`We need ${qty}; ${a.why.toLowerCase()}. Can you supply the full quantity?`);
      } else {
        lines.push(`${a.action}: ${a.why}.`);
      }
    }

    for (const a of ofKind('resolve_contested')) {
      relied.push(...a.evidence);
      const disagreement = a.action.replace(/^Resolve contradictory [^:]+: /, '');
      lines.push(`We have received conflicting information: ${disagreement}. Could you confirm which is correct? We won't proceed until this is clarified.`);
    }

    const asks = ofKind('ask_for_terms');
    const ownAsk = asks.length ? writer.askForTerms?.(asks, party, ctx) : null;
    if (ownAsk) {
      relied.push(...asks.map((a) => a.check_id!));
      subject = ownAsk.subject ?? subject;
      lines.push(...ownAsk.lines);
    } else if (asks.length) {
      relied.push(...asks.map((a) => a.check_id!));
      const bareQty = String(qty).replace(/\s*units?$/, '');
      if (!party.last_message) subject = `RFQ: ${ctx.task.item ? `${bareQty} x ${ctx.task.item}` : qty} — ${alias}`;
      const what = ctx.task.item ? `${bareQty} ${ctx.task.item}` : qty;
      lines.push(`We are looking to purchase ${what} for ${alias}${deadline ? `, and we need all ${qty} delivered by ${deadline}` : ''}.`);
      const questions: string[] = [];
      if (asks.some((a) => a.check_id!.startsWith('delivery_deadline') || a.check_id!.startsWith('quantity'))) {
        questions.push(`whether you can deliver all ${qty}${deadline ? ` by ${deadline}` : ''}`);
      }
      if (asks.some((a) => a.check_id!.startsWith('price_budget'))) questions.push('your unit price');
      if (questions.length) lines.push(`Could you confirm ${questions.join(', and ')}? Please send a formal quote.`);
    }

    for (const a of ofKind('request_approval')) {
      relied.push(a.check_id ?? 'budget_approval');
      const own = writer.requestApproval?.(a, party, ctx);
      if (own) {
        subject = own.subject ?? subject;
        lines.push(...own.lines);
        continue;
      }
      if (!party.last_message) subject = `Budget approval request — ${alias}`;
      const total = typeof qty === 'string' && typeof maxPrice === 'string'
        ? ` (${qty} at up to ${maxPrice}, max $${(parseFloat(qty) * parseFloat(String(maxPrice).replace('$', ''))).toFixed(2)})`
        : '';
      lines.push(`Could you approve a budget of up to ${maxPrice} per unit for ${alias}${total}?`);
    }

    for (const _a of accepting) {
      const terms = activeTermsOf(ctx, party.label);
      const valueOf = (k: string) => terms.find((x) => x.term === k)?.value;
      relied.push(...terms.map((x) => x.claim_id));
      const own = writer.accept?.(party, ctx);
      if (own) {
        lines.push(...own);
        continue;
      }
      const summary = [
        valueOf('delivery.schedule') && `delivery ${valueOf('delivery.schedule')}`,
        valueOf('price.unit') && `${valueOf('price.unit')} per unit`,
        valueOf('payment.terms'),
      ].filter(Boolean).join(', ');
      lines.push(`Thank you — your current offer meets all of our requirements, and we accept it for ${alias}: ${summary}.`);
      const doc = ctx.documents.find((d) => d.from === party.label && d.status === 'current');
      lines.push(`Please treat this email as our order confirmation${doc ? ` against ${doc.filename}` : ''}, and send the invoice and shipping details.`);
    }

    // their terms are waiting on us and nothing else above answers them: acknowledge, restating what we have
    if (ofKind('respond_to_offer').length && !accepting.length && !conflictsRaised.length) {
      const terms = activeTermsOf(ctx, party.label);
      relied.push(...terms.map((x) => x.claim_id));
      const summary = terms.map((x) => `${x.term} ${x.value}`).join(', ');
      lines.push(`Thanks for the updated terms${summary ? ` (${summary})` : ''}. We're reviewing them and will come back to you shortly.`);
    }

    for (const a of ofKind('follow_up_unanswered')) {
      relied.push(a.obligation_id!);
      const q = quotedPart(a.action) ?? '';
      const point = q.replace(/^Can you confirm\s*—\s*/i, '').replace(/^\w/, (ch) => ch.toUpperCase());
      lines.push(`Thanks for your reply. One point is still open: ${point} Could you confirm?`);
    }
    for (const a of ofKind('answer_them')) {
      const question = a.action.replace(/^Answer .*?: /, '').replace(/^"|"$/g, '');
      lines.push(`Regarding your question ("${question}"): we'll come back to you on this shortly.`);
    }
    for (const a of ofKind('fulfil_our_commitment')) {
      if (accepting.length) continue;
      lines.push(`On our side: we said we would ${quotedPart(a.action) ?? 'follow up'} — we'll do that as soon as the point above is settled.`);
    }
    for (const a of ofKind('remind_commitment')) {
      const promised = quotedPart(a.action) ?? '';
      relied.push(a.obligation_id!);
      const thing = promisedThing(promised) || 'item';
      // a reminder that is the whole email gets its own opening rather than an "Also"
      if (lines.length <= 2) {
        const overdue = /OVERDUE \(due (\d{4}-\d{2}-\d{2})\)/.exec(a.action)?.[1];
        lines.push(overdue
          ? `Just checking in: we were expecting the ${thing} by ${prettyDate(overdue)} and haven't received it yet. Please send it as soon as you can.`
          : `Just checking in on the ${thing} you mentioned — please send it when ready.`);
        continue;
      }
      const planNote = conflictsRaised.length ? writer.reminderSuffix ?? ', reflecting any changes to the delivery plan' : '';
      lines.push(`Also, we're still expecting the ${thing} you mentioned — please send it when ready${planNote}.`);
    }

    lines.push('', 'Thanks,', writer.signature ?? 'Acme Procurement Agent', `(${alias})`);
    let intent: OutMessage['intent'] = 'inform';
    if (accepting.length) intent = 'commit';
    else if (conflictsRaised.length) intent = 'negotiate';
    else if (lines.some((l) => /\?\s*$/.test(l))) intent = 'ask';
    messages.push({ to: address, subject, body: lines.join('\n'), intent });
  }

  if (!messages.length) {
    const rationale = ctx.next_actor === 'them' ? ctx.next_actor_reason : `No action needed: ${ctx.next_actor_reason}`;
    return { action: 'wait' as const, messages: [], rationale, relied_on: [] };
  }
  // with no P1 action anywhere, the only reason to write is to collect missing information
  const gathering = !ctx.suggested_actions.some((a) => a.priority === 1);
  const rationale = gathering
    ? `gathering missing information: ${actionable.filter((a) => a.kind === 'ask_for_terms' || a.kind === 'request_approval').map((a) => a.action).join(' | ')}`
    : `next_actor=${ctx.next_actor}: ${ctx.next_actor_reason}`;
  return { action: 'send', messages, rationale, relied_on: [...new Set(relied)] };
}
