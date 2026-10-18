// The story page. Its pieces:
//   1. nav that turns solid after the fold, a scroll thread, active section links, reveal-on-scroll
//      (headings rise word by word, section labels decode)
//   2. hero: "Agents forget." as particles (particles.js) over a looping canvas of agents on one thread
//   3. Fig. 2, the email → state sequence (mechanism.js)
//   4. the replayed demo: sticky thread + state readout driven by real engine output (snapshot.json)
//   5. results: Fig. 3 to scale (tokenfield.js), counters and cell meters
//   6. footer wordmark, dithered — the page's one dithered moment, kept quiet
import { dither } from './dither.js';
import { threadSVG, eventLabel, esc } from './board.js';
import { setupTheme, token } from './theme.js';
import { splitWords, scramble, countUp, setupNavThread, stillMotion } from './motion.js';
import { setupHeroParticles } from './particles.js';
import { setupMechanism } from './mechanism.js';
import { setupTokenField } from './tokenfield.js';

const one = (sel, root = document) => root.querySelector(sel);
const all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const MONO_11 = '400 11px "Geist Mono", ui-monospace, monospace';
const MONO_12 = '500 12px "Geist Mono", ui-monospace, monospace';

// ============================================================ 1 · nav + reveals
function setupChrome() {
  const nav = one('#nav');
  const onScroll = () => nav.classList.toggle('solid', scrollY > 24);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  setupNavThread(nav);

  // headings rise word by word; the words carry their own stagger
  all('.h2, .end-line, .h-keep').forEach(splitWords);

  const watcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      el.classList.add('in');
      watcher.unobserve(el);
      const label = el.matches('.sec-k') && one('.t', el);
      if (label) scramble(label, label.textContent, { duration: 650, delay: 120 });
      if (el.matches('.metric')) all('.bar-row b', el).forEach((b, i) => countUp(b, { delay: 250 + i * 120 }));
      if (el.matches('.ledger')) all('code', el).forEach((c, i) => scramble(c, c.textContent, { duration: 600, delay: 400 + i * 140 }));
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  all('.reveal').forEach((el) => watcher.observe(el));

  // the hero's second line rises as soon as the type is ready
  (document.fonts?.ready ?? Promise.resolve()).then(() => one('.h-keep')?.classList.add('in'));

  // the nav link for the section under the reading line
  const links = all('.nav-links a');
  const sections = links.map((a) => one(a.getAttribute('href')));
  const mark = () => {
    const line = innerHeight * 0.4;
    let current = -1;
    sections.forEach((sec, i) => { if (sec && sec.getBoundingClientRect().top < line) current = i; });
    links.forEach((a, i) => a.classList.toggle('on', i === current));
  };
  addEventListener('scroll', () => requestAnimationFrame(mark), { passive: true });
  mark();
}

// ============================================================ 2 · hero thread (canvas loop)
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

// colours are read from the theme tokens, and re-read when the theme changes
function readInk() {
  return {
    ink: token('--ink'), ink2: token('--ink-2'), muted: token('--muted'), faint: token('--faint'),
    bg: token('--bg'), signal: token('--signal'), signalInk: token('--signal-ink'),
  };
}

