// Fig. 2, played as a sequence when it scrolls into view:
//   the email types itself out → each phrase that matters lights up → a connector carries it
//   across to the state → the state line it changes decodes in (the old delivery date is struck)
//   → the next move flips from Them to Us.
// Connectors are SVG paths measured from the live layout, so they redraw on resize.
// Narrow screens stack the two cards and skip the connectors; the sequence still plays.

import { scramble, stillMotion } from './motion.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const NS = 'http://www.w3.org/2000/svg';

export function setupMechanism(fig) {
  const diff = fig.querySelector('.diff');
  const mail = fig.querySelector('.mail');
  const ver = fig.querySelector('[data-ver]');
  const rows = Array.from(fig.querySelectorAll('.dl'));
  const replay = fig.querySelector('[data-replay]');

  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('links');
  svg.setAttribute('aria-hidden', 'true');
  diff.append(svg);

  // the mail's text, segment by segment (plain text and highlighted phrases)
  const segments = Array.from(mail.childNodes).map((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const span = document.createElement('span');
      span.textContent = node.textContent;
      node.replaceWith(span);
      return { el: span, text: span.textContent };
    }
    return { el: node, text: node.textContent };
  });
  const caret = document.createElement('span');
  caret.className = 'caret';

  // a hidden full copy underneath holds the card's height while the text types in
  const ghost = mail.cloneNode(true);
  ghost.className = 'mail mail-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.querySelectorAll('[data-to]').forEach((p) => p.removeAttribute('data-to'));
  const stack = document.createElement('div');
  stack.className = 'mail-stack';
  mail.replaceWith(stack);
  stack.append(ghost, mail);

  const phrases = () => Array.from(mail.querySelectorAll('[data-to]'));
  const rowOf = (key) => fig.querySelector(`.dl[data-k="${key}"]`);
  const targetOf = (phrase) => rowOf(phrase.dataset.to.split(' ').pop());

  let drawn = []; // [phrase, row] pairs whose connector is on screen
  let run = 0;

  // ------------------------------------------------------------ connectors
  const stacked = () => getComputedStyle(diff).gridTemplateColumns.split(' ').length < 3;

  function geometry(phrase, row) {
    const box = diff.getBoundingClientRect();
    const inCard = fig.querySelector('.diff-in').getBoundingClientRect();
    const outCard = fig.querySelector('.diff-out').getBoundingClientRect();
    const rects = phrase.getClientRects();
    const last = rects[rects.length - 1];
    const r = row.getBoundingClientRect();
    const x1 = inCard.right - box.left;
    const y1 = last.top + last.height / 2 - box.top;
    const x2 = outCard.left - box.left;
    const y2 = r.top + r.height / 2 - box.top;
    const mid = (x2 - x1) / 2;
    return { x1, y1, x2, y2, d: `M${x1 - 10},${y1} H${x1} C${x1 + mid},${y1} ${x2 - mid},${y2} ${x2},${y2} H${x2 + 10}` };
  }

  function connector(phrase, row, animate) {
    if (stacked()) return Promise.resolve();
    const g = geometry(phrase, row);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', g.d);
    path.classList.add('link');
    const a = document.createElementNS(NS, 'rect');
    const b = document.createElementNS(NS, 'rect');
    for (const [end, x, y] of [[a, g.x1, g.y1], [b, g.x2, g.y2]]) {
      end.setAttribute('x', x - 2.5);
      end.setAttribute('y', y - 2.5);
      end.setAttribute('width', 5);
      end.setAttribute('height', 5);
      end.classList.add('end');
    }
    svg.append(path, a, b);
    drawn.push([phrase, row]);
    if (!animate) { a.classList.add('on'); b.classList.add('on'); return Promise.resolve(); }

    // draw the stroke, then send a packet along it
    const len = path.getTotalLength();
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    a.classList.add('on');
    path.getBoundingClientRect();
    path.style.transition = 'stroke-dashoffset 0.6s cubic-bezier(0.65, 0, 0.35, 1)';
    path.style.strokeDashoffset = 0;

    const packet = document.createElementNS(NS, 'rect');
    packet.setAttribute('width', 7);
    packet.setAttribute('height', 7);
    packet.classList.add('packet');
    svg.append(packet);
    return new Promise((done) => {
      const start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / 600);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const pt = path.getPointAtLength(e * len);
        packet.setAttribute('x', pt.x - 3.5);
        packet.setAttribute('y', pt.y - 3.5);
        if (t < 1) { requestAnimationFrame(tick); return; }
        packet.remove();
        b.classList.add('on');
        path.style.strokeDasharray = '';
        done();
      };
      requestAnimationFrame(tick);
    });
  }

  function redraw() {
    const pairs = drawn;
    svg.replaceChildren();
    drawn = [];
    pairs.forEach(([p, r]) => connector(p, r, false));
  }

  // ------------------------------------------------------------ states
  function reset() {
    run++;
    svg.replaceChildren();
    drawn = [];
    diff.classList.add('armed');
    segments.forEach((s) => { s.el.textContent = ''; s.el.classList.remove('lit'); });
    rows.forEach((r) => r.classList.remove('done'));
    rows.forEach((r) => { if (r.dataset.final) r.querySelector('span').innerHTML = r.dataset.first; });
    if (ver) ver.textContent = ver.dataset.from;
  }

  function finish() {
    run++;
    svg.replaceChildren();
    drawn = [];
    segments.forEach((s) => { s.el.textContent = s.text; });
    caret.remove();
    rows.forEach((r) => r.classList.add('done'));
    rows.forEach((r) => { if (r.dataset.final) r.querySelector('span').innerHTML = r.dataset.final; });
    phrases().forEach((p) => {
      p.classList.add('lit');
      connector(p, targetOf(p), false);
    });
    if (ver) ver.textContent = ver.dataset.to;
    diff.classList.remove('armed');
  }

  async function type(id) {
    // remaining text sits in a hidden span so the card never changes height while typing
    for (const s of segments) {
      for (let n = 1; n <= s.text.length; n++) {
        if (id !== run) return;
        s.el.textContent = s.text.slice(0, n);
        s.el.append(caret);
        if (n % 3 === 0) await wait(14);
      }
    }
    caret.remove();
  }

  async function play() {
    reset();
    const id = run;
    await wait(250);
    await type(id);

    for (const phrase of phrases()) {
      if (id !== run) return;
      await wait(240);
      phrase.classList.add('lit');
      await wait(260);
      await connector(phrase, targetOf(phrase), true);
      for (const k of phrase.dataset.to.split(' ')) {
        if (id !== run) return;
        const row = rowOf(k);
        row.classList.add('done');
        const value = row.querySelector('span');
        if (!row.classList.contains('del')) await scramble(value, value.textContent, { duration: 440 });
        await wait(100);
      }
    }

    if (id !== run) return;
    await wait(300);
    const next = fig.querySelector('.dl[data-final]');
    next.classList.add('flip');
    next.querySelector('span').innerHTML = next.dataset.final;
    next.classList.add('done');
    if (ver) await scramble(ver, ver.dataset.to, { duration: 400 });
    diff.classList.remove('armed');
  }

  // ------------------------------------------------------------ wiring
  new ResizeObserver(() => redraw()).observe(diff);
  replay?.addEventListener('click', () => (stillMotion ? finish() : play()));

  if (stillMotion) { finish(); return; }
  reset();
  const watch = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    watch.disconnect();
    play();
  }, { threshold: 0.5 });
  watch.observe(diff);
}
