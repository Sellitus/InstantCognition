// /council constellation: a node above each councillor pane, linked to every
// other node. Link brightness tracks how much the captured answers agree
// (lexical Jaccard overlap), and pulses run along the links on every capture
// round. On synthesis the nodes stream light into the answer.

const canvasLayer = require('./canvasLayer');

const STOP = new Set(['the', 'and', 'for', 'that', 'with', 'this', 'are', 'was', 'you', 'not', 'but', 'have', 'from', 'can', 'its', 'your', 'they', 'will', 'all', 'has', 'more', 'one', 'also', 'which', 'their', 'there', 'than', 'been', 'into', 'may', 'use']);

function tokenSet(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []) {
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

// Jaccard similarity of the content-word sets of two answers, 0..1.
function similarity(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

let session = null;

function nodePoint(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + 22 };
}

function draw(ctx, dt) {
  const s = session;
  if (!s) return false;
  s.t += dt;
  s.fade = s.ending ? Math.max(0, s.fade - dt / 0.9) : Math.min(1, s.fade + dt / 0.4);
  if (s.ending && s.fade <= 0) { session = null; return false; }
  const pts = s.wrappers.map(nodePoint);
  for (const link of s.links) {
    link.sim += (link.target - link.sim) * Math.min(1, dt * 3);
    const a = pts[link.i];
    const b = pts[link.j];
    if (!a || !b) continue;
    ctx.globalAlpha = s.fade * (0.12 + link.sim * 0.75);
    ctx.strokeStyle = '#8080C3';
    ctx.lineWidth = 1 + link.sim * 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const p = (s.t - s.pulseAt) / 0.8;
    if (p >= 0 && p <= 1) {
      ctx.globalAlpha = s.fade * (1 - p);
      ctx.fillStyle = '#00DCFF';
      ctx.beginPath();
      ctx.arc(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const beat = 0.5 + 0.5 * Math.sin(s.t * 4);
  pts.forEach((p) => {
    if (!p) return;
    ctx.globalAlpha = s.fade * (0.35 + 0.25 * beat);
    ctx.fillStyle = '#FF2486';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = s.fade;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  return true;
}

function start(wrappers) {
  const links = [];
  for (let i = 0; i < wrappers.length; i++) {
    for (let j = i + 1; j < wrappers.length; j++) links.push({ i, j, sim: 0, target: 0 });
  }
  const fresh = !session;
  session = { wrappers, links, t: 0, pulseAt: 0, fade: 0, ending: false };
  if (fresh) canvasLayer.addTask(draw);
}

// texts[i] is the latest captured answer for wrappers[i].
function update(texts) {
  if (!session) return;
  for (const link of session.links) link.target = similarity(texts[link.i], texts[link.j]);
  session.pulseAt = session.t;
}

function nodeRects() {
  if (!session) return [];
  return session.wrappers.map(nodePoint).filter(Boolean).map((p) => ({ left: p.x - 1, top: p.y - 1, width: 2, height: 2 }));
}

function stop() {
  if (session) session.ending = true;
}

module.exports = { similarity, start, update, nodeRects, stop };
