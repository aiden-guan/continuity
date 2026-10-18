// Section 03, the replay: how Continuity works, as three stations in a loop.
//
//   THE THREAD ──evidence──▶ CONTINUITY ──briefing──▶ THE AGENT
//        ▲                                                │
//        └───────────────────── reply ────────────────────┘
//
// The scene is pinned while the section scrolls past; each screen of scroll is one beat.
// Stepping forward one beat plays it (an email lands, a packet carries it along a link, a row
// of state flips, an agent dies or wakes with zero memory and types its reply). Any other jump
// renders the beat's end state at once, so scrubbing never queues animations.
// Every value comes from real engine output (snapshot.json): the state as of each event,
// the agents' briefing sizes and what they actually wrote.

import { esc } from './board.js';
import { token } from './theme.js';
import { stillMotion } from './motion.js';

const NS = 'http://www.w3.org/2000/svg';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fmt = (n) => Number(n).toLocaleString('en-US');

// the engine's next-move reasons, shortened for the scene
const WHY = {
  ev_1: 'Supplier to quote',
  ev_2: 'Supplier to quote',
  ev_3: 'Finance to approve the budget',
  ev_5: 'Accept the order',
  ev_6: 'Raise the late delivery',
  ev_7: 'Supplier to fix the schedule',
  ev_8: 'Accept the order',
  ev_9: 'Order placed · supplier to invoice',
};

