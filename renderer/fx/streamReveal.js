// Streaming text reveal. AnswerView re-renders the whole answer via innerHTML
// on every chunk, so per-chunk animation state would be lost each time. We
// keep a short history of which rendered-character ranges arrived when, and
// after each render re-wrap those ranges with a negative animation-delay so
// each fade continues where it left off instead of restarting or snapping.

const REVEAL_MS = 420;
const MAX_MARKS = 24;
const SKIP_SELECTOR = '.agent-answer-caret';
const tracks = new WeakMap();

/** @returns {Text[]} */
function textNodes(root) {
  /** @type {Text[]} */
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest(SKIP_SELECTOR)
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(/** @type {Text} */ (n));
  return out;
}

// Wrap rendered characters [start, end) in .fx-tok spans.
function wrapRange(nodes, start, end, delayMs) {
  let offset = 0;
  for (const node of nodes) {
    const len = node.data.length;
    const nodeStart = offset;
    offset += len;
    if (offset <= start) continue;
    if (nodeStart >= end) break;
    const from = Math.max(0, start - nodeStart);
    const to = Math.min(len, end - nodeStart);
    if (to <= from || !node.data.slice(from, to).trim()) continue;
    let target = node;
    if (from > 0) target = target.splitText(from);
    if (to - from < target.data.length) target.splitText(to - from);
    const span = document.createElement('span');
    span.className = 'fx-tok';
    span.style.animationDelay = `${-delayMs}ms`;
    target.parentNode.insertBefore(span, target);
    span.appendChild(target);
  }
}

// Forget history for `body` — call when a new answer starts.
function reset(body) {
  if (body) tracks.delete(body);
}

// Call right after `body.innerHTML` is replaced with the latest prefix.
function afterRender(body, now = performance.now()) {
  if (!body) return;
  let track = tracks.get(body);
  if (!track) { track = { len: 0, marks: [] }; tracks.set(body, track); }
  const nodes = textNodes(body);
  const len = nodes.reduce((sum, n) => sum + n.data.length, 0);
  if (len < track.len) {
    // Canonical re-render shrank the text (markdown settled); keep it still.
    track.len = len;
    track.marks = [];
    return;
  }
  if (len > track.len) track.marks.push({ start: track.len, end: len, t: now });
  track.len = len;
  track.marks = track.marks.filter((m) => now - m.t < REVEAL_MS).slice(-MAX_MARKS);
  // Wrap newest first: splitting a later text node only truncates it from the
  // end, so offsets of every earlier (older) range stay valid.
  for (let i = track.marks.length - 1; i >= 0; i--) {
    const m = track.marks[i];
    wrapRange(nodes, m.start, m.end, now - m.t);
  }
}

module.exports = { reset, afterRender, REVEAL_MS };
