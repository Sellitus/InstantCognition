// Aurora: a few soft curtains that undulate along the strip. Each ribbon is
// stroked three times (wide/faint to narrow/bright) for a glow without blur.

const { TAU, pick, rgba, between, sign } = require('./color');

const PASSES = [
  { width: 0.95, alpha: 0.22 },
  { width: 0.5, alpha: 0.4 },
  { width: 0.16, alpha: 0.75 },
];

function makeRibbons(rng) {
  const n = 3 + Math.floor(rng() * 2);
  const ribbons = [];
  for (let i = 0; i < n; i++) {
    ribbons.push({
      color: i,
      phase: rng() * TAU,
      speed: between(rng, 0.08, 0.2) * sign(rng),
      freq: between(rng, 1.2, 3.4),
      amp: between(rng, 0.12, 0.28),
      center: between(rng, 0.3, 0.7),
      thickness: between(rng, 0.35, 0.7),
      shimmer: rng() * TAU,
    });
  }
  return ribbons;
}

// Ribbon centre line, as a fraction of the strip thickness, at u along it.
function ribbonY(r, u, t) {
  return r.center
    + r.amp * Math.sin(u * r.freq * TAU + r.phase + t * r.speed * TAU)
    + r.amp * 0.35 * Math.sin(u * r.freq * 2.3 * TAU - t * r.speed * 1.7 * TAU);
}

function create(rng, palette) {
  const ribbons = makeRibbons(rng);
  let t = 0;

  function draw(ctx, w, h, alpha) {
    const segs = Math.max(24, Math.round(w / 28));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const r of ribbons) {
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      for (let k = 0; k <= 4; k++) {
        const wave = 0.55 + 0.45 * Math.sin(r.shimmer + t * 0.5 + k * 1.7);
        grad.addColorStop(k / 4, rgba(pick(palette, r.color + k), wave, 0.08));
      }
      ctx.strokeStyle = grad;
      for (const pass of PASSES) {
        ctx.globalAlpha = alpha * pass.alpha;
        ctx.lineWidth = Math.max(1, h * r.thickness * pass.width);
        ctx.beginPath();
        for (let i = 0; i <= segs; i++) {
          const u = i / segs;
          const y = ribbonY(r, u, t) * h;
          if (i === 0) ctx.moveTo(u * w, y);
          else ctx.lineTo(u * w, y);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  return { step(dt) { t += dt; }, draw, ribbons };
}

module.exports = { create, ribbonY };