function setupHeroThread(canvas) {
  const ctx = canvas.getContext('2d');
  const view = { w: 0, h: 0, dpr: 1 };
  let ink = readInk();
  let sparks = [];
  let lastHead = 0;
  let frameId = 0;
  let inView = true;
  const epoch = performance.now();
  const kick = () => { if (!frameId) frameId = requestAnimationFrame(frame); };

  function measure() {
    const box = canvas.getBoundingClientRect();
    view.dpr = Math.min(2, devicePixelRatio || 1);
    view.w = box.width;
    view.h = box.height;
    canvas.width = view.w * view.dpr;
    canvas.height = view.h * view.dpr;
    if (stillMotion) kick();
  }
  new ResizeObserver(measure).observe(canvas);
  measure();
  addEventListener('themechange', () => { ink = readInk(); kick(); });

  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView) kick();
  }).observe(canvas);

  // particles: a small outward burst, or (implode) a swarm drawn into a point
  function spray(x, y, count, colour, implode) {
    for (let k = 0; k < count; k++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.3 + Math.random() * 1.8;
      const p = { x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.4, life: 1, colour };
      if (implode) {
        p.x = x + Math.cos(angle) * 36 * Math.random();
        p.y = y + Math.sin(angle) * 22 * Math.random();
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

    const small = W < 720;
    const margin = Math.max(20, Math.min(W * 0.05, 64));
    const baseY = Math.round(H * 0.6);
    const laneY = baseY - 44;
    const xOf = (f) => margin + f * (W - margin * 2);
    const headX = xOf(head);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = alpha;

    // future: dotted; past: a solid ink rule
    ctx.fillStyle = ink.faint;
    for (let x = headX + 4; x < W - margin; x += 5) ctx.fillRect(Math.round(x), baseY, 1, 1);
    ctx.fillStyle = ink.ink;
    ctx.fillRect(margin, baseY - 0.75, headX - margin, 1.5);
    ctx.fillRect(Math.round(headX) - 1, baseY - 6, 2, 12);

    // events: inbound diamonds, outbound squares
    for (const ev of HERO_EVENTS) {
      const x = Math.round(xOf(ev.at));
      const reached = head >= ev.at;
      const fresh = reached ? Math.min(1, (head - ev.at) * 14) : 0;
      const alarm = ev.alarm && reached;

      ctx.save();
      ctx.translate(x, baseY);
      if (!ev.outbound) ctx.rotate(Math.PI / 4);
      const half = 3.5 + (reached ? 1 - fresh : 0) * 2;
      ctx.fillStyle = !reached || ev.outbound ? ink.bg : alarm ? ink.signal : ink.ink;
      ctx.strokeStyle = !reached ? ink.faint : alarm ? ink.signal : ink.ink;
      ctx.lineWidth = ev.outbound && reached ? 1.5 : 1;
      ctx.fillRect(-half, -half, half * 2, half * 2);
      ctx.strokeRect(-half, -half, half * 2, half * 2);
      ctx.restore();

      if (alarm && fresh < 1) {
        ctx.strokeStyle = ink.signal;
        ctx.globalAlpha = alpha * (1 - fresh);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, baseY, 8 + fresh * 22, 0, 7);
        ctx.stroke();
        ctx.globalAlpha = alpha;
      }

      if (small && ev.minor) continue;
      ctx.textAlign = 'center';
      ctx.globalAlpha = alpha * (reached ? 1 : 0.55);
      ctx.font = MONO_11;
      ctx.fillStyle = reached ? ink.muted : ink.faint;
      ctx.fillText(ev.id, x, baseY + 24);
      if (!small || ev.alarm) {
        ctx.fillStyle = alarm ? ink.signalInk : reached ? ink.ink2 : ink.faint;
        ctx.fillText(ev.text, x, baseY + 40);
      }
      ctx.globalAlpha = alpha;
    }

    // the gap: nobody running, the line keeps going
    if (head > HERO_GAP.start) {
      const a = xOf(HERO_GAP.start) + 12;
      const b = xOf(Math.min(head, HERO_GAP.end)) - 4;
      const text = small ? 'no agent running' : 'no agent running · state still updating';
      ctx.font = MONO_11;
      const tw = ctx.measureText(text).width;
      const showText = b - a > tw + 40;
      const mid = (a + b) / 2;
      ctx.fillStyle = ink.faint;
      for (let x = a; x < b; x += 4) {
        if (showText && Math.abs(x - mid) < tw / 2 + 10) continue;
        ctx.fillRect(Math.round(x), laneY, 1, 1);
      }
      if (showText) {
        ctx.textAlign = 'center';
        ctx.fillStyle = ink.muted;
        ctx.fillText(text, mid, laneY + 4);
      }
    }

    // agents: a lifeline above the thread, with a stem down to where it joined
    ctx.textAlign = 'left';
    for (const ag of HERO_AGENTS) {
      if (head < ag.start) continue;
      const living = head < ag.end;
      const killed = ag.dies && !living;
      const a = Math.round(xOf(ag.start));
      const b = Math.round(xOf(Math.min(head, ag.end)));
      const colour = killed ? ink.signal : living ? ink.ink : ink.muted;

      ctx.fillStyle = colour;
      ctx.globalAlpha = alpha * (killed ? 0.6 : 1);
      ctx.fillRect(a, laneY - 2, Math.max(4, b - a), 4);
      ctx.globalAlpha = alpha * 0.35;
      ctx.fillRect(a, laneY + 2, 1, baseY - laneY - 7);
      ctx.globalAlpha = alpha;
      if (living) ctx.fillRect(b - 1, laneY - 6, 2, 12);

      ctx.font = MONO_12;
      ctx.fillStyle = killed ? ink.signalInk : ink.ink;
      ctx.fillText(ag.name, a, laneY - 13);
      if (ag.note && !small) {
        const offset = ctx.measureText(ag.name + '  ').width;
        ctx.font = MONO_11;
        ctx.fillStyle = ink.muted;
        ctx.fillText(ag.note, a + offset, laneY - 13);
      }

      if (killed) {
        const kx = Math.round(xOf(ag.end));
        ctx.strokeStyle = ink.signal;
        ctx.lineWidth = 1.75;
        ctx.beginPath();
        ctx.moveTo(kx - 5, laneY - 5); ctx.lineTo(kx + 5, laneY + 5);
        ctx.moveTo(kx + 5, laneY - 5); ctx.lineTo(kx - 5, laneY + 5);
        ctx.stroke();
        const sinceDeath = head - ag.end;
        if (sinceDeath < 0.14) {
          ctx.globalAlpha = alpha * (1 - sinceDeath / 0.14);
          ctx.font = MONO_12;
          ctx.fillStyle = ink.signalInk;
          ctx.fillText('SIGKILL', kx + 12, laneY + 4);
          ctx.globalAlpha = alpha;
        }
      }

      // birth and death, fired once as the head crosses
      if (!stillMotion && lastHead < ag.start && head >= ag.start) spray(xOf(ag.start), laneY, 18, ink.ink, true);
      if (!stillMotion && ag.dies && lastHead < ag.end && head >= ag.end) spray(xOf(ag.end), laneY, 36, ink.signal);
    }

    // particles: 2px squares
    sparks = sparks.filter((p) => p.life > 0);
    for (const p of sparks) {
      if (p.tx != null) {
        p.x += (p.tx - p.x) * 0.14;
        p.y += (p.ty - p.y) * 0.14;
        p.life -= 0.035;
      } else {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.04;
        p.vx *= 0.98;
        p.life -= 0.02;
      }
      ctx.globalAlpha = alpha * Math.max(0, p.life);
      ctx.fillStyle = p.colour;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
    }

    ctx.globalAlpha = 1;
    lastHead = head;
    if (inView && !stillMotion) frameId = requestAnimationFrame(frame);
  }

  document.fonts?.ready.then(kick);
  kick();
}

