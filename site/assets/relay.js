// Section 03, the replay: one deal, three agents, and what Continuity does with every email.
//
//   STORE  [1][2][3][4][5]          every event is kept, in order (the log only grows)
//            │ │
//   SORT   ┌─ CONTINUITY ─────────────────┐   each event's facts land in the rows they change:
//          │ DELIVERY  300 FRI 23 · 200 … ✕│   four rows, shown as a departures board, that flip
//          │ NEXT      US · RAISE LATE …  ● │   and never grow
//          └──────────────────────────────┘
//                 │
//   READ   the agent on shift reads the board, not the log
//
// The scene is pinned while the section scrolls past; each screen of scroll is one beat.
// Stepping forward one beat plays it (an event is stored and sorted, an agent dies, or a new agent
// wakes with zero memory, reads the board and writes its reply). Any other jump renders the beat's
// end state at once, so scrubbing never queues animations.
// Every value comes from real engine output (snapshot.json): the state as of each event,
// the agents' briefing sizes and what they actually wrote.

import { esc } from './board.js';
import { token } from './theme.js';
import { stillMotion } from './motion.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fmt = (n) => Number(n).toLocaleString('en-US');

const W = 23; // flaps per row
const FLAP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$/·';
const FLY_MS = 620; // an event's facts travelling into their rows
const ROW_LAG = 90; // between rows, for both the packets and the flips

// who moves next, after each event: the engine's next_actor and next_actor_reason, shortened to fit a row
const NEXT = {
  ev_1: 'SUPPLIER · QUOTE',
  ev_2: 'SUPPLIER · QUOTE',
  ev_3: 'FINANCE · APPROVE',
  ev_5: 'US · ACCEPT THE ORDER',
  ev_6: 'US · RAISE LATE UNITS',
  ev_7: 'SUPPLIER · FIX DATES',
  ev_8: 'US · ACCEPT THE ORDER',
  ev_9: 'DONE · ORDER PLACED',
};

