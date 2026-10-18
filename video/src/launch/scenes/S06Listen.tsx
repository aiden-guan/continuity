// 06 — Listen. The supplier's correction (ev_6) as the product shows mail: monospace. A read head passes down it,
// then tracking boxes (after @mnowakdesign) lock onto each phrase that matters and leader lines carry what was
// understood out to the right. Ends on a whip to the right.
import React from 'react';
import { AbsoluteFill, interpolateColors, useCurrentFrame } from 'remotion';
import { Camera, Card, Chip, DotGrid, Label, MotionBlur, Rise, SectionKey, TrackBox } from '../kit';
import { C, ease, keys, mono, tw } from '../theme';
import { S06 } from '../timing';

const FS = 34; // email type size; Geist Mono advances 0.6em
const CW = FS * 0.6;
const LH = FS * 1.62;

// the email, broken where the product would wrap it so that no tracked phrase spans two lines
const LINES = [
  'Hi again,',
  '',
  'Correction to my earlier email:',
  'only 300 units can arrive Friday. The other',
  '200 won’t arrive until Wednesday, Oct 28 —',
  'our second production lot slipped.',
  'Pricing is unchanged.',
  'I’ll send a revised quote by tomorrow.',
];

type Phrase = { line: number; text: string; key: string; color: string; row: React.ReactNode };
const PHRASES: Phrase[] = [
  {
    line: 2,
    text: 'Correction',
    key: 'act · explicit correction',
    color: C.ink,
    row: (
      <>
        <b>act</b>
        <span>corrects ev_3 · supplier</span>
      </>
    ),
  },
  {
    line: 3,
    text: 'only 300 units can arrive Friday.',
    key: 'delivery.schedule',
    color: C.ink,
    row: (
      <>
        <b>delivery</b>
        <span>300 units · Fri Oct 23</span>
      </>
    ),
  },
  {
    line: 4,
    text: '200 won’t arrive until Wednesday, Oct 28',
    key: 'delivery.schedule · late',
    color: C.signal,
    row: (
      <>
        <b style={{ color: C.signal }}>delivery</b>
        <span style={{ color: C.signalInk }}>200 units · Wed Oct 28</span>
      </>
    ),
  },
  {
    line: 6,
    text: 'Pricing is unchanged.',
    key: 'price.unit',
    color: C.ink,
    row: (
      <>
        <b>price</b>
        <span>$11.40 · unchanged</span>
      </>
    ),
  },
  {
    line: 7,
    text: 'I’ll send a revised quote by tomorrow.',
    key: 'commitment · supplier → us',
    color: C.ink,
    row: (
      <>
        <b>owed</b>
        <span>revised quote · due Wed</span>
      </>
    ),
  },
];

const CARD_X = 120;
const CARD_Y = 196;
const BODY_X = CARD_X + 34; // card padding + border
const BODY_Y = CARD_Y + 92; // header block
const COL_X = 1300;
const rowY = (i: number) => 262 + i * 96;

