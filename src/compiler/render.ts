// Turns a compiled context into a compact text briefing for an LLM agent.
// Sections run in order of operational weight: what to do, what is blocked, what is true now,
// what stopped being true, who owes whom, what changed. Evidence ids stay inline.
//
// Budget (max_tokens; the unit is estimated tokens = characters / 4):
//   essential — header, processing warnings, requirements, next actor + P1 actions, conflicts,
//               current terms, withdrawn offers, open obligations. These are never removed. When
//               they alone overflow the budget the result reports it (budget.fits = false)
//               rather than cutting anything.
//   bounded   — P2/P3 actions, superseded/tentative terms, answered questions, resolved
//               commitments, documents, passing checks, flags, changes, evidence index. These are
//               trimmed least-important first, each leaving an "N omitted — drill down" line.
import type { CompiledContext } from './compile.ts';
import { estimateTokens, TOKEN_UNIT } from './compile.ts';

export interface BudgetReport {
  unit: string;
  limit: number | null;
  used: number;
  essential: number;
  fits: boolean;
  /** sections reduced or removed to meet the budget, with what was left out */
  trimmed: { section: string; omitted: number; drill_down: string }[];
}

interface Section {
  key: string;
  essential: boolean;
  lines: string[];
  drill: string;
  /** bullet lines that may be dropped, oldest first */
  items?: string[];
  head?: string[];
}

type SuggestedRow = CompiledContext['suggested_actions'][number];
type ObligationRow = CompiledContext['waiting_on_them'][number];

/** " [ev_1, ev_2]" for the ids that are present, or nothing. */
const evidenceTag = (ids: (string | null | undefined)[]) => {
  const present = ids.filter(Boolean);
  return present.length ? ` [${present.join(', ')}]` : '';
};

const bullet = (s: string) => `- ${s}`;

/** "MM-DD HH:MM" from an ISO timestamp. */
const shortStamp = (iso: string) => iso.slice(5, 16).replace('T', ' ');

const ACTIONS_TITLE = 'Suggested actions (derived from state; you decide)';

