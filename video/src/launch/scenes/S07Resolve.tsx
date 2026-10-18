// 07 — Resolve. Part A: the state diff builds itself in place (after @pitus_'s live UI): the line strikes through the
// superseded delivery term, the new term lands, the hard requirement fails, a commitment opens, the quote goes
// partially stale, and the next actor flips — v28 → v33. Part B: the panel tilts into an exploded stack of the
// stores behind it (after the Replay film), labelled with leader lines. It collapses into scene 08's briefing.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Card, Chip, Cross, DotGrid, Label, MotionBlur, Rise, Roll, SectionKey, Tick } from '../kit';
import { C, ease, keys, mono, sans, tw } from '../theme';
import { S07 } from '../timing';

const [STRIKE, ADD, CONFLICT, OWED, STALE, NEXT] = S07.steps;

// ---------------------------------------------------------------- part A: the diff

const Row: React.FC<{ at: number; mark: React.ReactNode; k: string; children: React.ReactNode; tint?: string; base?: boolean }> = ({ at, mark, k, children, tint, base }) => {
  const f = useCurrentFrame();
  const p = base ? 1 : tw(f, at, at + 26, 0, 1, ease.out);
  const flash = tint ? tw(f, at, at + 10, 0, 1, ease.out) * (1 - tw(f, at + 30, at + 80, 0, 0.6, ease.inOut)) : 0;
  return (
    <div style={{ height: 70 * p, overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '34px 150px 1fr',
          alignItems: 'center',
          gap: 14,
          height: 70,
          padding: '0 12px',
          margin: '0 -12px',
          borderRadius: 8,
          background: tint ? `rgba(226, 80, 29, ${0.1 * flash})` : undefined,
          opacity: p,
          transform: `translateX(${(1 - p) * -14}px)`,
        }}
      >
        <span style={{ fontFamily: mono, fontWeight: 500, fontSize: 26, color: C.muted, textAlign: 'center' }}>{mark}</span>
        <span style={{ fontFamily: mono, fontSize: 21, color: C.muted }}>{k}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontFamily: sans, fontWeight: 500, fontSize: 31, color: C.ink, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{children}</div>
      </div>
    </div>
  );
};

const Diff: React.FC = () => {
  const f = useCurrentFrame();
  const strike = tw(f, STRIKE, STRIKE + 26, 0, 1, ease.inOut);
  const nextFlip = tw(f, NEXT, NEXT + 22, 0, 1, ease.out);
  return (
    <Card
      title="State"
      meta={
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          PO-4817 ·{' '}
          <Roll
            frames={[
              [0, 'v28'],
              [STRIKE, 'v29'],
              [ADD, 'v30'],
              [CONFLICT, 'v31'],
              [OWED, 'v32'],
              [STALE, 'v33'],
            ]}
          />
        </span>
      }
      width={1180}
      pad={22}
      scale={1.5}
    >
      <Row at={0} base mark=" " k="price">
        <span style={{ color: C.ink2 }}>$11.40 / unit</span>
        <Chip tone="muted" size={17}>
          unchanged
        </Chip>
      </Row>
      <Row at={0} base mark=" " k="budget">
        <span style={{ color: C.ink2 }}>≤ $11.50 / unit</span>
        <Chip tone="ok" size={17}>
          <Tick size={15} p={1} /> approved · ev_5
        </Chip>
      </Row>
      <Row at={0} base mark={<span style={{ opacity: strike }}>−</span>} k="delivery">
        <span style={{ position: 'relative', color: strike > 0.5 ? C.muted : C.ink }}>
          500 units Fri Oct 23
          <span style={{ position: 'absolute', left: -4, top: '56%', height: 3, width: `calc(${strike * 100}% + 8px)`, background: C.signal }} />
        </span>
        <Chip tone="muted" size={17}>
          <span style={{ opacity: tw(f, STRIKE + 16, STRIKE + 30) }}>superseded</span>
        </Chip>
      </Row>
      <Row at={ADD} mark="+" k="delivery">
        300 Fri Oct 23 · 200 Wed Oct 28
        <Chip tone="ink" size={17}>
          ev_6
        </Chip>
      </Row>
      <Row at={CONFLICT} mark={<Cross size={22} p={tw(f, CONFLICT + 4, CONFLICT + 20)} />} k="check" tint={C.signal}>
        <span style={{ color: C.signalInk }}>All units by Fri Oct 23</span>
        <Chip tone="solid" size={17}>
          conflict
        </Chip>
      </Row>
      <Row at={OWED} mark="+" k="owed">
        supplier → revised quote
        <Chip tone="signal" size={17}>
          open
        </Chip>
      </Row>
      <Row at={STALE} mark="~" k="document">
        Q-2291.pdf
        <Chip tone="signal" size={17}>
          partially stale · delivery
        </Chip>
      </Row>
      <Row at={0} base mark="→" k="next">
        <span style={{ display: 'inline-grid', overflow: 'hidden' }}>
          <span style={{ gridArea: '1/1', transform: `translateY(${-nextFlip * 100}%)`, opacity: 1 - nextFlip }}>
            <b style={{ fontWeight: 600 }}>Us.</b> Accept the order.
          </span>
          <span style={{ gridArea: '1/1', transform: `translateY(${(1 - nextFlip) * 100}%)` }}>
            <b style={{ fontWeight: 600, color: C.signal }}>Us.</b> Raise it with the supplier.
          </span>
        </span>
      </Row>
    </Card>
  );
};

