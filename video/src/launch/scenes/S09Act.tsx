// 09 — Act. Agent B, which has never seen the conversation, writes the right email from its briefing. As each phrase
// lands, a connector ties it to the line of state it came from. "Send" folds the draft into a node on the thread.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { BRIEF_W, Briefing, briefRowY } from '../briefing';
import { Chip, DotGrid, Label, SectionKey, Slabs, Tick } from '../kit';
import { C, ease, keys, mono, sans, tw } from '../theme';
import { AGENT_B_EMAIL, S09, typedAt } from '../timing';
import { BRIEF_IN_S09 as B } from './S08Brief';

const FS = 25;
const CW = FS * 0.6;
const LH = FS * 1.62;
const CX = 780; // composer
const CY = 236;
const CWID = 1050;
const HEAD = 78;
const SIDE = 40;
const BODY_X = CX + SIDE;
const BODY_Y = CY + HEAD + 26;
const FOOT_Y = BODY_Y + AGENT_B_EMAIL.length * LH + 22;
const CHGT = FOOT_Y - CY + 92;

// where scene 10 wants the sent email: a node on the thread
export const SENT_NODE = { x: 880, y: 236 };

/** Character offset of `text` in the joined email, and its line/column. */
const locate = (line: number, text: string) => {
  const col = AGENT_B_EMAIL[line].indexOf(text);
  const offset = AGENT_B_EMAIL.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col + text.length;
  return { line, col, len: text.length, end: offset };
};

const LINKS = [
  { at: locate(3, '(200 units arrive Wed Oct 28)'), row: 4 },
  { at: locate(4, 'need to arrive by Fri Oct 23'), row: 1 },
  { at: locate(7, 'the revised quote you mentioned'), row: 3 },
];