function buildSections(ctx: CompiledContext): Section[] {
  const out: Section[] = [];
  const section = (key: string, essential: boolean, title: string | null, items: string[], drill = ctx.drill_down.state, head: string[] = []) => {
    const heading = title ? [`\n## ${title}`] : [];
    out.push({ key, essential, drill, head: [...heading, ...head], items, lines: [] });
  };
  const olderOmitted = (n: number, what: string, drill: string) => (n ? [bullet(`(${n} older ${what} omitted — ${drill})`)] : []);
  const omitted = ctx.history_omitted;
  const stateDrill = ctx.drill_down.state;

  // ---- header and processing warnings
  const header = [
    `# Task ${ctx.meta.alias} — state v${ctx.meta.state_version}${ctx.meta.as_of ? ` (as of ${ctx.meta.as_of})` : ''}`,
    `Goal: ${ctx.task.goal}`,
    `You are: ${ctx.task.you_are}`,
    `Parties: ${ctx.task.parties.map((p) => `${p.label} <${p.address}>${p.sender_auth === 'flag' ? ' (unauthenticated mail accepted but flagged)' : ''}`).join('; ')}`,
    `\n> ${ctx.safety}`,
  ];
  const pending = ctx.meta.pending_events;
  if (pending.length) {
    header.push(`\n> WARNING: ${pending.length} new email(s) (${pending.join(', ')}) are still being processed; this state may be about to change.`);
  }
  if (ctx.processing.failed_events.length) {
    header.push(`\n> WARNING: ${ctx.processing.failed_events.join(', ')} could not be interpreted; state may be missing what they said.`);
  }
  if (ctx.processing.actions_in_flight.length) {
    const sends = ctx.processing.actions_in_flight.map((a) => `${a.id} → ${a.to}: ${a.status}`).join('; ');
    header.push(`\n> WARNING: a send is in flight (${sends}); wait for it to settle.`);
  }
  section('header', true, null, [], stateDrill, header);

  // ---- requirements, next actor, actions
  section('requirements', true, 'Requirements (from our principal)', ctx.requirements.map((r) => bullet(`${r.key.replace('requirement.', '')}: ${r.value}${r.hard ? ' (hard)' : ''}`)));
  const urgent = ctx.suggested_actions.filter((a) => a.priority === 1);
  const lower = ctx.suggested_actions.filter((a) => a.priority !== 1);
  const actionLine = (a: SuggestedRow) => bullet(`P${a.priority}${a.to ? ` → ${a.to}` : ''}: ${a.action}. Why: ${a.why}${evidenceTag(a.evidence)}`);
  section('next_actor', true, `Next actor: ${ctx.next_actor.toUpperCase()}`, [], stateDrill, [ctx.next_actor_reason]);
  if (ctx.pending_approvals.length) {
    section('approvals', true, 'Waiting on a human (do not commit or act on these yourself)', ctx.pending_approvals.map((p) => bullet(
      `${p.id} [${p.status}]: ${p.title} — because ${p.asked_because.join('; ')}. Since ${shortStamp(p.since)}, expires ${shortStamp(p.expires_at)}.`,
    )));
  }
  if (ctx.suggested_actions.length) section('actions_p1', true, ACTIONS_TITLE, urgent.map(actionLine));
  // lower-priority actions sit under the same heading unless there were no P1 actions to carry it
  if (lower.length) section('actions_rest', false, urgent.length ? null : ACTIONS_TITLE, lower.map(actionLine));

  // ---- conflicts and current state
  if (ctx.conflicts.length) section('conflicts', true, 'Conflicts / blockers', ctx.conflicts.map((c) => bullet(`${c.check}: ${c.detail}`)));
  const termLines = ctx.current_terms.map((t) => {
    const contestedMark = t.status === 'contested' ? ' (CONTESTED)' : '';
    const alsoIn = t.documents.length ? ` (also in ${t.documents.join(', ')})` : '';
    return bullet(`${t.party} — ${t.term} = ${t.value}${contestedMark}${alsoIn}${evidenceTag(t.stated_in)}`);
  });
  section('current_terms', true, 'Current terms (latest valid statements)', termLines.length ? termLines : [bullet('(none yet)')]);
  if (ctx.withdrawn_offers.length) {
    section('withdrawn', true, 'Withdrawn offers — NOT available (history only)', ctx.withdrawn_offers.map((w) => {
      const gone = w.no_longer_available.length ? ` — no longer available: ${w.no_longer_available.map((x) => `${x.term} ${x.was}`).join(', ')}` : '';
      return bullet(`${w.party} withdrew${evidenceTag([w.withdrawn_in])}: "${w.quote}"${gone}`);
    }));
  }

  // ---- obligations
  const dueNote = (o: { due?: string; overdue?: boolean }) => (o.due ? ` (due ${o.due}${o.overdue ? ' — OVERDUE' : ''})` : '');
  const obligationExtras = (o: ObligationRow) => {
    let s = '';
    if ('issue' in o && o.issue) s += ` [issue: ${o.issue}]`;
    if ('outstanding_quantity' in o && o.outstanding_quantity != null) s += ` — ${o.fulfilled_quantity} of ${o.quantity} delivered, ${o.outstanding_quantity} outstanding`;
    if ('residual_deadline_missed' in o && o.residual_deadline_missed) s += ` — RESIDUAL LATE: ${o.residual_deadline_missed}`;
    if ('condition' in o && o.condition) s += ` — when ${o.condition}${o.condition_met ? ' (condition MET: now due)' : ' (not yet due)'}`;
    if ('closes_when' in o && o.closes_when) s += ` — closes when ${o.closes_when}`;
    return s;
  };
  const theirs = ctx.waiting_on_them.map((o) => bullet(`${o.owed_by} owes ${o.owed_to} [${o.kind}]: ${o.what}${dueNote(o)}${obligationExtras(o)}${evidenceTag([o.source])}`));
  section('waiting', true, 'Waiting on others (open)', theirs.length ? theirs : [bullet('(nothing)')]);
  const ours = ctx.we_owe.map((o) => bullet(`to ${o.owed_to} [${o.kind}]: ${o.what}${dueNote(o)}${obligationExtras(o)}${evidenceTag([o.source])}`));
  section('we_owe', true, 'We owe (open)', ours.length ? ours : [bullet('(nothing)')]);

  // ---- history (bounded)
  if (ctx.superseded_terms_do_not_use.length) {
    section('superseded', false, 'Superseded — do NOT rely on these', [
      ...olderOmitted(omitted.superseded_terms, 'superseded terms', stateDrill),
      ...ctx.superseded_terms_do_not_use.map((s) => bullet(`${s.party} — ${s.term} was ${s.old_value}${evidenceTag([s.old_source])}; now ${s.current_value} (${s.reason})`)),
    ]);
  }
  if (ctx.tentative_not_applied.length) {
    section('tentative', false, 'Tentative statements (not applied to state)', [
      ...olderOmitted(omitted.tentative, 'tentative statements', stateDrill),
      ...ctx.tentative_not_applied.map((t) => bullet(`${t.party} — ${t.term} = ${t.value}: ${t.why_not_applied}${evidenceTag([t.source])}`)),
    ]);
  }
  if (ctx.already_answered_do_not_reask.length) {
    section('answered', false, 'Already answered — do not re-ask', [
      ...olderOmitted(omitted.answered_questions, 'answered questions', stateDrill),
      ...ctx.already_answered_do_not_reask.map((q) => bullet(`${q.asked_by} asked: "${q.asked}"${'issue' in q && q.issue ? ` [${q.issue}]` : ''} → ${q.status}: ${q.resolution}${evidenceTag([q.resolved_in])}`)),
    ]);
  }
  if (ctx.resolved_commitments.length) {
    section('resolved', false, 'Resolved commitments', [
      ...olderOmitted(omitted.resolved_commitments, 'resolved commitments', stateDrill),
      ...ctx.resolved_commitments.map((c) => bullet(`${c.by}: "${c.what}" → ${c.status} (${c.resolution})${evidenceTag([c.resolved_in])}`)),
    ]);
  }
  if (ctx.documents.length) {
    const docLines = ctx.documents.map((d) => {
      let line = bullet(`${d.filename} (${d.kind}${d.version ? ` ${d.version}` : ''}, from ${d.from}) — ${d.status.toUpperCase()}${d.superseded_by ? ` by ${d.superseded_by}` : ''}${evidenceTag([d.received_in])}`);
      if (d.still_current_terms.length && d.status !== 'superseded' && d.status !== 'withdrawn') line += `\n  - still current: ${d.still_current_terms.join('; ')}`;
      for (const s of d.stale_terms) line += `\n  - STALE: ${s.term} says ${s.document_says}, now ${s.now}${evidenceTag([s.changed_by])}`;
      return line;
    });
    section('documents', false, 'Documents', [...olderOmitted(omitted.superseded_documents, 'superseded documents', stateDrill), ...docLines]);
  }
  const nonFailing = ctx.checks.filter((c) => c.status !== 'fail');
  if (nonFailing.length) section('checks', false, 'Checks passing / unknown', nonFailing.map((c) => bullet(`${c.status.toUpperCase()} ${c.check}: ${c.detail}`)));
  if (ctx.flags.length) {
    section('flags', false, 'Flags', [
      ...olderOmitted(omitted.flags, 'flags', stateDrill),
      ...ctx.flags.map((f) => bullet(`${f.kind}: ${f.detail.slice(0, 160)}${evidenceTag([f.event])}`)),
    ]);
  }

  // ---- changes: real state transitions listed; messages that changed nothing get one summary line
  const changes = ctx.changes_since_last_action;
  const transitionsOnly = changes.filter((c) => c.type !== 'event_ingested');
  const eventsWithEffect = new Set(transitionsOnly.map((c) => c.event));
  const quiet = changes.filter((c) => c.type === 'event_ingested' && !eventsWithEffect.has(c.event));
  const shown = transitionsOnly.slice(-15);
  const changeLines: string[] = [];
  if (!changes.length) changeLines.push(bullet('(none)'));
  const hidden = transitionsOnly.length - shown.length + omitted.changes;
  if (hidden > 0) changeLines.push(bullet(`(${hidden} earlier changes omitted — ${ctx.drill_down.changes})`));
  for (const c of shown) changeLines.push(bullet(`${shortStamp(c.at)} ${c.summary}${evidenceTag([c.event])}`));
  if (quiet.length) {
    const recent = quiet.slice(-6).map((c) => `${c.event} ${c.summary.replace(/^.*?: "/, '"')}`).join('; ');
    changeLines.push(bullet(`${quiet.length} other message${quiet.length > 1 ? 's' : ''} with no state change: ${recent}${quiet.length > 6 ? '; …' : ''}`));
  }
  section('changes', false, `Changes since ${ctx.meta.changes_since} (seq > ${ctx.meta.changes_since_seq})`, changeLines, ctx.drill_down.changes);

  // ---- evidence index and footer
  const evidenceLines = (Object.entries(ctx.evidence) as [string, any][]).map(([id, e]) =>
    bullet(`${id}: ${shortStamp(e.at)} ${e.from}→${e.to.join(',')} "${e.subject}"${e.attachments.length ? ` +${e.attachments.join(', ')}` : ''}`));
  section('evidence', false, 'Evidence index', evidenceLines, ctx.drill_down.raw_event);
  out.push({
    key: 'footer', essential: true, drill: '', items: [], lines: [],
    head: [`\nDrill down: ${ctx.drill_down.timeline}, ${ctx.drill_down.provenance}, ${ctx.drill_down.explain_term}`],
  });
  return out;
}

