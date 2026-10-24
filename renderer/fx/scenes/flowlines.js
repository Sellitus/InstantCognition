// Flowlines: streamers carried along the strip by a smooth, slowly evolving
// flow field, each leaving a short tapering trail.

const { TAU, pick, rgba, between, sign } = require('./color');

const TRAIL = 36;

// Cross-strip velocity (fraction of thickness per second) at (u, v, t).
function flowAt(field, u, v, t) {
  return field.swirl * (
    Math.sin(u * field.k1 * TAU + t * field.s1 + field.p1)
    + 0.6 * Math.cos(v * field.k2 * TAU - u * field.k3 * TAU - t * field.s2)
  ) - (v - 0.5) * 0.35;
}

function spawn(rng, i) {
  return {
    color: i,
    u: rng(),
    v: between(rng, 0.1, 0.9),
    speed: between(rng, 0.02, 0.05),
    width: between(rng, 0.6, 1.6),
    trail: [],
  };
}

// Advance one streamer; it wraps along the strip and restarts its trail there.
function stepStreamer(s, field, dt, t) {
  s.trail.push(s.u, s.v);
  if (s.trail.length > TRAIL * 2) s.trail.splice(0, 2);
  s.u += s.speed * field.dir * dt;
  s.v = Math.max(0.04, Math.min(0.96, s.v + flowAt(field, s.u, s.v, t) * dt));
  if (s.u > 1.02 || s.u < -0.02) {
    s.u = s.u > 1 ? -0.02 : 1.02;
    s.trail.length = 0;
  }
}

function create(rng, palette) {
  const field = {
    dir: sign(rng),
    swirl: between(rng, 0.12, 0.28),
    k1: between(rng, 1, 3), k2: between(rng, 0.6, 1.6), k3: between(rng, 0.5, 2),
    s1: between(rng, 0.2, 0.5), s2: between(rng, 0.15, 0.4),
    p1: rng() * TAU,
  };
  const n = 22 + Math.floor(rng() * 12);
  const streamers = [];
  for (let i = 0; i < n; i++) streamers.push(spawn(rng, i));
  let t = 0;

  function draw(ctx, w, h, alpha) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of streamers) {
      const pts = s.trail;
      if (pts.length < 4) continue;
      const rgb = pick(palette, s.color);
      // A wide faint halo along the whole trail, then three tapering
      // segments over it: faint tail, body, bright head.
      ctx.globalAlpha = alpha * 0.18;
      ctx.strokeStyle = rgba(rgb, 1);
      ctx.lineWidth = s.width * 4;
      ctx.beginPath();
      ctx.moveTo(pts[0] * w, pts[1] * h);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * w, pts[i + 1] * h);
      ctx.stroke();
      const third = Math.max(2, Math.floor(pts.length / 6) * 2);
      for (let part = 0; part < 3; part++) {
        const from = part * third;
        const to = part === 2 ? pts.length : Math.min(pts.length, from + third + 2);
        if (to - from < 4) continue;
        ctx.globalAlpha = alpha * (0.25 + part * 0.35);
        ctx.strokeStyle = rgba(rgb, 1, part * 0.15);
        ctx.lineWidth = s.width * (0.5 + part * 0.35);
        ctx.beginPath();
        ctx.moveTo(pts[from] * w, pts[from + 1] * h);
        for (let i = from + 2; i < to; i += 2) ctx.lineTo(pts[i] * w, pts[i + 1] * h);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  return {
    step(dt) {
      t += dt;
      for (const s of streamers) stepStreamer(s, field, dt, t);
    },
    draw,
    streamers,
  };
}

module.exports = { create, flowAt, stepStreamer, TRAIL };
