import { Audio, Video } from '@remotion/media';
import { loadFont as loadGeist } from '@remotion/google-fonts/Geist';
import { loadFont as loadGeistMono } from '@remotion/google-fonts/GeistMono';
import { loadFont as loadInstrumentSerif } from '@remotion/google-fonts/InstrumentSerif';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import type React from 'react';
import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { FADE, type Segment } from './plan';

// ---------------------------------------------------------------- type & colour

const sans = loadGeist('normal', { weights: ['400', '500', '600'], subsets: ['latin'] }).fontFamily;
const mono = loadGeistMono('normal', { weights: ['400', '500'], subsets: ['latin'] }).fontFamily;
const serif = loadInstrumentSerif('italic', { weights: ['400'], subsets: ['latin'] }).fontFamily;

const palette = {
  background: '#090807',
  text: '#f3ede4',
  textSoft: '#c4bcb0',
  textFaint: '#847c71',
  hairline: 'rgba(255,236,214,.12)',
  ember: '#ff6a2b',
  gold: '#ffcf8a',
} as const;

// ---------------------------------------------------------------- motion helpers

const easeOutExpo = Easing.bezier(0.16, 1, 0.3, 1);
const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
const held = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const appear = (frame: number, range: [number, number]) =>
  interpolate(frame, range, [0, 1], { ...held, easing: easeOutExpo });

const rise = (frame: number, range: [number, number], fromPx: number) =>
  interpolate(frame, range, [`0px ${fromPx}px`, '0px 0px'], { ...held, easing: easeOutExpo });

const coverStyle: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' };

// ---------------------------------------------------------------- composition

export type DemoProps = { segments: Segment[] };

export const Demo: React.FC<DemoProps> = ({ segments }) => {
  const track: React.ReactNode[] = [];
  segments.forEach((segment, i) => {
    if (i > 0) {
      track.push(
        <TransitionSeries.Transition
          key={`t${i}`}
          presentation={fade()}
          timing={linearTiming({ durationInFrames: FADE })}
        />,
      );
    }
    track.push(
      <TransitionSeries.Sequence
        key={`s${i}`}
        name={`${segment.kind}: ${segment.voice.id}`}
        durationInFrames={segment.frames}
      >
        <SegmentView segment={segment} />
      </TransitionSeries.Sequence>,
    );
  });

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background, fontFamily: sans }}>
      <TransitionSeries>{track}</TransitionSeries>
    </AbsoluteFill>
  );
};

/** The segment's voiceover, entering a third of a second after the cut. */
const Narration: React.FC<{ file: string }> = ({ file }) => {
  const { fps } = useVideoConfig();
  return (
    <Sequence from={Math.round(0.35 * fps)} name="voice" layout="none">
      <Audio src={staticFile(file)} />
    </Sequence>
  );
};

const SegmentView: React.FC<{ segment: Segment }> = ({ segment }) => {
  const { fps } = useVideoConfig();
  const narration = <Narration file={segment.voice.file} />;

  switch (segment.kind) {
    case 'hero':
      return (
        <AbsoluteFill>
          <Video src={staticFile(segment.src)} trimBefore={Math.round(segment.from * fps)} muted style={coverStyle} />
          {narration}
        </AbsoluteFill>
      );
    case 'idea':
      return <IdeaCard heroSrc={segment.heroSrc}>{narration}</IdeaCard>;
    case 'outro':
      return <EndCard>{narration}</EndCard>;
    case 'live':
      return (
        <ScreenWithCaption caption={segment.voice.text}>
          <Video
            src={staticFile(segment.src)}
            trimBefore={Math.round(segment.from * fps)}
            playbackRate={segment.rate}
            muted
            style={coverStyle}
          />
          {narration}
        </ScreenWithCaption>
      );
  }
};

// ---------------------------------------------------------------- scenes

const SCREEN_W = 1560;
const SCREEN_H = (SCREEN_W * 9) / 16;
const SCREEN_TOP = 42;

