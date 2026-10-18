// 05 — Continuity. On the downbeat the thread contracts into the mark (thread, live agent, next agent), the
// wordmark rises beside it, then the camera pushes through the "next agent" square into scene 06.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { DotField } from '../DotField';
import { Label } from '../kit';
import { C, ease, keys, sans, tw } from '../theme';
import { S05 } from '../timing';

const K = 13; // mark scale: the 26×12 logo at 13× is 338 × 156
const WORD = 'Continuity';
const DROP = [
  { x: 960, y: 540, at: S05.mark, strength: 18, speed: 1700, width: 80, decay: 0.8, signal: true },
  { x: 960, y: 540, at: S05.mark + 8, strength: 7, speed: 1100, width: 50, decay: 0.6 },
];

export const S05Title: React.FC = () => {
  const f = useCurrentFrame();

  // 1) the line contracts to the mark's width; Agent B shrinks into the live square; the next square appears
  const c = tw(f, S05.mark, S05.mark + 26, 0, 1, ease.out);
  // 2) the mark slides left to make room for the wordmark
  const slide = tw(f, S05.word + 10, S05.word + 54, 0, 1, ease.inOut);
  const markW = 26 * K;
  const lockW = markW + 56 + 890;
  const markX = keys(slide, [0, 1], [960 - markW / 2, 960 - lockW / 2], ease.linear);
  const cy = 540;

  const lineL = keys(c, [0, 1], [0, markX], ease.linear);
  const lineR = keys(c, [0, 1], [1920, markX + markW], ease.linear);
  const liveS = keys(c, [0, 1], [44, 6 * K], ease.linear);
  const liveX = keys(c, [0, 1], [960, markX + 7 * K], ease.linear);
  const nextP = tw(f, S05.mark + 12, S05.mark + 30, 0, 1, ease.out);
  const nextX = markX + 19 * K;

  // 3) push through the next-agent square
  const thru = tw(f, S05.through, S05.dur, 0, 1, ease.in);
  const zoom = Math.pow(80, thru);

  return (
    <AbsoluteFill style={{ background: C.paper, overflow: 'hidden' }}>
      {thru < 0.4 ? <DotField opacity={(0.5 + 0.5 * tw(f, 0, 30)) * (1 - thru / 0.4)} ripples={DROP} /> : null}
      <div style={{ position: 'absolute', inset: 0, transformOrigin: `${nextX}px ${cy}px`, transform: `scale(${zoom})` }}>
        <div style={{ position: 'absolute', left: lineL, top: cy - (1.25 * K) / 2, width: lineR - lineL, height: 1.25 * K, background: C.ink }} />
        <div style={{ position: 'absolute', left: liveX - liveS / 2, top: cy - liveS / 2, width: liveS, height: liveS, background: C.signal }} />
        <div
          style={{
            position: 'absolute',
            left: nextX - (5 * K * nextP) / 2,
            top: cy - (5 * K * nextP) / 2,
            width: 5 * K * nextP,
            height: 5 * K * nextP,
            background: C.paper,
            boxShadow: `inset 0 0 0 ${1.1 * K * Math.min(1, nextP * 2)}px ${C.ink}`,
          }}
        />
        {/* the wordmark rises letter by letter */}
        <div
          style={{
            position: 'absolute',
            left: markX + markW + 56,
            top: cy - 112,
            fontFamily: sans,
            fontWeight: 600,
            fontSize: 196,
            lineHeight: 1,
            letterSpacing: '-0.055em',
            color: C.ink,
            display: 'flex',
          }}
        >
          {WORD.split('').map((ch, i) => {
            const p = tw(f, S05.word + 14 + i * 2.2, S05.word + 14 + i * 2.2 + 30, 0, 1, ease.out);
            return (
              <span key={i} style={{ display: 'inline-block', overflow: 'hidden', paddingBottom: 30, marginBottom: -30 }}>
                <span style={{ display: 'inline-block', transform: `translateY(${(1 - p) * 110}%)`, filter: p < 0.95 ? `blur(${(1 - p) * 5}px)` : undefined }}>{ch}</span>
              </span>
            );
          })}
        </div>
        <div style={{ position: 'absolute', left: markX + markW + 66, top: cy + 116, opacity: tw(f, S05.tag, S05.tag + 20) }}>
          <Label size={22} color={C.muted}>
            The communication-state engine for agents
          </Label>
        </div>
      </div>
    </AbsoluteFill>
  );
};
