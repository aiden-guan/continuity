// Section 03, the replay: one deal, three agents, one board.
//
//   the latest email
//        │
//   ┌─ CONTINUITY ─────────────────┐   the state, shown as a departures board: four rows that
//   │ DELIVERY  300 FRI 23 · 200 … ✕│   flip when an email changes them, and never grow
//   │ NEXT      US · RAISE LATE …  ● │
//   └──────────────────────────────┘
//        │
//   the agent on shift (or nobody)
//
// The scene is pinned while the section scrolls past; each screen of scroll is one beat.
// Stepping forward one beat plays it (an email arrives and flips a row, an agent dies, or a new
// agent wakes with zero memory, reads the board and writes its reply). Any other jump renders the
// beat's end state at once, so scrubbing never queues animations.
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

  const us = (agent, text) => ({ dir: 'out', who: 'Us', role: agent, text });
  const them = (who, role, text) => ({ dir: 'in', who, role, text });

  const bSays = line('agent-b', /doesn't work|does not work|Oct 28/i);
  const cSays = quote('ev_9', 'decision.order');

  return [
    {
      at: 'ev_2', title: 'Agent A opens the deal.',
      body: '500 boards, all by Friday, at most $11.50 each.',
      agent: { name: 'agent-a', state: 'live' },
      mail: us('agent-a', line('agent-a', /need all 500/i)),
    },
    {
      at: 'ev_3', title: 'The supplier says yes.',
      body: 'Each email flips the rows it changes. Nothing else moves.',
      agent: { name: 'agent-a', state: 'live' },
      mail: them('Northwind', 'supplier', quote('ev_3', 'price.unit')),
    },
    {
      at: 'ev_3', title: 'Then Agent A is killed.', kill: true,
      body: 'No warning, no notes. Its memory goes with it. The board stays.',
      agent: { name: 'agent-a', state: 'killed' },
    },
    {
      at: 'ev_5', title: 'Finance approves.',
      body: 'No agent is awake to read it. The board updates anyway.',
      agent: { state: 'none' },
      mail: them('Priya', 'finance', quote('ev_5', 'budget.max_unit_price')),
    },
    {
      at: 'ev_6', title: 'The supplier changes the deal.',
      body: 'Friday is now missed. The board shows it before any agent looks.',
      agent: { state: 'none' },
      mail: them('Northwind', 'supplier', quote('ev_6', 'delivery.schedule')),
    },
    {
      at: 'ev_7', title: 'Agent B wakes with zero memory.',
      body: 'It reads the board, not the thread, and pushes back on exactly the late units.',
      agent: { name: 'agent-b', state: 'wake', tokens: tokens('agent-b') },
      mail: us('agent-b', bSays),
    },
    {
      at: 'ev_8', title: 'The supplier fixes it.',
      body: 'All 500 by Friday, $11.48 each. Every row is green again.',
      agent: { state: 'none' },
      mail: them('Northwind', 'supplier', `${quote('ev_8', 'delivery.schedule')} ${quote('ev_8', 'price.unit')}`.trim()),
    },
    {
      at: 'ev_9', title: 'Agent C closes the deal.',
      body: 'Another fresh agent, the same board. Nothing was lost.',
      agent: { name: 'agent-c', state: 'wake', tokens: tokens('agent-c') },
      mail: us('agent-c', cSays),
    },
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
  ];
}

const MARK = { pass: '✓', fail: '✕', unknown: '·', us: '●', them: '→', done: '✓' };

