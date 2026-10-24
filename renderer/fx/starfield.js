// Starfield for empty surfaces (welcome overlay, new-tab picker). Stars live in
// a unit cube and drift toward the viewer; an optional warp opens with streaks
// that ease into a slow cruise. The pointer adds gentle parallax. Renders at
// ~30fps while cruising, stops itself when its canvas is no longer visible,
// and in 'static' mode paints exactly one frame.

const ticker = require('./ticker');

const TINTS = ['#ffffff', '#cfe9ff', '#ffffff', '#9feaff', '#ffd1e6'];
const WARP_S = 1.1;

function makeStars(n, rng) {
  const stars = [];
  for (let i = 0; i < n; i++) {
    stars.push({ x: rng() * 2 - 1, y: rng() * 2 - 1, z: 0.05 + rng() * 0.95, tint: TINTS[i % TINTS.length] });
  }
  return stars;
}

// Advance stars toward the viewer by `dz`; recycle any that pass the camera.
function stepStars(stars, dz, rng = Math.random) {
  for (const s of stars) {
    s.z -= dz;
    if (s.z <= 0.03) {
      s.x = rng() * 2 - 1;
      s.y = rng() * 2 - 1;
      s.z = 1;
    }
  }
}

function project(s, cx, cy, f) {
  return { x: cx + (s.x / s.z) * f, y: cy + (s.y / s.z) * f };
}

// opts: { warp, mode: 'animate'|'static', lowPower, rng }
function createStarfield(canvas, opts = {}) {
  const rng = opts.rng || Math.random;
  const ctx = canvas.getContext('2d');
  let stars = null;
  let removeTick = null;
  let t = 0;
  let acc = 0;
  let checkAt = 0;
  const parallax = { x: 0, y: 0, tx: 0, ty: 0 };
  const onMove = (e) => {
    parallax.tx = (e.clientX / window.innerWidth - 0.5) * -24;
    parallax.ty = (e.clientY / window.innerHeight - 0.5) * -24;
  };

  function fit() {
    const dpr = Math.min(opts.lowPower ? 1 : 2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return false;
    if (canvas.width !== Math.ceil(w * dpr)) canvas.width = Math.ceil(w * dpr);
    if (canvas.height !== Math.ceil(h * dpr)) canvas.height = Math.ceil(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!stars) stars = makeStars(Math.min(opts.lowPower ? 140 : 320, Math.round((w * h) / 2600)), rng);
    return true;
  }

  function paint(dz) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const f = Math.max(w, h) * 0.5;
    const cx = w / 2 + parallax.x;
    const cy = h / 2 + parallax.y;
    const streak = dz > 0.004;
    for (const s of stars) {
      const p = project(s, cx, cy, f);
      if (p.x < -4 || p.y < -4 || p.x > w + 4 || p.y > h + 4) continue;
      const a = Math.min(1, (1 - s.z) * 1.3);
      ctx.globalAlpha = a;
      if (streak) {
        const q = project({ x: s.x, y: s.y, z: s.z + dz * 6 }, cx, cy, f);
        ctx.strokeStyle = s.tint;
        ctx.lineWidth = 0.6 + (1 - s.z) * 1.4;
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else {
        ctx.fillStyle = s.tint;
        const r = 0.35 + (1 - s.z) * 1.3;
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame(dt, now) {
    if (now - checkAt > 500) {
      checkAt = now;
      if (!canvas.isConnected || !canvas.checkVisibility() || !fit()) { stop(); return false; }
    }
    t += dt;
    acc += dt;
    const warping = opts.warp && t < WARP_S;
    if (!warping && acc < 1 / 30) return true;
    const step = acc;
    acc = 0;
    parallax.x += (parallax.tx - parallax.x) * Math.min(1, step * 4);
    parallax.y += (parallax.ty - parallax.y) * Math.min(1, step * 4);
    const speed = warping ? 0.02 + 1.6 * Math.pow(1 - t / WARP_S, 2) : 0.02;
    const dz = speed * step;
    stepStars(stars, dz, rng);
    paint(dz);
    return true;
  }

  function start() {
    if (removeTick || !fit()) return;
    if (opts.mode === 'static') { paint(0); return; }
    t = 0;
    window.addEventListener('pointermove', onMove, { passive: true });
    removeTick = ticker.add(frame);
  }

  function stop() {
    if (removeTick) { removeTick(); removeTick = null; }
    window.removeEventListener('pointermove', onMove);
  }

  return { start, stop };
}

module.exports = { createStarfield, makeStars, stepStars };
