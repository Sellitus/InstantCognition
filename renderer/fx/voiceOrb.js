// Voice orb: a small brand-gradient blob whose outline ripples with mic level.
// Drawn from VoiceCaptureOverlay's existing meter rAF loop — no loop of its own.

const smoothed = new WeakMap();

// Radius of the blob outline at angle `theta`, time `t`, for level 0..1.
function orbRadius(R, theta, t, level) {
  return R * (0.74
    + 0.14 * level * Math.sin(3 * theta + t * 3.1)
    + 0.08 * level * Math.sin(5 * theta - t * 2.3)
    + 0.03 * Math.sin(2 * theta + t * 1.2));
}

function drawOrb(canvas, level, nowMs) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.ceil(w * dpr)) canvas.width = Math.ceil(w * dpr);
  if (canvas.height !== Math.ceil(h * dpr)) canvas.height = Math.ceil(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const prev = smoothed.get(canvas) || 0;
  const lvl = prev + (Math.max(0, Math.min(1, level)) - prev) * 0.25;
  smoothed.set(canvas, lvl);

  const t = nowMs / 1000;
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2;

  const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
  halo.addColorStop(0, `rgba(0, 220, 255, ${0.18 + lvl * 0.3})`);
  halo.addColorStop(1, 'rgba(255, 36, 134, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, w, h);

  ctx.beginPath();
  const pts = 40;
  for (let i = 0; i <= pts; i++) {
    const th = (i / pts) * Math.PI * 2;
    const r = orbRadius(R * 0.82, th, t, lvl);
    const x = cx + Math.cos(th) * r;
    const y = cy + Math.sin(th) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  const fill = ctx.createLinearGradient(0, 0, w, h);
  fill.addColorStop(0, '#00DCFF');
  fill.addColorStop(1, '#FF2486');
  ctx.fillStyle = fill;
  ctx.fill();

  const shine = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, 0, cx, cy, R * 0.8);
  shine.addColorStop(0, 'rgba(255,255,255,0.55)');
  shine.addColorStop(0.5, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  ctx.fill();
}

module.exports = { drawOrb, orbRadius };
