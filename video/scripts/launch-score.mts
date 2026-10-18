// Synthesises the launch film's soundtrack from the same timing sheet the picture uses, so every hit lands on its
// frame. Two stems (music, foley) and their mix go to public/launch/. Deterministic: same input, same file.
//   node scripts/launch-score.mts
import { mkdirSync, writeFileSync } from 'node:fs';
import * as T from '../src/launch/timing.ts';

const SR = 44100;
const DUR = T.TOTAL / T.FPS + 2.5;
const N = Math.ceil(DUR * SR);
const BEAT = 0.5;
const BAR = 2;
const S16 = BEAT / 4;

type Bus = { L: Float32Array; R: Float32Array };
const bus = (): Bus => ({ L: new Float32Array(N), R: new Float32Array(N) });
const music = bus();
const sfx = bus();
const verbSend = bus(); // shared reverb send

// ---------------------------------------------------------------- helpers

let seed = 0x9e3779b9;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const noise = () => rnd() * 2 - 1;
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const g = (scene: number, frame: number) => (T.START[scene] + frame) / T.FPS; // scene-local frame → seconds
const TAU = Math.PI * 2;

const add = (b: Bus, t0: number, len: number, fn: (t: number, i: number) => number, pan = 0, send = 0) => {
  const s0 = Math.max(0, Math.floor(t0 * SR));
  const n = Math.min(N - s0, Math.floor(len * SR));
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < n; i++) {
    const v = fn(i / SR, i);
    b.L[s0 + i] += v * gl;
    b.R[s0 + i] += v * gr;
    if (send) {
      verbSend.L[s0 + i] += v * gl * send;
      verbSend.R[s0 + i] += v * gr * send;
    }
  }
};