export const S09Act: React.FC = () => {
  const f = useCurrentFrame();
  const n = typedAt(f);
  const typing = f >= S09.type && f < S09.typeEnd;
  const enter = tw(f, S09.composer, S09.composer + 26, 0, 1, ease.out);

  // send: press, then fold the draft into a node on the thread
  const press = tw(f, S09.send, S09.send + 5, 0, 1, ease.out) * (1 - tw(f, S09.send + 5, S09.send + 16, 0, 1, ease.out));
  const fold = tw(f, S09.send + 10, S09.dur - 4, 0, 1, ease.inOut);
  const leave = tw(f, S09.send + 6, S09.send + 30, 0, 1, ease.in);

  // the composer, as one rect that can fold to the node
  const fx = keys(fold, [0, 1], [CX, SENT_NODE.x - 8], ease.linear);
  const fy = keys(fold, [0, 1], [CY, SENT_NODE.y - 8], ease.linear);
  const fw = keys(fold, [0, 0.7, 1], [CWID, 60, 16], ease.linear);
  const fh = keys(fold, [0, 0.6, 1], [CHGT, 4, 16], ease.linear);
  const threadIn = tw(f, S09.send + 30, S09.dur, 0, 1, ease.out);

  const joined = AGENT_B_EMAIL.join('\n');
  const typed = joined.slice(0, n).split('\n');

  // a slow push toward the draft while it writes, released for the stamp
  const push = tw(f, 10, S09.typeEnd, 0, 1, ease.inOut) * (1 - tw(f, S09.stamp - 20, S09.stamp + 30, 0, 1, ease.inOut));
  const camS = 1 + push * 0.035;

  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <DotGrid step={24} opacity={0.9} />
      <AbsoluteFill style={{ transform: `scale(${camS})`, transformOrigin: '950px 480px' }}>

      {/* the thread comes back as the draft folds into it */}
      <div style={{ position: 'absolute', left: 960 - 1200 * threadIn, width: 2400 * threadIn, top: SENT_NODE.y - 1, height: 2, background: C.ink }} />

      {/* the briefing, carried over from scene 08 */}
      <div style={{ position: 'absolute', left: B.x, top: B.y, transform: `scale(${B.s})`, transformOrigin: '0 0', opacity: 1 - leave }}>
        <Briefing
          reveal={() => 1}
          highlight={(i) => {
            const l = LINKS.find((k) => k.row === i);
            if (!l) return 0;
            const t = S09.type + (l.at.end / joined.length) * (S09.typeEnd - S09.type);
            return tw(f, t, t + 12) * (1 - tw(f, S09.stamp, S09.stamp + 30, 0, 0.5));
          }}
        />
      </div>

      {/* the composer */}
      {fold < 0.999 ? (
        <div
          style={{
            position: 'absolute',
            left: fx,
            top: fy,
            width: fw,
            height: fh,
            overflow: 'hidden',
            border: `1.5px solid ${fold > 0.6 ? C.ink : C.line2}`,
            borderRadius: 14 * (1 - fold),
            background: fold > 0.6 ? C.ink : C.surface,
            boxShadow: '0 1.5px 0 rgba(22,21,19,0.04), 0 27px 60px -33px rgba(40,32,20,0.28)',
            opacity: enter,
            transform: `translateY(${(1 - enter) * 30}px)`,
          }}
        >
          <div style={{ opacity: 1 - tw(fold, 0, 0.25, 0, 1, ease.linear) }}>
            <div
              style={{
                position: 'absolute',
                left: SIDE,
                right: SIDE,
                top: 0,
                height: HEAD,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: `1.5px solid ${C.line}`,
                fontFamily: mono,
                fontWeight: 500,
                fontSize: 18,
                letterSpacing: '0.04em',
                color: C.muted,
                whiteSpace: 'nowrap',
              }}
            >
              <span>
                <span style={{ color: C.ink }}>TO</span> Dana Ruiz · Re: RFQ: 500 × AX-200 — PO-4817
              </span>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ width: 9, height: 9, background: C.signal, opacity: typing ? 0.4 + 0.6 * Math.abs(Math.sin(f / 6)) : 1 }} />
                agent-b · {f < S09.typeEnd ? 'writing' : 'draft'}
              </span>
            </div>
            <div style={{ position: 'absolute', left: SIDE, top: HEAD + 26, fontFamily: mono, fontSize: FS, lineHeight: `${LH}px`, color: C.ink, whiteSpace: 'pre' }}>
              {AGENT_B_EMAIL.map((line, i) => {
                const shown = typed[i] ?? '';
                const isCaretLine = i === typed.length - 1 && f >= S09.type - 10 && f < S09.typeEnd + 30;
                return (
                  <div key={i} style={{ height: LH, position: 'relative' }}>
                    {/* phrase highlights sit under the text */}
                    {LINKS.filter((l) => l.at.line === i).map((l, k) => {
                      const t = S09.type + (l.at.end / joined.length) * (S09.typeEnd - S09.type);
                      const h = tw(f, t, t + 14, 0, 1, ease.out);
                      return (
                        <span
                          key={k}
                          style={{
                            position: 'absolute',
                            left: l.at.col * CW - 3,
                            top: 4,
                            width: (l.at.len * CW + 6) * h,
                            height: LH - 8,
                            background: C.signalBg,
                            borderBottom: `2px solid ${C.signal}`,
                          }}
                        />
                      );
                    })}
                    <span style={{ position: 'relative' }}>{shown}</span>
                    {isCaretLine ? (
                      <span
                        style={{
                          display: 'inline-block',
                          position: 'relative',
                          width: CW * 0.9,
                          height: LH * 0.62,
                          marginLeft: 1,
                          verticalAlign: '-0.12em',
                          background: C.ink,
                          opacity: typing || Math.floor(f / 16) % 2 === 0 ? 1 : 0,
                        }}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
            {/* footer: what the draft did, and send */}
            <div style={{ position: 'absolute', left: SIDE, right: SIDE, top: FOOT_Y - CY, height: 70, display: 'flex', alignItems: 'center', gap: 12, borderTop: `1.5px solid ${C.line}` }}>
              {['raised the conflict', 'cited the open commitment', 'didn’t re-ask the budget'].map((t, i) => {
                const p = tw(f, S09.typeEnd + 4 + i * 7, S09.typeEnd + 22 + i * 7, 0, 1, ease.out);
                return (
                  <span key={i} style={{ opacity: p, transform: `translateY(${(1 - p) * 8}px)` }}>
                    <Chip tone="ok" size={16}>
                      <Tick size={14} p={p} /> {t}
                    </Chip>
                  </span>
                );
              })}
              <div
                style={{
                  marginLeft: 'auto',
                  height: 48,
                  padding: '0 22px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  borderRadius: 9,
                  background: press > 0 ? C.signal : C.ink,
                  color: C.paper,
                  fontFamily: sans,
                  fontWeight: 500,
                  fontSize: 21,
                  transform: `scale(${1 - press * 0.05})`,
                  opacity: tw(f, S09.typeEnd + 10, S09.typeEnd + 28),
                }}
              >
                Send <span style={{ fontSize: 22 }}>→</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* provenance: each phrase back to the state it came from */}
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible', opacity: 1 - leave }}>
        {LINKS.map((l, k) => {
          const t = S09.type + (l.at.end / joined.length) * (S09.typeEnd - S09.type);
          const d = tw(f, t + 2, t + 26, 0, 1, ease.inOut);
          if (d <= 0) return null;
          const x0 = BODY_X + l.at.col * CW - 6;
          const y0 = BODY_Y + l.at.line * LH + LH / 2;
          const x1 = B.x + BRIEF_W * B.s + 10;
          const y1 = B.y + briefRowY(l.row) * B.s;
          const path = `M${x0} ${y0} C ${x0 - 60} ${y0}, ${x1 + 50} ${y1}, ${x1} ${y1}`;
          const len = Math.hypot(x1 - x0, y1 - y0) + 120;
          return (
            <g key={k}>
              <path d={path} fill="none" stroke={C.signal} strokeWidth={1.6} strokeDasharray={len} strokeDashoffset={len * (1 - d)} />
              <circle cx={x0} cy={y0} r={4.5} fill={C.signal} />
              <rect x={x1 - 5} y={y1 - 5} width={10} height={10} fill={C.paper} stroke={C.signal} strokeWidth={1.6} opacity={d > 0.95 ? 1 : 0} />
            </g>
          );
        })}
      </svg>

      </AbsoluteFill>
      <SectionKey n="04" t="Act" at={4} out={S09.send} style={{ left: 122, top: 118 }} />
      <div style={{ position: 'absolute', left: B.x + 4, top: B.y - 46, opacity: (1 - leave) * tw(f, 6, 26) }}>
        <Label size={15} color={C.muted}>
          agent-b · pid 48377 · prior messages in memory: <span style={{ color: C.signal }}>0</span>
        </Label>
      </div>
      <div style={{ position: 'absolute', left: B.x, top: 760, opacity: 1 - leave }}>
        <Slabs lines={['AGENT B NEVER SAW', 'THE CONVERSATION.']} at={S09.stamp} size={50} gap={6} />
      </div>
    </AbsoluteFill>
  );
};
