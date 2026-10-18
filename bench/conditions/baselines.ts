// The non-Continuity conditions. Each one is a fair, competent version of a common strategy, given the
// same task header, the same new message and the same actor. Where a baseline needs a choice we make
// the generous one (e.g. full history and the running memories get ground-truth task membership, so
// they never see unrelated mail; Continuity has to do that linkage itself).
import type { Condition, ConditionCtx, Prepared } from './types.ts';
import type { Mailbox, MailMessage } from '../core/mailbox.ts';
import { renderEmail, taskHeader } from '../core/mailbox.ts';
import { Llm, estimateTokens, type CallRecord } from '../core/llm.ts';
import { outputSchema } from '../core/actor.ts';
import type { OracleState } from '../core/types.ts';
import { bm25 } from '../core/bm25.ts';

const before = (mb: Mailbox) => mb.messages.filter((m) => m.id !== mb.trigger.id);
const taskMail = (mb: Mailbox) => before(mb).filter((m) => m.task);

// ------------------------------------------------------------------ oracle (upper bound / calibration)

/** The ground-truth state rendered as a briefing: shows what the actor achieves with perfect memory. */
export const oracle: Condition = {
  id: 'oracle',
  label: 'Oracle state (upper bound)',
  description: 'The ground-truth state from the case labels, rendered as a briefing. Calibrates the actor ceiling; not a competitor.',
  usesModel: false,
  async prepare(mb) {
    const s: OracleState = mb.checkpoint.state;
    const id = (k: string) => mb.byKey.get(k)?.id ?? k;
    const ids = (ks: string[]) => ks.map(id).join(', ');
    const party = (a: string) => mb.case.task.parties.find((p) => p.address === a)?.label ?? a;
    const lines: string[] = [];
    lines.push('Current terms:');
    for (const t of s.terms) {
      if (t.status === 'current') lines.push(`- ${party(t.party)} <${t.party}> ${t.term} = ${JSON.stringify(t.value)} (${t.display}) [${ids(t.evidence)}]`);
      if (t.status === 'contested') for (const v of t.contested ?? []) lines.push(`- CONTESTED ${party(v.party)} <${v.party}> ${t.term} = ${JSON.stringify(v.value)} [${ids(v.evidence)}]`);
      if (t.status === 'absent') lines.push(`- ${party(t.party)} ${t.term}: no valid current value`);
    }
    lines.push('Superseded (do not use):', ...s.superseded.map((x) => `- ${party(x.party)} ${x.term} was ${JSON.stringify(x.value)} [${ids(x.evidence)}], replaced in ${id(x.superseded_by)}`));
    lines.push('Open loops:', ...s.open_loops.map((l) => `- ${l.kind} owed by ${party(l.debtor)} <${l.debtor}>: ${l.display} (subject ${l.subject}) [${ids(l.evidence)}]`));
    lines.push('Already answered / fulfilled (do not re-ask):', ...s.closed_loops.map((l) => `- ${l.display}`));
    lines.push('Conflicts:', ...s.conflicts.map((c) => `- ${c.kind} on ${c.term}: ${c.display}`));
    lines.push('Documents:', ...s.documents.map((d) => `- ${d.filename}: ${d.status}${d.stale_terms.length ? ` (stale: ${d.stale_terms.join(', ')})` : ''}`));
    if (s.flags?.length) lines.push('Flags:', ...s.flags.map((f) => `- ${f.kind} in ${id(f.event)}`));
    lines.push(`Next actor: ${s.next_actor}`);
    return { label: 'state_briefing', memory: lines.join('\n'), ingestion: [], retrieval: [] };
  },
};

// ------------------------------------------------------------------ full history

export const fullHistory: Condition = {
  id: 'full-history',
  label: 'Full history',
  description: 'Every task email in order (quoted replies included, as delivered) with attachment text. Expensive reference.',
  usesModel: false,
  async prepare(mb) {
    return { label: 'full_history', memory: taskMail(mb).map((m) => renderEmail(m)).join('\n\n=====\n\n'), ingestion: [], retrieval: [] };
  },
};

// ------------------------------------------------------------------ retrieval (RAG)

/**
 * Lexical retrieval over the whole inbox (task and unrelated mail, emails and attachments as separate
 * chunks), BM25-ranked against the task goal plus the new message. A substitute for Primitive's
 * /semantic-search, which needs the Pro plan and the semantic_search_enabled entitlement.
 */
