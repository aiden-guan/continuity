// 02 — SIGKILL. Opens on the push-in from scene 01 (Agent A at 16×), `kill -9`, then flash cuts on sixteenths
// (after @AmirMushich's human cut), then a dead stop: an empty thread and a hollow square.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { DotField } from '../DotField';
import { Agent, Label, Rise, Typed } from '../kit';
import { C, ease, mono, rand, sans, tw } from '../theme';
import { S02 } from '../timing';

const BIG = 448; // Agent A at the end of scene 01's push (28 px × 16)
const LINE = 32;

const KILL_RIPPLES = [
  { x: 960, y: 540, at: S02.stop, strength: 22, speed: 1500, width: 90, decay: 0.9 },
  { x: 960, y: 540, at: S02.stop + 10, strength: 8, speed: 900, width: 60, decay: 0.7 },
];

const bayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Agent A as a Bayer-dithered block: cells drop out as `t` falls. */
const Dithered: React.FC<{ size: number; t: number; color?: string }> = ({ size, t, color = C.signal }) => {
  const n = 24;
  const cell = size / n;
  const cells: React.ReactNode[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const th = (bayer4[(j % 4) * 4 + (i % 4)] + 0.5) / 16;
      const edge = Math.hypot(i - n / 2, j - n / 2) / (n * 0.7);
      if (th * 0.75 + edge * 0.35 < t) cells.push(<div key={`${i}-${j}`} style={{ position: 'absolute', left: i * cell, top: j * cell, width: cell + 0.5, height: cell + 0.5, background: color }} />);
    }
  return <div style={{ position: 'relative', width: size, height: size }}>{cells}</div>;
};

/** Agent A cut into horizontal slices that slip sideways. */
const Sliced: React.FC<{ size: number; seed: number; color?: string; bg?: string }> = ({ size, seed, color = C.signal, bg }) => {
  const n = 7;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      {Array.from({ length: n }).map((_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: (rand(`sl${seed}-${i}`) - 0.5) * size * 0.55,
            top: (i * size) / n,
            width: size,
            height: size / n - (i % 3 === 1 ? 6 : 0),
            background: color,
            outline: bg ? `2px solid ${bg}` : undefined,
          }}
        />
      ))}
    </div>
  );
};

const Center: React.FC<{ children: React.ReactNode; bg: string; dx?: number; dy?: number; s?: number }> = ({ children, bg, dx = 0, dy = 0, s = 1 }) => (
  <AbsoluteFill style={{ background: bg, alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ transform: `translate(${dx}px, ${dy}px) scale(${s})` }}>{children}</div>
  </AbsoluteFill>
);

const Thread: React.FC<{ color: string; h?: number }> = ({ color, h = 2 }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 540 - h / 2, height: h, background: color }} />
);

const flash = (k: number, f: number): React.ReactNode => {
  const jx = (rand(`jx${k}`) - 0.5) * 60;
  const jy = (rand(`jy${k}`) - 0.5) * 40;
  const huge = { fontFamily: sans, fontWeight: 700, letterSpacing: '-0.06em', lineHeight: 0.8 } as const;
  switch (k) {
    case 0:
      return (
        <Center bg={C.ink} dx={jx}>
          <div style={{ ...huge, fontSize: 400, color: C.paper }}>SIGKILL</div>
        </Center>
      );
    case 1:
      return (
        <AbsoluteFill style={{ background: C.paper }}>
          <Thread color={C.ink} h={LINE} />
          <Center bg="transparent" dx={jx}>
            <Sliced size={BIG} seed={k} />
          </Center>
        </AbsoluteFill>
      );
    case 2:
      return (
        <Center bg={C.signal} dy={jy}>
          <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 210, color: C.paper, letterSpacing: '-0.02em' }}>pid 48121</div>
        </Center>
      );
    case 3:
      return (
        <AbsoluteFill style={{ background: C.paper }}>
          <Thread color={C.ink} h={LINE * 0.6} />
          <Center bg="transparent">
            <Dithered size={BIG} t={0.78} />
          </Center>
        </AbsoluteFill>
      );
    case 4:
      return (
        <Center bg={C.ink} dx={jx}>
          <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 240, color: C.paper, letterSpacing: '-0.03em' }}>exit 137</div>
        </Center>
      );
    case 5:
      return (
        <Center bg={C.paper} dy={jy}>
          <div style={{ position: 'relative', fontFamily: mono, fontWeight: 500, fontSize: 250, color: C.ink, letterSpacing: '-0.03em' }}>
            agent-a
            <div style={{ position: 'absolute', left: -30, right: -30, top: '54%', height: 18, background: C.signal }} />
          </div>
        </Center>
      );
    case 6:
      return (
        <AbsoluteFill style={{ background: C.ink }}>
          <Thread color={C.paper} h={LINE * 0.4} />
          <Center bg="transparent" dx={jx}>
            <Sliced size={BIG * 0.8} seed={k} color={C.paper} />
          </Center>
        </AbsoluteFill>
      );
    case 7:
      return (
        <AbsoluteFill style={{ background: C.paper }}>
          <Thread color={C.ink} h={6} />
          <Center bg="transparent">
            <Dithered size={BIG * 0.7} t={0.45} />
          </Center>
        </AbsoluteFill>
      );
    case 8:
      return (
        <Center bg={C.ink} dx={jx} s={0.62}>
          <div style={{ ...huge, fontSize: 400, color: C.signal }}>SIGKILL</div>
        </Center>
      );
    case 9:
      return (
        <AbsoluteFill style={{ background: C.paper }}>
          <Thread color={C.ink} h={4} />
          <Center bg="transparent">
            <Dithered size={BIG * 0.4} t={0.3} />
          </Center>
        </AbsoluteFill>
      );
    case 10:
      return <AbsoluteFill style={{ background: C.signal }} />;
    case 11:
      return (
        <AbsoluteFill style={{ background: C.ink }}>
          <Thread color={C.paper} h={2} />
        </AbsoluteFill>
      );
    default:
      return (
        <AbsoluteFill style={{ background: C.paper }}>
          <Thread color={C.ink} h={2} />
          <Center bg="transparent">
            <Agent size={40} state="next" />
          </Center>
        </AbsoluteFill>
      );
  }
};

