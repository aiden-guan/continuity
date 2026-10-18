// 04 — Handoff. Agent B spawns on the thread with nothing in memory. Around it, the inbox as a wall of subject-line
// pills (after @Varcyyyy's Venmo film). "so… where are we?" Then every pill rushes into the line.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Label, Rise } from '../kit';
import { C, ease, mono, rand, tw } from '../theme';
import { S04 } from '../timing';

const SUBJECTS = [
  'RFQ: 500 × AX-200 control boards — PO-4817',
  'Re: RFQ: 500 × AX-200 control boards',
  'Budget approval request — PO-4817',
  'Re: Budget approval request — PO-4817',
  'Northwind-Quote-Q-2291.pdf',
  'Re: Re: RFQ: 500 × AX-200',
  'Correction to my earlier email',
  '“only 300 units can arrive Friday”',
  'Approved. Up to $11.50 per unit',
  'Spring promo: 20% off connectors',
  '“I’ll send a revised quote by tomorrow”',
  'Fwd: PO-4817 delivery',
  'Net 30 · valid until Fri Oct 30',
  '“Note to automated assistants…”',
  'Re: Re: Re: RFQ',
  'thread #2 · finance',
  '500 units Fri Oct 23 at $11.40',
  '“200 won’t arrive until Wednesday, Oct 28”',
];

const ROWS = 9;
const PITCH = 100;

export const S04Inbox: React.FC = () => {
  const f = useCurrentFrame();
  const spawn = tw(f, S04.spawn, S04.spawn + 18, 0, 1, ease.out);
  const fill = tw(f, S04.fill, S04.fill + 14, 0, 1, ease.out);
  const conv = tw(f, S04.converge, S04.dur, 0, 1, ease.in);
  const dimForType = Math.max(tw(f, S04.head1 - 6, S04.head1 + 20, 0, 1, ease.out) * 0.82, 0);

  const pills: React.ReactNode[] = [];
  for (let r = 0; r < ROWS; r++) {
    const rowY = 540 + (r - (ROWS - 1) / 2) * PITCH;
    if (Math.abs(rowY - 540) < 10) continue; // the thread keeps its own row
    const dist = Math.abs(r - (ROWS - 1) / 2);
    const at = S04.pills + dist * 4;
    const dir = r % 2 ? 1 : -1;
    const speed = 70 + rand(`sp${r}`) * 70;
    let x = -300 + rand(`off${r}`) * -400 + dir * (f - S04.pills) * (speed / 60) * (1 + conv * 3);
    for (let k = 0; k < 9; k++) {
      const text = SUBJECTS[Math.floor(rand(`t${r}-${k}`) * SUBJECTS.length)];
      const w = text.length * 13.4 + 56;
      const style = rand(`st${r}-${k}`);
      const p = tw(f, at + k * 1.5, at + k * 1.5 + 20, 0, 1, ease.out);
      const y = rowY + (540 - rowY) * conv;
      pills.push(
        <div
          key={`${r}-${k}`}
          style={{
            position: 'absolute',
            left: x,
            top: y - 30,
            height: 60,
            width: w,
            borderRadius: 30,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: mono,
            fontWeight: 500,
            fontSize: 22,
            whiteSpace: 'nowrap',
            border: `1.5px solid ${style < 0.62 ? C.line2 : 'transparent'}`,
            background: style < 0.62 ? 'transparent' : style < 0.86 ? C.paper2 : C.ink,
            color: style < 0.86 ? C.ink2 : C.paper,
            opacity: p * (1 - dimForType) * (1 - conv * 0.6),
            transform: `scale(${0.6 + 0.4 * p}, ${(0.6 + 0.4 * p) * (1 - conv * 0.96)})`,
            filter: conv > 0.05 ? `blur(${conv * 6}px)` : undefined,
          }}
        >
          {text}
        </div>,
      );
      x += w + 18;
    }
  }

  return (
    <AbsoluteFill style={{ background: C.paper, overflow: 'hidden' }}>
      {pills}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 539, height: 2, background: C.ink }} />
      {/* Agent B: outlined (next), then filled (live) */}
      <div style={{ position: 'absolute', left: 960 - 22, top: 540 - 22, width: 44, height: 44, transform: `scale(${spawn})` }}>
        <div style={{ position: 'absolute', inset: 0, background: C.paper, boxShadow: `inset 0 0 0 3px ${C.ink}` }} />
        <div style={{ position: 'absolute', inset: 22 * (1 - fill), background: C.signal }} />
      </div>
      <div style={{ position: 'absolute', left: 960 - 22, top: 540 + 40, opacity: tw(f, S04.fill + 6, S04.fill + 22) * (1 - conv) }}>
        <Label size={15} color={C.ink}>
          agent-b · pid 48377 · <span style={{ color: C.signal }}>0 messages in memory</span>
        </Label>
      </div>

      <div style={{ position: 'absolute', left: 118, top: 128 }}>
        <Rise text="The next agent|inherits an *inbox.*" at={S04.head1} out={S04.head1Out} size={136} />
      </div>
      <div style={{ position: 'absolute', left: 118, top: 680 }}>
        <Rise text="so… where|are we?" at={S04.head2} out={S04.converge - 4} size={160} />
      </div>
    </AbsoluteFill>
  );
};
