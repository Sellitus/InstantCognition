// Shared full-window overlay canvas for transient effects (bursts, comets,
// summon trails, council links). Created on first use, hidden and unscheduled
// whenever no effect is drawing.

const ticker = require('./ticker');

let canvas = null;
let ctx = null;
let dprCap = 2;
let removeTick = null;
const tasks = new Set();

function ensureCanvas() {
  if (canvas && canvas.isConnected) return;
  canvas = document.createElement('canvas');
  canvas.className = 'fx-layer';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
}

function fit() {
  const dpr = Math.min(dprCap, window.devicePixelRatio || 1);
  const w = Math.ceil(window.innerWidth * dpr);
  const h = Math.ceil(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function tick(dt) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  fit();
  ctx.globalCompositeOperation = 'lighter';
  for (const task of Array.from(tasks)) {
    if (task(ctx, dt) === false) tasks.delete(task);
  }
  ctx.globalCompositeOperation = 'source-over';
  if (tasks.size) return true;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.hidden = true;
  removeTick = null;
  return false;
}

// task(ctx, dt) draws one frame in CSS pixels; return false when finished.
// Returns a function that cancels the task.
function addTask(task) {
  ensureCanvas();
  tasks.add(task);
  if (!removeTick) {
    canvas.hidden = false;
    fit();
    removeTick = ticker.add(tick);
  }
  return () => tasks.delete(task);
}

function setLowPower(lowPower) { dprCap = lowPower ? 1 : 2; }

module.exports = { addTask, setLowPower };