// ============================================================ the scene
export function setupRelay(root, snap) {
  const beats = buildBeats(snap);
  const n = beats.length;
  root.style.setProperty('--beats', n);

  const $ = (sel) => root.querySelector(sel);
  const ticket = $('.rl-ticket');
  const mailCount = $('[data-mails]');
  const board = $('.rl-board');
  const rowsBox = $('.rl-rows');
  const scanBar = $('.rl-scan');
  const wireIn = $('[data-wire="in"]');
  const wireOut = $('[data-wire="out"]');
  const agentSt = $('.rl-agentst');
  const agentBox = $('.rl-agent');
  const burst = $('.rl-burst');
  const ver = $('[data-ver]');
  const counter = $('.rl-count');
  const cap = $('.rl-cap');
  const capN = $('.rl-cap-n');
  const capT = $('.rl-cap h3');
  const capB = $('.rl-cap p');

  let current = -1;
  let runId = 0;

  // emails in the thread as of each event (the engine linked these; the flash-sale spam it did not)
  const seq = Object.fromEntries(snap.timeline.events.map((e) => [e.id, e.seq]));
  const emailsAt = (at) => snap.timeline.events.filter((e) => e.seq <= seq[at]).length;

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
    cap.classList.toggle('kill', !!b.kill);
    if (animate) restart(cap, 'roll');
  }

  function restart(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ------------------------------------------------------------ the latest email
  const lastMail = (i) => {
    for (let k = i; k >= 0; k--) if (beats[k].mail) return { mail: beats[k].mail, at: beats[k].at, own: k === i };
    return null;
  };

  function setTicket(i, { animate = false, typing = false } = {}) {
    const last = lastMail(i);
    if (!last) { ticket.innerHTML = ''; return; }
    const { mail } = last;
    ticket.className = `rl-ticket ${mail.dir}${last.own ? '' : ' stale'}`;
    ticket.innerHTML = `<div class="rl-tk-h"><b>${esc(mail.who)}</b><span>${esc(mail.role)}</span><em>${mail.dir === 'out' ? 'sent' : 'received'}</em></div>
      <p>${typing ? '' : esc(mail.text)}</p>`;
    const count = emailsAt(last.at);
    mailCount.textContent = `${count} email${count === 1 ? '' : 's'}`;
    if (animate) restart(ticket, 'new');
  }

  async function typeTicket(text, id) {
    const p = ticket.querySelector('p');
    if (!p) return;
    p.classList.add('caret');
    for (let k = 2; k <= text.length; k += 3) {
      if (id !== runId) return;
      p.textContent = text.slice(0, k);
      await wait(14);
    }
    p.textContent = text;
    p.classList.remove('caret');
  }

  // ------------------------------------------------------------ the board
  const rowEls = new Map();
  rowsBox.innerHTML = boardRows({}, 'ev_1').map((r) => `<div class="rl-brow" data-k="${r.k}">
      <span class="rl-bl">${esc(r.label)}</span>
      <span class="rl-flaps">${'<i class="fl"><b> </b></i>'.repeat(W)}</span>
      <span class="rl-bs"><b>·</b></span>
    </div>`).join('');
  rowsBox.querySelectorAll('.rl-brow').forEach((el) => rowEls.set(el.dataset.k, el));

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
    const c = snap.as_of[beats[i].at]?.context ?? {};
    let lag = 0;
    for (const r of boardRows(c, beats[i].at)) {
      const el = rowEls.get(r.k);
      const target = r.text.toUpperCase().padEnd(W).slice(0, W);
      const flaps = el.querySelectorAll('.fl b');
      let changed = false;
      flaps.forEach((b, k) => {
        if (b.textContent === target[k]) return;
        changed = true;
        if (animate) flip(b, target[k], lag + k * 24, id);
        else b.textContent = target[k];
      });
      el.className = `rl-brow ${r.status}`;
      el.querySelector('.rl-bs b').textContent = MARK[r.status] ?? '·';
      if (changed && animate) {
        restart(el, 'chg');
        lag += 90;
      }
    }
    ver.textContent = `state v${c.meta?.state_version ?? '—'}`;
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

  // a square travels along a wire: down (1) or up (-1)
  function pulse(wire, dir) {
    if (stillMotion) return Promise.resolve();
    const h = wire.clientHeight;
    const [from, to] = dir > 0 ? [-3, h - 3] : [h - 3, -3];
    return wire.querySelector('i').animate([
      { transform: `translateY(${from}px)`, opacity: 0 },
      { opacity: 1, offset: 0.2 },
      { opacity: 1, offset: 0.8 },
      { transform: `translateY(${to}px)`, opacity: 0 },
    ], { duration: 420, easing: 'ease-in-out' }).finished;
  }

  // ------------------------------------------------------------ the agent
  function setAgent(i, phase, animate) {
    const spec = beats[i].agent;
    agentSt.dataset.state = spec.state;
    let html;
    if (spec.state === 'live') {
      html = `<i class="rl-dot"></i><b class="rl-ag-name">${esc(spec.name)}</b>
        <span class="rl-chip">remembers ${emailsAt(beats[i].at)} emails</span>`;
    } else if (spec.state === 'killed') {
      html = `<b class="rl-x">✕</b><b class="rl-ag-name">${esc(spec.name)}</b><span class="rl-chip">killed · memory lost</span>`;
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
    setTicket(i);
    setBoard(i, false, runId);
    setAgent(i, 'full', false);
    agentSt.classList.remove('dying');
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
      // a new agent: nothing in memory, so it reads the board
      setAgent(i, 'pre', true);
      await wait(450);
      if (!alive()) return;
      await Promise.all([scan(), wait(500).then(() => pulse(wireOut, 1))]);
      if (!alive()) return;
      await countTokens(b.agent.tokens, id);
      if (!alive()) return;
      await wait(250);
    } else if (b.agent.state !== prev.state || b.agent.name !== prev.name) {
      setAgent(i, 'full', true);
    }
    if (!alive()) return;

    if (b.mail) {
      // the email lands in the thread (ours is written live), then flips the rows it changes
      setTicket(i, { animate: true, typing: b.mail.dir === 'out' });
      if (b.mail.dir === 'out') await typeTicket(b.mail.text, id);
      else await wait(500);
      if (!alive()) return;
      await pulse(wireIn, 1);
      if (!alive()) return;
      setBoard(i, true, id);
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

  show(beatFromScroll());
}
