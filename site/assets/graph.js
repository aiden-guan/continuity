// The memory graph on the presenter's right half: what Continuity knows, as geometry.
//
//   emails (small dots, outer ring) ──stated in──▶ facts (ring around the deal) ──▶ the deal (hub)
//
// A fact that was replaced leaves a ghost behind it (history is kept, not overwritten). A hidden
// instruction is held outside the ring: linked to the email it came in, never to the deal. An agent
// appears below the deal; when it wakes, the facts flow into it along fresh edges (retrieval).
// Nodes ease toward fixed positions, so every run draws the same picture; the camera can zoom onto a
// node the way a note graph does.
const NS = 'http://www.w3.org/2000/svg';
const W = 1000;
const H = 820;
const HUB = { x: 500, y: 380 };
const FACT_R = 150;
const MAIL_R = 265;
// where each fact sits around the deal (degrees, 0 = right, y grows downward)
const FACT_AT = { price: 210, delivery: 270, quote: 330, owed: 30, order: 90, budget: 150 };
const AGENT_AT = { x: 500, y: 640 };
const BLOCKED_AT = { angle: 0, r: 285 };

const polar = (deg, r) => ({ x: HUB.x + r * Math.cos((deg * Math.PI) / 180), y: HUB.y + r * Math.sin((deg * Math.PI) / 180) });
const make = (tag, attrs = {}, parent = null) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
};