/** Zero-delay-feedback state-variable filter (Simper). Returns a stepper. */
const svf = () => {
  let ic1 = 0;
  let ic2 = 0;
  return (x: number, fc: number, q: number) => {
    const gg = Math.tan((Math.PI * Math.min(fc, SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + gg * (gg + k));
    const a2 = gg * a1;
    const a3 = gg * a2;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    return { lp: v2, bp: v1, hp: x - k * v1 - v2 };
  };
};

const expDecay = (t: number, tau: number) => Math.exp(-t / tau);
const attackDecay = (t: number, a: number, tau: number) => (t < a ? t / a : Math.exp(-(t - a) / tau));

// ---------------------------------------------------------------- instruments (music)

const kick = (t0: number, amp = 0.9) => {
  let ph = 0;
  add(music, t0, 0.6, (t) => {
    const f = 46 + 110 * Math.exp(-t / 0.035);
    ph += (TAU * f) / SR;
    const body = Math.sin(ph) * expDecay(t, 0.22);
    const click = t < 0.004 ? noise() * (1 - t / 0.004) * 0.3 : 0;
    return Math.tanh((body + click) * 1.6) * amp * 0.75;
  });
};

const hat = (t0: number, amp = 0.16, decay = 0.035, pan = 0.2) => {
  const f = svf();
  const f2 = svf();
  add(
    music,
    t0,
    decay * 6,
    (t) => {
      const n = noise();
      const h = f2(f(n, 7600, 0.8).hp, 9500, 0.9).hp;
      return h * expDecay(t, decay) * amp;
    },
    pan,
    0.05,
  );
};

const clap = (t0: number, amp = 0.32) => {
  const f = svf();
  add(
    music,
    t0,
    0.5,
    (t) => {
      const bursts = [0, 0.011, 0.022].reduce((a, o) => a + (t >= o && t < o + 0.008 ? 1 - (t - o) / 0.008 : 0), 0);
      const env = bursts * 0.6 + (t > 0.022 ? expDecay(t - 0.022, 0.12) : 0);
      return f(noise(), 1350, 1.4).bp * env * amp * 2.2;
    },
    -0.1,
    0.25,
  );
};

/** Soft FM pluck/bell. ratio 1 = woody pluck, 3.5 = bell. */
const fm = (b: Bus, t0: number, freq: number, amp: number, dur = 0.6, ratio = 2, index = 2.2, pan = 0, send = 0.2) => {
  let pc = 0;
  let pm = 0;
  add(
    b,
    t0,
    dur * 3,
    (t) => {
      pm += (TAU * freq * ratio) / SR;
      const idx = index * expDecay(t, dur * 0.3);
      pc += (TAU * freq) / SR;
      return Math.sin(pc + idx * Math.sin(pm)) * attackDecay(t, 0.003, dur * 0.45) * amp;
    },
    pan,
    send,
  );
};

/** Additive pad: soft harmonics, detuned pairs, slow swell. */
const pad = (t0: number, len: number, notes: number[], amp = 0.05, bright = 1, floor = 48) => {
  // voices below the floor are left to the bass, so the low mids stay clear
  const voices = notes.filter((m) => m >= floor).flatMap((m, i) => [
    { f: mtof(m) * Math.pow(2, 4 / 1200), pan: -0.4 + (i % 3) * 0.1 },
    { f: mtof(m) * Math.pow(2, -4 / 1200), pan: 0.4 - (i % 3) * 0.1 },
  ]);
  for (const v of voices) {
    const ph = [rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU];
    add(
      music,
      t0,
      len + 1.6,
      (t) => {
        const env = Math.min(1, t / 1.1) * (t > len ? Math.max(0, 1 - (t - len) / 1.6) : 1);
        let s = 0;
        for (let h = 1; h <= 5; h++) s += (Math.sin(TAU * v.f * h * t + ph[h - 1]) / Math.pow(h, 1.7 - 0.4 * bright)) * (h === 1 ? 1 : 0.7);
        return s * env * amp * (1 + 0.12 * Math.sin(TAU * 0.25 * t + v.f));
      },
      v.pan,
      0.35,
    );
  }
};

const bassNote = (t0: number, midi: number, len: number, amp = 0.34) => {
  const f = mtof(midi);
  let ph = 0;
  const lp = svf();
  add(music, t0, len + 0.05, (t) => {
    ph += (TAU * f) / SR;
    const env = Math.min(1, t / 0.004) * (t > len - 0.02 ? Math.max(0, 1 - (t - (len - 0.02)) / 0.07) : 1) * (0.7 + 0.3 * expDecay(t, 0.08));
    const raw = Math.tanh((Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph)) * 1.4);
    return lp(raw, 300 + 900 * expDecay(t, 0.05), 0.9).lp * env * amp;
  });
};

const sub = (t0: number, midi: number, len: number, amp = 0.3) => {
  const f = mtof(midi);
  add(music, t0, len, (t) => Math.sin(TAU * f * t) * Math.min(1, t / 0.02) * Math.min(1, (len - t) / 0.08) * amp);
};

/** A wide swell of filtered noise, for builds into the drop. */
const riser = (b: Bus, t0: number, len: number, amp = 0.2, f0 = 300, f1 = 7000) => {
  const fl = svf();
  const fr = svf();
  const s0 = Math.floor(t0 * SR);
  const n = Math.floor(len * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const p = i / n;
    const fc = f0 * Math.pow(f1 / f0, p * p);
    const e = Math.pow(p, 2.2) * amp;
    b.L[s0 + i] += fl(noise(), fc, 2.2).bp * e;
    b.R[s0 + i] += fr(noise(), fc * 1.03, 2.2).bp * e;
  }
};

// ---------------------------------------------------------------- foley (sfx)

const tick = (t0: number, amp = 0.16, tone = 2400, pan = 0) => {
  const f = svf();
  add(sfx, t0, 0.04, (t) => (f(noise(), tone, 2.5).bp * 2 + Math.sin(TAU * tone * 0.5 * t) * 0.3) * expDecay(t, 0.006) * amp, pan, 0.04);
};

const key = (t0: number, amp = 0.1) => {
  const f = svf();
  const tone = 1800 + rnd() * 1400;
  add(sfx, t0, 0.05, (t) => (f(noise(), tone, 1.8).bp * 2.4 + (t < 0.002 ? noise() * 0.6 : 0)) * expDecay(t, 0.009) * amp, (rnd() - 0.5) * 0.5, 0.03);
};

const clack = (t0: number, amp = 0.35) => {
  const f = svf();
  add(sfx, t0, 0.12, (t) => (f(noise(), 1100, 1.2).bp * 2 + Math.sin(TAU * 180 * t) * 0.5) * expDecay(t, 0.025) * amp, 0, 0.1);
};

const blip = (t0: number, freq: number, amp = 0.12, dur = 0.08, pan = 0) =>
  add(sfx, t0, dur * 4, (t) => Math.sin(TAU * freq * t) * attackDecay(t, 0.002, dur) * amp, pan, 0.15);

const lockOn = (t0: number, pan = 0) => {
  blip(t0, 1760, 0.07, 0.03, pan);
  blip(t0 + 0.055, 2637, 0.08, 0.05, pan);
  tick(t0, 0.12, 3200, pan);
};

const ding = (t0: number, midi: number, amp = 0.13) => fm(sfx, t0, mtof(midi), amp, 0.9, 3.5, 1.4, 0, 0.3);

const thump = (t0: number, amp = 0.32) => {
  let ph = 0;
  add(sfx, t0, 0.4, (t) => {
    ph += (TAU * (70 + 60 * Math.exp(-t / 0.03))) / SR;
    return Math.sin(ph) * expDecay(t, 0.09) * amp;
  });
};

const stamp = (t0: number, amp = 0.38) => {
  thump(t0, amp * 0.8);
  clack(t0, amp * 0.6);
};

const whoosh = (t0: number, len: number, amp = 0.22, up = true, panFrom = -0.6, panTo = 0.6) => {
  const fl = svf();
  const fr = svf();
  const s0 = Math.floor(t0 * SR);
  const n = Math.floor(len * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    if (s0 + i < 0) continue;
    const p = i / n;
    const fc = up ? 250 * Math.pow(24, p) : 6000 * Math.pow(1 / 24, p);
    const e = Math.pow(Math.sin(Math.PI * Math.pow(p, up ? 0.8 : 1.2)), 2) * amp;
    const pan = panFrom + (panTo - panFrom) * p;
    const v = fl(noise(), fc, 1.3).bp + fr(noise(), fc * 1.05, 1.3).bp * 0.5;
    sfx.L[s0 + i] += v * e * Math.cos(((pan + 1) * Math.PI) / 4);
    sfx.R[s0 + i] += v * e * Math.sin(((pan + 1) * Math.PI) / 4);
  }
};

/** Builds that accelerate into a cut (ease-in pushes). */
const swell = (t0: number, len: number, amp = 0.25) => {
  whoosh(t0, len, amp, true, 0, 0);
};

const glitch = (t0: number, len = 0.06, amp = 0.22) => {
  const f = 80 + rnd() * 900;
  const hold = 4 + Math.floor(rnd() * 20);
  let held = 0;
  add(sfx, t0, len, (t, i) => {
    if (i % hold === 0) held = Math.sign(Math.sin(TAU * f * t)) * 0.6 + noise() * 0.4;
    return held * amp * (1 - t / len);
  }, (rnd() - 0.5) * 0.6, 0.05);
};

const boom = (t0: number, amp = 0.7) => {
  let ph = 0;
  const lp = svf();
  add(sfx, t0, 3, (t) => {
    ph += (TAU * (32 + 40 * Math.exp(-t / 0.15))) / SR;
    return (Math.sin(ph) * expDecay(t, 0.7) + lp(noise(), 120, 0.7).lp * expDecay(t, 0.4) * 1.5) * amp;
  }, 0, 0.6);
};

const ring = (t0: number, len: number, amp = 0.025) =>
  add(sfx, t0, len, (t) => Math.sin(TAU * 3150 * t) * Math.min(1, t / 0.3) * Math.pow(1 - t / len, 2) * amp, 0.15);

const zip = (t0: number, len = 0.22, amp = 0.18) => {
  const f = svf();
  add(sfx, t0, len, (t) => f(noise(), 900 + 6000 * (t / len), 3).bp * Math.sin(Math.PI * (t / len)) * amp * 1.6, -0.3, 0.1);
};

const alert = (t0: number, amp = 0.14) => {
  fm(sfx, t0, mtof(57), amp, 0.25, 1, 3, 0, 0.2);
  fm(sfx, t0 + 0.13, mtof(56), amp, 0.35, 1, 3, 0, 0.2);
};

const deny = (t0: number, amp = 0.12) => {
  add(sfx, t0, 0.32, (t) => Math.sign(Math.sin(TAU * 110 * t)) * 0.5 * (t < 0.12 || t > 0.17 ? 1 : 0) * (1 - t / 0.32) * amp, 0, 0.1);
};

// ---------------------------------------------------------------- score

const AM9 = [45, 52, 55, 59, 60, 64];
const FMAJ7 = [41, 48, 52, 57, 60, 64];
const CMAJ7 = [48, 52, 55, 59, 62, 64];
const G6 = [43, 50, 55, 59, 62, 64];
const PROG = [
  { pad: AM9, root: 33, arp: [69, 72, 76, 79, 83, 79, 76, 72] },
  { pad: FMAJ7, root: 29, arp: [65, 69, 72, 76, 81, 76, 72, 69] },
  { pad: CMAJ7, root: 36, arp: [67, 71, 72, 76, 79, 76, 72, 71] },
  { pad: G6, root: 31, arp: [67, 71, 74, 76, 79, 76, 74, 71] },
];
const killAt = g(1, T.S02.enter);
const stopAt = g(1, T.S02.stop);
const dropAt = g(4, 0); // bar 10

// intro, bars 0–2 (+ the first beat of bar 3): heartbeat sub, clock, sparse arp, pad
pad(0, killAt - 0.2, AM9, 0.032, 0.6);
for (let b = 0; b < 4; b++) {
  for (let q = 0; q < 4; q++) {
    const t = b * BAR + q * BEAT;
    if (t >= killAt) continue;
    if (q === 0 || q === 2) kick(t, b === 0 ? 0.35 : 0.5);
    hat(t + BEAT / 2, 0.07 + b * 0.02, 0.025);
    if (b >= 1)
      for (let s = 0; s < 2; s++) {
        const tt = t + s * (BEAT / 2);
        if (tt < killAt) fm(music, tt, mtof(PROG[0].arp[(q * 2 + s) % 8]), 0.05 + b * 0.012, 0.35, 1, 1.6, ((q * 2 + s) % 2 ? 0.35 : -0.35), 0.3);
      }
  }
  if (b * BAR < killAt) bassNote(b * BAR, 33, 0.3, 0.22);
}

// the kill: music cuts out at the command; after the stop, a boom and a ring in the silence
boom(stopAt, 0.55);
ring(stopAt + 0.15, 3.2, 0.02);

// S03 (bars 5–7): a clock and a low drone; the clock races through the night
const s3 = g(2, 0);
pad(s3, 6 - 0.2, [33, 45, 52, 57], 0.04, 0.2, 0);
for (let q = 0; q < 12; q++) {
  const t = s3 + q * BEAT;
  tick(t, q % 2 ? 0.12 : 0.17, q % 2 ? 1500 : 2100, q % 2 ? 0.25 : -0.25);
  if (q % 4 === 0) {
    kick(t, 0.45);
    sub(t, 33, 1.6, 0.16);
  }
  if (q >= 4) hat(t + BEAT / 2, 0.06, 0.03);
}
for (let k = 0; k < 18; k++) tick(g(2, T.S03.finance + 4) + k * 0.075, 0.07 + 0.04 * (k / 18), 3000 + k * 60, (k % 2) - 0.5);

// S04 (bars 8–9): F → G, building into the drop with a riser and a snare roll
const s4 = g(3, 0);
pad(s4, 2, FMAJ7, 0.04, 0.9);
pad(s4 + 2, 1.75, G6, 0.045, 1);
riser(music, s4, 4 - 0.12, 0.2);
for (let s = 0; s < 32; s++) {
  const t = s4 + s * S16;
  if (s % 4 === 0 && s < 28) kick(t, 0.3 + (s / 32) * 0.35);
  if (s % 2 === 1) hat(t, 0.05 + (s / 32) * 0.08, 0.02);
  if (s % 4 === 2) bassNote(t, s < 16 ? 29 : 31, S16 * 1.6, 0.2);
  if (s >= 24 && s < 31) clap(t, 0.12 + ((s - 24) / 8) * 0.18);
}
for (let k = 0; k < 8; k++) clap(s4 + 3.5 + k * (S16 / 2), 0.08 + k * 0.025);

// the drop and the groove, bars 10–35
type Sec = { from: number; to: number; kick: boolean; clap: boolean; arp: number; bass: boolean; hats: number; padAmp: number };
const SECTIONS: Sec[] = [
  { from: 10, to: 12, kick: true, clap: true, arp: 0.05, bass: true, hats: 2, padAmp: 0.04 }, // S05 title
  { from: 12, to: 16, kick: true, clap: false, arp: 0, bass: true, hats: 1, padAmp: 0.032 }, // S06 listen
  { from: 16, to: 21, kick: true, clap: true, arp: 0.045, bass: true, hats: 2, padAmp: 0.036 }, // S07 resolve
  { from: 21, to: 24, kick: false, clap: false, arp: 0.035, bass: true, hats: 1, padAmp: 0.045 }, // S08 brief (breakdown)
  { from: 24, to: 28, kick: true, clap: false, arp: 0.03, bass: true, hats: 2, padAmp: 0.032 }, // S09 act
  { from: 28, to: 32, kick: true, clap: true, arp: 0.055, bass: true, hats: 2, padAmp: 0.036 }, // S10 close
  { from: 32, to: 36, kick: true, clap: true, arp: 0.06, bass: true, hats: 3, padAmp: 0.04 }, // S11 results
];
for (const sec of SECTIONS) {
  for (let bar = sec.from; bar < sec.to; bar++) {
    const ch = PROG[bar % 4];
    const t0 = bar * BAR;
    pad(t0, BAR - 0.05, ch.pad, sec.padAmp, 1);
    for (let s = 0; s < 16; s++) {
      const t = t0 + s * S16;
      if (sec.kick && s % 4 === 0) kick(t, 0.85);
      if (sec.clap && (s === 4 || s === 12)) clap(t, 0.3);
      if (s % 4 === 2) hat(t, 0.13, 0.04, 0.25);
      else if (sec.hats >= 2 && s % 2 === 1) hat(t, 0.045, 0.018, -0.2);
      else if (sec.hats >= 3 && s % 4 === 0) hat(t, 0.035, 0.015, 0.1);
      if (sec.bass && (s % 4 === 2 || (s === 15 && bar % 2 === 1))) bassNote(t, ch.root + (s === 15 ? 12 : 0), S16 * 1.7, 0.3);
      if (!sec.kick && sec.bass && s === 0) sub(t, ch.root + 12, BAR * 0.9, 0.12);
      if (sec.arp > 0 && s % 2 === 0) fm(music, t, mtof(ch.arp[(s / 2) % 8] + (bar >= 28 ? 12 : 0)), sec.arp, 0.28, 1, 1.8, s % 4 === 0 ? -0.4 : 0.4, 0.3);
    }
  }
}
// the drop itself: a stab and a wash
fm(music, dropAt, mtof(57), 0.16, 1.2, 1, 3);
fm(music, dropAt, mtof(64), 0.12, 1.2, 1, 3);
fm(music, dropAt, mtof(72), 0.1, 1.2, 1, 3);
whoosh(dropAt - 0.02, 1.4, 0.16, false, 0, 0);
sub(dropAt, 33, 1.4, 0.3);

// S12 finale, bars 36–39: pad and arp, then the bass returns with "The thread doesn't", then the last chord
const s12 = g(11, 0);
pad(s12, 3.2, AM9, 0.04, 0.8);
for (let s = 0; s < 26; s++) fm(music, s12 + s * S16 * 2, mtof(PROG[0].arp[s % 8]), 0.035, 0.3, 1, 1.4, s % 2 ? 0.4 : -0.4, 0.4);
const line2 = g(11, T.S12.line2);
for (let s = 0; s < 8; s++) bassNote(line2 + s * BEAT * 0.5, s % 4 === 3 ? 41 : 29, S16 * 1.6, 0.24);
const finalHit = g(11, T.S12.contract + 24);
pad(finalHit, 3.4, [36, 48, 52, 55, 59, 62, 67], 0.05, 1);
fm(music, finalHit, mtof(60), 0.14, 2.4, 1, 2.5, -0.2, 0.5);
fm(music, finalHit, mtof(67), 0.11, 2.4, 1, 2.5, 0.2, 0.5);
fm(music, finalHit, mtof(76), 0.09, 2.4, 3.5, 1.2, 0, 0.6);
kick(finalHit, 0.8);
sub(finalHit, 36, 2.2, 0.3);
whoosh(finalHit - 1.1, 1.1, 0.14, true, 0, 0);

// ---------------------------------------------------------------- foley cues, scene by scene

// 01 mid-deal
whoosh(g(0, 0), 0.7, 0.1, true, -0.8, 0.2);
blip(g(0, T.S01.agent), 1318, 0.08, 0.06);
T.S01.ev.forEach((f, i) => {
  tick(g(0, f), 0.16, 2600, -0.3 + i * 0.3);
  blip(g(0, f + 8), [988, 1175, 880][i], 0.05, 0.12, -0.3 + i * 0.3);
});
whoosh(g(0, T.S01.ev[2] - 26), 0.45, 0.08, false, 0.8, 0.2);
thump(g(0, T.S01.headline), 0.22);
swell(g(0, T.S01.push - 4), (T.S01.dur - T.S01.push + 4) / T.FPS, 0.22);

// 02 sigkill
'kill -9 48121'.split('').forEach((_, i) => key(g(1, T.S02.type + i * 2), 0.11));
clack(killAt, 0.4);
T.S02.cuts.forEach((f, i) => {
  glitch(g(1, f), 0.05 + rnd() * 0.04, 0.2 + (i % 3) * 0.05);
  if (i % 2 === 0) thump(g(1, f), 0.22);
});
thump(g(1, T.S02.headline), 0.2);

// 03 the deal doesn't wait
whoosh(g(2, T.S03.open), 0.5, 0.12, true, 0, 0);
blip(g(2, T.S03.zero), 659, 0.05, 0.1, 0.5);
ding(g(2, T.S03.finance), 76, 0.09);
whoosh(g(2, T.S03.pdf), 0.35, 0.06, true, -0.5, -0.2);
ding(g(2, T.S03.financeCheck), 81, 0.1);
ding(g(2, T.S03.financeCheck + 6), 88, 0.08);
ding(g(2, T.S03.correction), 72, 0.1);
zip(g(2, T.S03.underline), 0.5, 0.12);
lockOn(g(2, T.S03.quarantine), -0.4);
deny(g(2, T.S03.quarantine + 12), 0.08);
stamp(g(2, T.S03.headline), 0.32);
stamp(g(2, T.S03.headline + 5), 0.28);
whoosh(g(2, T.S03.collapse - 6), (T.S03.dur - T.S03.collapse + 6) / T.FPS, 0.14, false, 0, 0);

// 04 handoff
blip(g(3, T.S04.spawn), 523, 0.08, 0.08);
blip(g(3, T.S04.fill), 1047, 0.09, 0.06);
for (let k = 0; k < 40; k++) tick(g(3, T.S04.pills) + k * 0.03 + rnd() * 0.02, 0.025 + rnd() * 0.03, 2000 + rnd() * 3000, rnd() * 2 - 1);
thump(g(3, T.S04.head1), 0.2);
thump(g(3, T.S04.head2), 0.24);
whoosh(g(3, T.S04.converge), (T.S04.dur - T.S04.converge) / T.FPS, 0.16, false, 0, 0);

// 05 title
thump(g(4, 0), 0.3);
'Continuity'.split('').forEach((_, i) => tick(g(4, T.S05.word + 14 + i * 2.2), 0.05, 3000 + i * 120, -0.3 + i * 0.07));
blip(g(4, T.S05.tag), 1568, 0.04, 0.1);
swell(g(4, T.S05.through - 6), (T.S05.dur - T.S05.through + 6) / T.FPS, 0.2);

// 06 listen
riser(sfx, g(5, T.S06.scan), 84 / T.FPS, 0.05, 1200, 5000);
T.S06.locks.forEach((f, i) => {
  lockOn(g(5, f), -0.3 + i * 0.15);
  zip(g(5, f + 8), 0.25, 0.06);
  tick(g(5, f + 24), 0.06, 2200, 0.5);
});
thump(g(5, T.S06.headline), 0.22);
whoosh(g(5, T.S06.whip - 2), (T.S06.dur - T.S06.whip + 26) / T.FPS, 0.24, true, -0.7, 0.8);

// 07 resolve
const [st, ad, cf, ow, sl, nx] = T.S07.steps;
zip(g(6, st), 0.42, 0.16);
blip(g(6, ad), 1175, 0.07, 0.07);
alert(g(6, cf), 0.12);
blip(g(6, ow), 988, 0.06, 0.07);
blip(g(6, sl), 784, 0.06, 0.08);
tick(g(6, nx), 0.12, 2400);
blip(g(6, nx + 3), 1568, 0.06, 0.05);
[st, ad, cf, ow, sl].forEach((f) => tick(g(6, f + 2), 0.05, 4000, 0.6));
whoosh(g(6, T.S07.explode), 1.2, 0.14, true, -0.2, 0.2);
for (let i = 0; i < 5; i++) tick(g(6, T.S07.labels + (4 - i) * 8 + 14), 0.06, 2800 + i * 200, 0.6);
thump(g(6, T.S07.headline), 0.22);
whoosh(g(6, T.S07.collapse), (T.S07.dur - T.S07.collapse) / T.FPS, 0.14, false, 0.2, -0.2);

// 08 brief
'/tasks/PO-4817/context'.split('').forEach((_, i) => key(g(7, T.S08.type + (i * 60) / T.S08.cps), 0.08));
clack(g(7, T.S08.enter), 0.3);
ding(g(7, T.S08.enter + 4), 84, 0.06);
for (let i = 0; i < 7; i++) blip(g(7, T.S08.lines + i * T.S08.lineGap), mtof(69 + [0, 3, 7, 10, 12, 15, 19][i]), 0.045, 0.05, -0.3 + i * 0.1);
thump(g(7, T.S08.headline), 0.22);
whoosh(g(7, T.S08.out - 4), 0.5, 0.1, false, 0.4, -0.4);

// 09 act: typing, the connectors, the stamp, send
{
  const chars = T.AGENT_B_CHARS;
  for (let c = 0; c < chars; c += 2) {
    const f = T.S09.type + (c / chars) * (T.S09.typeEnd - T.S09.type);
    key(g(8, f) + rnd() * 0.015, 0.05 + rnd() * 0.03);
  }
  for (let i = 0; i < 3; i++) blip(g(8, T.S09.typeEnd + 4 + i * 7), mtof(76 + i * 3), 0.05, 0.06, 0.3);
  stamp(g(8, T.S09.stamp), 0.32);
  stamp(g(8, T.S09.stamp + 5), 0.28);
  clack(g(8, T.S09.send), 0.3);
  whoosh(g(8, T.S09.send + 8), (T.S09.dur - T.S09.send - 8) / T.FPS, 0.16, false, 0.6, -0.2);
}

// 10 close
whoosh(g(9, T.S10.reply - 6), 0.45, 0.09, false, 0.9, 0.3);
blip(g(9, T.S10.reply + 18), 880, 0.06, 0.08, 0.3);
T.S10.flips.forEach((f, i) => ding(g(9, f), [72, 76, 79, 83, 84][i], 0.08));
blip(g(9, T.S10.agentC), 523, 0.07, 0.08, 0.5);
blip(g(9, T.S10.agentC + 16), 1047, 0.08, 0.06, 0.5);
alert(g(9, T.S10.guard), 0.08);
whoosh(g(9, T.S10.card - 4), 0.4, 0.08, true, 0.2, 0.5);
clack(g(9, T.S10.approve), 0.3);
ding(g(9, T.S10.approve + 4), 84, 0.09);
ding(g(9, T.S10.approve + 8), 88, 0.08);
ding(g(9, T.S10.approve + 12), 91, 0.07);
thump(g(9, T.S10.headline), 0.24);

// 11 results
for (let k = 0; k < 60; k++) tick(g(10, T.S11.field) + k * 0.013, 0.02 + 0.03 * (k / 60), 2400 + k * 40, rnd() * 2 - 1);
for (let k = 0; k < 24; k++) tick(g(10, T.S11.count) + k * 0.066 * (1 + k / 30), 0.05, 3400, 0.4);
whoosh(g(10, T.S11.implode), (T.S11.landed - T.S11.implode) / T.FPS, 0.18, true, 0, 0);
thump(g(10, T.S11.landed), 0.32);
ding(g(10, T.S11.landed), 81, 0.1);
thump(g(10, T.S11.ratio), 0.2);
[0, 1, 2].forEach((order) => {
  const n = [3, 5, 6][order];
  for (let k = 0; k < n; k++) tick(g(10, T.S11.cells + order * 6 * T.S11.cellGap + k * T.S11.cellGap), 0.09, 1800 + k * 220 + order * 300, -0.2 + k * 0.08);
});
ding(g(10, T.S11.cells + 2 * 6 * T.S11.cellGap + 6 * T.S11.cellGap), 88, 0.1);

// 12 finale
thump(g(11, T.S12.line1), 0.22);
thump(g(11, T.S12.line2), 0.26);
whoosh(g(11, T.S12.contract - 8), 0.75, 0.12, false, -0.6, 0.6);
'Continuity'.split('').forEach((_, i) => tick(g(11, T.S12.word + i * 2.2), 0.04, 3000 + i * 120, -0.3 + i * 0.07));
blip(g(11, T.S12.by), 1568, 0.035, 0.12);

// ---------------------------------------------------------------- reverb, ducking, master

/** A small Freeverb-style room on the send bus. */
const reverb = (inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, wet = 0.32) => {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round((d * SR) / 44100));
  const aps = [556, 441, 341, 225].map((d) => Math.round((d * SR) / 44100));
  for (const [inp, out, spread] of [
    [inL, outL, 0],
    [inR, outR, 23],
  ] as const) {
    const cb = combs.map((d) => ({ buf: new Float32Array(d + spread), i: 0, store: 0 }));
    const ab = aps.map((d) => ({ buf: new Float32Array(d + spread), i: 0 }));
    const fb = 0.84;
    const damp = 0.3;
    for (let n = 0; n < N; n++) {
      const x = inp[n] * 0.015;
      let y = 0;
      for (const c of cb) {
        const o = c.buf[c.i];
        c.store = o * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * fb;
        c.i = (c.i + 1) % c.buf.length;
        y += o;
      }
      for (const a of ab) {
        const o = a.buf[a.i];
        a.buf[a.i] = y + o * 0.5;
        a.i = (a.i + 1) % a.buf.length;
        y = o - y;
      }
      out[n] += y * wet;
    }
  }
};

