// Records real engine output for the story section of the landing page (site/assets/snapshot.json),
// so the site can tell the story from genuine compiled state even when no server is running.
//
//   npm run demo -- --port 4300 &        # or any finished run of the story
//   CONTINUITY_URL=http://localhost:4300 npm run site:snapshot
import { writeFileSync } from 'node:fs';

const API = process.env.CONTINUITY_URL || 'http://localhost:4100';
const TASK = process.argv[2] || 'PO-4817';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

type Ev = { id: string };
type Context = { context: Record<string, unknown>; briefing: string; briefing_tokens: number; transcript_tokens: number };

const [health, timeline, runs, state, live] = await Promise.all([
  get<Record<string, unknown>>('/api/health'),
  get<{ events: Ev[] }>(`/tasks/${TASK}/timeline`),
  get<{ context: Record<string, unknown> }[]>(`/tasks/${TASK}/agent-runs`),
  get<unknown>(`/tasks/${TASK}/state`),
  get<{ briefing: string; briefing_tokens: number; transcript_tokens: number }>(`/tasks/${TASK}/context`),
]);

/** Drop the heavy parts of a context that the site never renders. */
function slim(context: Record<string, unknown>) {
  const { evidence: _evidence, drill_down: _drill, safety: _safety, ...kept } = context;
  return kept;
}

// the state as it stood after each event, replayed from the event log
const asOf: Record<string, unknown> = {};
for (const event of timeline.events) {
  const c = await get<Context>(`/tasks/${TASK}/context?as_of=${event.id}`);
  asOf[event.id] = { context: slim(c.context), briefing: c.briefing, briefing_tokens: c.briefing_tokens, transcript_tokens: c.transcript_tokens };
}

const snapshot = {
  captured_at: new Date().toISOString(),
  source: API,
  health,
  timeline,
  state,
  runs: runs.map((run) => ({ ...run, context: slim(run.context) })),
  final: { briefing: live.briefing, briefing_tokens: live.briefing_tokens, transcript_tokens: live.transcript_tokens },
  as_of: asOf,
};
const json = JSON.stringify(snapshot);
const target = new URL('../site/assets/snapshot.json', import.meta.url);
writeFileSync(target, json);
console.log(`wrote ${target.pathname} (${(json.length / 1024).toFixed(0)} KB, ${timeline.events.length} events, ${runs.length} agent runs)`);