export function createGraph(svg) {
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = '';
  const cam = make('g', { class: 'cam' }, svg);
  const edgeLayer = make('g', { class: 'edges' }, cam);
  const flowLayer = make('g', { class: 'flows' }, cam);
  const nodeLayer = make('g', { class: 'nodes' }, cam);

  const nodes = new Map(); // id → { el, x, y, tx, ty, kind, born }
  const edges = new Map(); // "a>b" → { el, a, b }
  let view = { x: 0, y: 0, w: W, h: H };
  let viewTarget = { ...view };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let warm = false; // false until the first picture is drawn

  // ---------------------------------------------------------------- nodes
  function upsertNode(id, kind, target, from, draw) {
    let n = nodes.get(id);
    if (!n) {
      const el = make('g', { class: `n ${kind}`, 'data-n': id }, nodeLayer);
      // what is already known when the page opens is simply there; only news flies in
      const start = (warm && from) || target;
      n = { id, el, kind, x: start.x, y: start.y, tx: target.x, ty: target.y, born: performance.now(), phase: Math.random() * 6.28 };
      nodes.set(id, n);
      el.classList.add('enter');
    }
    n.tx = target.x;
    n.ty = target.y;
    n.seen = true;
    draw(n);
    return n;
  }

  /** A dot with a two-line label (name, value) on the outer side of the node. */
  function drawFact(n, f, angle) {
    const key = JSON.stringify([f.label, f.value, f.tone, f.state]);
    if (n.key === key) return;
    const changed = n.key != null;
    n.key = key;
    n.el.setAttribute('class', `n fact ${f.tone ?? ''} ${f.state ?? ''}`);
    n.el.innerHTML = '';
    make('circle', { class: 'halo', r: 22 }, n.el);
    make('circle', { class: 'dot', r: 10 }, n.el);
    const right = Math.cos((angle * Math.PI) / 180) >= -0.2;
    const dx = right ? 20 : -20;
    const anchor = right ? 'start' : 'end';
    const name = make('text', { class: 'name', x: dx, y: -8, 'text-anchor': anchor }, n.el);
    name.textContent = f.label;
    const value = make('text', { class: 'value', x: dx, y: 19, 'text-anchor': anchor }, n.el);
    value.textContent = f.value;
    if (changed) pulse(n);
  }

  function drawMail(n, m) {
    if (n.key) return;
    n.key = 'mail';
    n.el.setAttribute('class', `n mail ${m.out ? 'out' : ''}`);
    make('circle', { class: 'dot', r: m.out ? 5 : 6.5 }, n.el);
    if (m.pdf) make('rect', { class: 'pdf', x: 6, y: -13, width: 7, height: 9, rx: 1 }, n.el);
  }

  function drawGhost(n, g) {
    if (n.key) return;
    n.key = 'ghost';
    make('circle', { class: 'dot', r: 6 }, n.el);
    const right = g.right;
    const t = make('text', { class: 'value', x: right ? 12 : -12, y: 4, 'text-anchor': right ? 'start' : 'end' }, n.el);
    t.textContent = g.value;
  }

  function drawHub(n, hub) {
    const key = JSON.stringify(hub);
    if (n.key === key) return;
    n.key = key;
    n.el.innerHTML = '';
    make('circle', { class: 'halo', r: 48 }, n.el);
    make('circle', { class: 'core', r: 30 }, n.el);
    // one arc per hard requirement around the deal: ink = unknown, green = met, signal = broken
    const k = hub.checks.length;
    const gap = 10;
    hub.checks.forEach((status, i) => {
      const a0 = -90 + (360 / k) * i + gap / 2;
      const a1 = a0 + 360 / k - gap;
      const p0 = { x: 38 * Math.cos((a0 * Math.PI) / 180), y: 38 * Math.sin((a0 * Math.PI) / 180) };
      const p1 = { x: 38 * Math.cos((a1 * Math.PI) / 180), y: 38 * Math.sin((a1 * Math.PI) / 180) };
      make('path', { class: `req ${status}`, d: `M${p0.x},${p0.y} A38,38 0 0 1 ${p1.x},${p1.y}` }, n.el);
    });
    const t = make('text', { class: 'hub-t', y: 4, 'text-anchor': 'middle' }, n.el);
    t.textContent = hub.label;
  }

  function drawAgent(n, a) {
    const key = JSON.stringify(a);
    if (n.key === key) return;
    n.key = key;
    n.el.setAttribute('class', `n agent ${a.state}`);
    n.el.innerHTML = '';
    make('rect', { class: 'body', x: -15, y: -15, width: 30, height: 30, rx: 7 }, n.el);
    if (a.state === 'killed') make('path', { class: 'x', d: 'M-9,-9L9,9M9,-9L-9,9' }, n.el);
    const name = make('text', { class: 'name', x: 26, y: -3 }, n.el);
    name.textContent = a.label;
    const sub = make('text', { class: 'value', x: 26, y: 15 }, n.el);
    sub.textContent = a.sub ?? '';
  }

  function drawBlocked(n, b) {
    if (n.key) return;
    n.key = 'blocked';
    make('circle', { class: 'halo', r: 20 }, n.el);
    make('path', { class: 'dot', d: 'M0,-11L11,0L0,11L-11,0Z' }, n.el);
    const name = make('text', { class: 'name', x: 20, y: -4 }, n.el);
    name.textContent = b.label;
    const value = make('text', { class: 'value', x: 20, y: 14 }, n.el);
    value.textContent = b.value;
  }

  function pulse(n) {
    n.el.classList.remove('pulse');
    void n.el.getBBox();
    n.el.classList.add('pulse');
  }

  // ---------------------------------------------------------------- edges
  function upsertEdge(a, b, kind) {
    const id = `${a}>${b}`;
    let e = edges.get(id);
    if (!e) {
      e = { id, a, b, el: make('line', { class: `e ${kind}` }, edgeLayer) };
      e.el.classList.add('enter');
      edges.set(id, e);
    }
    e.el.setAttribute('class', `e ${kind}`);
    e.seen = true;
    return e;
  }

  // ---------------------------------------------------------------- the model → the picture
  /**
   * model: { hub, facts: [{id,label,value,tone,state,src:[evId],old}], mails: [{id,out,pdf,facts:[id]}],
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

    const hub = upsertNode('deal', 'hub', HUB, null, (n) => drawHub(n, model.hub));

    // emails: inbound ones gather near the facts they support; ours sit along the lower arc
    const placed = [];
    const inbound = model.mails.filter((m) => !m.out);
    const outbound = model.mails.filter((m) => m.out);
    inbound.forEach((m, i) => {
      const angles = m.facts.map((f) => FACT_AT[f]).filter((a) => a != null);
      let angle = angles.length ? meanAngle(angles) : 180 + i * 14;
      while (placed.some((p) => Math.abs(angleDiff(p, angle)) < 13)) angle += 13;
      placed.push(angle);
      m.angle = angle;
    });
    for (const m of model.mails) {
      // new mail flies in from the inbox side, across the seam; what our agents sent sits beside them
      const k = outbound.indexOf(m);
      const at = m.out ? { x: AGENT_AT.x - 95 - k * 34, y: AGENT_AT.y + (k % 2 ? 22 : -10) } : polar(m.angle, MAIL_R);
      upsertNode(m.id, 'mail', at, { x: -60, y: at.y }, (n) => drawMail(n, m));
    }

    for (const f of model.facts) {
      const angle = FACT_AT[f.id] ?? 0;
      const src = f.src.find((id) => nodes.has(id));
      const from = src ? nodes.get(src) : HUB;
      upsertNode(f.id, 'fact', polar(angle, FACT_R), { x: from.x, y: from.y }, (n) => drawFact(n, f, angle));
      upsertEdge(f.id, 'deal', `fact-hub ${f.tone ?? ''}`);
      for (const id of f.src) if (nodes.has(id)) upsertEdge(id, f.id, 'mail-fact');
      if (f.old) {
        // the replaced value stays, one step further out, linked to what replaced it
        const ghostId = `${f.id}:was`;
        const gAngle = angle + (Math.cos((angle * Math.PI) / 180) >= -0.2 ? -24 : 24);
        upsertNode(ghostId, 'ghost', polar(gAngle, FACT_R + 105), polar(angle, FACT_R), (n) => drawGhost(n, { value: f.old, right: Math.cos((gAngle * Math.PI) / 180) >= -0.2 }));
        upsertEdge(ghostId, f.id, 'ghost');
      }
    }

    for (const b of model.blocked) {
      upsertNode(b.id, 'blocked', polar(BLOCKED_AT.angle, BLOCKED_AT.r), nodes.get(b.src) ?? null, (n) => drawBlocked(n, b));
      if (nodes.has(b.src)) upsertEdge(b.src, b.id, 'blocked');
    }

    if (model.agent) {
      upsertNode('agent', 'agent', AGENT_AT, { x: AGENT_AT.x, y: H + 60 }, (n) => drawAgent(n, model.agent));
      for (const m of outbound) if (m.by === model.agent.id) upsertEdge('agent', m.id, 'wrote');
    }
    void hub;
    sweep();
    if (!focused) viewTarget = fitView([...nodes.values()], 40, 520);
    if (!warm) view = { ...viewTarget };
    warm = true;
  }

  function sweep() {
    for (const [id, n] of nodes) if (!n.seen) { n.el.remove(); nodes.delete(id); }
    for (const [id, e] of edges) if (!e.seen || !nodes.has(e.a) || !nodes.has(e.b)) { e.el.remove(); edges.delete(id); }
  }

  // ---------------------------------------------------------------- retrieval
  /** The agent asks for its context: every fact sends a pulse down a fresh edge into the agent. */
  async function retrieve() {
    const agent = nodes.get('agent');
    if (!agent) return;
    const facts = [...nodes.values()].filter((n) => n.kind === 'fact' || n.kind === 'hub');
    focus(['agent', 'deal', ...facts.map((f) => f.id)]);
    for (const [i, f] of facts.entries()) {
      setTimeout(() => {
        const line = make('line', { class: 'flow', x1: f.x, y1: f.y, x2: agent.x, y2: agent.y }, flowLayer);
        const len = Math.hypot(agent.x - f.x, agent.y - f.y);
        line.style.strokeDasharray = `${len}`;
        line.style.strokeDashoffset = `${len}`;
        pulse(f);
        line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: reduce ? 0 : 520, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
        setTimeout(() => line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, fill: 'forwards' }).finished.then(() => line.remove()), 1500);
      }, i * 110);
    }
    setTimeout(() => pulse(agent), facts.length * 110 + 400);
  }

  // ---------------------------------------------------------------- camera
  /** Zoom onto a set of nodes ('*' or nothing = the whole graph). */
  let focused = null;
  function focus(ids) {
    const list = (ids ?? []).map((id) => nodes.get(id)).filter(Boolean);
    if (!list.length) {
      focused = null;
      viewTarget = fitView([...nodes.values()], 40, 520);
      return false;
    }
    focused = ids;
    viewTarget = fitView(list, 90, 640);
    svg.querySelectorAll('.n.focus').forEach((el) => el.classList.remove('focus'));
    for (const n of list) n.el.classList.add('focus');
    return true;
  }
  /** The view box that frames these nodes, labels included, never tighter than `minW` units wide. */
  function fitView(list, pad, minW) {
    if (!list.length) return { x: 0, y: 0, w: W, h: H };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of list) {
      const b = n.el.getBBox(); // local to the node: its dot plus its label
      x0 = Math.min(x0, n.tx + b.x);
      y0 = Math.min(y0, n.ty + b.y);
      x1 = Math.max(x1, n.tx + b.x + b.width);
      y1 = Math.max(y1, n.ty + b.y + b.height);
    }
    const ratio = svg.clientWidth && svg.clientHeight ? svg.clientWidth / svg.clientHeight : W / H;
    let w = Math.max(x1 - x0 + pad * 2, minW);
    let h = y1 - y0 + pad * 2;
    w = Math.max(w, h * ratio);
    h = w / ratio;
    return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
  }
  function unfocus() {
    svg.querySelectorAll('.n.focus').forEach((el) => el.classList.remove('focus'));
    focused = null;
    viewTarget = fitView([...nodes.values()], 40, 520);
  }

  // ---------------------------------------------------------------- frame loop
  function frame(now) {
    const k = reduce ? 1 : 0.075;
    for (const n of nodes.values()) {
      const drift = reduce ? 0 : 2.4;
      const ox = Math.sin(now / 2600 + n.phase) * drift;
      const oy = Math.cos(now / 3100 + n.phase) * drift;
      n.x += (n.tx + (n.kind === 'hub' ? 0 : ox) - n.x) * k;
      n.y += (n.ty + (n.kind === 'hub' ? 0 : oy) - n.y) * k;
      n.el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    }
    for (const e of edges.values()) {
      const a = nodes.get(e.a);
      const b = nodes.get(e.b);
      if (!a || !b) continue;
      e.el.setAttribute('x1', a.x.toFixed(1));
      e.el.setAttribute('y1', a.y.toFixed(1));
      e.el.setAttribute('x2', b.x.toFixed(1));
      e.el.setAttribute('y2', b.y.toFixed(1));
    }
    const c = reduce ? 1 : 0.06;
    view = { x: view.x + (viewTarget.x - view.x) * c, y: view.y + (viewTarget.y - view.y) * c, w: view.w + (viewTarget.w - view.w) * c, h: view.h + (viewTarget.h - view.h) * c };
    svg.setAttribute('viewBox', `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /** Light the nodes a fact came from (hover). */
  function highlight(ids) {
    svg.querySelectorAll('.n.lit').forEach((el) => el.classList.remove('lit'));
    for (const id of ids ?? []) nodes.get(id)?.el.classList.add('lit');
  }

  return { update, focus, unfocus, retrieve, highlight, has: (id) => nodes.has(id), element: (id) => nodes.get(id)?.el ?? null };
}

function meanAngle(list) {
  const x = list.reduce((s, a) => s + Math.cos((a * Math.PI) / 180), 0);
  const y = list.reduce((s, a) => s + Math.sin((a * Math.PI) / 180), 0);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
function angleDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}
