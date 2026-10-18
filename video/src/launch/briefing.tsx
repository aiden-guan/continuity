// Agent B's briefing (the real compiled context for agent-b at state v33), shared by scenes 08 and 09.
// Fixed geometry so other scenes can find each line: see `briefRowY`.
import React from 'react';
import { Chip, Roll } from './kit';
import { C, mono, sans } from './theme';

export const BRIEF_W = 1180;
export const BRIEF_HEAD = 76;
export const BRIEF_PAD = 26;
export const BRIEF_ROW = 66;
export const BRIEF_SIDE = 38;

export const BRIEF_ROWS: { k: string; v: string; ev?: string; tone?: 'signal' | 'ok' | 'muted' | 'strong' }[] = [
  { k: 'Next actor', v: 'Us — act on the conflict', tone: 'strong' },
  { k: '1 · Raise', v: 'All units by Fri Oct 23 is not met', ev: 'ev_6', tone: 'signal' },
  { k: '', v: '200 units arrive Wed Oct 28, after the deadline', tone: 'muted' },
  { k: '2 · Remind', v: 'Supplier owes a revised quote', ev: 'ev_6' },
  { k: 'Superseded', v: '500 Fri Oct 23 → 300 Fri + 200 Wed Oct 28', ev: 'ev_6' },
  { k: 'Don’t re-ask', v: 'Budget approved ≤ $11.50 / unit', ev: 'ev_5', tone: 'ok' },
  { k: 'Stale', v: 'Q-2291.pdf · delivery term', ev: 'ev_6' },
];

export const BRIEF_H = BRIEF_PAD * 2 + BRIEF_HEAD + BRIEF_ROWS.length * BRIEF_ROW;

/** Centre of row i, in the briefing's own (unscaled) px. */
export const briefRowY = (i: number) => BRIEF_PAD + BRIEF_HEAD + i * BRIEF_ROW + BRIEF_ROW / 2;
export const BRIEF_TEXT_X = BRIEF_SIDE + 230;

export const Briefing: React.FC<{ reveal: (i: number) => number; tokens?: [number, string][]; dim?: (i: number) => number; highlight?: (i: number) => number }> = ({
  reveal,
  tokens,
  dim,
  highlight,
}) => (
  <div
    style={{
      width: BRIEF_W,
      height: BRIEF_H,
      padding: `${BRIEF_PAD}px ${BRIEF_SIDE}px`,
      boxSizing: 'border-box',
      border: `1.5px solid ${C.line2}`,
      borderRadius: 15,
      background: C.surface,
      boxShadow: '0 1.5px 0 rgba(22,21,19,0.04), 0 27px 60px -33px rgba(40,32,20,0.28)',
    }}
  >
    <div
      style={{
        height: BRIEF_HEAD,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        borderBottom: `1.5px solid ${C.line}`,
        fontFamily: mono,
        fontWeight: 500,
        fontSize: 17,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: C.muted,
        paddingTop: 8,
        boxSizing: 'border-box',
      }}
    >
      <span>
        <span style={{ color: C.ink }}>Briefing</span> · for agent-b · since ev_2
      </span>
      <span style={{ letterSpacing: 0, textTransform: 'none', fontVariantNumeric: 'tabular-nums' }}>
        PO-4817 · v33 · {tokens ? <Roll frames={tokens} dur={8} /> : '1,432'} tokens
      </span>
    </div>
    {BRIEF_ROWS.map((r, i) => {
      const p = reveal(i);
      const d = dim ? dim(i) : 0;
      const h = highlight ? highlight(i) : 0;
      return (
        <div
          key={i}
          style={{
            height: BRIEF_ROW,
            display: 'grid',
            gridTemplateColumns: '230px 1fr auto',
            alignItems: 'center',
            borderBottom: i < BRIEF_ROWS.length - 1 && BRIEF_ROWS[i + 1].k ? `1px solid ${C.line}` : undefined,
            opacity: p * (1 - d * 0.6),
            clipPath: `inset(0 ${(1 - p) * 100}% 0 0)`,
            background: h > 0 ? `rgba(226, 80, 29, ${0.08 * h})` : undefined,
            margin: '0 -14px',
            padding: '0 14px',
          }}
        >
          <span style={{ fontFamily: mono, fontWeight: 500, fontSize: 18, letterSpacing: '0.06em', textTransform: 'uppercase', color: r.tone === 'signal' ? C.signal : C.muted }}>{r.k}</span>
          <span
            style={{
              fontFamily: sans,
              fontWeight: r.tone === 'strong' ? 600 : 500,
              fontSize: r.tone === 'muted' ? 24 : 29,
              letterSpacing: '-0.01em',
              color: r.tone === 'muted' ? C.muted : r.tone === 'signal' ? C.signalInk : C.ink,
              whiteSpace: 'nowrap',
            }}
          >
            {r.v}
          </span>
          <span>{r.ev ? <Chip tone={r.tone === 'ok' ? 'ok' : 'ink'} size={16}>{r.ev}</Chip> : null}</span>
        </div>
      );
    })}
  </div>
);
