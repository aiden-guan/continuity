// The scroll story. Five pieces:
//   1. nav that turns solid after the fold, and reveal-on-scroll
//   2. hero background: a dithered sunrise that sinks as you scroll
//   3. hero thread: a looping canvas animation of agents living and dying on one line
//   4. the replayed demo: sticky thread + state readout driven by real engine output (snapshot.json)
//   5. footer wordmark, dithered
import { dither } from './dither.js';
import { threadSVG, eventLabel, esc } from './board.js';

const one = (sel, root = document) => root.querySelector(sel);
const all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const stillMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const MONO_11 = '500 11px "Geist Mono", ui-monospace, monospace';
const MONO_12_5 = '500 12.5px "Geist Mono", ui-monospace, monospace';
const SANS_12_5 = '500 12.5px "Geist", ui-sans-serif, sans-serif';

// ============================================================ 1 · nav + reveals
function setupChrome() {
  const nav = one('#nav');
  addEventListener('scroll', () => nav.classList.toggle('solid', scrollY > 40), { passive: true });

  const watcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      watcher.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  all('.reveal').forEach((el) => watcher.observe(el));
}

// ============================================================ 2 · hero background
function setupSunrise() {
  const sky = dither(one('#hero-bg'), { scene: 'horizon', pixel: 3, palette: ['#090807', '#4a1708', '#ff6a2b', '#ffd9a0'] });
  addEventListener('scroll', () => sky.set('prog', Math.min(1, scrollY / innerHeight)), { passive: true });
}

// ============================================================ 3 · hero thread (canvas loop)
// positions are fractions of the line's length
const HERO_EVENTS = [
  { at: 0.06, id: 'ev_1', text: 'RFQ sent', outbound: true },
  { at: 0.12, id: 'ev_2', text: 'budget request', outbound: true, minor: true },
  { at: 0.24, id: 'ev_3', text: 'offer + quote.pdf' },
  { at: 0.44, id: 'ev_5', text: 'finance approves', minor: true },
  { at: 0.56, id: 'ev_6', text: 'correction: 200 late', alarm: true },
  { at: 0.70, id: 'ev_7', text: 'agent-b raises it', outbound: true },
  { at: 0.82, id: 'ev_8', text: 'rev 2 quote', minor: true },
  { at: 0.93, id: 'ev_9', text: 'accepted', outbound: true },
];
const HERO_AGENTS = [
  { name: 'agent-a', start: 0.03, end: 0.33, dies: true },
  { name: 'agent-b', start: 0.645, end: 0.74, note: 'memory 0 · 1.4k tok' },
  { name: 'agent-c', start: 0.875, end: 0.955, note: 'memory 0' },
];
const HERO_GAP = { start: 0.33, end: 0.645 };
const HERO_LOOP_MS = 17000;

