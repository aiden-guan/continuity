// The film's datasheet frame: crop marks and four corner readouts that run across every scene.
// Story clock bottom-left, task top-right, evidence and live agents bottom-right. Uses the global frame.
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { Label, Mark, Roll } from './kit';
import { C, ease, keys, tw } from './theme';
import { S01, S02, S03, S04, S05, S09, S10, S12, START } from './timing';

const g = (scene: number, local: number) => START[scene] + local;

const clock: [number, string][] = [
  [0, 'MON 19 OCT  08:55'],
  [g(0, S01.ev[2]), 'MON 19 OCT  11:20'],
  [g(1, S02.enter), 'MON 19 OCT  11:24'],
  [g(2, S03.finance), 'MON 19 OCT  15:05'],
  [g(2, S03.finance + 22), 'MON 19 OCT  19:40'],
  [g(2, S03.finance + 40), 'TUE 20 OCT  01:15'],
  [g(2, S03.finance + 54), 'TUE 20 OCT  06:50'],
  [g(2, S03.correction), 'TUE 20 OCT  10:12'],
  [g(9, 0), 'WED 21 OCT  09:30'],
];

const scene: [number, string][] = [
  [0, '00 MID-DEAL     '],
  [g(1, 0), '00 SIGKILL      '],
  [g(2, 0), '00 NOBODY AWAKE '],
  [g(3, 0), '00 HANDOFF      '],
  [g(5, 0), '01 LISTEN       '],
  [g(6, 0), '02 RESOLVE      '],
  [g(7, 0), '03 BRIEF        '],
  [g(8, 0), '04 ACT          '],
  [g(9, 0), '05 CLOSE        '],
  [g(10, 0), '06 RESULTS      '],
];

const events: [number, string][] = [
  [0, 'EVENTS 00'],
  [g(0, S01.ev[0]), 'EVENTS 01'],
  [g(0, S01.ev[1]), 'EVENTS 02'],
  [g(0, S01.ev[2]), 'EVENTS 03'],
  [g(2, S03.finance), 'EVENTS 04'],
  [g(2, S03.correction), 'EVENTS 05'],
  [g(8, S09.send + 20), 'EVENTS 06'],
  [g(9, 0), 'EVENTS 07'],
];

const agents: [number, string][] = [
  [0, 'AGENTS 0'],
  [g(0, S01.agent), 'AGENTS 1'],
  [g(1, S02.stop), 'AGENTS 0'],
  [g(3, S04.fill), 'AGENTS 1'],
  [g(8, S09.send + 20), 'AGENTS 0'],
  [g(9, S10.agentC), 'AGENTS 1'],
];

const Cross: React.FC<{ x: number; y: number }> = ({ x, y }) => (
  <svg width={18} height={18} style={{ position: 'absolute', left: x - 9, top: y - 9 }}>
    <path d="M9 0 V18 M0 9 H18" stroke={C.ink} strokeWidth={1.2} />
  </svg>
);

export const Hud: React.FC = () => {
  const f = useCurrentFrame();
  // hidden during the flash cuts, the title and the finale
  const vis = Math.min(
    tw(f, 18, 48),
    keys(f, [g(1, S02.enter - 2), g(1, S02.enter), g(1, S02.stop + 10), g(1, S02.stop + 30)], [1, 0, 0, 1], ease.inOut),
    keys(f, [g(4, 0) - 8, g(4, 0), g(4, S05.through), g(4, S05.through + 30)], [1, 0, 0, 1], ease.inOut),
    keys(f, [g(11, S12.line1 - 20), g(11, S12.line1)], [1, 0], ease.inOut),
  );
  const fromStart = tw(f, 18, 60, 0, 1, ease.out);
  if (vis <= 0.001) return null;
  const inset = 56;
  const style = { fontVariantNumeric: 'tabular-nums' } as const;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: vis, pointerEvents: 'none' }}>
      <Cross x={inset} y={inset} />
      <Cross x={1920 - inset} y={inset} />
      <Cross x={inset} y={1080 - inset} />
      <Cross x={1920 - inset} y={1080 - inset} />

      <div style={{ position: 'absolute', left: inset + 26, top: inset - 9, display: 'flex', gap: 14, alignItems: 'center', transform: `translateY(${(1 - fromStart) * -8}px)` }}>
        <Mark height={11} />
        <Label size={14} color={C.ink}>
          Continuity
        </Label>
        <Label size={14} color={C.muted}>
          <Roll frames={scene} style={style} />
        </Label>
      </div>

      <div style={{ position: 'absolute', right: inset + 26, top: inset - 9, transform: `translateY(${(1 - fromStart) * -8}px)` }}>
        <Label size={14} color={C.muted}>
          PO-4817 · 500 × AX-200 · ≤ $11.50 · by Fri Oct 23
        </Label>
      </div>

      <div style={{ position: 'absolute', left: inset + 26, bottom: inset - 9, display: 'flex', gap: 10, alignItems: 'center', transform: `translateY(${(1 - fromStart) * 8}px)` }}>
        <Label size={14} color={C.ink}>
          <Roll frames={clock} style={style} />
        </Label>
      </div>

      <div style={{ position: 'absolute', right: inset + 26, bottom: inset - 9, display: 'flex', gap: 22, transform: `translateY(${(1 - fromStart) * 8}px)` }}>
        <Label size={14} color={C.muted}>
          <Roll frames={events} style={style} />
        </Label>
        <Label size={14} color={C.ink}>
          <Roll frames={agents} style={style} />
        </Label>
      </div>
    </div>
  );
};