// ---------------------------------------------------------------- part B: the stack

const LAYERS: { name: string; note: string; rows: [string, string, 'ok' | 'bad' | 'old' | 'open' | ''][] }[] = [
  {
    name: '01 Events',
    note: 'append-only · 5',
    rows: [
      ['ev_1  → supplier', 'RFQ · Mon 08:55', ''],
      ['ev_2  → finance', 'budget request · 08:55', ''],
      ['ev_3  ← supplier', 'quote + Q-2291.pdf · 11:20', ''],
      ['ev_5  ← finance', 'approved · 15:05', ''],
      ['ev_6  ← supplier', 'correction · Tue 10:12', 'open'],
    ],
  },
  {
    name: '02 Claims',
    note: '1 superseded',
    rows: [
      ['delivery', '500 units Fri Oct 23', 'old'],
      ['delivery', '300 Fri · 200 Wed Oct 28', 'open'],
      ['price.unit', '$11.40 · email + PDF', ''],
      ['payment', 'Net 30 · PDF', ''],
      ['budget', '≤ $11.50 · finance', 'ok'],
    ],
  },
  {
    name: '03 Obligations',
    note: '1 open',
    rows: [
      ['us → supplier', 'confirm by Fri? · answered', 'ok'],
      ['us → supplier', 'send a quote · answered', 'ok'],
      ['us → finance', 'approve budget · answered', 'ok'],
      ['supplier → us', 'revised quote · open', 'open'],
    ],
  },
  {
    name: '04 Checks',
    note: '1 failing',
    rows: [
      ['all by Fri Oct 23', '200 arrive Wed Oct 28', 'bad'],
      ['quantity 500', '500 offered', 'ok'],
      ['price ≤ $11.50', '$11.40', 'ok'],
      ['budget approved', 'ev_5', 'ok'],
    ],
  },
];
const TOP = { name: '05 State', note: 'what an agent reads' };
const ALL = [...LAYERS.map((l) => ({ name: l.name, note: l.note })), TOP];

const PW = 1180;
const PH = 690;
const RX = 56; // tilt back
const STACK_S = 0.52;

/** Project a point on a layer (plane coords from its centre, height z) the way CSS will, so labels can find it. */
const project = (px: number, py: number, z: number, rx: number, rz: number, s: number, cx: number, cy: number, d: number) => {
  const a = (rx * Math.PI) / 180;
  const b = (rz * Math.PI) / 180;
  // rotateZ first, then rotateX (CSS applies the right-most transform first); scale is outermost
  const x1 = px * Math.cos(b) - py * Math.sin(b);
  const y1 = px * Math.sin(b) + py * Math.cos(b);
  const y2 = y1 * Math.cos(a) - z * Math.sin(a);
  const z2 = y1 * Math.sin(a) + z * Math.cos(a);
  const k = d / (d - z2 * s);
  return { x: cx + x1 * s * k, y: cy + y2 * s * k };
};