function setupHeroThread(canvas) {
  const ctx = canvas.getContext('2d');
  const view = { w: 0, h: 0, dpr: 1 };
  let sparks = [];
  let lastHead = 0;
  let frameId = 0;
  let inView = true;
  const epoch = performance.now();

  function measure() {
    const box = canvas.getBoundingClientRect();
    view.dpr = Math.min(2, devicePixelRatio || 1);
    view.w = box.width;
    view.h = box.height;
    canvas.width = view.w * view.dpr;
    canvas.height = view.h * view.dpr;
  }
  new ResizeObserver(measure).observe(canvas);
  measure();

  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView && !frameId) frameId = requestAnimationFrame(frame);
  }).observe(canvas);

  // particles: an outward explosion, or (implode) a swarm drawn into a point
  function spray(x, y, count, colour, implode) {
    for (let k = 0; k < count; k++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.4 + Math.random() * 2.6;
      const p = {
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.6,
        life: 1,
        size: Math.random() < 0.3 ? 3 : 2,
        colour,
      };
      if (implode) {
        p.x = x + Math.cos(angle) * 46 * Math.random();
        p.y = y + Math.sin(angle) * 28 * Math.random();
        p.tx = x;
        p.ty = y;
      }
      sparks.push(p);
    }
  }

  function frame(now) {
    frameId = 0;
    const { w: W, h: H, dpr } = view;
    const phase = stillMotion ? 0.78 : ((now - epoch) % HERO_LOOP_MS) / HERO_LOOP_MS;
    const head = Math.min(1, phase * 1.07); // reaches the end early and holds there
    const alpha = phase > 0.95 ? 1 - (phase - 0.95) / 0.05 : phase < 0.02 ? phase / 0.02 : 1;
    if (head < lastHead) sparks = []; // the loop restarted

    const margin = Math.max(18, W * 0.04);
    const baseY = Math.round(H * 0.58);
    const laneY = baseY - 40;
    const xOf = (f) => margin + f * (W - margin * 2);
    const headX = xOf(head);
    const small = W < 720;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = alpha;

    // future: a dotted line
    ctx.fillStyle = 'rgba(255,236,214,.16)';
    for (let x = headX; x < W - margin; x += 6) ctx.fillRect(Math.round(x), baseY, 2, 1);

    // past: a glowing gradient line
    const grad = ctx.createLinearGradient(margin, 0, headX, 0);
    grad.addColorStop(0, 'rgba(255,106,43,.15)');
    grad.addColorStop(0.7, '#ff6a2b');
    grad.addColorStop(1, '#ffd9a0');
    ctx.save();
    ctx.shadowColor = '#ff6a2b';
    ctx.shadowBlur = 14;
    ctx.fillStyle = grad;
    ctx.fillRect(margin, baseY - 1, headX - margin, 2);
    ctx.restore();

    // the head
    ctx.save();
    ctx.shadowColor = '#ffd9a0';
    ctx.shadowBlur = 22;
    ctx.fillStyle = '#fff3df';
    ctx.fillRect(Math.round(headX) - 3, baseY - 3, 6, 6);
    ctx.restore();

    // events
    ctx.textAlign = 'center';
    for (const ev of HERO_EVENTS) {
      const x = Math.round(xOf(ev.at));
      const reached = head >= ev.at;
      const fresh = reached ? Math.min(1, (head - ev.at) * 14) : 0;

      ctx.save();
      ctx.translate(x, baseY);
      if (!ev.outbound) ctx.rotate(Math.PI / 4);
      ctx.fillStyle = !reached ? 'rgba(255,236,214,.22)' : ev.outbound ? '#9cc2ff' : ev.alarm ? '#ff5b4f' : '#ff6a2b';
      const half = 4 + (reached ? 1 - fresh : 0) * 3;
      ctx.fillRect(-half, -half, half * 2, half * 2);
      ctx.restore();

      if (ev.alarm && reached && fresh < 1) {
        ctx.strokeStyle = `rgba(255,91,79,${1 - fresh})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, baseY, 8 + fresh * 26, 0, 7);
        ctx.stroke();
      }

      if (small && ev.minor) continue;
      ctx.globalAlpha = alpha * (reached ? 0.35 + fresh * 0.65 : 0.25);
      ctx.font = MONO_11;
      ctx.fillStyle = '#847c71';
      ctx.fillText(ev.id, x, baseY + 24);
      ctx.font = SANS_12_5;
      if (!small || ev.alarm) {
        ctx.fillStyle = ev.alarm && reached ? '#ffb3ab' : '#c4bcb0';
        ctx.fillText(ev.text, x, baseY + 41);
      }
      ctx.globalAlpha = alpha;
    }

    // the gap: nobody running, the line keeps going
    if (head > HERO_GAP.start) {
      const a = xOf(HERO_GAP.start) + 10;
      const b = xOf(Math.min(head, HERO_GAP.end));
      ctx.fillStyle = 'rgba(255,236,214,.22)';
      for (let x = a; x < b - 4; x += 5) ctx.fillRect(Math.round(x), laneY, 1, 1);
      if (b - a > 150) {
        ctx.textAlign = 'center';
        ctx.font = MONO_11;
        ctx.fillStyle = '#847c71';
        ctx.fillText(small ? 'no agent running' : 'no agent running · state still updating', (a + b) / 2, laneY - 9);
      }
    }

    // agents
    ctx.textAlign = 'left';
    for (const ag of HERO_AGENTS) {
      if (head < ag.start) continue;
      const living = head < ag.end;
      const a = xOf(ag.start);
      const b = xOf(Math.min(head, ag.end));
      const colour = ag.dies && !living ? '#ff5b4f' : '#9cc2ff';

      ctx.fillStyle = colour;
      ctx.globalAlpha = alpha * (living ? 0.95 : 0.5);
      ctx.fillRect(Math.round(a), laneY - 3, Math.max(4, Math.round(b - a)), 6);
      ctx.fillRect(Math.round(a), laneY + 3, 1, baseY - laneY - 8);
      if (living) {
        ctx.save();
        ctx.shadowColor = colour;
        ctx.shadowBlur = 16;
        ctx.fillRect(Math.round(b) - 4, laneY - 4, 8, 8);
        ctx.restore();
        ctx.fillRect(Math.round(b), laneY + 3, 1, baseY - laneY - 6);
      }
      ctx.globalAlpha = alpha;

      ctx.font = MONO_12_5;
      ctx.fillStyle = colour;
      ctx.fillText(ag.name, Math.round(a), laneY - 11);
      if (ag.note && !small) {
        const offset = ctx.measureText(ag.name + '  ').width;
        ctx.fillStyle = '#847c71';
        ctx.font = MONO_11;
        ctx.fillText(ag.note, Math.round(a + offset), laneY - 11);
      }

      if (ag.dies && !living) {
        const kx = Math.round(xOf(ag.end));
        ctx.strokeStyle = '#ff5b4f';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(kx - 5, laneY - 5); ctx.lineTo(kx + 5, laneY + 5);
        ctx.moveTo(kx + 5, laneY - 5); ctx.lineTo(kx - 5, laneY + 5);
        ctx.stroke();
        const sinceDeath = head - ag.end;
        if (sinceDeath < 0.12) {
          ctx.globalAlpha = alpha * (1 - sinceDeath / 0.12);
          ctx.font = '600 12px "Geist Mono", ui-monospace, monospace';
          ctx.fillStyle = '#ff5b4f';
          ctx.fillText('SIGKILL', kx + 10, laneY + 4);
          ctx.globalAlpha = alpha;
        }
      }

      // birth and death bursts, fired once as the head crosses
      if (!stillMotion && lastHead < ag.start && head >= ag.start) spray(xOf(ag.start), laneY, 34, '#9cc2ff', true);
      if (!stillMotion && ag.dies && lastHead < ag.end && head >= ag.end) spray(xOf(ag.end), laneY, 70, Math.random() < 0.5 ? '#ff5b4f' : '#ff6a2b');
    }

    // particles: blocky, with a little flicker
    sparks = sparks.filter((p) => p.life > 0);
    for (const p of sparks) {
      if (p.tx != null) {
        p.x += (p.tx - p.x) * 0.14;
        p.y += (p.ty - p.y) * 0.14;
        p.life -= 0.03;
      } else {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.05;
        p.vx *= 0.985;
        p.life -= 0.016;
      }
      ctx.globalAlpha = alpha * Math.max(0, p.life) * (Math.random() < 0.12 ? 0.3 : 1);
      ctx.fillStyle = p.colour;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }

    ctx.globalAlpha = 1;
    lastHead = head;
    if (inView && !stillMotion) frameId = requestAnimationFrame(frame);
  }

  document.fonts?.ready.then(() => { if (!frameId) frameId = requestAnimationFrame(frame); });
  frameId = requestAnimationFrame(frame);
}

// ============================================================ 4 · the replayed demo
const lightLabel = (label) => label
  .replace('All units by ', 'All by ')
  .replace('Unit price within budget', 'Price ≤ budget')
  .replace('Quantity 500 units', '500 units')
  .replace('Budget approved', 'Budget OK');

function buildBeats(snap) {
  const events = snap.timeline.events;
  const pos = (id) => events.findIndex((e) => e.id === id);
  const sendingRun = (agent) => snap.runs.find((r) => r.agent_id === agent && r.decision?.action === 'send');

  const killAt = pos('ev_3') + 0.45;
  const bWakes = pos('ev_7') - 0.45;
  const cWakes = pos('ev_9') - 0.45;

  const agentA = (to, state) => ({ name: 'agent-a', from: 0, to, state });
  const deadA = agentA(killAt, 'killed');
  const agentB = { name: 'agent-b', from: bWakes, to: pos('ev_7'), state: 'done', note: 'memory 0' };
  const agentC = { name: 'agent-c', from: cWakes, to: pos('ev_9'), state: 'alive', note: 'memory 0' };
  const sinceKill = (to) => [{ from: killAt, to }];

  // the single sentence agent B wrote that proves the point
  const bBody = sendingRun('agent-b')?.decision?.messages?.[0]?.body ?? '';
  const bSentence = bBody.split('\n').find((line) => /doesn't work|does not work|Oct 28/i.test(line)) ?? '';

  return [
    { at: 'ev_2', head: pos('ev_2'), title: 'Agent A opens the deal.', body: '500 boards, all by Friday, at most $11.50 each.', agents: [agentA(pos('ev_2'), 'alive')] },
    { at: 'ev_3', head: pos('ev_3'), title: 'The supplier says yes.', body: '500 by Friday at $11.40. Quote attached.', agents: [agentA(pos('ev_3'), 'alive')] },
    { at: 'ev_3', head: killAt, title: 'Then Agent A is killed.', body: 'No warning. No handoff notes.', agents: [deadA] },
    { at: 'ev_5', head: pos('ev_5'), title: 'Finance approves.', body: 'Nobody is awake to read it. Continuity is.', agents: [deadA], gaps: sinceKill(pos('ev_5')) },
    {
      at: 'ev_6', head: pos('ev_6'), hot: pos('ev_6'), title: 'The supplier changes the deal.',
      said: { who: 'them', text: '“Only 300 can arrive Friday. The other 200, Wednesday.”' },
      body: 'The deadline is now missed.', agents: [deadA], gaps: sinceKill(pos('ev_6')),
    },
    {
      at: 'ev_7', head: pos('ev_7'), title: 'Agent B wakes up with zero memory.', body: 'One call to Continuity. Then it writes:',
      said: { who: 'agent', text: bSentence, caption: 'agent-b · 0 messages in memory' },
      kicker: 'It never saw the conversation.', agents: [deadA, agentB], gaps: sinceKill(bWakes),
    },
    { at: 'ev_8', head: pos('ev_8'), title: 'The supplier fixes it.', body: 'All 500 by Friday, $11.48 each.', agents: [deadA, agentB], gaps: sinceKill(bWakes) },
    { at: 'ev_9', head: pos('ev_9'), title: 'Agent C closes the deal.', body: 'Another fresh agent. Every check passes.', agents: [deadA, agentB, agentC], gaps: sinceKill(bWakes) },
  ];
}

function stepMarkup(beat, i) {
  const quote = beat.said
    ? `<div class="said ${beat.said.who}">${beat.said.caption ? `<small>${esc(beat.said.caption)}</small>` : ''}${esc(beat.said.text)}</div>`
    : '';
  const kicker = beat.kicker ? `<p class="kicker">${esc(beat.kicker)}</p>` : '';
  return `<article class="step" data-i="${i}">
    <div class="step-n">${String(i + 1).padStart(2, '0')}</div>
    <h3>${esc(beat.title)}</h3>
    <p>${esc(beat.body)}</p>
    ${quote}
    ${kicker}
  </article>`;
}

function miniMarkup(c) {
  const who = c?.next_actor === 'us' ? 'Us' : c?.next_actor === 'them' ? 'Them' : 'Nobody';
  const lights = (c?.checks ?? []).map((x) => `<div class="light ${esc(x.status)}"><i></i>${esc(lightLabel(x.check))}</div>`).join('')
    || '<div class="light"><i></i>waiting for an offer</div>';
  return `<div><div class="mini-k">Next move</div><div class="actor ${esc(c?.next_actor)}">${who}</div></div>
      <div><div class="mini-k">Requirements</div><div class="lights">${lights}</div></div>`;
}

async function setupStory() {
  let snap;
  try {
    snap = await fetch('assets/snapshot.json').then((r) => r.json());
  } catch {
    return;
  }

  const beats = buildBeats(snap);
  one('#story-steps').innerHTML = beats.map(stepMarkup).join('');

  const nodes = snap.timeline.events.map((e) => ({ id: e.id, label: eventLabel(e), dir: e.direction }));
  const threadBox = one('#story-thread');
  const mini = one('#story-mini');
  const steps = all('.step');
  let shown = -1;

  function show(i) {
    if (i === shown) return;
    shown = i;
    const beat = beats[i];
    const c = snap.as_of[beat.at]?.context;
    const model = { slots: nodes.length, nodes: nodes.map((n, k) => ({ ...n, hot: k === beat.hot })), head: beat.head, agents: beat.agents, gaps: beat.gaps };
    threadBox.innerHTML = threadSVG(model, { width: Math.max(320, threadBox.clientWidth), height: 150, labels: innerWidth > 520 });
    mini.className = `mini ${(c?.checks ?? []).some((x) => x.status === 'fail') ? 'bad' : ''}`;
    mini.innerHTML = miniMarkup(c);
    steps.forEach((s) => s.classList.toggle('on', Number(s.dataset.i) === i));
  }

  // the step whose centre is closest to the reading line wins
  function choose() {
    const readingLine = innerHeight * (innerWidth < 960 ? 0.65 : 0.5);
    let best = 0;
    let bestDist = Infinity;
    steps.forEach((s, i) => {
      const box = s.getBoundingClientRect();
      const dist = Math.abs(box.top + box.height / 2 - readingLine);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    show(best);
  }

  show(0);
  addEventListener('scroll', () => requestAnimationFrame(choose), { passive: true });
  addEventListener('resize', () => { shown = -1; choose(); });
  one('#foot-src').textContent = `story: real engine output, ${snap.captured_at.slice(0, 10)}`;
}

// ============================================================ 5 · wordmark
function setupWordmark() {
  const canvas = one('#wordmark');
  const glyphs = document.createElement('canvas');

  function drawGlyphs(w, h) {
    glyphs.width = w;
    glyphs.height = h;
    const g = glyphs.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    let px = h * 0.98;
    g.font = `600 ${px}px Geist, ui-sans-serif, sans-serif`;
    px *= Math.min(1, (w * 0.96) / g.measureText('continuity').width);
    g.font = `600 ${px}px Geist, ui-sans-serif, sans-serif`;
    if ('letterSpacing' in g) g.letterSpacing = `${-px * 0.045}px`;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#fff';
    g.fillText('continuity', w / 2, h * 0.78);
  }

  const begin = () => dither(canvas, {
    scene: 'source', pixel: 4, gain: 1.15,
    palette: ['#090807', '#3d1306', '#ff6a2b', '#ffe2b0'],
    source: glyphs, onResize: drawGlyphs,
  });
  (document.fonts?.ready ?? Promise.resolve()).then(begin);
}

setupChrome();
setupSunrise();
setupHeroThread(one('#hero-thread'));
setupStory();
setupWordmark();
