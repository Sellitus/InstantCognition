// One shared requestAnimationFrame loop for every canvas effect. It runs only
// while at least one callback is registered, so an idle app costs zero frames.

const callbacks = new Set();
let rafId = 0;
let last = 0;

function frame(now) {
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
  last = now;
  for (const cb of Array.from(callbacks)) {
    if (cb(dt, now) === false) callbacks.delete(cb);
  }
  if (callbacks.size) rafId = requestAnimationFrame(frame);
  else { rafId = 0; last = 0; }
}

// cb(dt, now) runs every frame; return false to unregister. Returns a remover.
function add(cb) {
  callbacks.add(cb);
  if (!rafId) rafId = requestAnimationFrame(frame);
  return () => callbacks.delete(cb);
}

function size() { return callbacks.size; }

module.exports = { add, size };
