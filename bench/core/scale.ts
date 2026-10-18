// The scale transform: the same case with a backlog of N state-neutral messages that arrive after the
// last meaningful event and before the agent wakes. The oracle does not change (the backlog is neutral
// by construction), but the critical facts drift far from the newest mail. Accuracy and context size
// are then plotted against N.
//
// The backlog is packed into at most six hours so the clock barely moves: deadlines and "by tomorrow"
// promises mean the same thing with and without it.
import type { BenchCase, BenchEvent, VerticalModule } from './types.ts';
import { Rand, seedOf } from './util.ts';

export function withBacklog(c: BenchCase, n: number, mod: VerticalModule): BenchCase {
  if (n <= 0) return c;
  const r = new Rand(seedOf(c.id, 'backlog', n));
  const trigger = c.events.find((e) => e.key === c.trigger)!;
  const self = c.task.self_address;
  const step = Math.min(25 * 60_000, Math.floor((6 * 3600_000) / (n + 1)));
  const start = Date.parse(trigger.at);
  const maxNum = (prefix: string) => Math.max(0, ...c.events.filter((e) => e.key.startsWith(prefix)).map((e) => Number(e.key.slice(1)) || 0));
  let nextTask = maxNum('e');
  let nextBg = maxNum('b');

  const extra: BenchEvent[] = [];
  for (let i = 0; i < n; i++) {
    let m = mod.neutral(c, i, r);
    // the newest message must be on-task (it is what wakes the agent)
    for (let k = 1; i === n - 1 && m.background && k < 50; k++) m = mod.neutral(c, i + k, r);
    const at = new Date(start + step * (i + 1)).toISOString().replace('.000', '');
    extra.push({
      key: m.background ? `b${++nextBg}` : `e${++nextTask}`,
      direction: 'inbound', from: m.from, fromName: m.fromName, to: [self], subject: m.subject, body: m.body, at,
      background: m.background, quoteParent: false, auth: 'pass', note: 'scale-transform backlog (state-neutral)',
    });
  }
  const last = extra.filter((e) => !e.background).at(-1);
  if (!last) return c;

  const cutIndex = c.events.findIndex((e) => e.key === c.trigger);
  const events = [...c.events.slice(0, cutIndex + 1), ...extra, ...c.events.slice(cutIndex + 1)].sort((a, b) => a.at.localeCompare(b.at));
  const final = c.checkpoints.at(-1)!;
  const now = new Date(Date.parse(last.at) + 15 * 60_000).toISOString().replace('.000', '');
  return {
    ...c,
    id: `${c.id}@backlog${n}`,
    events,
    trigger: last.key,
    backlog: n,
    capabilities: [...new Set([...c.capabilities, 'scale' as const])],
    checkpoints: [...c.checkpoints.slice(0, -1), { ...final, after: last.key, now: now > final.now ? now : final.now }],
  };
}
