// Particle physics for bursts and sparks. step/spawn are pure over plain
// objects; draw takes any CanvasRenderingContext2D.

const BRAND = ['#00DCFF', '#FF2486', '#8080C3', '#7FEFFF'];

// Spawn `count` particles spread over a rect, flung outward from its centre.
function spawnBurst({ x, y, w = 0, h = 0, count = 24, speed = 220, rng = Math.random, colors = BRAND }) {
  const out = [];
  const cx = x + w / 2;
  const cy = y + h / 2;
  for (let i = 0; i < count; i++) {
    const px = x + rng() * w;
    const py = y + rng() * h;
    const ang = Math.atan2(py - cy, px - cx) + (rng() - 0.5) * 1.2;
    const v = speed * (0.35 + rng() * 0.65);
    const life = 0.45 + rng() * 0.45;
    out.push({
      x: px, y: py,
      vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - speed * 0.25,
      life, max: life,
      size: 1 + rng() * 2.2,
      color: colors[Math.floor(rng() * colors.length) % colors.length],
    });
  }
  return out;
}

// Integrate in place and drop dead particles. Returns the live count.
function stepParticles(ps, dt, { gravity = 420, drag = 2.4 } = {}) {
  const k = Math.exp(-drag * dt);
  let n = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    p.life -= dt;
    if (p.life <= 0) continue;
    p.vx *= k;
    p.vy = p.vy * k + gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    ps[n++] = p;
  }
  ps.length = n;
  return n;
}

function drawParticles(ctx, ps) {
  for (const p of ps) {
    const a = Math.max(0, p.life / p.max);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.6 + a * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

module.exports = { BRAND, spawnBurst, stepParticles, drawParticles };