export const S06Listen: React.FC = () => {
  const f = useCurrentFrame();

  const whip = tw(f, S06.whip, S06.dur, 0, 1, ease.in);
  const settle = tw(f, 0, 40, 0, 1, ease.out);
  const camS = (1.12 - 0.12 * settle) * (1 + tw(f, 40, S06.whip, 0, 0.035, ease.linear));
  const camX = 960 + tw(f, 40, S06.whip, 0, 30, ease.linear) + whip * whip * 1800;
  const blur = Math.min(60, whip * whip * 90);

  // the read head moves down the body; each line darkens as it passes
  const scanY = keys(f, [S06.scan, S06.scan + 84], [-20, LINES.length * LH + 10], ease.inOut);

  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <MotionBlur id="s06blur" x={blur} />
      <Camera x={camX} y={540} s={camS} style={{ filter: blur > 0.5 ? 'url(#s06blur)' : undefined }}>
        <DotGrid step={24} opacity={0.9} />

        <div style={{ position: 'absolute', left: CARD_X, top: CARD_Y, opacity: tw(f, 0, 16), filter: f < 16 ? `blur(${(1 - tw(f, 0, 16)) * 10}px)` : undefined }}>
          <Card title="← Supplier · Dana Ruiz" meta="ev_6 · Tue 20 Oct 10:12 · Re: RFQ: 500 × AX-200" width={1040} pad={20} scale={1.5}>
            <div style={{ position: 'relative', height: LINES.length * LH, fontFamily: mono, fontSize: FS, lineHeight: `${LH}px`, whiteSpace: 'pre' }}>
              {LINES.map((l, i) => {
                const passed = tw(scanY, i * LH + LH * 0.2, i * LH + LH * 0.9, 0, 1, ease.linear);
                return (
                  <div key={i} style={{ color: interpolateColors(passed, [0, 1], [C.faint, C.ink]) }}>
                    {l || ' '}
                  </div>
                );
              })}
              {f > S06.scan - 2 && f < S06.scan + 92 ? (
                <div style={{ position: 'absolute', left: -14, right: -14, top: scanY, height: 2, background: C.signal, boxShadow: `0 -26px 30px -6px ${C.signalBg}` }} />
              ) : null}
            </div>
          </Card>
        </div>

        {/* tracking boxes, in the body's character grid */}
        {PHRASES.map((p, i) => {
          const col = LINES[p.line].indexOf(p.text);
          return (
            <TrackBox
              key={i}
              x={BODY_X + col * CW - 8}
              y={BODY_Y + p.line * LH + 4}
              w={p.text.length * CW + 16}
              h={LH - 10}
              at={S06.locks[i]}
              color={p.color}
              tag={String(i + 1).padStart(2, '0')}
              tagSide="left"
            />
          );
        })}

        {/* leader lines out to what was understood */}
        <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          {PHRASES.map((p, i) => {
            const col = LINES[p.line].indexOf(p.text);
            const x0 = BODY_X + (col + p.text.length) * CW + 14;
            const y0 = BODY_Y + p.line * LH + LH / 2 - 1;
            const x1 = COL_X - 24;
            const y1 = rowY(i) + 22;
            const xm = 1240 + i * 10;
            const len = x1 - x0 + Math.abs(y1 - y0) + 40;
            const d = tw(f, S06.locks[i] + 8, S06.locks[i] + 30, 0, 1, ease.inOut);
            return (
              <g key={i} opacity={d > 0 ? 1 : 0}>
                <path
                  d={`M${x0} ${y0} H${xm} L${xm + 30} ${y1} H${x1}`}
                  fill="none"
                  stroke={p.color}
                  strokeWidth={1.5}
                  strokeDasharray={len}
                  strokeDashoffset={len * (1 - d)}
                />
                <circle cx={x0} cy={y0} r={4} fill={p.color} />
                <rect x={x1 - 4} y={y1 - 4} width={8} height={8} fill={C.paper} stroke={p.color} strokeWidth={1.5} opacity={d > 0.95 ? 1 : 0} />
              </g>
            );
          })}
        </svg>

        <div style={{ position: 'absolute', left: COL_X, top: rowY(0) - 70, opacity: tw(f, S06.locks[0], S06.locks[0] + 20) }}>
          <Label size={16} color={C.muted}>
            Understood · ev_6
          </Label>
        </div>
        {PHRASES.map((p, i) => {
          const a = tw(f, S06.locks[i] + 24, S06.locks[i] + 44, 0, 1, ease.out);
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: COL_X,
                top: rowY(i),
                width: 500,
                display: 'grid',
                gridTemplateColumns: '40px 104px 1fr',
                alignItems: 'baseline',
                gap: 14,
                padding: '10px 0 12px',
                borderBottom: `1px solid ${C.line2}`,
                fontFamily: mono,
                fontSize: 22,
                color: C.ink,
                opacity: a,
                transform: `translateX(${(1 - a) * -16}px)`,
              }}
            >
              <span style={{ fontSize: 15, color: p.color === C.signal ? C.signal : C.muted }}>{String(i + 1).padStart(2, '0')}</span>
              {p.row}
            </div>
          );
        })}
        <div style={{ position: 'absolute', left: COL_X, top: rowY(5) + 18, opacity: tw(f, S06.locks[4] + 50, S06.locks[4] + 70) }}>
          <Chip tone="ink" size={17}>
            authority ✓ supplier may set delivery.* and price.*
          </Chip>
        </div>
      </Camera>

      <SectionKey n="01" t="Listen" at={4} out={S06.whip - 10} style={{ left: 122, top: 118 }} />
      <div style={{ position: 'absolute', left: 118, top: 840, opacity: 1 - whip }}>
        <Rise text="Every email becomes *evidence.*" at={S06.headline} size={104} />
      </div>
    </AbsoluteFill>
  );
};