const Stack: React.FC = () => {
  const f = useCurrentFrame();
  const tilt = tw(f, S07.explode, S07.explode + 60, 0, 1, ease.inOut);
  const gap = tw(f, S07.explode + 24, S07.explode + 96, 0, 1, ease.out) * (1 - tw(f, S07.collapse, S07.dur - 8, 0, 1, ease.inOut));
  const flat = tw(f, S07.collapse + 4, S07.dur, 0, 1, ease.inOut);
  const rz = keys(f, [S07.explode, S07.explode + 60, S07.collapse], [0, -34, -28], ease.inOut);
  const rx = RX * tilt * (1 - flat);
  const rzz = rz * (1 - flat);
  const drift = tw(f, 20, S07.explode, 0, 1, ease.linear);
  const cx = keys(f, [S07.explode, S07.explode + 60, S07.collapse, S07.dur], [960, 1190, 1210, 960], ease.inOut);
  const cy = keys(f, [S07.explode, S07.explode + 60, S07.collapse, S07.dur], [513, 380, 370, 560], ease.inOut);
  const d = 2600;
  const sA = 1 + drift * 0.03;
  const s = keys(tilt, [0, 1], [sA, STACK_S], ease.linear) * keys(flat, [0, 1], [1, 0.9 / STACK_S], ease.linear);
  const Z = 290 * gap;

  return (
    <>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, perspective: d, perspectiveOrigin: `${cx}px ${cy}px` }}>
        <div
          style={{
            position: 'absolute',
            left: cx - PW / 2,
            top: cy - PH / 2,
            width: PW,
            height: PH,
            transformStyle: 'preserve-3d',
            transform: `scale(${s}) rotateX(${rx}deg) rotateZ(${rzz}deg)`,
          }}
        >
          {LAYERS.map((L, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                inset: 0,
                transform: `translateZ(${i * Z - LAYERS.length * Z}px)`,
                background: ['#ebe9e3', '#efede8', '#f3f2ee', '#f7f6f3'][i],
                border: `2px solid ${C.line2}`,
                borderRadius: 15,
                boxShadow: `0 30px 60px -30px rgba(40,32,20,${0.22 * gap})`,
                padding: '34px 40px',
                opacity: gap > 0.01 ? 1 : 0,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: mono, fontWeight: 500, fontSize: 24, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.muted, borderBottom: `1.5px solid ${C.line}`, paddingBottom: 16 }}>
                <span style={{ color: C.ink }}>{L.name}</span>
                <span>{L.note}</span>
              </div>
              {L.rows.map((r, j) => (
                <div key={j} style={{ display: 'grid', gridTemplateColumns: '30px 330px 1fr', gap: 12, alignItems: 'center', padding: '17px 0', borderBottom: `1px solid ${C.line}`, fontFamily: mono, fontSize: 26, color: C.ink2 }}>
                  <span style={{ width: 14, height: 14, background: r[2] === 'bad' || r[2] === 'open' ? C.signal : r[2] === 'ok' ? C.ok : r[2] === 'old' ? C.faint : C.ink }} />
                  <span>{r[0]}</span>
                  <span style={{ textDecoration: r[2] === 'old' ? 'line-through' : undefined, textDecorationColor: C.signal, color: r[2] === 'bad' ? C.signalInk : r[2] === 'old' ? C.muted : C.ink }}>{r[1]}</span>
                </div>
              ))}
            </div>
          ))}
          {/* the top sheet is the state view itself */}
          <div style={{ position: 'absolute', left: 0, top: 0, width: PW }}>
            <Diff />
          </div>
        </div>
      </div>

      {/* leader-line labels, in screen space */}
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        {ALL.map((L, i) => {
          const at = S07.labels + (ALL.length - 1 - i) * 8;
          const p = tw(f, at, at + 26, 0, 1, ease.inOut) * (1 - tw(f, S07.collapse - 16, S07.collapse + 4, 0, 1, ease.in));
          if (p <= 0) return null;
          const z = i * Z - LAYERS.length * Z;
          const a = project(PW / 2 - 30, -PH / 2 + 30, z, rx, rzz, s, cx, cy, d);
          const x1 = 1560;
          return (
            <g key={i} opacity={Math.min(1, p * 2)}>
              <circle cx={a.x} cy={a.y} r={5} fill={i === 3 ? C.signal : C.ink} />
              <line x1={a.x} y1={a.y} x2={a.x + (x1 - a.x) * p} y2={a.y} stroke={i === 3 ? C.signal : C.ink} strokeWidth={1.4} />
            </g>
          );
        })}
      </svg>
      {ALL.map((L, i) => {
        const at = S07.labels + (ALL.length - 1 - i) * 8;
        const p = tw(f, at + 14, at + 34, 0, 1, ease.out) * (1 - tw(f, S07.collapse - 16, S07.collapse + 4, 0, 1, ease.in));
        const z = i * Z - LAYERS.length * Z;
        const a = project(PW / 2 - 30, -PH / 2 + 30, z, rx, rzz, s, cx, cy, d);
        return (
          <div key={i} style={{ position: 'absolute', left: 1576, top: a.y - 12, opacity: p, transform: `translateX(${(1 - p) * 12}px)`, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Label size={18} color={C.ink}>
              {L.name}
            </Label>
            <Label size={16} color={i === 3 ? C.signal : C.muted}>
              {L.note}
            </Label>
          </div>
        );
      })}
    </>
  );
};

export const S07Resolve: React.FC = () => {
  const f = useCurrentFrame();
  const whipIn = 1 - tw(f, 0, 26, 0, 1, ease.out);
  const blur = whipIn * whipIn * 70;

  return (
    <AbsoluteFill style={{ background: C.paper, overflow: 'hidden' }}>
      <MotionBlur id="s07blur" x={blur} />
      <div style={{ position: 'absolute', inset: 0, transform: `translateX(${whipIn * 1500}px)`, filter: blur > 0.5 ? 'url(#s07blur)' : undefined }}>
        <DotGrid step={24} opacity={0.9} />
        <Stack />
      </div>

      <SectionKey n="02" t="Resolve" at={6} out={S07.collapse - 20} style={{ left: 122, top: 118 }} />
      <div style={{ position: 'absolute', left: 118, top: 700 }}>
        <Rise text="Evidence|becomes *state.*" at={S07.headline} out={S07.collapse - 30} size={128} />
      </div>
    </AbsoluteFill>
  );
};