// the music ducks a little under each kick, and gates out at the kill
const duck = new Float32Array(N).fill(1);
const kickTimes: number[] = [];
for (const sec of SECTIONS) for (let bar = sec.from; bar < sec.to; bar++) if (sec.kick) for (let q = 0; q < 4; q++) kickTimes.push(bar * BAR + q * BEAT);
for (const t of kickTimes) {
  const s0 = Math.floor(t * SR);
  for (let i = 0; i < SR * 0.25 && s0 + i < N; i++) duck[s0 + i] = Math.min(duck[s0 + i], 1 - 0.3 * Math.exp(-i / (SR * 0.06)));
}
const gateFrom = Math.floor(killAt * SR);
const gateTo = Math.floor(g(2, 0) * SR);
for (let n = 0; n < N; n++) {
  let gate = 1;
  if (n >= gateFrom && n < gateTo) gate = Math.max(0, 1 - (n - gateFrom) / (SR * 0.012));
  music.L[n] *= duck[n] * gate;
  music.R[n] *= duck[n] * gate;
  if (n >= gateFrom && n < Math.floor(stopAt * SR)) {
    verbSend.L[n] *= 0.2;
    verbSend.R[n] *= 0.2;
  }
}

const wetL = new Float32Array(N);
const wetR = new Float32Array(N);
reverb(verbSend.L, verbSend.R, wetL, wetR, 0.9);

