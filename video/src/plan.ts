// Edit decision list: combines the recorded timeline with the narration lengths.
// Each "live" cut is the untouched footage of one beat. Instead of trimming, its playback rate is tuned
// so the beat runs exactly as long as its voiceover: slow agent work gets faster, nothing is dropped.

export type Beat = { index: number; title: string; caption: string; start: number; end: number };

export type Timeline = {
  mode: string;
  hero: { file: string; duration: number };
  live: { file: string; duration: number; beats: Beat[]; finale: number };
};

export type VoiceLine = { id: string; text: string; file: string; duration: number };
export type Voice = { provider: string; lines: VoiceLine[] };

type HeroCut = { kind: 'hero'; frames: number; src: string; from: number; voice: VoiceLine };
type IdeaCut = { kind: 'idea'; frames: number; heroSrc: string; voice: VoiceLine };
type LiveCut = { kind: 'live'; frames: number; src: string; from: number; to: number; rate: number; voice: VoiceLine };
type OutroCut = { kind: 'outro'; frames: number; voice: VoiceLine };
export type Segment = HeroCut | IdeaCut | LiveCut | OutroCut;

export const FPS = 30;
/** Crossfade length between neighbouring segments, in frames. */
export const FADE = 10;
/** Breathing room left after each spoken line, in seconds. */
const TAIL = 0.9;

const within = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const toFrames = (seconds: number) => Math.round(seconds * FPS);
const liveFrames = (cut: { from: number; to: number; rate: number }) => toFrames((cut.to - cut.from) / cut.rate);

export function plan(timeline: Timeline, voice: Voice): { segments: Segment[]; durationInFrames: number } {
  const narration = (id: string): VoiceLine => {
    const found = voice.lines.find((l) => l.id === id);
    if (!found) throw new Error(`no narration for "${id}" — run npm run narrate`);
    return found;
  };

  const { hero, live } = timeline;
  const out: Segment[] = [];

  // 1. landing hero under the opening line
  const intro = narration('intro');
  out.push({
    kind: 'hero',
    src: hero.file,
    from: 0.4,
    voice: intro,
    frames: toFrames(within(intro.duration + TAIL + 0.6, 4, hero.duration - 0.5)),
  });

  // 2. the headline card
  const idea = narration('idea');
  out.push({ kind: 'idea', heroSrc: hero.file, voice: idea, frames: toFrames(idea.duration + TAIL + 0.8) });

  // 3. one cut per beat of the live run, each stretched or squeezed to fit its line
  live.beats.forEach((beat, i) => {
    const next = live.beats[i + 1];
    const from = Math.max(0, beat.start - 0.35);
    const to = next ? next.start - 0.15 : live.finale - 0.1;
    const line = narration(`beat-${i}`);
    const rate = within((to - from) / (line.duration + TAIL), 0.85, 8);
    out.push({ kind: 'live', src: live.file, from, to, rate, voice: line, frames: liveFrames({ from, to, rate }) });
  });

  // 4. the closing card from the live run (at most 5 s of it, never sped up beyond 2x)
  const finale = narration('finale');
  const finaleFrom = live.finale - 0.1;
  const finaleTo = Math.min(live.duration - 0.1, live.finale + 5);
  const finaleRate = within((finaleTo - finaleFrom) / (finale.duration + TAIL), 0.85, 2);
  out.push({
    kind: 'live',
    src: live.file,
    from: finaleFrom,
    to: finaleTo,
    rate: finaleRate,
    voice: finale,
    frames: liveFrames({ from: finaleFrom, to: finaleTo, rate: finaleRate }),
  });

  // 5. wordmark
  const outro = narration('outro');
  out.push({ kind: 'outro', voice: outro, frames: toFrames(outro.duration + 3.2) });

  // every segment must outlast the two crossfades that overlap it
  for (const seg of out) seg.frames = Math.max(seg.frames, FADE * 2 + 1);

  const total = out.reduce((sum, seg) => sum + seg.frames, 0);
  return { segments: out, durationInFrames: total - FADE * (out.length - 1) };
}
