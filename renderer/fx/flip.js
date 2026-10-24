// FLIP animation for keyed children that a component re-renders wholesale
// (TabBar wipes innerHTML; layouts restyle wrappers). Capture rects before the
// render, diff after, and play the inverse transform back to identity.

const EPSILON = 0.75;

function captureRects(container, selector, keyOf) {
  const rects = new Map();
  if (!container) return rects;
  container.querySelectorAll(selector).forEach((el) => {
    const key = keyOf(el);
    if (!key) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) rects.set(key, r);
  });
  return rects;
}

// Pure diff of two key→rect maps.
function diffRects(before, after) {
  const moved = [];
  const added = [];
  const removed = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) { removed.push({ key, rect: b }); continue; }
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    const sx = a.width ? b.width / a.width : 1;
    const sy = a.height ? b.height / a.height : 1;
    if (Math.abs(dx) > EPSILON || Math.abs(dy) > EPSILON || Math.abs(1 - sx) > 0.01 || Math.abs(1 - sy) > 0.01) {
      moved.push({ key, dx, dy, sx, sy });
    }
  }
  for (const key of after.keys()) {
    if (!before.has(key)) added.push(key);
  }
  return { moved, added, removed };
}

// Animate `container`'s keyed children from their `before` rects back to
// identity. `scale:false` keeps text crisp (tabs): size changes snap while
// position springs. Returns the diff plus the live key→element map so callers
// can decorate added/removed items.
function playFlip(container, selector, keyOf, before, { easing, duration, scale = true }) {
  const els = new Map();
  container.querySelectorAll(selector).forEach((el) => {
    const key = keyOf(el);
    if (key) els.set(key, el);
  });
  const after = new Map();
  for (const [key, el] of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) after.set(key, r);
  }
  const diff = diffRects(before, after);
  for (const m of diff.moved) {
    const from = scale
      ? `translate(${m.dx}px, ${m.dy}px) scale(${m.sx}, ${m.sy})`
      : `translate(${m.dx}px, ${m.dy}px)`;
    els.get(m.key).animate(
      [{ transform: from, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }],
      { duration, easing },
    );
  }
  return { ...diff, els };
}

module.exports = { captureRects, diffRects, playFlip };
