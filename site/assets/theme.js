// Light by default; dark only when the viewer picks it. The choice is remembered per browser.
// The <head> sets data-theme before first paint; this wires the switch and tells canvases to repaint.
const root = document.documentElement;

export const currentTheme = () => (root.dataset.theme === 'dark' ? 'dark' : 'light');

/** Read a colour token from site.css, e.g. token('--ink'). */
export const token = (name) => getComputedStyle(root).getPropertyValue(name).trim();

function label() {
  const next = currentTheme() === 'dark' ? 'Light' : 'Dark';
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
    b.textContent = next;
    b.setAttribute('aria-label', `Switch to ${next.toLowerCase()} theme`);
  });
}

export function setTheme(theme) {
  root.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch {}
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', token('--bg'));
  label();
  dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

export function setupTheme() {
  label();
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
    b.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  });
}
