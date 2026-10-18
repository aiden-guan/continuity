// The launch film's design system: the site's datasheet tokens (site/assets/site.css), plus motion helpers.
import { loadFont as loadGeist } from '@remotion/google-fonts/Geist';
import { loadFont as loadGeistMono } from '@remotion/google-fonts/GeistMono';
import { Easing, interpolate, random } from 'remotion';

export const sans = loadGeist('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] }).fontFamily;
export const mono = loadGeistMono('normal', { weights: ['400', '500', '600'], subsets: ['latin'] }).fontFamily;

export const C = {
  paper: '#f3f2ee',
  paper2: '#eae8e2',
  surface: '#fbfaf8',
  ink: '#161513',
  ink2: '#44423d',
  muted: '#7b7871',
  faint: '#b5b2aa',
  line: 'rgba(22, 21, 19, 0.09)',
  line2: 'rgba(22, 21, 19, 0.17)',
  signal: '#e2501d',
  signalInk: '#b93c10',
  signalBg: 'rgba(226, 80, 29, 0.09)',
  ok: '#2c7a4b',
  okBg: 'rgba(44, 122, 75, 0.1)',
} as const;

export const W = 1920;
export const H = 1080;

export const ease = {
  out: Easing.bezier(0.16, 1, 0.3, 1), // expo-out: every entrance
  outQuart: Easing.bezier(0.25, 1, 0.5, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1), // camera moves
  in: Easing.bezier(0.7, 0, 0.84, 0), // exits
  snap: Easing.bezier(0.2, 0.95, 0.1, 1), // tracking boxes locking on
  linear: Easing.linear,
};

/** 0→1 (or from→to) between frames a and b, clamped. */
export const tw = (f: number, a: number, b: number, from = 0, to = 1, easing = ease.out) =>
  interpolate(f, [a, b], [from, to], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing });

/** Piecewise, clamped, one easing for every segment. */
export const keys = (f: number, at: number[], values: number[], easing = ease.inOut) =>
  interpolate(f, at, values, { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing });

export const rand = (seed: string | number) => random(seed);

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Hatching like a tracking box: diagonal hairlines. */
export const hatch = (color: string, gap = 7, width = 1.4, angle = 135) =>
  `repeating-linear-gradient(${angle}deg, ${color} 0 ${width}px, transparent ${width}px ${gap}px)`;

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