export const S02Sigkill: React.FC = () => {
  const f = useCurrentFrame();

  // flash cuts
  if (f >= S02.enter && f < S02.stop) {
    let k = 0;
    for (let i = 0; i < S02.cuts.length; i++) if (f >= S02.cuts[i]) k = i;
    return <AbsoluteFill>{flash(k, f)}</AbsoluteFill>;
  }

  // before: Agent A, huge, alive; the command types in
  if (f < S02.enter) {
    const breathe = 1 + Math.sin(f / 5) * 0.004;
    return (
      <AbsoluteFill style={{ background: C.paper }}>
        <Thread color={C.ink} h={LINE} />
        <Center bg="transparent" s={breathe * (1 + f * 0.0012)}>
          <Agent size={BIG} state="live" />
        </Center>
        <div style={{ position: 'absolute', left: 160, top: 170, fontFamily: mono, fontWeight: 500, fontSize: 64, color: C.ink, letterSpacing: '-0.01em' }}>
          <span style={{ color: C.muted }}>$ </span>
          <Typed text="kill -9 48121" at={S02.type} cps={30} />
        </div>
        <div style={{ position: 'absolute', left: 160, top: 250, opacity: tw(f, 0, 10) }}>
          <Label size={22} color={C.muted}>
            agent-a · pid 48121 · alive · 3 messages in memory
          </Label>
        </div>
      </AbsoluteFill>
    );
  }

  // after: stillness. A hollow square where Agent A was, its last pixels falling away.
  const l = f - S02.stop;
  const settle = tw(f, S02.stop, S02.stop + 50, 0, 1, ease.out);
  const out = tw(f, S02.out, S02.dur, 0, 1, ease.in);
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <DotField opacity={0.35 + settle * 0.6} ripples={KILL_RIPPLES} />
      <Thread color={C.ink} h={2} />
      {Array.from({ length: 26 }).map((_, i) => {
        const r1 = rand(`ash${i}`);
        const r2 = rand(`ash-b${i}`);
        const delay = r1 * 30;
        const t = Math.max(0, l - delay);
        const y = 540 + 6 + t * t * 0.012 * (0.6 + r2) + t * 0.4;
        const x = 960 + (r1 - 0.5) * 36 + Math.sin(t / 14 + i) * 3;
        const o = Math.max(0, 1 - t / (70 + r2 * 60));
        const s = 3 + Math.floor(r2 * 3) * 2;
        return <div key={i} style={{ position: 'absolute', left: x, top: y, width: s, height: s, background: C.signal, opacity: o }} />;
      })}
      <div style={{ position: 'absolute', left: 960 - 20, top: 540 - 20 }}>
        <Agent size={40} state="dead" />
      </div>
      <div style={{ position: 'absolute', left: 960 - 20, top: 540 + 44, opacity: tw(f, S02.stop + 16, S02.stop + 40) }}>
        <Label size={15} color={C.muted}>
          agent-a · killed · exit 137
        </Label>
      </div>
      <div style={{ position: 'absolute', left: 118, top: 700, opacity: 1 - out }}>
        <Rise text="Then it dies." at={S02.headline} size={150} />
      </div>
      <div style={{ position: 'absolute', left: 122, top: 880, opacity: tw(f, S02.headline + 30, S02.headline + 50) * (1 - out) }}>
        <Label size={20} color={C.muted}>
          No warning. No notes. Nothing running.
        </Label>
      </div>
    </AbsoluteFill>
  );
};