// ============================================================ beats, from the snapshot
function buildBeats(snap) {
  const ctx = (at) => snap.as_of[at]?.context ?? {};
  const sent = (agent) => snap.runs.find((r) => r.agent_id === agent && r.decision?.action === 'send');
  const body = (agent) => sent(agent)?.decision?.messages?.[0]?.body ?? '';
  const line = (agent, re) => body(agent).split('\n').find((l) => re.test(l))?.trim() ?? '';
  const quote = (at, term) => (ctx(at).current_terms ?? []).find((t) => t.term === term && t.stated_in?.includes(at))?.quote ?? '';
  const tokens = (agent) => sent(agent)?.context_tokens;

  const us = (agent, text) => ({ dir: 'out', who: 'Us', text });
  const them = (who, text) => ({ dir: 'in', who, text });

  return [
    { at: 'ev_2', title: 'Agent A opens the deal.', agent: { name: 'agent-a', state: 'live' }, mail: us('agent-a', line('agent-a', /need all 500/i)) },
    { at: 'ev_3', title: 'The supplier says yes.', agent: { name: 'agent-a', state: 'live' }, mail: them('Northwind', quote('ev_3', 'price.unit')) },
    { at: 'ev_3', title: 'Agent A is killed.', kill: true, agent: { name: 'agent-a', state: 'killed' } },
    { at: 'ev_5', title: 'Finance approves.', agent: { state: 'none' }, mail: them('Priya', quote('ev_5', 'budget.max_unit_price')) },
    { at: 'ev_6', title: 'The deal changes.', agent: { state: 'none' }, mail: them('Northwind', quote('ev_6', 'delivery.schedule')) },
    { at: 'ev_7', title: 'Agent B wakes. No memory.', agent: { name: 'agent-b', state: 'wake', tokens: tokens('agent-b') }, mail: us('agent-b', line('agent-b', /doesn't work|does not work|Oct 28/i)) },
    { at: 'ev_8', title: 'The supplier fixes it.', agent: { state: 'none' }, mail: them('Northwind', `${quote('ev_8', 'delivery.schedule')} ${quote('ev_8', 'price.unit')}`.trim()) },
    { at: 'ev_9', title: 'Agent C closes it.', agent: { name: 'agent-c', state: 'wake', tokens: tokens('agent-c') }, mail: us('agent-c', quote('ev_9', 'decision.order')), end: true },
  ];
}

// ============================================================ the state, as board rows
// "300 units Fri Oct 23 + 200 units Wed Oct 28" → "300 FRI 23 · 200 WED 28"; one lot keeps its month
function lots(v) {
  const parts = [...String(v).matchAll(/(\d+) units (\w{3}) (\w{3}) (\d+)/g)];
  if (parts.length === 1) return parts[0].slice(1).join(' ');
  if (parts.length > 1) return parts.map(([, q, day, , d]) => `${q} ${day} ${d}`).join(' · ');
  return String(v);
}

function boardRows(c, at) {
  const term = (t) => (c.current_terms ?? []).find((x) => x.term === t)?.value;
  const check = (name) => (c.checks ?? []).find((x) => x.check === name)?.status ?? 'unknown';
  const delivery = term('delivery.schedule');
  const price = term('price.unit');
  const budget = term('budget.max_unit_price');
  return [
    { k: 'delivery', label: 'Delivery', status: check('All units by Fri Oct 23'), text: delivery ? lots(delivery) : 'AWAITING QUOTE' },
    { k: 'price', label: 'Price', status: check('Unit price within budget'), text: price ? `${price} / UNIT` : 'AWAITING QUOTE' },
    { k: 'budget', label: 'Budget', status: check('Budget approved'), text: budget ? `UP TO ${budget}` : 'ASKED FINANCE' },
    { k: 'next', label: 'Next', status: at === 'ev_9' ? 'done' : c.next_actor === 'us' ? 'us' : 'them', text: NEXT[at] ?? '' },
  ].map((r) => ({ ...r, text: r.text.toUpperCase().padEnd(W).slice(0, W) }));
}

const MARK = { pass: '✓', fail: '✕', unknown: '·', us: '●', them: '→', done: '✓' };

// ============================================================ the scene
export function setupRelay(root, snap) {
  const beats = buildBeats(snap);
  const n = beats.length;
  root.style.setProperty('--beats', n);

  const $ = (sel) => root.querySelector(sel);
  const scene = $('.rl-scene');
  const log = $('.rl-log');
  const tiles = $('.rl-tiles');
  const latest = $('.rl-latest');
  const eventCount = $('[data-mails]');
  const board = $('.rl-board');
  const rowsBox = $('.rl-rows');
  const scanBar = $('.rl-scan');
  const wireOut = $('[data-wire="out"]');
  const agentSt = $('.rl-agentst');
  const agentBox = $('.rl-agent');
  const burst = $('.rl-burst');
  const ver = $('[data-ver]');
  const counter = $('.rl-count');
  const cap = $('.rl-cap');
  const capN = $('.rl-cap-n');
  const capT = $('.rl-cap h3');

  let current = -1;
  let runId = 0;

  // the events in the thread as of each beat, in order (the flash-sale spam was never linked)
  const events = [...snap.timeline.events].sort((a, b) => a.seq - b.seq);
  const seq = Object.fromEntries(events.map((e) => [e.id, e.seq]));
  const eventsAt = (at) => events.filter((e) => e.seq <= seq[at]);

  const restart = (el, cls) => {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };

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

  function setCaption(i, animate) {
    capN.textContent = String(i + 1).padStart(2, '0');
    capT.textContent = beats[i].title;
    cap.classList.toggle('kill', !!beats[i].kill);
    if (animate) restart(cap, 'roll');
  }

  // ------------------------------------------------------------ store: the log, one tile per event
  const lastMail = (i) => {
    for (let k = i; k >= 0; k--) if (beats[k].mail) return { mail: beats[k].mail, own: k === i };
    return null;
  };

  // pending: our own email is still being written, so it is not in the log yet
  function setLog(i, { pending = false, added = false } = {}) {
    const evs = eventsAt(beats[i].at).slice(0, pending ? -1 : undefined);
    const fresh = !pending && !!beats[i].mail;
    tiles.innerHTML = evs.map((e, k) =>
      `<i class="rl-tile ${e.direction === 'outbound' ? 'out' : 'in'}${fresh && k === evs.length - 1 ? ' now' : ''}">${k + 1}</i>`).join('');
    if (added) restart(tiles.lastElementChild, 'add');
    eventCount.textContent = `${evs.length} events`;
    const last = lastMail(i);
    latest.classList.toggle('stale', !last?.own);
    latest.innerHTML = last ? `<b>${esc(last.mail.who)}</b><span>${pending ? '' : esc(last.mail.text)}</span>` : '';
  }

  async function typeLatest(text, id) {
    const span = latest.querySelector('span');
    if (!span) return;
    latest.classList.add('caret');
    for (let k = 2; k <= text.length; k += 3) {
      if (id !== runId) return;
      span.textContent = text.slice(0, k);
      await wait(12);
    }
    span.textContent = text;
    latest.classList.remove('caret');
  }

  // ------------------------------------------------------------ sort: the board
  const rowEls = new Map();
  const shown = new Map(); // row → what it shows now
  rowsBox.innerHTML = boardRows({}, 'ev_1').map((r) => `<div class="rl-brow" data-k="${r.k}">
      <span class="rl-bl">${esc(r.label)}</span>
      <span class="rl-flaps">${'<i class="fl"><b> </b></i>'.repeat(W)}</span>
      <span class="rl-bs"><b>·</b></span>
    </div>`).join('');
  rowsBox.querySelectorAll('.rl-brow').forEach((el) => rowEls.set(el.dataset.k, el));

  const rowsAt = (i) => boardRows(snap.as_of[beats[i].at]?.context ?? {}, beats[i].at);
  const changedRows = (i) => rowsAt(i).filter((r) => shown.get(r.k) !== `${r.status}|${r.text}`).map((r) => r.k);

  // one flap: a few random characters, each a quick fold, then the real one
  function flip(b, to, delay, id) {
    const steps = 2 + ((Math.random() * 4) | 0);
    let k = 0;
    const go = () => {
      if (id !== runId) return;
      k++;
      b.textContent = k < steps ? FLAP[(Math.random() * FLAP.length) | 0] : to;
      b.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(0.08)', offset: 0.45 }, { transform: 'scaleY(1)' }], { duration: 75, easing: 'ease-out' });
      if (k < steps) setTimeout(go, 62);
    };
    setTimeout(go, delay);
  }

  // rows that change flip one after another, each left to right
  function setBoard(i, animate, id) {
    let lag = 0;
    for (const r of rowsAt(i)) {
      const el = rowEls.get(r.k);
      const flaps = el.querySelectorAll('.fl b');
      let changed = false;
      flaps.forEach((b, k) => {
        if (b.textContent === r.text[k]) return;
        changed = true;
        if (animate) flip(b, r.text[k], lag + k * 24, id);
        else b.textContent = r.text[k];
      });
      el.className = `rl-brow ${r.status}`;
      el.querySelector('.rl-bs b').textContent = MARK[r.status] ?? '·';
      if (animate && shown.get(r.k) !== `${r.status}|${r.text}`) {
        restart(el, 'chg');
        if (changed) lag += ROW_LAG;
      }
      shown.set(r.k, `${r.status}|${r.text}`);
    }
    ver.textContent = `state v${snap.as_of[beats[i].at]?.context?.meta?.state_version ?? '—'}`;
  }

  // the newest event's facts travel from its tile into each row they change
  function fly(keys) {
    const from = tiles.lastElementChild;
    if (stillMotion || !keys.length || !from) return;
    const s = scene.getBoundingClientRect();
    const t = from.getBoundingClientRect();
    const x0 = t.left + t.width / 2 - s.left;
    const y0 = t.bottom - s.top;
    keys.forEach((k, n) => {
      const r = rowEls.get(k).querySelector('.rl-flaps').getBoundingClientRect();
      const x3 = r.left - s.left + 6;
      const y3 = r.top + r.height / 2 - s.top;
      const frames = [];
      for (let step = 0; step <= 16; step++) {
        const p = step / 16;
        const u = 1 - p;
        const x = u * u * u * x0 + 3 * u * u * p * x0 + 3 * u * p * p * (x3 - 48) + p * p * p * x3;
        const y = u * u * u * y0 + 3 * u * u * p * (y0 + 56) + 3 * u * p * p * y3 + p * p * p * y3;
        frames.push({ transform: `translate(${x - 3.5}px, ${y - 3.5}px)` });
      }
      const sq = document.createElement('i');
      sq.className = 'rl-packet';
      scene.append(sq);
      const anim = sq.animate(frames, { duration: FLY_MS, delay: n * ROW_LAG, easing: 'cubic-bezier(0.45, 0, 0.25, 1)', fill: 'both' });
      anim.finished.finally(() => sq.remove()).catch(() => {});
    });
  }

  // ------------------------------------------------------------ read: the agent
  function setAgent(i, phase, animate) {
    const spec = beats[i].agent;
    agentSt.dataset.state = spec.state;
    let html;
    if (spec.state === 'live') {
      html = `<i class="rl-dot"></i><b class="rl-ag-name">${esc(spec.name)}</b>
        <span class="rl-chip">remembers ${eventsAt(beats[i].at).length} emails</span>`;
    } else if (spec.state === 'killed') {
      html = `<b class="rl-x">✕</b><b class="rl-ag-name">${esc(spec.name)}</b><span class="rl-chip">memory lost</span>`;
    } else if (spec.state === 'none') {
      html = '<span class="rl-none">No agent running</span>';
    } else {
      html = `<i class="rl-dot"></i><b class="rl-ag-name">${esc(spec.name)}</b><span class="rl-chip new">new</span>
        <span class="rl-chip">memory 0</span>
        <span class="rl-chip tok${phase === 'pre' ? ' wait' : ''}">read <b>${phase === 'pre' ? '0' : fmt(spec.tokens)}</b> tokens</span>`;
    }
    agentBox.innerHTML = html;
    if (animate) restart(agentBox, 'enter');
  }

  // the agent reading the board: a line of light runs down it
  function scan() {
    if (stillMotion) return Promise.resolve();
    const h = board.clientHeight;
    return scanBar.animate([
      { transform: 'translateY(-48px)', opacity: 0 },
      { opacity: 1, offset: 0.12 },
      { opacity: 1, offset: 0.88 },
      { transform: `translateY(${h}px)`, opacity: 0 },
    ], { duration: 1000, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' }).finished;
  }

  // a square runs down the wire from the board to the agent
  function pulse(wire) {
    if (stillMotion) return Promise.resolve();
    const h = wire.clientHeight;
    return wire.querySelector('i').animate([
      { transform: 'translateY(-3px)', opacity: 0 },
      { opacity: 1, offset: 0.2 },
      { opacity: 1, offset: 0.8 },
      { transform: `translateY(${h - 3}px)`, opacity: 0 },
    ], { duration: 420, easing: 'ease-in-out' }).finished;
  }

  function countTokens(to, id) {
    const b = agentBox.querySelector('.rl-chip.tok b');
    agentBox.querySelector('.rl-chip.tok')?.classList.remove('wait');
    if (!b || stillMotion) { if (b) b.textContent = fmt(to); return Promise.resolve(); }
    return new Promise((done) => {
      const start = performance.now();
      const tick = (now) => {
        if (id !== runId) return done();
        const t = clamp01((now - start) / 700);
        b.textContent = fmt(Math.round(to * (1 - Math.pow(1 - t, 3))));
        if (t < 1) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
  }

  // the agent's death: its strip glitches and bursts into squares
  function shatter() {
    const box = burst.getBoundingClientRect();
    const name = agentBox.querySelector('.rl-ag-name')?.getBoundingClientRect() ?? box;
    const dpr = Math.min(2, devicePixelRatio || 1);
    burst.width = box.width * dpr;
    burst.height = box.height * dpr;
    const g = burst.getContext('2d');
    const colours = [token('--signal'), token('--signal'), token('--ink')];
    const ox = name.left - box.left + name.width / 2;
    const oy = name.top - box.top + name.height / 2;
    const parts = Array.from({ length: 70 }, () => {
      const a = Math.random() * Math.PI * 2;
      const v = 0.6 + Math.random() * 3.2;
      return { x: ox + (Math.random() - 0.5) * 80, y: oy + (Math.random() - 0.5) * 16, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.8, life: 1, c: colours[(Math.random() * 3) | 0] };
    });
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
      else g.clearRect(0, 0, box.width, box.height);
    };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ rendering a beat
  function renderInstant(i) {
    setCaption(i, false);
    setTrack(i);
    setLog(i);
    setBoard(i, false, runId);
    setAgent(i, 'full', false);
    agentSt.classList.remove('dying');
    log.classList.remove('skip');
  }

  async function play(i, id) {
    const b = beats[i];
    const prev = beats[i - 1].agent;
    const alive = () => id === runId;
    setCaption(i, true);
    setTrack(i);

    if (b.kill) {
      agentSt.classList.add('dying');
      await wait(380);
      if (!alive()) return;
      shatter();
      setAgent(i, 'full', true);
      agentSt.classList.remove('dying');
      return;
    }

    if (b.agent.state === 'wake') {
      // read: a new agent has nothing in memory, so it reads the board and skips the log
      setAgent(i, 'pre', true);
      await wait(450);
      if (!alive()) return;
      log.classList.add('skip');
      await Promise.all([scan(), wait(500).then(() => pulse(wireOut))]);
      if (!alive()) return;
      await countTokens(b.agent.tokens, id);
      if (!alive()) return;
      await wait(250);
      log.classList.remove('skip');
    } else if (b.agent.state !== prev.state || b.agent.name !== prev.name) {
      setAgent(i, 'full', true);
    }
    if (!alive() || !b.mail) return;

    // store: the email joins the log (ours is written first)
    if (b.mail.dir === 'out') {
      setLog(i, { pending: true });
      await typeLatest(b.mail.text, id);
      if (!alive()) return;
    }
    setLog(i, { added: true });
    await wait(420);
    if (!alive()) return;

    // sort: its facts travel into the rows they change, which flip as they land
    fly(changedRows(i));
    await wait(FLY_MS - 60);
    if (!alive()) return;
    setBoard(i, true, id);
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

  show(beatFromScroll());
}
