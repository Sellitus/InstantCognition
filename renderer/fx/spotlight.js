// Cursor spotlight: one passive, rAF-throttled pointermove listener writes the
// pointer position into --fx-mx/--fx-my on the hovered surface; CSS draws the
// glow. Only the element under the cursor is touched.

const SELECTOR = '.command-palette-item, .new-tab-picker-card, .tab-bar-tab, .agent-panel-starters button, .session-list__open';

let installed = false;
let pending = null;
let scheduled = false;

function flush() {
  scheduled = false;
  const e = pending;
  pending = null;
  if (!e || !(e.target instanceof Element)) return;
  const el = e.target.closest(SELECTOR);
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--fx-mx', `${(e.clientX - r.left).toFixed(1)}px`);
  el.style.setProperty('--fx-my', `${(e.clientY - r.top).toFixed(1)}px`);
}

function onMove(e) {
  pending = e;
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flush);
  }
}

function install() {
  if (installed) return;
  installed = true;
  document.addEventListener('pointermove', onMove, { passive: true });
}

module.exports = { install, SELECTOR };
