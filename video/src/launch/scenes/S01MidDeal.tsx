// 01 — Mid-deal. The line draws on; Agent A rides it; the first three emails drop onto it as evidence.
// Ends by punching into Agent A so scene 02 can open on it.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Agent, Camera, Card, Chip, DotGrid, Label, Rise, Tick } from '../kit';
import { C, ease, keys, mono, sans, tw } from '../theme';
import { S01 } from '../timing';

const Y = 600; // the thread, in world px
const EV_X = [760, 1320, 1880];

const cards = [
  {
    head: '→ Supplier',
    meta: 'ev_1 · 08:55',
    body: 'RFQ: 500 × AX-200 boards',
    sub: 'All 500 by Fri Oct 23 · send a quote',
    chip: <Chip tone="ink">open · question</Chip>,
  },
  {
    head: '→ Finance · thread #2',
    meta: 'ev_2 · 08:55',
    body: 'Budget up to $11.50 / unit?',
    sub: '500 units · $5,750 max',
    chip: <Chip tone="ink">open · waiting</Chip>,
  },
  {
    head: '← Supplier',
    meta: 'ev_3 · 11:20',
    body: '500 units Fri Oct 23 at $11.40',
    sub: 'Northwind-Quote-Q-2291.pdf',
    chip: (
      <Chip tone="ok">
        <Tick size={14} p={1} /> answered
      </Chip>
    ),
  },
];

export const S01MidDeal: React.FC = () => {
  const f = useCurrentFrame();

  // Agent A travels the thread, arriving at each send; after ev_3 it creeps on, waiting for finance.
  const ax = keys(f, [S01.agent, S01.ev[0], S01.ev[1], S01.ev[1] + 30, S01.push], [420, EV_X[0], EV_X[1], EV_X[1] + 60, EV_X[2] + 300], ease.inOut);

  // camera: a slow tracking move along the thread, then a punch into Agent A
  // opens tight on the line drawing itself, pulls back to the working scale, then punches in
  const push = tw(f, S01.push, S01.dur, 0, 1, ease.in);
  const centre = tw(f, S01.push - 6, S01.push + 34, 0, 1, ease.inOut);
  const camX0 = keys(f, [0, 70, S01.push], [560, 860, 1960], ease.inOut);
  const camX = camX0 + (ax - camX0) * centre;
  const camY0 = keys(f, [0, 70], [Y, 558], ease.inOut);
  const camY = camY0 + (Y - camY0) * centre;
  const camS = keys(f, [0, 76], [2.6, 1.42], ease.inOut) * (1 + push * push * 10.3);

  const draw = tw(f, S01.line, S01.line + 34, 0.04, 1, ease.out);
  const lineRight = 200 + draw * 6000;

  // inbound ev_3 arrives as a packet from the supplier's end of the line
  const packetX = keys(f, [S01.ev[2] - 26, S01.ev[2]], [EV_X[2] + 900, EV_X[2]], ease.out);
  const showPacket = f >= S01.ev[2] - 26 && f < S01.ev[2] + 2;

  const others = 1 - tw(f, S01.push, S01.push + 34, 0, 1, ease.in);

  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <Camera x={camX} y={camY} s={camS}>
        <div style={{ opacity: others }}>
          <DotGrid step={24} opacity={tw(f, 0, 30)} />
        </div>

        {/* ruler under the thread: the story clock */}
        <div style={{ opacity: others * tw(f, 10, 40) }}>
          {Array.from({ length: 60 }).map((_, i) => {
            const x = 280 + i * 60;
            const major = i % 8 === 0;
            return (
              <React.Fragment key={i}>
                <div style={{ position: 'absolute', left: x, top: Y + 10, width: 1, height: major ? 12 : 6, background: major ? C.muted : C.faint }} />
                {major ? (
                  <div style={{ position: 'absolute', left: x + 8, top: Y + 12, fontFamily: mono, fontSize: 13, color: C.muted, letterSpacing: '0.06em' }}>
                    {['MON 08:00', 'MON 09:00', 'MON 10:00', 'MON 11:00', 'MON 12:00', 'MON 13:00', 'MON 14:00', 'MON 15:00'][i / 8]}
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
        </div>

        {/* the thread */}
        <div style={{ position: 'absolute', left: -400, top: Y - 1, width: lineRight + 400, height: 2, background: C.ink }} />

        {/* evidence nodes and their cards */}
        {cards.map((c, i) => {
          const at = S01.ev[i];
          const pop = tw(f, at, at + 14, 0, 1, ease.out);
          const stem = tw(f, at + 2, at + 16, 0, 1, ease.out);
          const rise = tw(f, at + 8, at + 34, 0, 1, ease.out);
          const x = EV_X[i];
          const inbound = i === 2;
          return (
            <div key={i} style={{ opacity: others }}>
              <div
                style={{
                  position: 'absolute',
                  left: x - 7,
                  top: Y - 7,
                  width: 14,
                  height: 14,
                  background: inbound ? C.paper : C.ink,
                  boxShadow: inbound ? `inset 0 0 0 2px ${C.ink}` : undefined,
                  transform: `scale(${pop})`,
                }}
              />
              <div style={{ position: 'absolute', left: x, top: Y - 16 - 64 * stem, width: 1, height: 64 * stem, background: C.line2 }} />
              <div
                style={{
                  position: 'absolute',
                  left: x - 40,
                  top: Y - 80 - 196,
                  opacity: rise,
                  transform: `translateY(${(1 - rise) * 26}px)`,
                  filter: rise < 0.98 ? `blur(${(1 - rise) * 6}px)` : undefined,
                }}
              >
                <Card title={c.head} meta={c.meta} width={420} pad={18}>
                  <div style={{ fontFamily: sans, fontSize: 24, fontWeight: 500, color: C.ink, letterSpacing: '-0.01em' }}>{c.body}</div>
                  <div style={{ fontFamily: mono, fontSize: 14, color: C.muted, marginTop: 8 }}>{c.sub}</div>
                  <div style={{ marginTop: 14 }}>{c.chip}</div>
                </Card>
              </div>
            </div>
          );
        })}

        {showPacket ? <div style={{ position: 'absolute', left: packetX - 5, top: Y - 5, width: 10, height: 10, background: C.ink }} /> : null}

        {/* Agent A */}
        <div style={{ position: 'absolute', left: ax - 14, top: Y - 14, transform: `scale(${tw(f, S01.agent, S01.agent + 16, 0, 1, ease.out)})` }}>
          <Agent size={28} state="live" />
        </div>
        <div style={{ position: 'absolute', left: ax - 14, top: Y + 40, opacity: others * tw(f, S01.agent + 10, S01.agent + 30), display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ width: 8, height: 8, borderRadius: 8, background: C.signal, opacity: 0.4 + 0.6 * Math.abs(Math.sin(f / 9)) }} />
          <Label size={14} color={C.ink}>
            agent-a · pid 48121
          </Label>
        </div>
      </Camera>

      {/* the statement, below the thread */}
      <div style={{ position: 'absolute', left: 118, top: 700, opacity: others }}>
        <Rise text="Your agent ■|is mid-deal." at={S01.headline} size={132} />
      </div>
    </AbsoluteFill>
  );
};
