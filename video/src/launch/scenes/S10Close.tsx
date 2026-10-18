// 10 — Close. The supplier expedites (ev_8, quote rev 2) and the checks flip on the beat. Agent C — another fresh
// process — drafts the acceptance; the send guard holds binding language for a human, and Sam approves.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Card, Chip, Cross, DotGrid, Label, Rise, SectionKey, Tick } from '../kit';
import { C, ease, keys, mono, sans, tw } from '../theme';
import { S10 } from '../timing';

const Y = 236;
const NODE = { ev6: 520, ev7: 880, ev8: 1240, c: 1540 };

const CHECKS: { name: string; from: string; to: string; fromTone: 'signal' | 'muted' | 'ink'; toTone: 'ok' | 'muted' }[] = [
  { name: 'All units by Fri Oct 23', from: 'conflict', to: 'resolved', fromTone: 'signal', toTone: 'ok' },
  { name: 'Supplier owes a revised quote', from: 'open', to: 'fulfilled · ev_8', fromTone: 'signal', toTone: 'ok' },
  { name: 'Q-2291.pdf', from: 'partially stale', to: 'superseded by rev 2', fromTone: 'signal', toTone: 'muted' },
  { name: 'Unit price $11.48 ≤ $11.50', from: 'checking', to: 'within budget', fromTone: 'ink', toTone: 'ok' },
  { name: 'Quantity 500 · budget approved', from: 'checking', to: 'passed', fromTone: 'ink', toTone: 'ok' },
];

const CheckRow: React.FC<{ i: number }> = ({ i }) => {
  const f = useCurrentFrame();
  const c = CHECKS[i];
  const at = S10.flips[i];
  const p = tw(f, at, at + 14, 0, 1, ease.out);
  const flash = tw(f, at, at + 6) * (1 - tw(f, at + 10, at + 46));
  const appear = tw(f, 14 + i * 5, 36 + i * 5, 0, 1, ease.out);
  const good = c.toTone === 'ok';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '40px 1fr auto',
        alignItems: 'center',
        gap: 14,
        height: 74,
        padding: '0 14px',
        margin: '0 -14px',
        borderBottom: `1px solid ${C.line}`,
        background: `rgba(44, 122, 75, ${0.1 * flash})`,
        opacity: appear,
        transform: `translateY(${(1 - appear) * 14}px)`,
      }}
    >
      <span style={{ position: 'relative', width: 26, height: 26 }}>
        <span style={{ position: 'absolute', inset: 0, opacity: 1 - p }}>{c.fromTone === 'signal' ? <Cross size={26} p={1} /> : <span style={{ display: 'block', width: 10, height: 10, margin: 8, background: C.faint }} />}</span>
        <span style={{ position: 'absolute', inset: 0 }}>{good ? <Tick size={26} p={p} width={2.6} /> : <span style={{ display: 'block', width: 14, height: 2, margin: '12px 6px', background: C.muted, opacity: p }} />}</span>
      </span>
      <span style={{ fontFamily: sans, fontWeight: 500, fontSize: 30, letterSpacing: '-0.01em', color: p > 0.5 && !good ? C.muted : C.ink, textDecoration: p > 0.5 && !good ? 'line-through' : undefined, textDecorationColor: C.faint }}>{c.name}</span>
      <span style={{ display: 'inline-grid', overflow: 'hidden', justifyItems: 'end' }}>
        <span style={{ gridArea: '1/1', transform: `translateY(${-p * 110}%)` }}>
          <Chip tone={c.fromTone === 'signal' ? 'signal' : 'muted'} size={17}>
            {c.from}
          </Chip>
        </span>
        <span style={{ gridArea: '1/1', transform: `translateY(${(1 - p) * 110}%)` }}>
          <Chip tone={good ? 'ok' : 'muted'} size={17}>
            {c.to}
          </Chip>
        </span>
      </span>
    </div>
  );
};

