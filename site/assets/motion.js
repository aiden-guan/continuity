// Small motion pieces shared across the story page:
//   splitWords  — headings rise word by word out of a mask
//   scramble    — mono text decodes from glyph noise into its final value
//   countUp     — a number ticks up to its printed value
//   setupNavThread — the page as a thread: scroll progress along the nav, a marker that slides between links

export const stillMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Wrap every word of an element in a mask, keeping inline elements (.dim, <br>) intact. */
export function splitWords(el) {
  let index = 0;
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = child.textContent.split(/([ \t\n]+)/); // not \s: a no-break space keeps its words together
        const frag = document.createDocumentFragment();
        for (const part of parts) {
          if (!part) continue;
          if (/^[ \t\n]+$/.test(part)) { frag.append(' '); continue; }
          const mask = document.createElement('span');
          mask.className = 'w';
          const inner = document.createElement('span');
          inner.textContent = part;
          inner.style.setProperty('--i', index++);
          mask.append(inner);
          frag.append(mask);
        }
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'BR') {
        walk(child);
      }
    }
  };
  walk(el);
  el.classList.add('split');
  return index;
}

const GLYPHS = '▚▞▖▗▘▝░▒/\\<>_-+=*#01';

/** Decode an element's text from glyph noise, left to right. Resolves when done. */
export function scramble(el, text = el.textContent, { duration = 700, delay = 0 } = {}) {
  if (stillMotion) { el.textContent = text; return Promise.resolve(); }
  return new Promise((done) => {
    const start = performance.now() + delay;
    const chars = Array.from(text);
    const tick = (now) => {
      const t = Math.max(0, (now - start) / duration);
      if (t >= 1) { el.textContent = text; done(); return; }
      const settled = Math.floor(t * chars.length * 1.15);
      el.textContent = chars.map((ch, i) => {
        if (i < settled || ch === ' ') return ch;
        if (now < start) return '';
        return i < settled + 6 ? GLYPHS[(Math.random() * GLYPHS.length) | 0] : '';
      }).join('');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Tick a printed number ("2.4k", "2.7M", "6/6") up from zero, keeping its format.
 * The first number in the text is animated; the rest of the text is kept.
 */
export function countUp(el, { duration = 1400, delay = 0 } = {}) {
  const text = el.textContent;
  const match = text.match(/\d+(?:[.,]\d+)?/);
  if (!match || stillMotion) return;
  const target = parseFloat(match[0].replace(',', ''));
  const decimals = (match[0].split('.')[1] || '').length;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const start = performance.now() + delay;
  el.textContent = before + (0).toFixed(decimals) + after;
  const tick = (now) => {
    const t = Math.min(1, Math.max(0, (now - start) / duration));
    const e = 1 - Math.pow(1 - t, 4);
    el.textContent = before + (target * e).toFixed(decimals) + after;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Scroll progress drawn as a thread under the nav, and a square that follows the active link. */
export function setupNavThread(nav) {
  const bar = document.createElement('div');
  bar.className = 'nav-thread';
  bar.setAttribute('aria-hidden', 'true');
  bar.innerHTML = '<i></i><b></b>';
  nav.append(bar);

  const links = nav.querySelector('.nav-links');
  const mark = document.createElement('i');
  mark.className = 'nav-mark';
  mark.setAttribute('aria-hidden', 'true');
  links?.append(mark);

  let queued = false;
  const update = () => {
    queued = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.setProperty('--p', max > 0 ? (scrollY / max).toFixed(4) : 0);
    const on = links?.querySelector('a.on');
    if (on) {
      mark.style.setProperty('--x', `${on.offsetLeft + on.offsetWidth / 2}px`);
      mark.classList.add('show');
    } else {
      mark.classList.remove('show');
    }
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue);
  update();
}
