// Summon moment: when the window is revealed (hotkey/tray/dock), two light
// heads race around the window edge from top-centre and meet at the bottom,
// while the content settles from 98.5% with a spring. Triggered by watching
// ipcBridge's `window-stabilizing` class come off <body>, i.e. the first frame
// the page is actually visible.

const canvasLayer = require('./canvasLayer');

const DEBOUNCE_MS = 700;
const TRAVEL_S = 0.7;
const FADE_S = 0.35;

// Point at arc length `s` on a w×h rectangle's perimeter, starting at the top
// centre and running clockwise. Negative `s` runs counter-clockwise.
function perimeterPoint(s, w, h) {
  const P = 2 * (w + h);
  let d = ((s % P) + P) % P;
  const half = w / 2;
  if (d <= half) return { x: half + d, y: 0 };
  d -= half;
  if (d <= h) return { x: w, y: d };
  d -= h;
  if (d <= w) return { x: w - d, y: h };
  d -= w;
  if (d <= h) return { x: 0, y: h - d };
  d -= h;
  return { x: d, y: 0 };
}

function drawHead(ctx, s, dir, w, h, color, alpha) {
  const trail = Math.min(260, (w + h) * 0.18);
  const steps = 22;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const p = perimeterPoint((s - trail * (1 - f)) * dir, w, h);
    ctx.globalAlpha = alpha * f * f;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 0.6 + 2.4 * f, 0, Math.PI * 2);
    ctx.fill();
  }
  const head = perimeterPoint(s * dir, w, h);
  const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 18);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = g;
  ctx.fillRect(head.x - 18, head.y - 18, 36, 36);
  ctx.globalAlpha = 1;
}

function playEdgeTrail() {
  let t = 0;
  canvasLayer.addTask((ctx, dt) => {
    t += dt;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const travel = Math.min(1, t / TRAVEL_S);
    const eased = 1 - Math.pow(1 - travel, 3);
    const alpha = t <= TRAVEL_S ? 1 : Math.max(0, 1 - (t - TRAVEL_S) / FADE_S);
    const s = eased * (w + h);
    drawHead(ctx, s, 1, w, h, '#00DCFF', alpha);
    drawHead(ctx, s, -1, w, h, '#FF2486', alpha);
    return t < TRAVEL_S + FADE_S;
  });
}

function settleContent(spring) {
  const target = document.getElementById('tab-bar-wrap') || document.getElementById('space-container');
  if (!target) return;
  target.animate(
    [{ transform: 'scale(0.985)', opacity: 0.6 }, { transform: 'none', opacity: 1 }],
    { duration: spring.duration, easing: spring.easing },
  );
}

function flashEdge() {
  let el = document.querySelector('.fx-summon-edge');
  if (!el) {
    el = document.createElement('div');
    el.className = 'fx-summon-edge';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: 900, easing: 'ease-out' });
}

// getLevel() → 'full'|'subtle'|'off'; getSpring() → { easing, duration }.
function install({ getLevel, getSpring }) {
  let wasStabilizing = document.body.classList.contains('window-stabilizing');
  let lastAt = 0;
  const observer = new MutationObserver(() => {
    const now = document.body.classList.contains('window-stabilizing');
    const revealed = wasStabilizing && !now;
    wasStabilizing = now;
    if (!revealed) return;
    const level = getLevel();
    const t = performance.now();
    if (level === 'off' || t - lastAt < DEBOUNCE_MS) return;
    lastAt = t;
    settleContent(getSpring());
    flashEdge();
    if (level === 'full') playEdgeTrail();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

module.exports = { install, perimeterPoint };
