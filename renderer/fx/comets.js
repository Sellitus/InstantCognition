// Agent action comets: a glowing head with a fading tail arcs from the agent
// panel to the pane a tool call acts on, then rings out on impact. Makes the
// agent's reach visible: the user sees which page each action touches.

const canvasLayer = require('./canvasLayer');

const FLIGHT_S = 0.62;
const RING_S = 0.55;

function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

// Quadratic Bézier point; the control point lifts the arc above the chord.
function arcPoint(a, b, t) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const lift = Math.min(160, Math.hypot(b.x - a.x, b.y - a.y) * 0.25);
  const cx = mx;
  const cy = my - lift;
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y };
}

function ring(ctx, p, t, color) {
  const f = Math.min(1, t / RING_S);
  ctx.globalAlpha = (1 - f) * 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * (1 - f) + 0.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4 + f * 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Expanding ring at a viewport point (e.g. where a click landed).
function impactAt(x, y, color = '#00DCFF') {
  let t = 0;
  canvasLayer.addTask((ctx, dt) => {
    t += dt;
    ring(ctx, { x, y }, t, color);
    return t < RING_S;
  });
}

/**
 * Fly from rect `from` to rect `to`; `onArrive` fires when the head lands.
 * @param {{ color?: string, delay?: number, onArrive?: () => void }} [opts]
 */
function launch(from, to, opts = {}) {
  const { color = '#00DCFF', delay = 0, onArrive = null } = opts;
  const a = center(from);
  const b = { x: to.left + to.width / 2, y: to.top + Math.min(to.height / 2, 80) };
  let t = -delay;
  let arrived = false;
  canvasLayer.addTask((ctx, dt) => {
    t += dt;
    if (t < 0) return true;
    const f = Math.min(1, t / FLIGHT_S);
    const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
    if (f < 1) {
      const steps = 16;
      for (let i = 0; i <= steps; i++) {
        const k = i / steps;
        const p = arcPoint(a, b, Math.max(0, e - 0.22 * (1 - k)));
        ctx.globalAlpha = k * k;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 0.8 + 2.6 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      const head = arcPoint(a, b, e);
      const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 16);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = g;
      ctx.fillRect(head.x - 16, head.y - 16, 32, 32);
      ctx.globalAlpha = 1;
      return true;
    }
    if (!arrived) {
      arrived = true;
      if (onArrive) onArrive();
    }
    ring(ctx, b, t - FLIGHT_S, color);
    return t - FLIGHT_S < RING_S;
  });
}

module.exports = { launch, impactAt, arcPoint };
