// The blind judge. It sees the ground-truth facts of the case, the task goal, the drafted emails and
// a list of plain-language conditions under neutral ids (c1, c2, …). It never sees which system wrote
// the drafts, the condition names, or whether a condition is required or prohibited.
import type { ActionCond, AgentOutput } from './types.ts';
import type { Mailbox } from './mailbox.ts';
import { Llm, type CallRecord } from './llm.ts';

const SYSTEM = `You review emails drafted by an assistant handling a business task. For each numbered statement, decide whether the drafted emails clearly do what the statement says. Judge only what the drafts actually say, not what they might mean. A statement is true only if a reader of the drafts would plainly agree. Mentioning something only to reject or correct it (e.g. "the earlier date no longer holds") does not count as relying on it. Return a verdict for every statement with a short verbatim quote from the drafts as support (empty if none).`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', 'met', 'quote'], properties: { id: { type: 'string' }, met: { type: 'boolean' }, quote: { type: 'string' } } },
    },
  },
};

export async function judge(llm: Llm, mb: Mailbox, out: AgentOutput, conds: ActionCond[], trial = 1): Promise<{ verdicts: Map<string, { met: boolean; quote?: string }>; record: CallRecord | null }> {
  const verdicts = new Map<string, { met: boolean; quote?: string }>();
  const msgs = out.decision.action === 'send' ? out.decision.messages : [];
  if (!conds.length || !msgs.length) return { verdicts, record: null };
  const label = (to: string) => {
    const p = mb.case.task.parties.find((x) => to.toLowerCase().includes(x.address.toLowerCase()));
    return p ? `${p.label} <${p.address}>` : to;
  };
  const drafts = msgs.map((m, i) => `--- Draft ${i + 1} to ${label(m.to)}${m.subject ? ` | Subject: ${m.subject}` : ''}\n${m.body}`).join('\n\n');
  const statements = conds.map((c, i) => `c${i + 1}. ${c.text}`).join('\n');
  const content = `Task: ${mb.case.task.goal}\n\nGround truth about the task at this point:\n${mb.checkpoint.judge_facts ?? '(none)'}\n\nDrafted emails:\n${drafts}\n\nStatements:\n${statements}`;
  const res = await llm.complete({ purpose: 'judge', system: SYSTEM, messages: [{ role: 'user', content }], schema: SCHEMA, effort: 'medium', trial });
  const parsed = Llm.json<{ verdicts: { id: string; met: boolean; quote: string }[] }>(res);
  for (const v of parsed.verdicts) {
    const idx = Number(v.id.replace(/^c/i, '')) - 1;
    if (conds[idx]) verdicts.set(conds[idx].id, { met: v.met, quote: v.quote });
  }
  return { verdicts, record: res.record };
}
