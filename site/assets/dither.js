// Bayer-dithered light in WebGL.
//
// Every frame is a single fullscreen triangle. The fragment shader computes a scalar
// brightness per blocky cell, adds an 8×8 ordered-dither threshold and quantises to
// four palette entries. Two scenes:
//   'horizon' — a sunrise over a low horizon: cloud noise, a pointer-steered sun, a rippling reflection
//   'source'  — any 2D canvas (white-on-black) lit by a slow sweep plus the pointer
// The canvas is sized in CSS pixels, rendering stops while offscreen, and reduced motion
// gets one still frame per resize.

const VERTEX_SRC = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT_SRC = `
precision highp float;

uniform vec2  u_size;      // canvas size in device pixels
uniform float u_clock;     // seconds
uniform vec2  u_pointer;   // eased pointer, 0..1 with y up
uniform float u_scroll;    // 0..1, sinks the horizon as the page scrolls
uniform float u_cell;      // dither cell size in pixels
uniform vec3  u_pal0;
uniform vec3  u_pal1;
uniform vec3  u_pal2;
uniform vec3  u_pal3;
uniform sampler2D u_image;
uniform float u_mode;      // 0 = horizon, 1 = source
uniform float u_boost;

float rand2(vec2 v) {
  return fract(sin(dot(v, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise(vec2 v) {
  vec2 cellId = floor(v);
  vec2 f = fract(v);
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = rand2(cellId);
  float b = rand2(cellId + vec2(1.0, 0.0));
  float c = rand2(cellId + vec2(0.0, 1.0));
  float d = rand2(cellId + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

float octaves(vec2 v) {
  float sum = 0.0;
  float amp = 0.5;
  for (int k = 0; k < 5; k++) {
    sum += amp * valueNoise(v);
    v = v * 2.03 + 17.1;
    amp *= 0.5;
  }
  return sum;
}

// recursive Bayer matrix: 2x2 -> 4x4 -> 8x8
float threshold2(vec2 v) {
  v = floor(v);
  return fract(v.x / 2.0 + v.y * v.y * 0.75);
}
float threshold4(vec2 v) { return threshold2(0.5 * v) * 0.25 + threshold2(v); }
float threshold8(vec2 v) { return threshold4(0.5 * v) * 0.25 + threshold2(v); }

float horizonScene(vec2 uv, float aspect) {
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  float horizon = (aspect < 1.0 ? 0.15 : 0.255) - u_scroll * 0.2;
  vec2 sunPos = vec2((u_pointer.x - 0.5) * 0.18 * aspect, horizon - 0.015);
  float r = length((p - sunPos) * vec2(0.62, 1.9));

  float clouds = octaves(vec2(p.x * 1.4 + u_clock * 0.016, p.y * 4.6 - u_clock * 0.009));
  float wisps  = octaves(vec2(p.x * 3.2 - u_clock * 0.025, p.y * 10.0));

  float core  = exp(-r * 6.5) * 1.05;
  float glow  = exp(-r * 2.1) * 0.3;
  float strip = exp(-abs(p.y - horizon) * 38.0) * 0.75 * exp(-abs(p.x - sunPos.x) * 0.8);

  float sky = (core + glow + strip) * mix(0.55, 1.35, clouds);
  sky *= 1.0 - smoothstep(0.0, 0.7, p.y - horizon) * 0.7;
  sky += smoothstep(0.58, 1.0, wisps) * exp(-r * 2.2) * 0.4;

  float water = exp(-abs(p.x - sunPos.x) * 3.4) * (0.5 + 0.5 * sin(p.y * 260.0 + u_clock * 1.1 + clouds * 9.0));
  water *= exp(-(horizon - p.y) * 9.0) * 0.55 + strip * 0.5;

  return mix(water, sky, step(horizon, p.y)) * u_boost;
}

float sourceScene(vec2 uv, float aspect) {
  float ink = texture2D(u_image, vec2(uv.x, 1.0 - uv.y)).r;
  float sweep = 0.55 + 0.45 * sin(uv.x * 3.2 - u_clock * 0.55 + uv.y * 1.4);
  float spot = exp(-length((uv - u_pointer) * vec2(aspect, 1.0)) * 2.4);
  float grain = octaves(uv * vec2(aspect * 3.0, 3.0) + u_clock * 0.05);
  float lum = ink * (sweep * 0.75 + spot * 0.65 + 0.15) * mix(0.75, 1.15, grain);
  lum += (1.0 - ink) * spot * 0.05;
  return lum * u_boost;
}

void main() {
  vec2 block = floor(gl_FragCoord.xy / u_cell);
  vec2 uv = (block * u_cell + 0.5 * u_cell) / u_size;
  float aspect = u_size.x / u_size.y;

  float lum = u_mode < 0.5 ? horizonScene(uv, aspect) : sourceScene(uv, aspect);
  lum = clamp(lum, 0.0, 1.0);

  float level = floor(lum * 3.0 + threshold8(block) * 0.999) / 3.0;
  vec3 rgb = level < 0.2 ? u_pal0 : level < 0.5 ? u_pal1 : level < 0.9 ? u_pal2 : u_pal3;
  gl_FragColor = vec4(rgb, 1.0);
}
`;

