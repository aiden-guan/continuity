// One clock for picture and sound. Plain TypeScript (no JSX) so scripts/launch-score.mts can import it too.
// 60 fps, 120 BPM: a beat is 30 frames, a bar 120, a sixteenth 7.5.

export const FPS = 60;
export const BEAT = 30;
export const BAR = 120;

// Every scene's own key frames, in frames from the scene's start.
export const S01 = { dur: 360, line: 0, agent: 10, ev: [44, 98, 152], headline: 182, push: 300 } as const;
export const S02 = {
  dur: 240,
  type: 6,
  enter: 40,
  // flash cuts on sixteenths, then a roll of thirty-seconds into the stop
  cuts: [40, 48, 55, 63, 70, 78, 85, 93, 97, 101, 105, 108, 111],
  stop: 116,
  headline: 146,
  out: 226,
} as const;
export const S03 = {
  dur: 360,
  open: 0,
  zero: 18,
  finance: 30,
  financeCheck: 72,
  pdf: 48,
  correction: 96,
  underline: 128,
  quarantine: 150,
  headline: 196,
  collapse: 324,
} as const;
export const S04 = { dur: 240, spawn: 4, fill: 22, pills: 18, head1: 40, head1Out: 124, head2: 132, converge: 200 } as const;
export const S05 = { dur: 240, mark: 0, word: 8, tag: 58, through: 192 } as const;
export const S06 = { dur: 480, card: 0, scan: 26, locks: [60, 96, 132, 168, 204], headline: 300, whip: 450 } as const;
export const S07 = {
  dur: 600,
  panel: 0,
  steps: [60, 96, 132, 168, 204, 240], // strike, add, conflict, owed, stale, next
  explode: 300,
  headline: 334,
  labels: 372,
  collapse: 556,
} as const;
export const S08 = { dur: 360, type: 4, cps: 48, enter: 34, lines: 44, lineGap: 9, count: 120, headline: 196, out: 338 } as const;
export const S09 = { dur: 480, composer: 0, type: 22, typeEnd: 318, stamp: 336, send: 424 } as const;
export const S10 = {
  dur: 480,
  reply: 0,
  flips: [60, 90, 120, 150, 180],
  agentC: 210,
  guard: 236,
  card: 268,
  approve: 352,
  headline: 382,
} as const;
export const S11 = { dur: 480, field: 0, count: 8, implode: 120, landed: 172, ratio: 184, cells: 300, cellGap: 6 } as const;
export const S12 = { dur: 480, line1: 24, line2: 84, contract: 196, word: 236, by: 290 } as const;

export const SCENES = [
  { id: 'S01-MidDeal', ...S01 },
  { id: 'S02-Sigkill', ...S02 },
  { id: 'S03-DealDoesntWait', ...S03 },
  { id: 'S04-Inbox', ...S04 },
  { id: 'S05-Title', ...S05 },
  { id: 'S06-Listen', ...S06 },
  { id: 'S07-Resolve', ...S07 },
  { id: 'S08-Brief', ...S08 },
  { id: 'S09-Act', ...S09 },
  { id: 'S10-Close', ...S10 },
  { id: 'S11-Results', ...S11 },
  { id: 'S12-Finale', ...S12 },
] as const;

export const START: number[] = [];
{
  let t = 0;
  for (const s of SCENES) {
    START.push(t);
    t += s.dur;
  }
}
export const TOTAL = SCENES.reduce((n, s) => n + s.dur, 0);

/** The text Agent B types in scene 09: the real ev_7, trimmed. */
export const AGENT_B_EMAIL = [
  'Hi Dana,',
  '',
  'Thanks for letting us know. Unfortunately, the updated schedule',
  '(200 units arrive Wed Oct 28) doesn’t work for us: all 500 units',
  'need to arrive by Fri Oct 23. That is a hard requirement.',
  '',
  'Can you get the remaining units to us by Fri Oct 23?',
  'Also, we’re still expecting the revised quote you mentioned.',
];
export const AGENT_B_CHARS = AGENT_B_EMAIL.join('\n').length;
export const typedAt = (local: number) =>
  Math.floor(Math.max(0, Math.min(1, (local - S09.type) / (S09.typeEnd - S09.type))) * AGENT_B_CHARS);
