// Nebula: large soft glow pools drifting on slow Lissajous paths and breathing
// in size. The strip only ever shows a slice of each pool.

const { TAU, pick, rgba, between } = require('./color');

function makeClouds(rng) {
  const n = 6 + Math.floor(rng() * 4);
  const clouds = [];
  for (let i = 0; i < n; i++) {
    clouds.push({
      color: i,
      cx: rng(),
      cy: between(rng, 0.2, 0.8),
      ax: between(rng, 0.04, 0.12),
      ay: between(rng, 0.2, 0.5),
      fx: between(rng, 0.015, 0.045),
      fy: between(rng, 0.03, 0.08),
      phase: rng() * TAU,
      radius: between(rng, 1.4, 3.2),
      breathe: between(rng, 0.05, 0.12),
      core: between(rng, 0.55, 0.9),
    });
  }
  return clouds;
}

// Cloud centre (u along, v across, both 0..1-ish) and radius scale at time t.
function cloudAt(c, t) {
  return {
    u: c.cx + c.ax * Math.sin(t * c.fx * TAU + c.phase),
    v: c.cy + c.ay * Math.sin(t * c.fy * TAU + c.phase * 1.3),
    scale: c.radius * (1 + 0.18 * Math.sin(t * c.breathe * TAU + c.phase)),
  };
}

function create(rng, palette) {
  const clouds = makeClouds(rng);
  let t = 0;

  function draw(ctx, w, h, alpha) {
    for (const c of clouds) {
      const p = cloudAt(c, t);
      const x = p.u * w;
      const y = p.v * h;
      const r = Math.max(8, p.scale * h);
      const rgb = pick(palette, c.color);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rgba(rgb, c.core));
      grad.addColorStop(0.45, rgba(rgb, c.core * 0.35));
      grad.addColorStop(1, rgba(rgb, 0));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  return { step(dt) { t += dt; }, draw, clouds };
}

module.exports = { create, cloudAt };
