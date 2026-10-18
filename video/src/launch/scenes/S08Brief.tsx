// 08 — Brief. The collapsed state from scene 07 is now the frame of Agent B's briefing. One request, and the
// compiled context arrives line by line, every line cited. Hands the card to scene 09's left column.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { BRIEF_ROWS, Briefing } from '../briefing';
import { Chip, DotGrid, Label, Rise, SectionKey, Typed } from '../kit';
import { C, ease, keys, mono, tw } from '../theme';
import { S08 } from '../timing';

// where scene 07 left the card, and where scene 09 wants it
const A = { x: 429, y: 249.5, s: 0.9 };
export const BRIEF_IN_S09 = { x: 70, y: 318, s: 0.56 };

export const S08Brief: React.FC = () => {
  const f = useCurrentFrame();
  const out = tw(f, S08.out, S08.dur, 0, 1, ease.inOut);
  const lift = tw(f, S08.headline - 10, S08.headline + 30, 0, 1, ease.inOut);
  const x = keys(out, [0, 1], [A.x, BRIEF_IN_S09.x], ease.linear);
  const y = keys(out, [0, 1], [A.y - lift * 44, BRIEF_IN_S09.y], ease.linear);
  const s = keys(out, [0, 1], [A.s, BRIEF_IN_S09.s], ease.linear);

  const rowAt = (i: number) => S08.lines + i * S08.lineGap;
  const tokens: [number, string][] = [[0, '0'], ...BRIEF_ROWS.map((_, i) => [rowAt(i) + 4, ['118', '304', '377', '596', '903', '1,174', '1,432'][i]] as [number, string])];
  const ok = tw(f, S08.enter, S08.enter + 14, 0, 1, ease.out);
  const reqOut = 1 - tw(f, S08.out - 16, S08.out + 6, 0, 1, ease.in);

  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <DotGrid step={24} opacity={0.9} />

      <div style={{ position: 'absolute', left: A.x, top: 150 - lift * 30, display: 'flex', alignItems: 'center', gap: 18, opacity: reqOut }}>
        <Chip tone="solid" size={20}>
          agent-b
        </Chip>
        <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 34, color: C.ink, letterSpacing: '-0.01em' }}>
          <span style={{ color: C.muted }}>GET </span>
          <Typed text="/tasks/PO-4817/context" at={S08.type} cps={S08.cps} hideCaretAfter={S08.enter} />
        </div>
        <div style={{ opacity: ok, transform: `translateX(${(1 - ok) * -10}px)` }}>
          <Chip tone="ok" size={20}>
            200 OK · 41 ms
          </Chip>
        </div>
      </div>

      <div style={{ position: 'absolute', left: x, top: y, transform: `scale(${s})`, transformOrigin: '0 0' }}>
        <Briefing reveal={(i) => tw(f, rowAt(i), rowAt(i) + 18, 0, 1, ease.out)} tokens={tokens} />
      </div>

      <SectionKey n="03" t="Brief" at={4} out={S08.out - 10} style={{ left: 122, top: 118 }} />
      <div style={{ position: 'absolute', right: 122, top: 118, opacity: reqOut * tw(f, S08.count, S08.count + 20) }}>
        <Label size={15} color={C.muted}>
          mandatory first · cited · budgeted
        </Label>
      </div>
      <div style={{ position: 'absolute', left: 118, top: 852 }}>
        <Rise text="One call. *The* *whole* *picture.*" at={S08.headline} out={S08.out - 14} size={100} />
      </div>
    </AbsoluteFill>
  );
};