/** Live footage set into a rounded "screen", with the spoken line written beneath it. */
const ScreenWithCaption: React.FC<{ caption: string; children: React.ReactNode }> = ({ caption, children }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(70% 60% at 50% 110%, rgba(255,106,43,.18), transparent 70%), ${palette.background}`,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: (1920 - SCREEN_W) / 2,
          top: SCREEN_TOP,
          width: SCREEN_W,
          height: SCREEN_H,
          borderRadius: 26,
          overflow: 'hidden',
          border: `1px solid ${palette.hairline}`,
          boxShadow: '0 50px 120px -40px rgba(0,0,0,.9), 0 0 0 1px rgba(0,0,0,.6)',
        }}
      >
        {children}
      </div>
      <Interactive.Div
        name="Caption"
        style={{
          position: 'absolute',
          left: 120,
          right: 120,
          top: SCREEN_TOP + SCREEN_H + 28,
          textAlign: 'center',
          fontSize: 38,
          lineHeight: 1.25,
          letterSpacing: '-0.015em',
          color: palette.text,
          opacity: appear(frame, [6, 20]),
          translate: rise(frame, [6, 20], 10),
        }}
      >
        {caption}
      </Interactive.Div>
    </AbsoluteFill>
  );
};

/** The thesis, set large over a blurred, slowed copy of the hero horizon. */
const IdeaCard: React.FC<{ heroSrc: string; children: React.ReactNode }> = ({ heroSrc, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: '0 150px' }}>
      <Video
        src={staticFile(heroSrc)}
        trimBefore={4 * fps}
        playbackRate={0.5}
        muted
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          filter: 'blur(26px) brightness(.55)',
          scale: '1.15',
        }}
      />
      <AbsoluteFill
        style={{ background: 'linear-gradient(180deg, rgba(9,8,7,.55), rgba(9,8,7,.25) 50%, rgba(9,8,7,.7))' }}
      />
      <Interactive.Div
        name="Headline"
        style={{
          position: 'relative',
          fontSize: 128,
          fontWeight: 500,
          letterSpacing: '-0.05em',
          lineHeight: 0.98,
          color: palette.text,
          maxWidth: 1500,
          opacity: appear(frame, [4, 24]),
          translate: rise(frame, [4, 30], 30),
        }}
      >
        Continuity gives every conversation a{' '}
        <span style={{ fontFamily: serif, fontStyle: 'italic', color: palette.gold, letterSpacing: '-0.02em' }}>
          state.
        </span>
      </Interactive.Div>
      <Interactive.Div
        name="Subline"
        style={{
          position: 'relative',
          fontSize: 46,
          color: palette.textSoft,
          marginTop: 40,
          letterSpacing: '-0.02em',
          opacity: appear(frame, [Math.round(1.8 * fps), Math.round(2.4 * fps)]),
        }}
      >
        Any agent can pick it up.
      </Interactive.Div>
      {children}
    </AbsoluteFill>
  );
};

/** A glowing thread sweeps left to right carrying a bright point; the wordmark settles above it. */
const EndCard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sweepEnd = 1.6 * fps;
  const progress = interpolate(frame, [0, sweepEnd], [0, 1], { ...held, easing: easeInOut });
  const riderOpacity = progress < 1 ? 1 : interpolate(frame, [sweepEnd, 2.2 * fps], [1, 0], held);

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div
        style={{
          position: 'absolute',
          left: 160,
          right: 160,
          top: 640,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${palette.ember} 30%, ${palette.gold})`,
          transformOrigin: 'left',
          scale: `${progress} 1`,
          boxShadow: `0 0 18px ${palette.ember}`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 633,
          left: 160 + progress * 1600 - 8,
          width: 16,
          height: 16,
          background: '#fff3df',
          boxShadow: `0 0 26px ${palette.gold}`,
          opacity: riderOpacity,
        }}
      />
      <Interactive.Div
        name="Wordmark"
        style={{
          fontSize: 190,
          fontWeight: 600,
          letterSpacing: '-0.06em',
          color: palette.text,
          marginTop: -120,
          opacity: appear(frame, [0.6 * fps, 1.4 * fps]),
          translate: rise(frame, [0.6 * fps, sweepEnd], 24),
        }}
      >
        Continuity
      </Interactive.Div>
      <Interactive.Div
        name="Line"
        style={{
          fontFamily: serif,
          fontStyle: 'italic',
          fontSize: 64,
          color: palette.gold,
          marginTop: 6,
          opacity: appear(frame, [1.2 * fps, 2 * fps]),
        }}
      >
        One unbroken thread.
      </Interactive.Div>
      <Interactive.Div
        name="Url"
        style={{
          position: 'absolute',
          bottom: 110,
          fontFamily: mono,
          fontSize: 26,
          letterSpacing: '0.04em',
          color: palette.textFaint,
          opacity: appear(frame, [2 * fps, 2.6 * fps]),
        }}
      >
        built on Primitive · continuity-demo-tau.vercel.app
      </Interactive.Div>
      {children}
    </AbsoluteFill>
  );
};
