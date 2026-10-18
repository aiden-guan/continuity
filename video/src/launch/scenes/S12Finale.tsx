// 12 — Finale. The whole thread at once: three days, nine emails, three agents (one killed, two that never met it).
// "Agents forget. The thread doesn't." Then the line contracts into the mark, and the film ends on the lockup.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { DotField } from '../DotField';
import { Agent, Label, Rise } from '../kit';
import { C, ease, keys, mono, sans, tw } from '../theme';
import { S12 } from '../timing';

const Y = 640;
const EVENTS = [
  { x: 300, out: true, t: 'ev_1' },
  { x: 380, out: true, t: 'ev_2' },
  { x: 560, out: false, t: 'ev_3' },
  { x: 820, out: false, t: 'ev_5' },
  { x: 1080, out: false, t: 'ev_6' },
  { x: 1120, out: true, t: 'ev_7' },
  { x: 1440, out: false, t: 'ev_8' },
  { x: 1480, out: true, t: 'ev_9' },
];
const AGENTS = [
  { x: 640, state: 'dead' as const, label: 'agent-a · killed' },
  { x: 1160, state: 'next' as const, label: 'agent-b · 0 memories' },
  { x: 1520, state: 'next' as const, label: 'agent-c · 0 memories' },
];
const DAYS = [
  { x: 260, t: 'MON 19 OCT' },
  { x: 1000, t: 'TUE 20 OCT' },
  { x: 1400, t: 'WED 21 OCT' },
];

const K = 13;
const MARK_W = 26 * K;
const LOCK_W = MARK_W + 56 + 890;

export const S12Finale: React.FC = () => {
  const f = useCurrentFrame();
  const intro = tw(f, 0, 30, 0, 1, ease.out);
  const fadeStory = tw(f, S12.contract - 30, S12.contract, 0, 1, ease.in);
  const c = tw(f, S12.contract, S12.contract + 40, 0, 1, ease.inOut);

  // the thread contracts from the full width into the mark's line, then rises to the logo's centre line
  const markX = 960 - LOCK_W / 2;
  const ly = keys(c, [0, 1], [Y, 540], ease.linear);
  const lineL = keys(c, [0, 1], [0, markX], ease.linear);
  const lineR = keys(c, [0, 1], [1920, markX + MARK_W], ease.linear);
  const lineH = keys(c, [0, 1], [2, 1.25 * K], ease.linear);
  const live = tw(f, S12.contract + 24, S12.contract + 44, 0, 1, ease.out);
  const next = tw(f, S12.contract + 32, S12.contract + 52, 0, 1, ease.out);

  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <DotField opacity={0.75} ripples={[{ x: markX + 7 * K, y: 540, at: S12.contract + 24, strength: 16, speed: 1300, width: 90, decay: 1.1, signal: true }]} />

      {/* the story on one line */}
      <div style={{ position: 'absolute', inset: 0, opacity: intro * (1 - fadeStory) }}>
        {DAYS.map((d, i) => (
          <React.Fragment key={i}>
            <div style={{ position: 'absolute', left: d.x, top: Y + 18, width: 1, height: 16, background: C.muted }} />
            <div style={{ position: 'absolute', left: d.x + 10, top: Y + 20 }}>
              <Label size={14} color={C.muted}>
                {d.t}
              </Label>
            </div>
          </React.Fragment>
        ))}
        {EVENTS.map((e, i) => {
          const p = tw(f, 4 + i * 3, 18 + i * 3, 0, 1, ease.out);
          return <div key={i} style={{ position: 'absolute', left: e.x - 7, top: Y - 7, width: 14, height: 14, background: e.out ? C.ink : C.paper, boxShadow: e.out ? undefined : `inset 0 0 0 2px ${C.ink}`, transform: `scale(${p})` }} />;
        })}
        {AGENTS.map((a, i) => {
          const p = tw(f, 14 + i * 8, 34 + i * 8, 0, 1, ease.out);
          return (
            <div key={i} style={{ position: 'absolute', left: a.x - 16, top: Y - 82, opacity: p, transform: `translateY(${(1 - p) * 12}px)` }}>
              <Agent size={32} state={a.state} />
              <div style={{ position: 'absolute', left: 16, top: 32, width: 1, height: 34, background: C.line2 }} />
              <div style={{ position: 'absolute', left: 0, top: -30 }}>
                <Label size={14} color={a.state === 'dead' ? C.muted : C.ink}>
                  {a.label}
                </Label>
              </div>
            </div>
          );
        })}
        {/* the state, still live at the end of the line */}
        <div style={{ position: 'absolute', left: 1700 - 14, top: Y - 14, width: 28, height: 28, background: C.signal, transform: `scale(${tw(f, 40, 56, 0, 1, ease.out)})` }} />
        <div style={{ position: 'absolute', left: 1700 - 14, top: Y + 26, opacity: tw(f, 50, 70) }}>
          <Label size={14} color={C.ink}>
            state v55 · live
          </Label>
        </div>

        <div style={{ position: 'absolute', left: 118, top: 150 }}>
          <Rise text="Agents forget." at={S12.line1} size={150} />
        </div>
        <div style={{ position: 'absolute', left: 118, top: 300 }}>
          <Rise text="The thread doesn’t." at={S12.line2} size={150} color={C.signal} />
        </div>
      </div>

      {/* the line, then the mark */}
      <div style={{ position: 'absolute', left: lineL, top: ly - lineH / 2, width: lineR - lineL, height: lineH, background: C.ink }} />
      <div style={{ position: 'absolute', left: markX + 4 * K + 3 * K * (1 - live), top: 540 - 3 * K * live, width: 6 * K * live, height: 6 * K * live, background: C.signal }} />
      <div
        style={{
          position: 'absolute',
          left: markX + 19 * K - 2.5 * K * next,
          top: 540 - 2.5 * K * next,
          width: 5 * K * next,
          height: 5 * K * next,
          background: C.paper,
          boxShadow: `inset 0 0 0 ${1.1 * K * Math.min(1, next * 2)}px ${C.ink}`,
        }}
      />
      <div style={{ position: 'absolute', left: markX + MARK_W + 56, top: 540 - 112, fontFamily: sans, fontWeight: 600, fontSize: 196, lineHeight: 1, letterSpacing: '-0.055em', color: C.ink, display: 'flex' }}>
        {'Continuity'.split('').map((ch, i) => {
          const p = tw(f, S12.word + i * 2.2, S12.word + i * 2.2 + 30, 0, 1, ease.out);
          return (
            <span key={i} style={{ display: 'inline-block', overflow: 'hidden', paddingBottom: 30, marginBottom: -30 }}>
              <span style={{ display: 'inline-block', transform: `translateY(${(1 - p) * 110}%)` }}>{ch}</span>
            </span>
          );
        })}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 540 + 170, display: 'flex', justifyContent: 'center', opacity: tw(f, S12.by, S12.by + 24) }}>
        <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 22, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.muted }}>Built on Primitive</div>
      </div>
    </AbsoluteFill>
  );
};