export const S10Close: React.FC = () => {
  const f = useCurrentFrame();

  const packetX = keys(f, [S10.reply - 4, S10.reply + 18], [2100, NODE.ev8], ease.out);
  const reply = tw(f, S10.reply + 14, S10.reply + 40, 0, 1, ease.out);
  const replyOut = tw(f, S10.card - 20, S10.card + 4, 0, 1, ease.in);
  const cSpawn = tw(f, S10.agentC, S10.agentC + 16, 0, 1, ease.out);
  const cFill = tw(f, S10.agentC + 16, S10.agentC + 28, 0, 1, ease.out);
  const card = tw(f, S10.card, S10.card + 28, 0, 1, ease.out);
  const guard = tw(f, S10.guard, S10.guard + 20, 0, 1, ease.out);
  const press = tw(f, S10.approve, S10.approve + 5) * (1 - tw(f, S10.approve + 5, S10.approve + 18));
  const approved = tw(f, S10.approve + 6, S10.approve + 24, 0, 1, ease.out);
  const passed = S10.flips.filter((t) => f >= t + 6).length;

  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <DotGrid step={24} opacity={0.9} />

      {/* the thread, carried over from scene 09 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: Y - 1, height: 2, background: C.ink }} />
      {[
        { x: NODE.ev6, inbound: true, label: 'ev_6 · correction', show: 1 },
        { x: NODE.ev7, inbound: false, label: 'ev_7 · agent-b', show: 1 },
        { x: NODE.ev8, inbound: true, label: 'ev_8 · rev 2', show: tw(f, S10.reply + 16, S10.reply + 26, 0, 1, ease.out) },
      ].map((n, i) => (
        <React.Fragment key={i}>
          <div style={{ position: 'absolute', left: n.x - 8, top: Y - 8, width: 16, height: 16, background: n.inbound ? C.paper : C.ink, boxShadow: n.inbound ? `inset 0 0 0 2.5px ${C.ink}` : undefined, transform: `scale(${n.show})` }} />
          <div style={{ position: 'absolute', left: n.x - 8, top: Y - 40, opacity: n.show }}>
            <Label size={14} color={C.muted}>
              {n.label}
            </Label>
          </div>
        </React.Fragment>
      ))}
      {f > S10.reply - 4 && f < S10.reply + 20 ? <div style={{ position: 'absolute', left: packetX - 6, top: Y - 6, width: 12, height: 12, background: C.ink }} /> : null}
      {/* Agent B has sent and exited */}
      <div style={{ position: 'absolute', left: NODE.ev7 - 66, top: Y - 12, width: 24, height: 24, boxShadow: `inset 0 0 0 2.5px ${C.faint}` }} />

      {/* Agent C */}
      <div style={{ position: 'absolute', left: NODE.c - 16, top: Y - 16, width: 32, height: 32, transform: `scale(${cSpawn})` }}>
        <div style={{ position: 'absolute', inset: 0, background: C.paper, boxShadow: `inset 0 0 0 3px ${C.ink}` }} />
        <div style={{ position: 'absolute', inset: 16 * (1 - cFill), background: C.signal }} />
      </div>
      <div style={{ position: 'absolute', left: NODE.c - 16, top: Y + 28, opacity: tw(f, S10.agentC + 20, S10.agentC + 36) }}>
        <Label size={14} color={C.ink}>
          agent-c · <span style={{ color: C.signal }}>0 messages in memory</span>
        </Label>
      </div>

      {/* checks */}
      <div style={{ position: 'absolute', left: 118, top: 330 }}>
        <Card title="Checks · PO-4817" meta={<span style={{ fontVariantNumeric: 'tabular-nums' }}>{passed >= 5 ? '5 / 5 passing' : `${Math.min(4, 2 + passed)} / 5 passing`}</span>} width={800} pad={20} scale={1.4}>
          {CHECKS.map((_, i) => (
            <CheckRow key={i} i={i} />
          ))}
        </Card>
      </div>

      {/* the supplier's answer */}
      <div style={{ position: 'absolute', left: 1010, top: 330, opacity: reply * (1 - replyOut), transform: `translateY(${(1 - reply) * 26 - replyOut * 30}px)` }}>
        <Card title="← Supplier" meta="ev_8 · Wed 09:30" width={800} pad={20} scale={1.4}>
          <div style={{ fontFamily: sans, fontWeight: 500, fontSize: 31, lineHeight: 1.3, color: C.ink, letterSpacing: '-0.015em' }}>
            We can air-freight the remaining 200 units so all 500 arrive Friday, Oct 23. Unit price $11.48. Revised quote attached.
          </div>
          <div style={{ marginTop: 18, display: 'flex', gap: 10 }}>
            <Chip tone="ink" size={17}>
              Northwind-Quote-Q-2291-rev2.pdf
            </Chip>
          </div>
        </Card>
      </div>

      {/* the approval card */}
      <div style={{ position: 'absolute', left: 1010, top: 330, opacity: card, transform: `translateY(${(1 - card) * 30}px)` }}>
        <Card title="Held for a human · send guard" meta="agent-c → supplier" width={800} pad={20} scale={1.4} style={{ boxShadow: approved > 0 ? `inset 6px 0 0 ${C.ok}, 0 25px 56px -30px rgba(40,32,20,0.3)` : undefined }}>
          <div style={{ fontFamily: sans, fontWeight: 600, fontSize: 33, lineHeight: 1.22, color: C.ink, letterSpacing: '-0.02em' }}>Approve committing to the supplier’s current terms on AX-200 control boards?</div>
          <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 10, fontFamily: mono, fontSize: 21, color: C.ink2 }}>
            <span>500 units · Fri Oct 23</span>
            <span>$11.48 / unit · Net 30</span>
            <span>Q-2291-rev2.pdf</span>
            <span style={{ color: C.ok }}>all checks ✓ 5 / 5</span>
          </div>
          <div style={{ marginTop: 18, opacity: guard }}>
            <Chip tone="signal" size={17}>
              binding language: “we accept it for PO-4817”
            </Chip>
          </div>
          <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                height: 54,
                padding: '0 22px',
                display: 'flex',
                alignItems: 'center',
                borderRadius: 10,
                background: approved > 0.5 ? C.ok : C.ink,
                color: C.paper,
                fontFamily: sans,
                fontWeight: 500,
                fontSize: 22,
                transform: `scale(${1 - press * 0.05})`,
              }}
            >
              {approved > 0.5 ? '✓ Approved · sent' : 'Approve and send'}
            </div>
            <div style={{ height: 54, padding: '0 22px', display: 'flex', alignItems: 'center', borderRadius: 10, border: `1.5px solid ${C.line2}`, fontFamily: sans, fontWeight: 500, fontSize: 22, color: C.ink, opacity: 1 - approved * 0.6 }}>
              Reject
            </div>
            <div style={{ marginLeft: 'auto', opacity: approved, transform: `translateX(${(1 - approved) * 10}px)` }}>
              <Label size={17} color={C.ok}>
                by Sam · ops lead
              </Label>
            </div>
          </div>
        </Card>
      </div>

      <SectionKey n="05" t="Close" at={4} style={{ left: 122, top: 118 }} />
      <div style={{ position: 'absolute', left: 118, top: 884 }}>
        <Rise text="Agents propose. *A* *human* *decides.*" at={S10.headline} size={96} />
      </div>
    </AbsoluteFill>
  );
};
