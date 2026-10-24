// Resizable-split helpers for SideBySideLayout / StackedLayout.
// Drag handles, persistence, and live resize via flex-basis adjustments.
// `axis` is 'horizontal' (default, side-by-side) or 'vertical' (stacked).

const RATIO_STORAGE_PREFIX = 'space:sideBySide:ratios:';
const MIN_FLEX = 5;

function ratiosKey(activeIds, axis = 'horizontal') {
  const suffix = axis === 'vertical' ? ':v' : '';
  return RATIO_STORAGE_PREFIX + [...activeIds].sort().join(',') + suffix;
}

function loadRatios(activeIds, axis = 'horizontal') {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ratiosKey(activeIds, axis));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    for (const id of activeIds) {
      if (typeof parsed[id] !== 'number' || !Number.isFinite(parsed[id])) return null;
    }
    return parsed;
  } catch (_) { return null; }
}

function saveRatios(activeIds, ratios, axis = 'horizontal') {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(ratiosKey(activeIds, axis), JSON.stringify(ratios)); } catch (_) {}
}

function findWrapperById(container, id) {
  const wv = container.querySelector(`.space-webview-wrapper [id="${id}"]`);
  return wv && wv.parentElement;
}

function installHandles(container, orderedActive, onChange, axis = 'horizontal') {
  if (!container || typeof container.querySelectorAll !== 'function') return;
  container.querySelectorAll('.space-resize-handle').forEach((h) => h.remove());
  if (orderedActive.length < 2) return;

  const wrapperById = new Map();
  container.querySelectorAll('.space-webview-wrapper').forEach((w) => {
    const wv = w.querySelector('.space-browser');
    if (wv) wrapperById.set(wv.id, w);
  });

  // Triple-click reset state, shared by every handle in this set. The detector
  // lives inside beginDrag.onUp (counted only when no drag movement happened)
  // because relying on the synthesized `click` event was unreliable: mousedown's
  // preventDefault + the document-capture mouseup listener combine to suppress
  // click in some browsers, so clicks were never counted.
  const clickTracker = { count: 0, timer: null };

  for (let i = 0; i < orderedActive.length - 1; i++) {
    const leftId = orderedActive[i];
    const rightId = orderedActive[i + 1];
    const leftWrapper = wrapperById.get(leftId);
    if (!leftWrapper || !wrapperById.get(rightId)) continue;

    const handle = document.createElement('div');
    handle.className = 'space-resize-handle' + (axis === 'vertical' ? ' vertical' : '');
    // Wrappers use even integers (idx*2) so handles claim the odd integer
    // between their two neighbors. Fractional CSS `order` values like 0.5
    // are silently rejected — using leftWrapper.order + 1 guarantees a valid
    // slot between the two wrappers without colliding with any other handle.
    const leftOrder = leftWrapper.style.order;
    const leftOrderNum = leftOrder === '' ? NaN : parseInt(leftOrder, 10);
    handle.style.order = Number.isFinite(leftOrderNum) ? String(leftOrderNum + 1) : '';
    handle.dataset.leftId = leftId;
    handle.dataset.rightId = rightId;
    handle.title = 'Drag to resize · triple-click to reset to even split';
    handle.addEventListener('mousedown', (e) => beginDrag(e, container, orderedActive, leftId, rightId, onChange, axis, clickTracker));
    container.appendChild(handle);
  }
}

// Reset every pane in the split to an equal share. Used by triple-click on
// any resize handle — restores the layout's "default" 50/50 (or N-way even).
function resetRatios(container, orderedActive, onChange, axis = 'horizontal') {
  if (!container || !Array.isArray(orderedActive) || orderedActive.length < 2) return;
  const horizontal = axis !== 'vertical';
  const sizeProp = horizontal ? 'maxWidth' : 'maxHeight';
  const equalPct = 100 / orderedActive.length;
  const ratios = {};
  for (const id of orderedActive) {
    const wrap = findWrapperById(container, id);
    if (wrap) {
      wrap.style.flexBasis = `${equalPct}%`;
      wrap.style[sizeProp] = `${equalPct}%`;
    }
    ratios[id] = equalPct;
  }
  saveRatios(orderedActive, ratios, axis);
  if (typeof onChange === 'function') onChange(ratios);
}

