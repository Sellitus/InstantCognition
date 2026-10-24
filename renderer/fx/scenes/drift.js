// Drift: twinkling motes on three parallax layers sliding along the strip,
// with an occasional glint that sweeps the full length.

const { TAU, pick, rgba, between, sign } = require('./color');

const LAYERS = [
  { speed: 0.006, size: 0.7, alpha: 0.45 },
  { speed: 0.012, size: 1.1, alpha: 0.7 },
  { speed: 0.022, size: 1.6, alpha: 1 },
];

function makeMotes(rng) {
  const motes = [];
  const n = 42 + Math.floor(rng() * 24);
  for (let i = 0; i < n; i++) {
    const layer = LAYERS[i % LAYERS.length];
    motes.push({
      color: i,
      layer,
      u: rng(),
      v: between(rng, 0.08, 0.92),
      bob: rng() * TAU,
      twinkle: between(rng, 0.3, 1.1),
      size: layer.size * between(rng, 0.7, 1.4),
    });
  }
  return motes;
}

// Wraps u into [0, 1).
function wrap(u) { return u - Math.floor(u); }

function create(rng, palette) {
  const dir = sign(rng);
  const motes = makeMotes(rng);
  const glint = { u: -1, wait: between(rng, 3, 8), speed: 0, color: 0 };
  let t = 0;

  function stepGlint(dt) {
    if (glint.u < 0 || glint.u > 1.2) {
      glint.wait -= dt;
      if (glint.wait > 0) return;
      glint.u = 0;
      glint.v = between(rng, 0.3, 0.7);
      glint.speed = between(rng, 0.25, 0.45);
      glint.color = Math.floor(rng() * 8);
      glint.wait = between(rng, 6, 12);
      return;
    }
    glint.u += glint.speed * dt;
  }

  function drawGlint(ctx, w, h, alpha) {
    if (glint.u < 0 || glint.u > 1.2) return;
    const head = (dir > 0 ? glint.u : 1 - glint.u) * w;
    const tail = head - dir * w * 0.12;
    const y = glint.v * h;
    const rgb = pick(palette, glint.color);
    const grad = ctx.createLinearGradient(tail, y, head, y);
    grad.addColorStop(0, rgba(rgb, 0));
    grad.addColorStop(1, rgba(rgb, 0.9, 0.4));
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(tail, y);
    ctx.lineTo(head, y);
    ctx.stroke();
  }

  function draw(ctx, w, h, alpha) {
    for (const m of motes) {
      const x = m.u * w;
      const y = (m.v + 0.06 * Math.sin(t * 0.6 + m.bob)) * h;
      const flicker = 0.55 + 0.45 * Math.sin(t * m.twinkle * TAU + m.bob);
      const rgb = pick(palette, m.color);
      ctx.globalAlpha = alpha * m.layer.alpha * flicker;
      ctx.fillStyle = rgba(rgb, 0.25);
      ctx.beginPath();
      ctx.arc(x, y, m.size * 3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = rgba(rgb, 1, 0.5);
      ctx.beginPath();
      ctx.arc(x, y, m.size, 0, TAU);
      ctx.fill();
    }
    drawGlint(ctx, w, h, alpha);
    ctx.globalAlpha = 1;
  }

  return {
    step(dt) {
      t += dt;
      for (const m of motes) m.u = wrap(m.u + m.layer.speed * dir * dt);
      stepGlint(dt);
    },
    draw,
    motes,
    glint,
  };
}

module.exports = { create, wrap, LAYERS };
