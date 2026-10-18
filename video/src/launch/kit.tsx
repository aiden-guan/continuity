// Shared building blocks for the launch film. Every one is a pure function of the scene-local frame.
import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { C, ease, hatch, mono, sans, tw } from './theme';

// ---------------------------------------------------------------- stage

/** The site's figure texture: a quiet dot grid on paper. Lives in world space so it parallaxes with the camera. */
export const DotGrid: React.FC<{ step?: number; opacity?: number; size?: number; x?: number; y?: number; w?: number; h?: number }> = ({
  step = 24,
  opacity = 1,
  size = 1.1,
  x = -4000,
  y = -4000,
  w = 12000,
  h = 12000,
}) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: w,
      height: h,
      opacity,
      backgroundImage: `radial-gradient(${C.line2} ${size}px, transparent ${size + 0.2}px)`,
      backgroundSize: `${step}px ${step}px`,
      backgroundPosition: `${-x}px ${-y}px`,
    }}
  />
);

/** Fine paper grain and a faint lens falloff; sits on top of everything. The grain is the paper's, so it holds still. */
export const Finish: React.FC<{ dark?: boolean }> = ({ dark }) => {
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <AbsoluteFill
        style={{
          backgroundImage: `url(${staticFile('launch/grain.png')})`,
          backgroundSize: '384px 384px',
          mixBlendMode: dark ? 'screen' : 'multiply',
          opacity: dark ? 0.05 : 0.075,
        }}
      />
      <AbsoluteFill
        style={{
          background: dark
            ? 'radial-gradient(ellipse 75% 70% at 50% 50%, transparent 55%, rgba(0,0,0,0.35) 100%)'
            : 'radial-gradient(ellipse 80% 75% at 50% 48%, transparent 58%, rgba(70,58,40,0.10) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};

/** A world plane seen through a camera: (x, y) in world px lands at the frame centre. */
export const Camera: React.FC<{ x: number; y: number; s?: number; r?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({
  x,
  y,
  s = 1,
  r = 0,
  children,
  style,
}) => (
  <AbsoluteFill style={{ overflow: 'hidden', ...style }}>
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
        transformOrigin: '0 0',
        transform: `translate(960px, 540px) rotate(${r}deg) scale(${s}) translate(${-x}px, ${-y}px)`,
      }}
    >
      {children}
    </div>
  </AbsoluteFill>
);

/** Directional motion blur for whips and pushes (an SVG filter whose strength the caller animates). */
export const MotionBlur: React.FC<{ id: string; x?: number; y?: number }> = ({ id, x = 0, y = 0 }) => (
  <svg width={0} height={0} style={{ position: 'absolute' }}>
    <defs>
      <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation={`${Math.max(0, x).toFixed(2)} ${Math.max(0, y).toFixed(2)}`} />
      </filter>
    </defs>
  </svg>
);

// ---------------------------------------------------------------- type

type RiseProps = {
  text: string; // '|' breaks lines; *word* is signal orange; ■ is an inline live-agent square; □ the next agent
  at: number;
  out?: number;
  size: number;
  weight?: number;
  color?: string;
  stagger?: number;
  dur?: number;
  lineHeight?: number;
  tracking?: number;
  align?: 'left' | 'center' | 'right';
  style?: React.CSSProperties;
  font?: string;
  dim?: string; // words wrapped in ~tilde~ take this colour
};

/** Headlines rise word by word out of a mask, with a little vertical smear while they move. */
export const Rise: React.FC<RiseProps> = ({
  text,
  at,
  out,
  size,
  weight = 600,
  color = C.ink,
  stagger = 3,
  dur = 30,
  lineHeight = 0.98,
  tracking = -0.045,
  align = 'left',
  style,
  font = sans,
  dim = C.faint,
}) => {
  const frame = useCurrentFrame();
  let i = 0;
  const lines = text.split('|');
  return (
    <div
      style={{
        fontFamily: font,
        fontWeight: weight,
        fontSize: size,
        lineHeight,
        letterSpacing: `${tracking}em`,
        color,
        textAlign: align,
        fontFeatureSettings: '"ss01", "cv11"',
        ...style,
      }}
    >
      {lines.map((line, li) => (
        <div key={li} style={{ whiteSpace: 'nowrap' }}>
          {line.split(' ').map((raw, wi) => {
            const idx = i++;
            const p = tw(frame, at + idx * stagger, at + idx * stagger + dur, 0, 1, ease.out);
            const q = out === undefined ? 0 : tw(frame, out + idx * 2, out + idx * 2 + 16, 0, 1, ease.in);
            const y = (1 - p) * 108 - q * 108;
            const smear = (1 - p) * 10 + q * 8;
            let word: React.ReactNode = raw;
            let wc: string | undefined;
            if (raw.startsWith('*') && raw.endsWith('*')) {
              word = raw.slice(1, -1);
              wc = C.signal;
            } else if (raw.startsWith('~') && raw.endsWith('~')) {
              word = raw.slice(1, -1);
              wc = dim;
            }
            if (raw === '■' || raw === '□') {
              word = (
                <span
                  style={{
                    display: 'inline-block',
                    width: '0.56em',
                    height: '0.56em',
                    marginBottom: '0.06em',
                    background: raw === '■' ? C.signal : 'transparent',
                    boxShadow: raw === '□' ? `inset 0 0 0 ${Math.max(2, size * 0.035)}px ${C.ink}` : undefined,
                  }}
                />
              );
            }
            return (
              <React.Fragment key={wi}>
                <span style={{ display: 'inline-block', overflow: 'hidden', paddingBottom: '0.14em', marginBottom: '-0.14em', verticalAlign: 'top' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      transform: `translateY(${y}%)`,
                      color: wc,
                      filter: smear > 0.3 ? `blur(${(smear * size) / 400}px)` : undefined,
                    }}
                  >
                    {word}
                  </span>
                </span>
                {wi < line.split(' ').length - 1 ? ' ' : null}
              </React.Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
};

/** A small mono annotation, like a figure caption on the site. */
export const Label: React.FC<{
  children: React.ReactNode;
  size?: number;
  color?: string;
  upper?: boolean;
  weight?: number;
  style?: React.CSSProperties;
}> = ({ children, size = 15, color = C.muted, upper = true, weight = 500, style }) => (
  <div
    style={{
      fontFamily: mono,
      fontSize: size,
      fontWeight: weight,
      lineHeight: 1.3,
      letterSpacing: upper ? '0.08em' : '0',
      textTransform: upper ? 'uppercase' : 'none',
      color,
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {children}
  </div>
);

/** Text that types itself (deterministic), with an optional block caret. */
export const Typed: React.FC<{ text: string; at: number; cps?: number; caret?: boolean; caretColor?: string; hideCaretAfter?: number }> = ({
  text,
  at,
  cps = 30,
  caret = true,
  caretColor = C.ink,
  hideCaretAfter,
}) => {
  const frame = useCurrentFrame();
  const n = Math.max(0, Math.min(text.length, Math.floor(((frame - at) * cps) / 60)));
  const typing = frame >= at && n < text.length;
  const blinkOn = typing || Math.floor(frame / 16) % 2 === 0;
  const show = caret && frame >= at - 10 && (hideCaretAfter === undefined || frame < hideCaretAfter);
  return (
    <span>
      {text.slice(0, n)}
      {show ? (
        <span
          style={{
            display: 'inline-block',
            width: '0.55em',
            height: '1.08em',
            marginLeft: 2,
            verticalAlign: '-0.16em',
            background: caretColor,
            opacity: blinkOn ? 1 : 0,
          }}
        />
      ) : null}
    </span>
  );
};

/** Characters roll in from below when a value changes; keyframes are [frame, text]. */
export const Roll: React.FC<{ frames: [number, string][]; style?: React.CSSProperties; dur?: number }> = ({ frames, style, dur = 16 }) => {
  const frame = useCurrentFrame();
  let idx = 0;
  for (let k = 0; k < frames.length; k++) if (frame >= frames[k][0]) idx = k;
  const [t0, cur] = frames[idx];
  const prev = idx > 0 ? frames[idx - 1][1] : '';
  const width = Math.max(cur.length, prev.length);
  return (
    <span style={{ display: 'inline-flex', ...style }}>
      {Array.from({ length: width }).map((_, ci) => {
        const a = prev[ci] ?? '';
        const b = cur[ci] ?? '';
        if (a === b || idx === 0) {
          return (
            <span key={ci} style={{ display: 'inline-block', whiteSpace: 'pre' }}>
              {b}
            </span>
          );
        }
        const p = tw(frame, t0 + ci * 1.2, t0 + ci * 1.2 + dur, 0, 1, ease.out);
        return (
          <span key={ci} style={{ display: 'inline-grid', overflow: 'hidden', verticalAlign: 'top' }}>
            <span style={{ gridArea: '1/1', whiteSpace: 'pre', transform: `translateY(${-p * 100}%)`, opacity: 1 - p }}>{a}</span>
            <span style={{ gridArea: '1/1', whiteSpace: 'pre', transform: `translateY(${(1 - p) * 100}%)` }}>{b}</span>
          </span>
        );
      })}
    </span>
  );
};

// ---------------------------------------------------------------- product pieces

/** An agent on the thread: live (filled orange), next (outlined), or dead (hollow, crossed). */
export const Agent: React.FC<{ size: number; state: 'live' | 'next' | 'dead'; style?: React.CSSProperties }> = ({ size, state, style }) => {
  const stroke = Math.max(2, size * 0.09);
  return (
    <div
      style={{
        width: size,
        height: size,
        background: state === 'live' ? C.signal : C.paper,
        boxShadow: state === 'live' ? undefined : `inset 0 0 0 ${stroke}px ${state === 'dead' ? C.faint : C.ink}`,
        position: 'relative',
        ...style,
      }}
    >
      {state === 'dead' ? (
        <svg width={size} height={size} style={{ position: 'absolute', inset: 0 }}>
          <path d={`M${size * 0.28} ${size * 0.28} L${size * 0.72} ${size * 0.72} M${size * 0.72} ${size * 0.28} L${size * 0.28} ${size * 0.72}`} stroke={C.faint} strokeWidth={stroke * 0.8} />
        </svg>
      ) : null}
    </div>
  );
};

/** The brand mark: the thread, the live agent, the next agent (site/index.html logo, 26×12 viewBox). */
export const Mark: React.FC<{ height: number; line?: number; live?: number; next?: number }> = ({ height, line = 1, live = 1, next = 1 }) => {
  const k = height / 12;
  return (
    <svg width={26 * k} height={12 * k} viewBox="0 0 26 12" style={{ overflow: 'visible' }}>
      <line x1={13 - 13 * line} y1={6} x2={13 + 13 * line} y2={6} stroke={C.ink} strokeWidth={1.25} />
      <rect x={4 + 3 * (1 - live)} y={3 + 3 * (1 - live)} width={6 * live} height={6 * live} fill={C.signal} />
      <rect x={16.5 + 2.5 * (1 - next)} y={3.5 + 2.5 * (1 - next)} width={5 * next} height={5 * next} fill={C.paper} stroke={C.ink} strokeWidth={1.1 * Math.min(1, next * 3)} />
    </svg>
  );
};

/** A product card: surface, hairline border, mono header with a rule under it. */
export const Card: React.FC<{
  title?: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  width?: number | string;
  pad?: number;
  scale?: number;
  style?: React.CSSProperties;
}> = ({ title, meta, children, width, pad = 22, scale = 1, style }) => (
  <div
    style={{
      width,
      padding: `${pad * scale}px ${(pad + 2) * scale}px`,
      border: `${Math.max(1, scale)}px solid ${C.line2}`,
      borderRadius: 10 * scale,
      background: C.surface,
      boxShadow: `0 ${1 * scale}px 0 rgba(22,21,19,0.04), 0 ${18 * scale}px ${40 * scale}px -${22 * scale}px rgba(40,32,20,0.28)`,
      ...style,
    }}
  >
    {title !== undefined ? (
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12 * scale,
          marginBottom: 14 * scale,
          paddingBottom: 12 * scale,
          borderBottom: `${Math.max(1, scale * 0.8)}px solid ${C.line}`,
          fontFamily: mono,
          fontWeight: 500,
          fontSize: 11 * scale,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: C.muted,
          whiteSpace: 'nowrap',
        }}
      >
        <span>{title}</span>
        <span style={{ letterSpacing: 0, textTransform: 'none' }}>{meta}</span>
      </div>
    ) : null}
    {children}
  </div>
);

export const Chip: React.FC<{ tone?: 'ok' | 'signal' | 'ink' | 'muted' | 'solid'; size?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({
  tone = 'muted',
  size = 15,
  children,
  style,
}) => {
  const tones = {
    ok: { bg: C.okBg, fg: C.ok, bd: 'transparent' },
    signal: { bg: C.signalBg, fg: C.signalInk, bd: 'transparent' },
    ink: { bg: 'transparent', fg: C.ink, bd: C.line2 },
    muted: { bg: C.paper2, fg: C.muted, bd: 'transparent' },
    solid: { bg: C.signal, fg: '#fff', bd: C.signal },
  }[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: size * 0.45,
        padding: `${size * 0.28}px ${size * 0.6}px`,
        borderRadius: size * 0.4,
        border: `1px solid ${tones.bd}`,
        background: tones.bg,
        color: tones.fg,
        fontFamily: mono,
        fontWeight: 500,
        fontSize: size,
        lineHeight: 1.15,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
};

/** A check mark that draws itself. */
export const Tick: React.FC<{ size: number; p: number; color?: string; width?: number }> = ({ size, p, color = C.ok, width = 2.2 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" style={{ overflow: 'visible', flex: 'none' }}>
    <path d="M4 10.5 L8.4 14.6 L16 5.8" fill="none" stroke={color} strokeWidth={width} strokeLinecap="square" strokeDasharray={20} strokeDashoffset={20 * (1 - p)} />
  </svg>
);

/** A cross that draws itself. */
export const Cross: React.FC<{ size: number; p: number; color?: string; width?: number }> = ({ size, p, color = C.signal, width = 2.2 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" style={{ overflow: 'visible', flex: 'none' }}>
    <path d="M5 5 L15 15" fill="none" stroke={color} strokeWidth={width} strokeDasharray={15} strokeDashoffset={15 * (1 - Math.min(1, p * 2))} />
    <path d="M15 5 L5 15" fill="none" stroke={color} strokeWidth={width} strokeDasharray={15} strokeDashoffset={15 * (1 - Math.max(0, p * 2 - 1))} />
  </svg>
);

/** A tracking box (after @mnowakdesign): it locks onto a target, then fills with hatching. */
export const TrackBox: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  at: number;
  color?: string;
  tag?: string;
  sub?: string;
  tagSide?: 'top' | 'bottom' | 'left';
  fade?: number;
}> = ({ x, y, w, h, at, color = C.ink, tag, sub, tagSide = 'top', fade = 1 }) => {
  const frame = useCurrentFrame();
  if (frame < at - 1) return null;
  const lock = tw(frame, at, at + 13, 0, 1, ease.snap);
  const fill = tw(frame, at + 6, at + 20, 0, 1, ease.out);
  const grow = 1 + (1 - lock) * 0.45;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const bw = w * grow;
  const bh = h * grow;
  const corner = 12;
  const tagN = tag ? Math.floor(tw(frame, at + 4, at + 4 + tag.length * 0.9, 0, tag.length, ease.linear)) : 0;
  const subN = sub ? Math.floor(tw(frame, at + 10, at + 10 + sub.length * 0.7, 0, sub.length, ease.linear)) : 0;
  return (
    <div style={{ position: 'absolute', left: cx - bw / 2, top: cy - bh / 2, width: bw, height: bh, opacity: lock * fade }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          border: `1.5px solid ${color}`,
          backgroundImage: hatch(color === C.ink ? 'rgba(22,21,19,0.16)' : 'rgba(226,80,29,0.22)', 8, 1.4),
          backgroundColor: color === C.ink ? 'rgba(22,21,19,0.025)' : 'rgba(226,80,29,0.05)',
          opacity: 0.35 + fill * 0.65,
          backgroundSize: `${100 * fill}% 100%`,
          backgroundRepeat: 'no-repeat',
        }}
      />
      {/* corner brackets sit just outside the box */}
      {[
        [0, 0, 1, 1],
        [1, 0, -1, 1],
        [0, 1, 1, -1],
        [1, 1, -1, -1],
      ].map(([ax, ay, dx, dy], k) => (
        <svg key={k} width={corner} height={corner} style={{ position: 'absolute', left: ax ? bw - corner + 5 : -5, top: ay ? bh - corner + 5 : -5, overflow: 'visible' }}>
          <path
            d={`M${dx > 0 ? 0 : corner} ${dy > 0 ? corner : 0} L${dx > 0 ? 0 : corner} ${dy > 0 ? 0 : corner} L${dx > 0 ? corner : 0} ${dy > 0 ? 0 : corner}`}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
          />
        </svg>
      ))}
      {tag ? (
        <div
          style={{
            position: 'absolute',
            ...(tagSide === 'left'
              ? { right: bw + 12, top: bh / 2 - 13 }
              : tagSide === 'top'
                ? { left: -1, bottom: bh + 10 }
                : { left: -1, top: bh + 10 }),
            padding: '4px 8px',
            background: color,
            color: color === C.ink ? C.paper : '#fff',
            fontFamily: mono,
            fontWeight: 500,
            fontSize: 16,
            lineHeight: 1.15,
            whiteSpace: 'pre',
            opacity: tagN > 0 ? 1 : 0,
          }}
        >
          {tag.slice(0, Math.max(1, tagN))}
        </div>
      ) : null}
      {sub ? (
        <div
          style={{
            position: 'absolute',
            left: bw + 12,
            top: bh / 2 - 9,
            fontFamily: mono,
            fontSize: 14,
            color: C.muted,
            whiteSpace: 'pre',
          }}
        >
          {sub.slice(0, subN)}
        </div>
      ) : null}
    </div>
  );
};

/** Inverted label blocks (after the Replay film): each line a slab of ink that wipes on. */
export const Slabs: React.FC<{ lines: string[]; at: number; size?: number; out?: number; tone?: 'ink' | 'signal'; gap?: number; align?: 'left' | 'center' }> = ({
  lines,
  at,
  size = 40,
  out,
  tone = 'ink',
  gap = 8,
  align = 'left',
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'left' ? 'flex-start' : 'center', gap }}>
      {lines.map((l, i) => {
        const p = tw(frame, at + i * 5, at + i * 5 + 18, 0, 1, ease.out);
        const q = out === undefined ? 0 : tw(frame, out + i * 3, out + i * 3 + 12, 0, 1, ease.in);
        const t = tw(frame, at + i * 5 + 6, at + i * 5 + 6 + l.length * 0.8, 0, l.length, ease.linear);
        return (
          <div
            key={i}
            style={{
              padding: `${size * 0.18}px ${size * 0.32}px ${size * 0.14}px`,
              background: tone === 'ink' ? C.ink : C.signal,
              color: tone === 'ink' ? C.paper : '#fff',
              fontFamily: mono,
              fontWeight: 500,
              fontSize: size,
              lineHeight: 1.05,
              letterSpacing: '0.02em',
              whiteSpace: 'pre',
              clipPath: `inset(0 ${(1 - p) * 100}% 0 ${q * 100}%)`,
            }}
          >
            {l.slice(0, Math.floor(t)).padEnd(l.length, ' ')}
          </div>
        );
      })}
    </div>
  );
};

/** Scene section marker, e.g. "01  Listen" (the site's numbered section key). */
export const SectionKey: React.FC<{ n: string; t: string; at?: number; out?: number; style?: React.CSSProperties }> = ({ n, t, at = 0, out, style }) => {
  const frame = useCurrentFrame();
  const p = tw(frame, at, at + 22, 0, 1, ease.out);
  const q = out === undefined ? 0 : tw(frame, out, out + 12, 0, 1, ease.in);
  return (
    <div style={{ position: 'absolute', display: 'flex', gap: 14, alignItems: 'baseline', opacity: p * (1 - q), ...style }}>
      <Label size={17} color={C.signal}>
        {n}
      </Label>
      <div style={{ width: 40 * p, height: 1, background: C.ink, alignSelf: 'center' }} />
      <Label size={17} color={C.ink}>
        {t}
      </Label>
    </div>
  );
};

export const Fill: React.FC<{ color?: string; children?: React.ReactNode; style?: React.CSSProperties }> = ({ color = C.paper, children, style }) => (
  <AbsoluteFill style={{ background: color, ...style }}>{children}</AbsoluteFill>
);

export { Img };