const writeWav = (path: string, L: Float32Array, R: Float32Array, gain: number) => {
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + N * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(N * 4, 40);
  for (let n = 0; n < N; n++) {
    // gentle limiter: soft knee via tanh above -3 dB
    const l = Math.tanh(L[n] * gain * 1.1) / 1.1;
    const r = Math.tanh(R[n] * gain * 1.1) / 1.1;
    const fade = Math.min(1, (N - n) / (SR * 1.5));
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l * fade)) * 32767), 44 + n * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r * fade)) * 32767), 46 + n * 4);
  }
  writeFileSync(path, buf);
};

const peak = (L: Float32Array, R: Float32Array) => {
  let p = 0;
  for (let n = 0; n < N; n++) p = Math.max(p, Math.abs(L[n]), Math.abs(R[n]));
  return p;
};

const mixL = new Float32Array(N);
const mixR = new Float32Array(N);
for (let n = 0; n < N; n++) {
  mixL[n] = music.L[n] * 0.9 + sfx.L[n] * 1.5 + wetL[n];
  mixR[n] = music.R[n] * 0.9 + sfx.R[n] * 1.5 + wetR[n];
}
const p = peak(mixL, mixR);
const gain = 0.89 / p;
const out = process.env.SCORE_OUT ?? 'public/launch';
mkdirSync(out, { recursive: true });
writeWav(`${out}/score.wav`, mixL, mixR, gain);
writeWav(`${out}/music.wav`, music.L, music.R, gain);
writeWav(`${out}/foley.wav`, sfx.L, sfx.R, gain);
console.log(`score: ${DUR.toFixed(1)} s, peak before gain ${p.toFixed(2)}, gain ${gain.toFixed(2)}`);
