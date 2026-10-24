// "Live" rim: a brand-gradient outline with a bright segment orbiting the
// border while something is generating. SVG stroke-dashoffset animation, so
// each frame repaints only a thin stroke rather than a full-box gradient.

const SVG_NS = 'http://www.w3.org/2000/svg';
const LEAVE_MS = 320;
const rims = new WeakMap();

function ensureDefs() {
  if (document.getElementById('fx-defs')) return;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'fx-defs';
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = '<defs><linearGradient id="fx-grad" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#00DCFF"/><stop offset="1" stop-color="#FF2486"/>'
    + '</linearGradient></defs>';
  document.body.appendChild(svg);
}

function buildRim(host) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'fx-rim');
  svg.setAttribute('aria-hidden', 'true');
  for (const part of ['glow', 'line', 'comet']) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', `fx-rim-${part}`);
    rect.setAttribute('pathLength', '100');
    svg.appendChild(rect);
  }
  const radius = parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0;
  svg.style.setProperty('--fx-rim-radius', `${Math.max(0, radius - 1)}px`);
  return svg;
}

// Show the rim on `host`. Idempotent; a pending removal is cancelled.
function attach(host) {
  if (!host) return;
  const existing = rims.get(host);
  if (existing) {
    clearTimeout(existing.timer);
    existing.svg.classList.add('is-on');
    return;
  }
  ensureDefs();
  const restorePosition = getComputedStyle(host).position === 'static';
  if (restorePosition) host.style.position = 'relative';
  const svg = buildRim(host);
  host.appendChild(svg);
  rims.set(host, { svg, timer: 0, restorePosition });
  requestAnimationFrame(() => svg.classList.add('is-on'));
}

// Fade the rim out, then remove it.
function detach(host) {
  const entry = host && rims.get(host);
  if (!entry) return;
  entry.svg.classList.remove('is-on');
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.svg.remove();
    if (entry.restorePosition) host.style.position = '';
    rims.delete(host);
  }, LEAVE_MS);
}

module.exports = { attach, detach };