// ============================================================ 3 · the replayed demo
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
    const before = one('.actor', mini)?.textContent;
    mini.className = `mini ${(c?.checks ?? []).some((x) => x.status === 'fail') ? 'bad' : ''}`;
    mini.innerHTML = miniMarkup(c);
    const actor = one('.actor', mini);
    if (before && actor.textContent !== before) actor.classList.add('roll');
    one('#stage-v').textContent = `${beat.at} · state v${c?.meta?.state_version ?? '—'}`;
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

// ============================================================ 4 · results
function setupCells() {
  all('.cells').forEach((row) => {
    const n = Number(row.dataset.n);
    const of = Number(row.dataset.of);
    row.innerHTML = Array.from({ length: of }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  });
}

// ============================================================ 5 · wordmark
// paper-on-paper: the dither only reaches full ink where the slow sweep or the pointer lights it
const wordmarkPalette = () => [token('--bg'), token('--bg-2'), token('--faint'), token('--muted')];

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

  const begin = () => {
    const fx = dither(canvas, {
      scene: 'source', pixel: 3, gain: 0.8,
      palette: wordmarkPalette(),
      source: glyphs, onResize: drawGlyphs,
    });
    addEventListener('themechange', () => fx.set('palette', wordmarkPalette()));
  };
  (document.fonts?.ready ?? Promise.resolve()).then(begin);
}

setupTheme();
setupChrome();
setupHeroThread(one('#hero-thread'));
if (document.documentElement.classList.contains('px')) {
  setupHeroParticles({ hero: one('.hero'), line: one('.h-forget'), thread: one('#hero-thread') });
}
setupMechanism(one('#mech'));
setupTokenField(one('#field'));
setupStory();
setupCells();
setupWordmark();
