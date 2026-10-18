// The site's dot grid, drawn on a canvas so it can react: a ring of displacement travels out from a hit (the kill,
// the drop, the final chord) and dots on its front darken — or, for `signal` ripples, flash orange.
import React, { useLayoutEffect, useRef } from 'react';
import { useCurrentFrame } from 'remotion';
import { C } from './theme';

export type Ripple = { x: number; y: number; at: number; strength?: number; speed?: number; width?: number; decay?: number; signal?: boolean };
export type Pull = { x: number; y: number; from: number; to: number; strength?: number };

export const DotField: React.FC<{ ripples?: Ripple[]; pulls?: Pull[]; step?: number; opacity?: number; size?: number }> = ({
  ripples = [],
  pulls = [],
  step = 24,
  opacity = 1,
  size = 2.2,
}) => {
  const frame = useCurrentFrame();
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 1920, 1080);
    const live = ripples
      .map((r) => ({ ...r, t: (frame - r.at) / 60 }))
      .filter((r) => r.t >= 0 && r.t < (r.decay ?? 0.9) * 5);
    for (let y = step / 2; y < 1080; y += step) {
      for (let x = step / 2; x < 1920; x += step) {
        let dx = 0;
        let dy = 0;
        let heat = 0;
        let hot = false;
        for (const r of live) {
          const ddx = x - r.x;
          const ddy = y - r.y;
          const dist = Math.hypot(ddx, ddy) || 1;
          const front = (r.speed ?? 1400) * r.t;
          const w = r.width ?? 70;
          const d = dist - front;
          const a = Math.exp(-(d * d) / (2 * w * w)) * Math.exp(-r.t / (r.decay ?? 0.9));
          const push = (r.strength ?? 14) * a;
          dx += (ddx / dist) * push;
          dy += (ddy / dist) * push;
          if (a > heat) {
            heat = a;
            hot = !!r.signal;
          }
        }
        for (const p of pulls) {
          const k = Math.max(0, Math.min(1, (frame - p.from) / (p.to - p.from)));
          if (k <= 0 || k >= 1) continue;
          const bell = Math.sin(Math.PI * k);
          const ddx = p.x - x;
          const ddy = p.y - y;
          const dist = Math.hypot(ddx, ddy) || 1;
          const m = Math.min(dist * 0.35, ((p.strength ?? 60) * bell * 600) / (dist + 300));
          dx += (ddx / dist) * m;
          dy += (ddy / dist) * m;
          heat = Math.max(heat, bell * 0.4 * Math.exp(-dist / 700));
        }
        const s = size * (1 + heat * 0.9);
        ctx.fillStyle = hot && heat > 0.12 ? `rgba(226, 80, 29, ${0.25 + 0.6 * heat})` : `rgba(22, 21, 19, ${0.17 + 0.45 * heat})`;
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, s / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [frame, ripples, pulls, step, size]);

  return <canvas ref={ref} width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, opacity, background: 'transparent', color: C.ink }} />;
};
