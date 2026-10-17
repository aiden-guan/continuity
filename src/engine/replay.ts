// Event-sourced replay: rebuild a task's state from its immutable event log.
//
//  - using the saved proposals (the default) it reproduces exactly what the system believed after
//    any given event ("what did we know when we sent ev_7?")
//  - using a fresh extractor it re-interprets the same evidence (say, after an extractor upgrade)
//    without touching the original events.
// Replay always runs in memory; the source can be a task working set from any backend.
import { MemoryBackend } from '../store/memory-backend.ts';
import type { MemoryStore } from '../store/state.ts';
import { Engine, DEFAULT_ORG } from './engine.ts';
import type { Extractor, Proposal } from '../extract/types.ts';
import type { EventInput, StoredEvent } from '../types.ts';

/** An extractor that hands back whatever proposal was last saved for each event. */
export function savedProposals(src: MemoryStore): Extractor {
  return {
    name: 'replay:saved-proposals',
    async extract(input) {
      const latest = src.extractionsFor(input.event.id).at(-1);
      if (!latest) throw new Error(`no saved proposal for ${input.event.id}`);
      return latest.proposal as Proposal;
    },
  };
}

export async function replayTask(src: MemoryStore, taskId: string, opts: { uptoEventId?: string; extractor?: Extractor; raw?: (e: StoredEvent) => unknown } = {}): Promise<MemoryStore> {
  const task = src.getTask(taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  const lastSeq = opts.uptoEventId ? src.getEvent(opts.uptoEventId)?.seq ?? Infinity : Infinity;

  const target = new MemoryBackend();
  const engine = new Engine(target, opts.extractor ?? savedProposals(src));
  await engine.createTask(DEFAULT_ORG, task, src.taskCreatedAt(task.id) ?? new Date(0).toISOString());

  const artifacts = src.artifactsForTask(task.id);
  const storedText = (eventId: string, filename: string) =>
    artifacts.find((a) => a.event_id === eventId && a.filename === filename)?.text;

  for (const e of src.eventsForTask(task.id)) {
    if (e.seq > lastSeq) break;
    // still pending at the source, so not part of what was believed (unless re-interpreting)
    if (!src.isInterpreted(e.id) && !opts.extractor) continue;
    const input: EventInput = {
      ...e,
      raw: opts.raw?.(e) ?? src.getEventRaw(e.id) ?? undefined,
      task_id: task.id,
      link_reason: e.link_reason,
      preserve_seq: e.seq, // keep the original event ids so evidence references stay valid
      attachments: e.attachments.map((m) => ({ ...m, text: m.text ?? storedText(e.id, m.filename) ?? '' })),
    };
    await engine.ingest(DEFAULT_ORG, input);
  }
  return target.org(DEFAULT_ORG);
}