const DEFAULTS = {
  scene: 'horizon',
  pixel: 3,
  gain: 1,
  palette: ['#090807', '#5c1e0a', '#ff6a2b', '#ffd9a0'],
  source: null,
};

const hexToRgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
const prefersStill = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function compile(gl, kind, text) {
  const shader = gl.createShader(kind);
  gl.shaderSource(shader, text);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(shader));
  return shader;
}

function buildProgram(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SRC));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
  gl.linkProgram(program);
  gl.useProgram(program);

  // one oversized triangle covers the viewport
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const attr = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(attr);
  gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);

  const names = ['u_size', 'u_clock', 'u_pointer', 'u_scroll', 'u_cell', 'u_pal0', 'u_pal1', 'u_pal2', 'u_pal3', 'u_image', 'u_mode', 'u_boost'];
  return Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)]));
}

/**
 * Attach a dithered renderer to `canvas`.
 * opts: { scene, pixel, gain, palette: [bg, c1, c2, c3], source: HTMLCanvasElement, onResize(w, h) }
 * Returns { set(key, value), destroy() }; set('prog', 0..1) drives the horizon's scroll sink.
 */
export function dither(canvas, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) {
    canvas.style.background = `radial-gradient(60% 50% at 50% 85%, ${cfg.palette[2]}55, transparent)`;
    return { set() {}, destroy() {} };
  }

  const loc = buildProgram(gl);

  let texture = null;
  function pushSource() {
    if (!cfg.source) return;
    texture ??= gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cfg.source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  pushSource();

  const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
  const born = performance.now();
  let scroll = 0;
  let onscreen = true;
  let rafId = 0;

  function paint(now) {
    // ease the light toward the pointer
    pointer.x += (pointer.tx - pointer.x) * 0.04;
    pointer.y += (pointer.ty - pointer.y) * 0.04;
    const [p0, p1, p2, p3] = cfg.palette.map(hexToRgb);
    gl.uniform2f(loc.u_size, canvas.width, canvas.height);
    gl.uniform1f(loc.u_clock, prefersStill() ? 12 : (now - born) / 1000);
    gl.uniform2f(loc.u_pointer, pointer.x, pointer.y);
    gl.uniform1f(loc.u_scroll, scroll);
    gl.uniform1f(loc.u_cell, cfg.pixel);
    gl.uniform1f(loc.u_mode, cfg.scene === 'source' ? 1 : 0);
    gl.uniform1f(loc.u_boost, cfg.gain);
    gl.uniform3fv(loc.u_pal0, p0);
    gl.uniform3fv(loc.u_pal1, p1);
    gl.uniform3fv(loc.u_pal2, p2);
    gl.uniform3fv(loc.u_pal3, p3);
    if (texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(loc.u_image, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function tick(now) {
    paint(now);
    rafId = onscreen && !prefersStill() ? requestAnimationFrame(tick) : 0;
  }

  function fit() {
    const box = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(box.width));
    canvas.height = Math.max(1, Math.round(box.height));
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (cfg.onResize) {
      cfg.onResize(canvas.width, canvas.height);
      pushSource();
    }
    if (prefersStill()) paint(performance.now());
  }

  function track(ev) {
    const box = canvas.getBoundingClientRect();
    pointer.tx = (ev.clientX - box.left) / box.width;
    pointer.ty = 1 - (ev.clientY - box.top) / box.height;
  }

  addEventListener('pointermove', track, { passive: true });
  const sizeWatch = new ResizeObserver(fit);
  sizeWatch.observe(canvas);
  const viewWatch = new IntersectionObserver(([entry]) => {
    onscreen = entry.isIntersecting;
    if (onscreen && !rafId) rafId = requestAnimationFrame(tick);
  });
  viewWatch.observe(canvas);

  fit();
  rafId = requestAnimationFrame(tick);

  return {
    set(key, value) {
      if (key === 'prog') scroll = value;
      else cfg[key] = value;
      if (key === 'source') pushSource();
    },
    destroy() {
      cancelAnimationFrame(rafId);
      sizeWatch.disconnect();
      viewWatch.disconnect();
      removeEventListener('pointermove', track);
    },
  };
}