export const retrieval: Condition = {
  id: 'retrieval',
  label: 'Retrieval (BM25, top-8)',
  description: 'Top-8 inbox chunks (emails and attachments, task and unrelated mail) by BM25 against goal + new message, max ~2,000 tokens. Substitute for Primitive /semantic-search (Pro-gated).',
  usesModel: false,
  async prepare(mb) {
    const chunks = before(mb).flatMap((m) => [
      { id: m.id, text: renderEmail(m, { attachments: false }), m },
      ...m.attachments.map((a) => ({ id: `${m.id}:${a.filename}`, text: `[attachment ${a.filename} (from ${m.id})]\n${a.text}`, m })),
    ]);
    const query = `${mb.case.task.goal}\n${mb.trigger.event.subject}\n${mb.trigger.event.body}`;
    const ranked = bm25(chunks.map((c) => c.text), query);
    const picked: typeof chunks = [];
    let budget = 2000;
    for (const { index } of ranked) {
      if (picked.length >= 8) break;
      const cost = estimateTokens(chunks[index].text);
      if (cost > budget) continue;
      budget -= cost;
      picked.push(chunks[index]);
    }
    // present in chronological order, as a retriever-backed agent would see them
    picked.sort((a, b) => a.m.event.at.localeCompare(b.m.event.at));
    return {
      label: 'retrieved_messages',
      memory: picked.map((c) => c.text).join('\n\n=====\n\n'),
      ingestion: [],
      retrieval: [],
      diag: { retrieved: picked.map((c) => c.id), task_hits: picked.filter((c) => c.m.task).length, background_hits: picked.filter((c) => !c.m.task).length },
    };
  },
};

// ------------------------------------------------------------------ rolling summary

const SUMMARY_SYSTEM = `You maintain the running memory of an email-based business task for an AI agent that will later pick the task up with no other memory. After each new message you rewrite the summary.
Keep everything a successor needs to act correctly: current terms per party (with message ids), what changed and what was replaced, open questions and promises (who owes what), conflicts with requirements, document status, and who must act next. Drop pleasantries. Hard limit: 700 words. Output only the new summary text.`;

export const rollingSummary: Condition = {
  id: 'rolling-summary',
  label: 'Rolling summary',
  description: 'A ≤700-word running summary, rewritten by the model after every task email (same model).',
  usesModel: true,
  async prepare(mb, ctx) {
    let summary = '(empty: no messages yet)';
    const calls: CallRecord[] = [];
    for (const m of taskMail(mb)) {
      const res = await ctx.llm.complete({
        purpose: 'summary',
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: `${taskHeader(mb).replace(/Current time:.*$/m, '')}\n\n<summary_so_far>\n${summary}\n</summary_so_far>\n\n<new_message>\n${renderEmail(m)}\n</new_message>\n\nRewrite the summary.` }],
        effort: 'low',
        trial: ctx.trial,
      });
      calls.push(res.record);
      summary = res.text.trim();
    }
    return { label: 'running_summary', memory: summary, ingestion: calls, retrieval: [] };
  },
};

// ------------------------------------------------------------------ agent self-notes (LLM-maintained structured memory)

const NOTES_SYSTEM = `You maintain structured working notes for an email-based business task, for an AI agent that will later pick the task up with no other memory. After each new message you output the complete, updated notes as JSON in the given schema: current terms per party, superseded values, open loops, conflicts, document status, who acts next. Keep message ids (like m07) as sources. The "decision" field is not used here: set action "wait", messages [] and rationale "".`;

/**
 * The strongest model-only competitor: the model keeps its own structured state (the same schema the
 * actor reports), updated after every task email, like LLM-managed memory systems. Isolates what the
 * deterministic resolver adds over "let the model maintain state".
 */
export const agentNotes: Condition = {
  id: 'agent-notes',
  label: 'LLM-maintained structured notes',
  description: 'The model rewrites a structured JSON state (same schema as the report) after every task email; the actor gets the final notes.',
  usesModel: true,
  async prepare(mb, ctx) {
    const parties = mb.case.task.parties.map((p) => p.address);
    const schema = outputSchema(ctx.vertical, parties);
    let notes = '{}';
    const calls: CallRecord[] = [];
    for (const m of taskMail(mb)) {
      const res = await ctx.llm.complete({
        purpose: 'notes',
        system: `${NOTES_SYSTEM}\n\nVocabulary: ${ctx.vertical.terms.map((t) => `${t.key} (${t.type})`).join(', ')}`,
        messages: [{ role: 'user', content: `${taskHeader(mb).replace(/Current time:.*$/m, '')}\n\n<notes_so_far>\n${notes}\n</notes_so_far>\n\n<new_message>\n${renderEmail(m)}\n</new_message>\n\nOutput the updated notes.` }],
        schema,
        effort: 'low',
        trial: ctx.trial,
      });
      calls.push(res.record);
      const parsed = Llm.json<Record<string, unknown>>(res);
      delete parsed.decision;
      notes = JSON.stringify(parsed, null, 1);
    }
    return { label: 'working_notes', memory: notes, ingestion: calls, retrieval: [] };
  },
};

export type { Prepared, ConditionCtx, MailMessage };
