// 11 — Results (after @Varcyyyy's giant numerals). To scale: 1,134 squares, each one a 2,442-token briefing, are what
// it takes to reread 267 messages. They collapse into one. Then the cold-handoff scores fill in on sixteenths.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { DotField } from '../DotField';
import { Label, Rise, SectionKey } from '../kit';
import { C, ease, fmtInt, keys, mono, rand, sans, tw } from '../theme';
import { S11 } from '../timing';

const COLS = 54;
const ROWS = 21; // 54 × 21 = 1,134
const PITCH = 26;
const SQ = 17;
const FX = 960 - (COLS * PITCH) / 2;
const FY = 382;
const TARGET = { x: 960, y: FY + (ROWS * PITCH) / 2 };

const PULLS = [{ x: TARGET.x, y: TARGET.y, from: S11.implode, to: S11.landed + 6, strength: 70 }];
const LANDED = [{ x: TARGET.x, y: TARGET.y, at: S11.landed, strength: 16, speed: 1500, width: 80, decay: 0.8, signal: true }];

const SCORES = [
  { who: 'Last 3 emails', n: 3, color: C.ink2, order: 0 },
  { who: 'Full transcript', n: 5, color: C.ink2, order: 1 },
  { who: 'Continuity', n: 6, color: C.signal, order: 2 },
];

export const S11Results: React.FC = () => {
  const f = useCurrentFrame();

  const count = keys(f, [S11.count, S11.count + 96], [0, 2769083], ease.out);
  const landed = f >= S11.landed;
  const partB = tw(f, S11.cells - 30, S11.cells - 6, 0, 1, ease.inOut);
  const headOut = tw(f, S11.cells - 40, S11.cells - 18, 0, 1, ease.in);

  const squares: React.ReactNode[] = [];
  if (f < S11.landed + 4) {
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        const x0 = FX + c * PITCH;
        const y0 = FY + r * PITCH;
        const wave = (c + r * 1.6) / (COLS + ROWS * 1.6);
        const a = tw(f, S11.field + wave * 46, S11.field + wave * 46 + 10, 0, 1, ease.out);
        const dist = Math.hypot(x0 - TARGET.x, y0 - TARGET.y) / 900;
        const t0 = S11.implode + (1 - dist) * 22 + rand(`im${i}`) * 10;
        const m = tw(f, t0, t0 + 26, 0, 1, ease.in);
        const x = x0 + (TARGET.x - SQ / 2 - x0) * m;
        const y = y0 + (TARGET.y - SQ / 2 - y0) * m;
        squares.push(
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: SQ * (1 - m * 0.5),
              height: SQ * (1 - m * 0.5),
              background: C.ink,
              opacity: a * (0.82 - m * 0.5),
              transform: `scale(${a})`,
            }}
          />,
        );
      }
  }
  const one = tw(f, S11.landed - 4, S11.landed + 12, 0, 1, ease.out);
  const oneOut = tw(f, S11.cells - 40, S11.cells - 16, 0, 1, ease.in);

  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <DotField opacity={0.75} pulls={PULLS} ripples={LANDED} />
      <SectionKey n="06" t="Results" at={4} style={{ left: 122, top: 118 }} />

      {/* part A: to scale */}
      <div style={{ opacity: 1 - headOut }}>
        <div style={{ position: 'absolute', left: 118, top: 160, display: 'flex', alignItems: 'baseline', gap: 28 }}>
          <div style={{ fontFamily: sans, fontWeight: 600, fontSize: 168, lineHeight: 1, letterSpacing: '-0.055em', color: landed ? C.signal : C.ink, fontVariantNumeric: 'tabular-nums' }}>
            {landed ? '2,442' : fmtInt(count)}
          </div>
          <Label size={22} color={landed ? C.ink : C.muted}>
            {landed ? 'tokens in the Continuity briefing' : 'tokens to reread 267 messages'}
          </Label>
        </div>
        {squares}
        <div
          style={{
            position: 'absolute',
            left: TARGET.x - 22,
            top: TARGET.y - 22,
            width: 44,
            height: 44,
            background: C.signal,
            transform: `scale(${one * (1 + 0.25 * tw(f, S11.landed, S11.landed + 6) * (1 - tw(f, S11.landed + 6, S11.landed + 30)))})`,
            opacity: 1 - oneOut,
          }}
        />
        <div style={{ position: 'absolute', left: TARGET.x + 44, top: TARGET.y - 12, opacity: tw(f, S11.landed + 10, S11.landed + 30) * (1 - oneOut) }}>
          <Label size={18} color={C.ink}>
            ← one briefing. Same answer.
          </Label>
        </div>
        <div style={{ position: 'absolute', left: 118, top: 852 }}>
          <Rise text="*1,134×* less context." at={S11.ratio} out={S11.cells - 44} size={110} />
        </div>
      </div>

      {/* part B: cold handoffs answered correctly */}
      <div style={{ position: 'absolute', left: 118, top: 300, opacity: partB }}>
        <Label size={20} color={C.muted}>
          Cold handoffs answered correctly · Claude agent · 6 scenarios
        </Label>
        {SCORES.map((s, row) => {
          const base = S11.cells + s.order * 6 * S11.cellGap;
          const done = f >= base + s.n * S11.cellGap;
          return (
            <div key={row} style={{ display: 'grid', gridTemplateColumns: '520px auto 1fr', alignItems: 'center', gap: 40, marginTop: row === 0 ? 50 : 34 }}>
              <span style={{ fontFamily: sans, fontWeight: 600, fontSize: 64, letterSpacing: '-0.04em', color: s.order === 2 ? C.ink : C.ink2 }}>{s.who}</span>
              <span style={{ display: 'flex', gap: 14 }}>
                {Array.from({ length: 6 }).map((_, k) => {
                  const on = k < s.n;
                  const t = base + k * S11.cellGap;
                  const p = tw(f, t, t + 10, 0, 1, ease.out);
                  return (
                    <span
                      key={k}
                      style={{
                        width: 92,
                        height: 92,
                        boxShadow: `inset 0 0 0 2px ${on ? s.color : C.line2}`,
                        background: on ? s.color : 'transparent',
                        opacity: on ? 0.15 + 0.85 * p : 1,
                        transform: `scale(${on ? 0.8 + 0.2 * p : 1})`,
                      }}
                    />
                  );
                })}
              </span>
              <span style={{ fontFamily: mono, fontWeight: 500, fontSize: 64, color: s.order === 2 ? C.signal : C.ink2, opacity: done ? 1 : 0.15, fontVariantNumeric: 'tabular-nums' }}>{s.n}/6</span>
            </div>
          );
        })}
        <div style={{ marginTop: 56, opacity: tw(f, S11.cells + 100, S11.cells + 130) }}>
          <Label size={16} color={C.muted} upper={false}>
            Graded by rubric on the first email each fresh agent sends. Token counts: eval/results/scale.json.
          </Label>
        </div>
      </div>
    </AbsoluteFill>
  );
};