function beginDrag(e, container, orderedActive, leftId, rightId, onChange, axis = 'horizontal', clickTracker) {
  if (!container || !e || typeof e.preventDefault !== 'function') return;
  e.preventDefault();
  const leftWrap = findWrapperById(container, leftId);
  const rightWrap = findWrapperById(container, rightId);
  if (!leftWrap || !rightWrap) return;
  const horizontal = axis !== 'vertical';
  const containerRect = container.getBoundingClientRect();
  const total = (horizontal ? containerRect.width : containerRect.height) || 1;
  const start = horizontal ? e.clientX : e.clientY;
  const leftRect = leftWrap.getBoundingClientRect();
  const rightRect = rightWrap.getBoundingClientRect();
  const leftStart = horizontal ? leftRect.width : leftRect.height;
  const rightStart = horizontal ? rightRect.width : rightRect.height;
  const sumStart = leftStart + rightStart;
  const sumPct = (sumStart / total) * 100;
  const sizeProp = horizontal ? 'maxWidth' : 'maxHeight';
  const DRAG_THRESHOLD_PX = 3;
  let moved = false;

  const overlay = document.createElement('div');
  overlay.className = 'space-resize-overlay' + (horizontal ? '' : ' vertical');
  if (document.body) document.body.appendChild(overlay);

  const onMove = (ev) => {
    const cur = horizontal ? ev.clientX : ev.clientY;
    const d = cur - start;
    // Below the threshold is a click in disguise — don't perturb flex sizes
    // for sub-pixel jitter, otherwise a triple-click would slowly shift the
    // ratio away from where the user wanted it.
    if (!moved && Math.abs(d) <= DRAG_THRESHOLD_PX) return;
    moved = true;
    const minPx = (total * MIN_FLEX) / 100;
    let newLeft = leftStart + d;
    let newRight = rightStart - d;
    if (newLeft < minPx) { newLeft = minPx; newRight = sumStart - minPx; }
    if (newRight < minPx) { newRight = minPx; newLeft = sumStart - minPx; }
    const leftPct = (newLeft / total) * 100;
    const rightPct = sumPct - leftPct;
    leftWrap.style.flexBasis = `${leftPct}%`;
    leftWrap.style[sizeProp] = `${leftPct}%`;
    rightWrap.style.flexBasis = `${rightPct}%`;
    rightWrap.style[sizeProp] = `${rightPct}%`;
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
    if (!moved && clickTracker) {
      // No drag — count this as a click toward triple-click reset. We do this
      // here (in onUp) rather than via a separate `click` listener because
      // the synthesized click event isn't reliably delivered after mousedown's
      // preventDefault + a document-capture mouseup teardown.
      clickTracker.count += 1;
      if (clickTracker.timer) { clearTimeout(clickTracker.timer); clickTracker.timer = null; }
      if (clickTracker.count >= 3) {
        clickTracker.count = 0;
        resetRatios(container, orderedActive, onChange, axis);
      } else {
        clickTracker.timer = setTimeout(() => { clickTracker.count = 0; clickTracker.timer = null; }, 450);
      }
      return;
    }
    const ratios = {};
    for (const id of orderedActive) {
      const wrap = findWrapperById(container, id);
      if (!wrap) { ratios[id] = 100 / orderedActive.length; continue; }
      const r = wrap.getBoundingClientRect();
      ratios[id] = ((horizontal ? r.width : r.height) / total) * 100;
    }
    saveRatios(orderedActive, ratios, axis);
    if (typeof onChange === 'function') onChange(ratios);
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
}

module.exports = { installHandles, loadRatios, saveRatios, RATIO_STORAGE_PREFIX };