// ============================================================ beats, from the snapshot
function buildBeats(snap) {
  const ctx = (at) => snap.as_of[at]?.context ?? {};
  const sent = (agent) => snap.runs.find((r) => r.agent_id === agent && r.decision?.action === 'send');
  const body = (agent) => sent(agent)?.decision?.messages?.[0]?.body ?? '';
  const line = (agent, re) => body(agent).split('\n').find((l) => re.test(l))?.trim() ?? '';
  const quote = (at, term) => (ctx(at).current_terms ?? []).find((t) => t.term === term && t.stated_in?.includes(at))?.quote ?? '';
  const tokens = (agent) => sent(agent)?.context_tokens;

  const us = (id, agent, text) => ({ id, dir: 'out', who: 'Us', role: agent, text });
  const them = (id, who, role, text) => ({ id, dir: 'in', who, role, text });

  const bSays = line('agent-b', /doesn't work|does not work|Oct 28/i);
  const cSays = quote('ev_9', 'decision.order');

  return [
    {
      at: 'ev_2', title: 'Agent A opens the deal.',
      body: '500 boards, all by Friday, at most $11.50 each. Every email it sends is recorded.',
      agent: { name: 'agent-a', state: 'live' },
      mail: us('m1', 'agent-a', line('agent-a', /need all 500/i)),
      flows: ['reply', 'evidence'],
    },
    {
      at: 'ev_3', title: 'The supplier says yes.',
      body: 'Each email becomes evidence. Continuity turns it into state: the terms, the checks, who moves next.',
      agent: { name: 'agent-a', state: 'live' },
      mail: them('m2', 'Northwind', 'supplier', quote('ev_3', 'price.unit')),
      flows: ['evidence'],
    },
    {
      at: 'ev_3', title: 'Then Agent A is killed.', kill: true,
      body: 'No warning, no handoff notes. Everything it remembered is gone.',
      agent: { name: 'agent-a', state: 'killed' },
      flows: [],
    },
    {
      at: 'ev_5', title: 'Finance approves.',
      body: 'No agent is awake to read it. Continuity is.',
      agent: { state: 'none' },
      mail: them('m3', 'Priya', 'finance', quote('ev_5', 'budget.max_unit_price')),
      flows: ['evidence'],
    },
    {
      at: 'ev_6', title: 'The supplier changes the deal.',
      body: 'The Friday deadline is now missed. The state shows it before any agent looks.',
      agent: { state: 'none' },
      mail: them('m4', 'Northwind', 'supplier', quote('ev_6', 'delivery.schedule')),
      flows: ['evidence'],
    },
    {
      at: 'ev_7', title: 'Agent B wakes up with zero memory.',
      body: 'It reads one short briefing instead of the thread, and pushes back on exactly the right problem.',
      agent: { name: 'agent-b', state: 'wake', tokens: tokens('agent-b'), says: bSays },
      mail: us('m5', 'agent-b', bSays),
      flows: ['briefing', 'reply', 'evidence'],
    },
    {
      at: 'ev_8', title: 'The supplier fixes it.',
      body: 'All 500 by Friday, $11.48 each. Every check passes again.',
      agent: { state: 'none' },
      mail: them('m6', 'Northwind', 'supplier', `${quote('ev_8', 'delivery.schedule')} ${quote('ev_8', 'price.unit')}`.trim()),
      flows: ['evidence'],
    },
    {
      at: 'ev_9', title: 'Agent C closes the deal.',
      body: 'Another fresh agent, another clean handoff. The thread never broke.',
      agent: { name: 'agent-c', state: 'wake', tokens: tokens('agent-c'), says: cSays },
      mail: us('m7', 'agent-c', cSays),
      flows: ['briefing', 'reply', 'evidence'],
      end: true,
    },
  ];
}

// ============================================================ the state, as rows
const shortTerm = (v) => String(v).replace(/ units/g, '').replace(' + ', ' · ');

function termView(c, term) {
  const now = (c.current_terms ?? []).find((t) => t.term === term)?.value;
  const old = (c.superseded_terms_do_not_use ?? []).filter((s) => s.term === term && s.current_value === now).pop();
  return { value: now, was: old?.old_value };
}

function stateRows(c) {
  const check = (name) => (c.checks ?? []).find((x) => x.check === name)?.status ?? 'unknown';
  const delivery = termView(c, 'delivery.schedule');
  const price = termView(c, 'price.unit');
  const budget = termView(c, 'budget.max_unit_price').value;
  return [
    { k: 'delivery', label: 'All 500 by Fri Oct 23', status: check('All units by Fri Oct 23'), value: delivery.value && shortTerm(delivery.value), was: delivery.was && shortTerm(delivery.was) },
    { k: 'price', label: 'Price within budget', status: check('Unit price within budget'), value: price.value && `${price.value} / unit`, was: price.was },
    { k: 'budget', label: 'Budget approved', status: check('Budget approved'), value: budget ? `up to ${budget} / unit` : 'asked finance' },
  ];
}

const ICON = { pass: '✓', fail: '✕', unknown: '·' };

function rowMarkup(r, changed) {
  const was = r.was ? `<s>${esc(r.was)}</s>` : '';
  return `<div class="rl-row ${esc(r.status)}${changed ? ' chg' : ''}" data-k="${r.k}">
    <i class="rl-ic">${ICON[r.status] ?? '·'}</i>
    <div><div class="rl-k">${esc(r.label)}</div><div class="rl-v">${was}<span>${esc(r.value ?? '—')}</span></div></div>
  </div>`;
}

// ============================================================ the scene
export function setupRelay(root, snap) {
  const beats = buildBeats(snap);
  const n = beats.length;
  root.style.setProperty('--beats', n);

  const $ = (sel) => root.querySelector(sel);
  const stage = $('.rl-stage');
  const st = { thread: $('.rl-thread'), core: $('.rl-corest'), agent: $('.rl-agentst') };
  const bubs = $('.rl-bubs');
  const core = $('.rl-core');
  const agentBox = $('.rl-agent');
  const agentChip = $('[data-agent-chip]');
  const ver = $('[data-ver]');
  const counter = $('.rl-count');
  const capN = $('.rl-cap-n');
  const capT = $('.rl-cap h3');
  const capB = $('.rl-cap p');
  const burst = $('.rl-burst');
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('rl-links');
  svg.setAttribute('aria-hidden', 'true');
  stage.append(svg);

  let current = -1;
  let runId = 0;
  let shownMails = [];
  let lastRows = new Map();
  const base = {}; // kind → { path, label }

  // ------------------------------------------------------------ track: one node per beat, agent shifts above
  const track = $('.rl-track');
  const shifts = [
    { name: 'a', from: 0, to: 2, dies: true },
    { name: 'b', from: 5, to: 5 },
    { name: 'c', from: 7, to: 7 },
  ];
  track.innerHTML = `<i class="rl-line"></i>${shifts.map((s) =>
    `<span class="rl-shift${s.dies ? ' dies' : ''}" data-from="${s.from}" data-to="${s.to}" style="left:${(s.from / n) * 100}%;width:${((s.to - s.from + 1) / n) * 100}%"><em>agent-${s.name}</em></span>`).join('')}${beats.map((b, i) =>
    `<button type="button" class="rl-node${b.kill ? ' kill' : ''}" style="left:${((i + 0.5) / n) * 100}%" data-i="${i}" aria-label="Beat ${i + 1}: ${esc(b.title)}"></button>`).join('')}`;
  track.addEventListener('click', (ev) => {
    const node = ev.target.closest('.rl-node');
    if (node) jumpTo(Number(node.dataset.i));
  });

  function setTrack(i) {
    track.querySelectorAll('.rl-node').forEach((el, k) => {
      el.classList.toggle('past', k < i);
      el.classList.toggle('now', k === i);
    });
    track.querySelectorAll('.rl-shift').forEach((el) => {
      el.classList.toggle('on', i >= Number(el.dataset.from));
      el.classList.toggle('dead', el.classList.contains('dies') && i >= Number(el.dataset.to));
    });
    track.style.setProperty('--head', `${((i + 0.5) / n) * 100}%`);
    counter.textContent = `${String(i + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
  }

  // ------------------------------------------------------------ caption
  function setCaption(i, animate) {
    const b = beats[i];
    capN.textContent = String(i + 1).padStart(2, '0');
    capT.textContent = b.title;
    capB.textContent = b.body;
    root.querySelector('.rl-cap').classList.toggle('kill', !!b.kill);
    if (animate) {
      const cap = root.querySelector('.rl-cap');
      cap.classList.remove('roll');
      void cap.offsetWidth;
      cap.classList.add('roll');
    }
  }

  // ------------------------------------------------------------ the thread station
  const bubbleMarkup = (m) => `<div class="rl-bub ${m.dir}" data-id="${m.id}">
      <div class="rl-bub-h"><b>${esc(m.who)}</b><span>${esc(m.role)}</span></div>
      <p>${esc(m.text)}</p>
    </div>`;

  function setBubbles(mails, animate) {
    const before = new Map(Array.from(bubs.children).map((el) => [el.dataset.id, el.getBoundingClientRect().top]));
    shownMails = mails;
    bubs.innerHTML = mails.slice(-3).reverse().map(bubbleMarkup).join('');
    if (!animate) return;
    for (const el of bubs.children) {
      const top = before.get(el.dataset.id);
      if (top == null) { el.classList.add('new'); continue; }
      const dy = top - el.getBoundingClientRect().top;
      if (!dy) continue;
      el.style.transform = `translateY(${dy}px)`;
      el.style.transition = 'none';
      requestAnimationFrame(() => {
        el.style.transition = '';
        el.style.transform = '';
      });
    }
  }

  // ------------------------------------------------------------ the Continuity station
  function setCore(i, animate) {
    const c = snap.as_of[beats[i].at]?.context ?? {};
    const rows = stateRows(c);
    const next = c.next_actor === 'us' ? 'Us' : c.next_actor === 'them' ? 'Them' : '—';
    const done = beats[i].end;
    core.innerHTML = rows.map((r) => {
      const sig = `${r.status}|${r.value}|${r.was}`;
      const changed = animate && lastRows.has(r.k) && lastRows.get(r.k) !== sig;
      return rowMarkup(r, changed);
    }).join('') + `<div class="rl-next${done ? ' done' : ''}">
        <span class="rl-k">Next move</span>
        <b class="actor ${esc(c.next_actor)}${animate ? ' roll' : ''}">${done ? 'Done' : next}</b>
        <span class="rl-why">${esc(WHY[beats[i].at] ?? '')}</span>
      </div>`;
    lastRows = new Map(rows.map((r) => [r.k, `${r.status}|${r.value}|${r.was}`]));
    if (ver) ver.textContent = `state v${c.meta?.state_version ?? '—'}`;
    st.core.classList.toggle('bad', rows.some((r) => r.status === 'fail'));
  }

  // ------------------------------------------------------------ the agent station
  function setAgent(spec, phase, animate) {
    const chip = { live: 'running', wake: 'running', killed: 'killed', none: 'idle' }[spec.state];
    agentChip.textContent = chip;
    st.agent.dataset.state = spec.state;
    let html;
    if (spec.state === 'live') {
      html = `<div class="rl-ag-name"><i class="rl-pulse"></i>${esc(spec.name)}</div>
        <div class="rl-ag-meta">Running. Holds this deal in its own memory.</div>`;
    } else if (spec.state === 'killed') {
      html = `<div class="rl-ag-name"><b class="rl-x">✕</b>${esc(spec.name)}</div>
        <div class="rl-ag-meta">Killed. Its memory went with it.</div>`;
    } else if (spec.state === 'none') {
      html = `<div class="rl-empty">No agent running</div>
        <div class="rl-ag-meta">The thread keeps moving anyway.</div>`;
    } else {
      const tokens = phase === 'pre' ? '—' : `${fmt(spec.tokens)} tokens`;
      html = `<div class="rl-ag-name"><i class="rl-pulse"></i>${esc(spec.name)}<span class="rl-fresh">new</span></div>
        <dl class="rl-facts">
          <div><dt>Memory</dt><dd>0 messages</dd></div>
          <div class="rl-tok${phase === 'pre' ? '' : ' got'}"><dt>Briefing</dt><dd>${tokens}</dd></div>
        </dl>
        <p class="rl-says">${phase === 'pre' ? '' : `“${esc(spec.says)}”`}</p>`;
    }
    agentBox.innerHTML = html;
    if (animate) {
      agentBox.classList.remove('enter');
      void agentBox.offsetWidth;
      agentBox.classList.add('enter');
    }
  }

  async function typeSays(text, id) {
    const el = agentBox.querySelector('.rl-says');
    if (!el) return;
    const full = `“${text}”`;
    for (let k = 1; k <= full.length; k += 2) {
      if (id !== runId) return;
      el.textContent = full.slice(0, k);
      await wait(12);
    }
    el.textContent = full;
  }

  // the agent's death: its card glitches and bursts into squares
  function shatter() {
    const box = st.agent.getBoundingClientRect();
    const name = agentBox.querySelector('.rl-ag-name')?.getBoundingClientRect() ?? box;
    const dpr = Math.min(2, devicePixelRatio || 1);
    burst.width = box.width * dpr;
    burst.height = box.height * dpr;
    const g = burst.getContext('2d');
    const colours = [token('--signal'), token('--signal'), token('--ink')];
    const ox = name.left - box.left + 40;
    const oy = name.top - box.top + name.height / 2;
    const parts = Array.from({ length: 70 }, () => {
      const a = Math.random() * Math.PI * 2;
      const v = 0.6 + Math.random() * 3.2;
      return { x: ox + (Math.random() - 0.5) * 80, y: oy + (Math.random() - 0.5) * 16, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.8, life: 1, c: colours[(Math.random() * 3) | 0] };
    });
    return new Promise((done) => {
      const tick = () => {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, box.width, box.height);
        let alive = false;
        for (const p of parts) {
          if (p.life <= 0) continue;
          alive = true;
          p.x += p.vx; p.y += p.vy; p.vy += 0.09; p.vx *= 0.985; p.life -= 0.022;
          g.globalAlpha = Math.max(0, p.life);
          g.fillStyle = p.c;
          g.fillRect(p.x, p.y, 2.5, 2.5);
        }
        if (alive) requestAnimationFrame(tick);
        else { g.clearRect(0, 0, box.width, box.height); done(); }
      };
      requestAnimationFrame(tick);
    });
  }

  // ------------------------------------------------------------ the links between stations
  const stacked = () => getComputedStyle(stage).gridTemplateColumns.split(' ').length < 3;

  function layoutLinks() {
    svg.replaceChildren();
    const s = stage.getBoundingClientRect();
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { l: b.left - s.left, r: b.right - s.left, t: b.top - s.top, b: b.bottom - s.top, cx: (b.left + b.right) / 2 - s.left, cy: (b.top + b.bottom) / 2 - s.top };
    };
    const T = r(st.thread);
    const C = r(st.core);
    const A = r(st.agent);
    const paths = {};
    const labels = {};
    if (!stacked()) {
      const y = Math.min(T.t, C.t) + 64;
      paths.evidence = `M${T.r},${y} H${C.l}`;
      paths.briefing = `M${C.r},${y} H${A.l}`;
      const low = Math.max(T.b, A.b) + 30;
      const rad = 12;
      paths.reply = `M${A.cx},${A.b} V${low - rad} Q${A.cx},${low} ${A.cx - rad},${low} H${T.cx + rad} Q${T.cx},${low} ${T.cx},${low - rad} V${T.b}`;
      labels.evidence = [(T.r + C.l) / 2, y - 9, 'middle'];
      labels.briefing = [(C.r + A.l) / 2, y - 9, 'middle'];
      labels.reply = [(T.cx + A.cx) / 2, low - 8, 'middle'];
    } else {
      paths.evidence = `M${T.cx},${T.b} V${C.t}`;
      paths.briefing = `M${C.cx},${C.b} V${A.t}`;
      const gx = Math.max(-10, T.l - 9);
      const rad = 6;
      paths.reply = `M${A.l},${A.t + 22} H${gx + rad} Q${gx},${A.t + 22} ${gx},${A.t + 22 - rad} V${T.t + 22 + rad} Q${gx},${T.t + 22} ${gx + rad},${T.t + 22} H${T.l}`;
      labels.evidence = [T.cx + 10, (T.b + C.t) / 2 + 4, 'start'];
      labels.briefing = [C.cx + 10, (C.b + A.t) / 2 + 4, 'start'];
    }
    for (const kind of Object.keys(paths)) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', paths[kind]);
      path.classList.add('rl-path');
      svg.append(path);
      let label = null;
      if (labels[kind]) {
        label = document.createElementNS(NS, 'text');
        const [x, y, anchor] = labels[kind];
        label.setAttribute('x', x);
        label.setAttribute('y', y);
        label.setAttribute('text-anchor', anchor);
        label.textContent = kind;
        label.classList.add('rl-label');
        svg.append(label);
      }
      base[kind] = { path, label };
    }
  }

  function flow(kind, id) {
    const link = base[kind];
    if (!link || stillMotion) return Promise.resolve();
    const lit = link.path.cloneNode();
    lit.classList.add('rl-lit');
    svg.append(lit);
    const len = lit.getTotalLength();
    lit.style.strokeDasharray = `${len}`;
    lit.style.strokeDashoffset = `${len}`;
    const packet = document.createElementNS(NS, 'rect');
    packet.setAttribute('width', 8);
    packet.setAttribute('height', 8);
    packet.classList.add('rl-packet');
    svg.append(packet);
    link.label?.classList.add('on');
    const ms = kind === 'reply' ? 900 : 650;
    return new Promise((done) => {
      const start = performance.now();
      const tick = (now) => {
        const t = clamp01((now - start) / ms);
        const e = easeInOut(t);
        lit.style.strokeDashoffset = `${len * (1 - e)}`;
        const pt = lit.getPointAtLength(e * len);
        packet.setAttribute('x', pt.x - 4);
        packet.setAttribute('y', pt.y - 4);
        if (t < 1 && id === runId) { requestAnimationFrame(tick); return; }
        packet.remove();
        lit.classList.add('fade');
        setTimeout(() => lit.remove(), 700);
        link.label?.classList.remove('on');
        done();
      };
      requestAnimationFrame(tick);
    });
  }

  // ------------------------------------------------------------ rendering a beat
  const mailsUpTo = (i) => beats.slice(0, i + 1).map((b) => b.mail).filter(Boolean);
  const agentAt = (i) => beats[i].agent;

  function renderInstant(i) {
    setCaption(i, false);
    setTrack(i);
    setBubbles(mailsUpTo(i), false);
    lastRows = new Map();
    setCore(i, false);
    setAgent(agentAt(i), 'full', false);
    st.agent.classList.remove('dying');
  }

  async function play(i, id) {
    const b = beats[i];
    const alive = () => id === runId;
    setCaption(i, true);
    setTrack(i);

    const prev = beats[i - 1].agent;
    if (b.agent.state === 'killed') {
      st.agent.classList.add('dying');
      await wait(380);
      if (!alive()) return;
      shatter();
      setAgent(b.agent, 'full', true);
      st.agent.classList.remove('dying');
    } else if (b.agent.state === 'wake') {
      setAgent(b.agent, 'pre', true);
      await wait(500);
    } else if (b.agent.state !== prev.state || b.agent.name !== prev.name) {
      setAgent(b.agent, 'full', true);
    }

    for (const f of b.flows) {
      if (!alive()) return;
      if (f === 'briefing') {
        await flow('briefing', id);
        if (!alive()) return;
        setAgent(b.agent, 'brief', false);
        agentBox.querySelector('.rl-says').textContent = '';
        await wait(300);
      }
      if (f === 'reply') {
        if (b.agent.says) await typeSays(b.agent.says, id);
        if (!alive()) return;
        await flow('reply', id);
        if (!alive()) return;
        setBubbles([...shownMails, b.mail], true);
        await wait(350);
      }
      if (f === 'evidence') {
        if (b.mail?.dir === 'in') {
          setBubbles([...shownMails, b.mail], true);
          await wait(550);
        }
        if (!alive()) return;
        await flow('evidence', id);
        if (!alive()) return;
        setCore(i, true);
      }
    }
  }

  function show(i) {
    if (i === current) return;
    const forward = i === current + 1 && current >= 0;
    runId++;
    if (forward && !stillMotion) {
      renderInstant(current); // finish whatever the last beat was doing
      current = i;
      play(i, runId);
    } else {
      current = i;
      renderInstant(i);
    }
  }

  // ------------------------------------------------------------ scroll → beat
  function beatFromScroll() {
    const box = root.getBoundingClientRect();
    const span = box.height - innerHeight;
    const p = span > 0 ? clamp01(-box.top / span) : 0;
    return Math.min(n - 1, Math.floor(p * n));
  }

  function jumpTo(i) {
    const box = root.getBoundingClientRect();
    const span = box.height - innerHeight;
    scrollTo({ top: scrollY + box.top + ((i + 0.5) / n) * span, behavior: stillMotion ? 'auto' : 'smooth' });
  }

  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; show(beatFromScroll()); });
  }, { passive: true });

  new ResizeObserver(() => layoutLinks()).observe(stage);
  layoutLinks();
  show(beatFromScroll());
}
