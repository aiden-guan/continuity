// The memory graph on the presenter's right half: what Continuity knows, as geometry.
//
//   emails (small dots, outer ring) ──stated in──▶ facts (ring around the deal) ──▶ the deal (hub)
//
// A fact that was replaced leaves a ghost behind it (history is kept, not overwritten). A hidden
// instruction is held outside the ring: linked to the email it came in, never to the deal. An agent
// appears below the deal; when it wakes, the facts travel into it (retrieval).
// Facts and the deal have fixed seats, so every run draws the same picture; the loose nodes (emails,
// ghosts, the hidden instruction) are nudged apart until no dot or label overlaps another. Motion is
// time-based easing, so it looks the same at any frame rate; the camera frames everything, or zooms
// onto a few nodes the way a note graph does.
const NS = 'http://www.w3.org/2000/svg';
const W = 1000;
const H = 820;
const HUB = { x: 500, y: 380 };
const FACT_R = 150;
const MAIL_R = 270;
// where each fact sits around the deal (degrees, 0 = right, y grows downward)
const FACT_AT = { price: 210, delivery: 270, quote: 330, owed: 30, order: 90, budget: 150 };
const AGENT_AT = { x: 500, y: 640 };
const BLOCKED_AT = { angle: 0, r: 290 };
const LOOSE = new Set(['mail', 'ghost', 'blocked']);
const GAP = 14; // the clear space kept around every dot and label

const rad = (deg) => (deg * Math.PI) / 180;
const polar = (deg, r) => ({ x: HUB.x + r * Math.cos(rad(deg)), y: HUB.y + r * Math.sin(rad(deg)) });
const make = (tag, attrs = {}, parent = null) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
};
const EASE = 'cubic-bezier(.22,1,.36,1)';