const joinSections = (list: Section[]) => list.flatMap((s) => [...(s.head ?? []), ...(s.items ?? [])]).join('\n');

/** Which sections give way first when over budget: the least decision-relevant lead. */
const TRIM_ORDER = ['evidence', 'checks', 'resolved', 'flags', 'documents', 'tentative', 'answered', 'changes', 'superseded', 'actions_rest'];

export function renderWithBudget(ctx: CompiledContext, opts: { maxTokens?: number } = {}): { text: string; budget: BudgetReport } {
  const list = buildSections(ctx);
  const limit = opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : null;
  const trimmed: BudgetReport['trimmed'] = [];
  const essentialTokens = estimateTokens(joinSections(list.filter((s) => s.essential)));
  const over = () => estimateTokens(joinSections(list)) > limit!;

  if (limit) {
    for (const key of TRIM_ORDER) {
      if (!over()) break;
      const sec = list.find((s) => s.key === key);
      if (!sec || !sec.items?.length) continue;
      const before = sec.items.length;
      // drop from the oldest end, then leave a pointer to what was removed
      while (sec.items.length && over()) sec.items.shift();
      const dropped = before - sec.items.length;
      if (dropped) {
        trimmed.push({ section: key, omitted: dropped, drill_down: sec.drill });
        sec.items.unshift(`- (${dropped} item${dropped > 1 ? 's' : ''} omitted for budget — ${sec.drill})`);
      }
    }
  }

  let text = joinSections(list);
  const fits = !limit || estimateTokens(text) <= limit;
  if (!fits) {
    // a blocker or an open obligation is never dropped to meet a budget; flag the overrun instead
    text = `> CONTEXT BUDGET EXCEEDED: essential state needs ~${essentialTokens} ${TOKEN_UNIT}; limit ${limit}. Nothing essential was removed; this briefing is over budget.\n${text}`;
  }
  return { text, budget: { unit: TOKEN_UNIT, limit, used: estimateTokens(text), essential: essentialTokens, fits, trimmed } };
}

export function renderBriefing(ctx: CompiledContext, opts: { maxTokens?: number } = {}): string {
  return renderWithBudget(ctx, opts).text;
}