export function createGraph(svg) {
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = '';
  const cam = make('g', { class: 'cam' }, svg);
  const edgeLayer = make('g', { class: 'edges' }, cam);
  const flowLayer = make('g', { class: 'flows' }, cam);
  const nodeLayer = make('g', { class: 'nodes' }, cam);

  const nodes = new Map(); // id → { el, kind, x, y (drawn), hx, hy (home), tx, ty (after relaxing), box }
  const edges = new Map(); // "a>b" → { el, a, b }
  let view = { x: 0, y: 0, w: W, h: H };
  let viewTarget = { ...view };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let warm = false; // false until the first picture is drawn
  let focused = null;

  // ---------------------------------------------------------------- nodes
  function upsertNode(id, kind, home, from, draw) {
    let n = nodes.get(id);
    if (!n) {
      const el = make('g', { class: `n ${kind}`, 'data-n': id }, nodeLayer);
      // what is already known when the page opens is simply there; only news travels in
      const start = (warm && from) || home;
      n = { id, el, kind, x: start.x, y: start.y, hx: home.x, hy: home.y, tx: home.x, ty: home.y, phase: Math.random() * 6.28, parts: {} };
      nodes.set(id, n);
      if (warm) el.classList.add('enter');
    }
    n.hx = home.x;
    n.hy = home.y;
    n.seen = true;
    if (draw(n)) n.box = null; // redrawn: measure again
    return n;
  }

  /** Swap a label's text with a short rise-and-fade, so a change reads as a change. */
  function setText(t, text, animate) {
    if (t.textContent === text) return false;
    t.textContent = text;
    if (animate && !reduce) t.animate([{ opacity: 0, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: EASE });
    return true;
  }

  function factParts(n, right) {
    if (n.parts.dot) return n.parts;
    const dx = right ? 20 : -20;
    const anchor = right ? 'start' : 'end';
    n.parts.halo = make('circle', { class: 'halo', r: 22 }, n.el);
    n.parts.dot = make('circle', { class: 'dot', r: 10 }, n.el);
    n.parts.name = make('text', { class: 'name', x: dx, y: -8, 'text-anchor': anchor }, n.el);
    n.parts.value = make('text', { class: 'value', x: dx, y: 19, 'text-anchor': anchor }, n.el);
    return n.parts;
  }

  function drawFact(n, f, angle) {
    const born = !n.parts.dot;
    const p = factParts(n, Math.cos(rad(angle)) >= -0.2);
    n.el.setAttribute('class', `n fact ${f.tone ?? ''} ${f.state ?? ''} ${n.el.classList.contains('focus') ? 'focus' : ''}`);
    const a = setText(p.name, f.label, !born);
    const b = setText(p.value, f.value, !born);
    if (born && warm) setTimeout(() => ripple(n), 650);
    else if (a || b) pulse(n);
    return born || a || b;
  }

  function drawMail(n, m) {
    if (n.parts.dot) return false;
    n.el.setAttribute('class', `n mail ${m.out ? 'out' : ''}`);
    n.parts.dot = make('circle', { class: 'dot', r: m.out ? 5 : 6.5 }, n.el);
    if (m.pdf) make('rect', { class: 'pdf', x: 6, y: -13, width: 7, height: 9, rx: 1 }, n.el);
    return true;
  }

  function drawGhost(n, g) {
    if (n.parts.dot) return false;
    n.parts.dot = make('circle', { class: 'dot', r: 6 }, n.el);
    make('text', { class: 'value', x: g.right ? 12 : -12, y: 6, 'text-anchor': g.right ? 'start' : 'end' }, n.el).textContent = g.value;
    return true;
  }

  function drawHub(n, hub) {
    const key = JSON.stringify(hub.checks);
    if (!n.parts.core) {
      n.parts.halo = make('circle', { class: 'halo', r: 48 }, n.el);
      n.parts.core = make('circle', { class: 'core', r: 30 }, n.el);
      n.parts.arcs = make('g', {}, n.el);
      make('text', { class: 'hub-t', y: 4, 'text-anchor': 'middle' }, n.el).textContent = hub.label;
    }
    if (n.parts.key === key) return false;
    n.parts.key = key;
    // one arc per hard requirement around the deal: grey = not known yet, green = met, signal = broken
    const k = hub.checks.length;
    const arcs = [...n.parts.arcs.children];
    hub.checks.forEach((status, i) => {
      const a0 = -90 + (360 / k) * i + 5;
      const a1 = a0 + 360 / k - 10;
      const p0 = { x: 39 * Math.cos(rad(a0)), y: 39 * Math.sin(rad(a0)) };
      const p1 = { x: 39 * Math.cos(rad(a1)), y: 39 * Math.sin(rad(a1)) };
      const arc = arcs[i] ?? make('path', {}, n.parts.arcs);
      arc.setAttribute('d', `M${p0.x.toFixed(2)},${p0.y.toFixed(2)} A39,39 0 0 1 ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`);
      arc.setAttribute('class', `req ${status}`);
    });
    arcs.slice(k).forEach((arc) => arc.remove());
    return true;
  }

  function drawAgent(n, a) {
    if (!n.parts.body) {
      n.parts.body = make('rect', { class: 'body', x: -15, y: -15, width: 30, height: 30, rx: 7 }, n.el);
      n.parts.x = make('path', { class: 'x', d: 'M-9,-9L9,9M9,-9L-9,9' }, n.el);
      n.parts.name = make('text', { class: 'name', x: 26, y: -3 }, n.el);
      n.parts.sub = make('text', { class: 'value', x: 26, y: 16 }, n.el);
    }
    n.el.setAttribute('class', `n agent ${a.state} ${n.el.classList.contains('focus') ? 'focus' : ''}`);
    const renamed = setText(n.parts.name, a.label, warm);
    if (renamed) pulse(n);
    const sub = a.sub ?? '';
    if (n.parts.subText !== sub) {
      n.parts.subText = sub;
      countUp(n.parts.sub, sub);
      return true;
    }
    return renamed;
  }

  /** Numbers in a label count up to their value (a briefing size arriving reads as a measurement). */
  function countUp(t, text) {
    const m = text.match(/([\d,]{3,})/);
    if (!m || reduce || !warm) {
      t.textContent = text;
      return;
    }
    const target = Number(m[1].replace(/,/g, ''));
    const began = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - began) / 900);
      const eased = 1 - (1 - k) ** 3;
      t.textContent = text.replace(m[1], Math.round(target * eased).toLocaleString());
      if (k < 1 && t.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function drawBlocked(n, b) {
    if (n.parts.dot) return false;
    n.parts.halo = make('circle', { class: 'halo', r: 20 }, n.el);
    n.parts.dot = make('path', { class: 'dot', d: 'M0,-11L11,0L0,11L-11,0Z' }, n.el);
    make('text', { class: 'name', x: 20, y: -4 }, n.el).textContent = b.label;
    make('text', { class: 'value', x: 20, y: 16 }, n.el).textContent = b.value;
    if (warm) setTimeout(() => ripple(n), 650);
    return true;
  }

  function pulse(n) {
    const target = n.parts.dot ?? n.parts.core ?? n.parts.body;
    if (!target || reduce) return;
    target.animate([{ transform: 'scale(1.7)' }, { transform: 'scale(1)' }], { duration: 650, easing: EASE });
  }

  /** A ring that spreads out from a node once, when it first lands. */
  function ripple(n) {
    if (reduce || !nodes.has(n.id)) return;
    const ring = make('circle', { class: 'ripple', r: 10 }, n.el);
    ring.animate([{ r: '10px', opacity: 0.7 }, { r: '46px', opacity: 0 }], { duration: 1100, easing: EASE }).finished.then(() => ring.remove());
  }

  // ---------------------------------------------------------------- edges
  function upsertEdge(a, b, kind) {
    const id = `${a}>${b}`;
    let e = edges.get(id);
    if (!e) {
      e = { id, a, b, el: make('line', { class: `e ${kind}` }, edgeLayer) };
      if (warm) e.el.classList.add('enter');
      edges.set(id, e);
    }
    e.el.setAttribute('class', `e ${kind}${e.el.classList.contains('enter') ? ' enter' : ''}`);
    e.seen = true;
    return e;
  }

  // ---------------------------------------------------------------- layout: nothing overlaps
  /** The node's dot and label as a rectangle at its target position (measured once per drawing). */
  function rect(n) {
    if (!n.box) {
      const b = n.el.getBBox();
      n.box = { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    return { x0: n.tx + n.box.x - GAP / 2, y0: n.ty + n.box.y - GAP / 2, x1: n.tx + n.box.x + n.box.w + GAP / 2, y1: n.ty + n.box.y + n.box.h + GAP / 2 };
  }

  /** Push loose nodes out of anything they overlap; a weak pull keeps each one near its seat. */
  function relax() {
    const all = [...nodes.values()];
    for (const n of all) {
      n.tx = n.hx;
      n.ty = n.hy;
    }
    const loose = all.filter((n) => LOOSE.has(n.kind));
    for (let iter = 0; iter < 80; iter++) {
      let moved = false;
      for (const a of loose) {
        for (const b of all) {
          if (a === b) continue;
          const A = rect(a);
          const B = rect(b);
          const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
          const oy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          const share = LOOSE.has(b.kind) ? 0.5 : 1;
          // leave along the shorter way out, away from the other node's centre
          if (ox < oy) {
            const dir = (A.x0 + A.x1) / 2 >= (B.x0 + B.x1) / 2 ? 1 : -1;
            a.tx += dir * ox * share;
            if (share < 1) b.tx -= dir * ox * share;
          } else {
            const dir = (A.y0 + A.y1) / 2 >= (B.y0 + B.y1) / 2 ? 1 : -1;
            a.ty += dir * oy * share;
            if (share < 1) b.ty -= dir * oy * share;
          }
        }
        a.tx += (a.hx - a.tx) * 0.02;
        a.ty += (a.hy - a.ty) * 0.02;
      }
      if (!moved) break;
    }
  }

  // ---------------------------------------------------------------- the model → the picture
  /**
   * model: { hub, facts: [{id,label,value,tone,state,src:[evId],old}], mails: [{id,out,pdf,by,facts:[id]}],
   *          blocked: [{id,label,value,src}], agent: {id,label,sub,state} | null }
   */
  function update(model) {
    for (const n of nodes.values()) n.seen = false;
    for (const e of edges.values()) e.seen = false;
    if (!model) {
      sweep();
      warm = false;
      return;
    }

    upsertNode('deal', 'hub', HUB, null, (n) => drawHub(n, model.hub));

    // inbound emails gather beyond the facts they support; ours sit beside the agent that wrote them
    const placed = [];
    const outbound = model.mails.filter((m) => m.out);
    model.mails.filter((m) => !m.out).forEach((m, i) => {
      const angles = m.facts.map((f) => FACT_AT[f]).filter((a) => a != null);
      let angle = angles.length ? meanAngle(angles) : 180 + i * 14;
      while (placed.some((p) => Math.abs(angleDiff(p, angle)) < 12)) angle += 12;
      placed.push(angle);
      m.angle = angle;
    });
    for (const m of model.mails) {
      const k = outbound.indexOf(m);
      const home = m.out ? { x: AGENT_AT.x - 70 - k * 30, y: AGENT_AT.y + 50 } : polar(m.angle, MAIL_R);
      // new mail travels in from the inbox side of the screen, across the seam
      upsertNode(m.id, 'mail', home, { x: -80, y: home.y }, (n) => drawMail(n, m));
    }

    for (const f of model.facts) {
      const angle = FACT_AT[f.id] ?? 0;
      const src = f.src.find((id) => nodes.has(id));
      const from = src ? nodes.get(src) : HUB;
      upsertNode(f.id, 'fact', polar(angle, FACT_R), { x: from.x, y: from.y }, (n) => drawFact(n, f, angle));
      upsertEdge(f.id, 'deal', `fact-hub ${f.tone ?? ''}`);
      for (const id of f.src) if (nodes.has(id)) upsertEdge(id, f.id, 'mail-fact');
      if (f.old) {
        // the replaced value stays, further out, linked to what replaced it
        const ghostId = `${f.id}:was`;
        const right = Math.cos(rad(angle)) >= -0.2;
        const gAngle = angle + (right ? -22 : 22);
        upsertNode(ghostId, 'ghost', polar(gAngle, FACT_R + 110), polar(angle, FACT_R), (n) => drawGhost(n, { value: f.old, right }));
        upsertEdge(ghostId, f.id, 'ghost');
      }
    }

    for (const b of model.blocked) {
      upsertNode(b.id, 'blocked', polar(BLOCKED_AT.angle, BLOCKED_AT.r), nodes.get(b.src) ?? null, (n) => drawBlocked(n, b));
      if (nodes.has(b.src)) upsertEdge(b.src, b.id, 'blocked');
    }

    if (model.agent) {
      upsertNode('agent', 'agent', AGENT_AT, { x: AGENT_AT.x, y: AGENT_AT.y + 160 }, (n) => drawAgent(n, model.agent));
      for (const m of outbound) if (m.by === model.agent.id) upsertEdge('agent', m.id, 'wrote');
    }
    sweep();
    relax();
    viewTarget = focused ? fitView(focused.map((id) => nodes.get(id)).filter(Boolean), 90, 640) : fitView([...nodes.values()], 40, 540);
    if (!warm) {
      view = { ...viewTarget };
      for (const n of nodes.values()) {
        n.x = n.tx;
        n.y = n.ty;
      }
    }
    warm = true;
  }

  function sweep() {
    for (const [id, n] of nodes) if (!n.seen) { n.el.remove(); nodes.delete(id); }
    for (const [id, e] of edges) if (!e.seen || !nodes.has(e.a) || !nodes.has(e.b)) { e.el.remove(); edges.delete(id); }
  }

  // ---------------------------------------------------------------- retrieval
  /** The agent asks for its context: from every fact a spark travels down a fresh line into the agent. */
  function retrieve() {
    const agent = nodes.get('agent');
    if (!agent) return;
    const facts = [...nodes.values()].filter((n) => n.kind === 'fact');
    focus(['agent', 'deal', ...facts.map((f) => f.id)]);
    const stagger = 140;
    facts.forEach((f, i) => {
      setTimeout(() => {
        if (!nodes.has(f.id)) return;
        pulse(f);
        const len = Math.hypot(agent.tx - f.tx, agent.ty - f.ty);
        const line = make('line', { class: 'flow', x1: f.tx, y1: f.ty, x2: agent.tx, y2: agent.ty }, flowLayer);
        line.style.strokeDasharray = `${len}`;
        const spark = make('circle', { class: 'spark', r: 5 }, flowLayer);
        const dur = reduce ? 0 : 700;
        line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: dur, easing: EASE, fill: 'forwards' });
        spark.animate([
          { transform: `translate(${f.tx}px,${f.ty}px)`, opacity: 1 },
          { transform: `translate(${agent.tx}px,${agent.ty}px)`, opacity: 1 },
        ], { duration: dur, easing: EASE, fill: 'forwards' }).finished.then(() => {
          spark.remove();
          pulse(agent);
        });
        line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, delay: dur + 600, easing: 'ease-out', fill: 'forwards' }).finished.then(() => line.remove());
      }, i * stagger);
    });
  }

  // ---------------------------------------------------------------- camera
  /** Zoom onto a set of nodes; nothing (or unknown ids) frames the whole graph. */
  function focus(ids) {
    const list = (ids ?? []).map((id) => nodes.get(id)).filter(Boolean);
    svg.querySelectorAll('.n.focus').forEach((el) => el.classList.remove('focus'));
    if (!list.length) {
      unfocus();
      return false;
    }
    focused = list.map((n) => n.id);
    viewTarget = fitView(list, 90, 640);
    for (const n of list) n.el.classList.add('focus');
    svg.classList.add('focusing');
    return true;
  }
  function unfocus() {
    svg.querySelectorAll('.n.focus').forEach((el) => el.classList.remove('focus'));
    svg.classList.remove('focusing');
    focused = null;
    viewTarget = fitView([...nodes.values()], 40, 540);
  }

  /** The view box that frames these nodes, labels included, never tighter than `minW` units wide. */
  function fitView(list, pad, minW) {
    if (!list.length) return { x: 0, y: 0, w: W, h: H };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of list) {
      const r = rect(n);
      x0 = Math.min(x0, r.x0);
      y0 = Math.min(y0, r.y0);
      x1 = Math.max(x1, r.x1);
      y1 = Math.max(y1, r.y1);
    }
    const ratio = svg.clientWidth && svg.clientHeight ? svg.clientWidth / svg.clientHeight : W / H;
    let w = Math.max(x1 - x0 + pad * 2, minW);
    let h = y1 - y0 + pad * 2;
    w = Math.max(w, h * ratio);
    h = w / ratio;
    return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
  }

  // ---------------------------------------------------------------- frame loop (time-based easing)
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - last);
    last = now;
    const kn = reduce ? 1 : 1 - Math.exp(-dt / 170); // nodes settle in about half a second
    const kc = reduce ? 1 : 1 - Math.exp(-dt / 320); // the camera a little slower
    for (const n of nodes.values()) {
      const drift = reduce || n.kind === 'hub' ? 0 : 2;
      const ox = Math.sin(now / 2600 + n.phase) * drift;
      const oy = Math.cos(now / 3100 + n.phase) * drift;
      n.x += (n.tx + ox - n.x) * kn;
      n.y += (n.ty + oy - n.y) * kn;
      n.el.setAttribute('transform', `translate(${n.x.toFixed(2)},${n.y.toFixed(2)})`);
    }
    for (const e of edges.values()) {
      const a = nodes.get(e.a);
      const b = nodes.get(e.b);
      if (!a || !b) continue;
      e.el.setAttribute('x1', a.x.toFixed(2));
      e.el.setAttribute('y1', a.y.toFixed(2));
      e.el.setAttribute('x2', b.x.toFixed(2));
      e.el.setAttribute('y2', b.y.toFixed(2));
    }
    view = {
      x: view.x + (viewTarget.x - view.x) * kc,
      y: view.y + (viewTarget.y - view.y) * kc,
      w: view.w + (viewTarget.w - view.w) * kc,
      h: view.h + (viewTarget.h - view.h) * kc,
    };
    svg.setAttribute('viewBox', `${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}`);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // the panel can change size (the approval card takes room): keep everything framed
  new ResizeObserver(() => {
    if (!nodes.size) return;
    viewTarget = focused ? fitView(focused.map((id) => nodes.get(id)).filter(Boolean), 90, 640) : fitView([...nodes.values()], 40, 540);
  }).observe(svg);

  return { update, focus, unfocus, retrieve, has: (id) => nodes.has(id) };
}

function meanAngle(list) {
  const x = list.reduce((s, a) => s + Math.cos(rad(a)), 0);
  const y = list.reduce((s, a) => s + Math.sin(rad(a)), 0);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
function angleDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}
