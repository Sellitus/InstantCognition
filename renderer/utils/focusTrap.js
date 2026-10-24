/**
 * focusTrap — keep keyboard focus inside a modal root until released.
 *
 * Usage:
 *   const release = trap(overlayElement, { initialFocus: myInput, allow: [backdropEl] });
 *   // ... when closing:
 *   release();
 *
 * Behavior:
 *   - Tab / Shift+Tab wrap within focusable descendants of `root`.
 *   - Escape is NOT handled here — each modal already handles its own Escape.
 *   - Sets aria-modal="true" and role="dialog" if not already on root.
 *   - Marks siblings of root as `inert` so screen readers + Tab don't leak.
 *   - On release: restores focus to the element focused before trap was opened,
 *     and removes `inert`, except from an element another owner marked with
 *     `data-inert-hold` while the trap was open (a dock collapsed meanwhile).
 *
 * Browsers without `inert` support silently skip the sibling-blocking step;
 * the Tab-wrap still works.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function getFocusable(root) {
  if (!root || !root.querySelectorAll) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // Skip zero-size / display:none elements — getClientRects is a reliable proxy.
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
    return true;
  });
}

// focus() throws on a detached or hidden element in some engines. The trap can
// carry on without focus, but a silent failure hides a broken modal.
function focusOrLog(el) {
  try { el.focus(); }
  catch (err) { console.error('[focusTrap] focus failed:', (err instanceof Error && err.message) || err); }
}

function trap(root, opts = {}) {
  if (!root || typeof document === 'undefined') return () => {};

  const previouslyFocused = /** @type {HTMLElement} */ (document.activeElement);
  const inertSiblings = [];

  // Mark root as a dialog if caller didn't set it up
  if (!root.getAttribute('role')) root.setAttribute('role', 'dialog');
  if (!root.hasAttribute('aria-modal')) root.setAttribute('aria-modal', 'true');

  // Mark non-root body children as inert so tab navigation skips them. `allow`
  // exempts siblings that belong to the same modal — a dropdown's backdrop must
  // stay clickable or click-outside-to-close dies under inert.
  const allowed = Array.isArray(opts.allow) ? opts.allow.filter(Boolean) : [];
  if (document.body) {
    for (const child of Array.from(document.body.children)) {
      if (child === root || child.contains(root)) continue;
      if (allowed.some((el) => el === child || child.contains(el))) continue;
      if (child.hasAttribute('inert')) continue;
      child.setAttribute('inert', '');
      inertSiblings.push(child);
    }
  }

  // Initial focus: explicit opt > first focusable > root itself (with tabindex)
  const first = opts.initialFocus || getFocusable(root)[0] || null;
  if (first && typeof first.focus === 'function') {
    focusOrLog(first);
  } else {
    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    focusOrLog(root);
  }

  function onKeyDown(e) {
    if (e.key !== 'Tab') return;
    const focusable = getFocusable(root);
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const firstEl = focusable[0];
    const lastEl = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && (active === firstEl || !root.contains(active))) {
      e.preventDefault();
      focusOrLog(lastEl);
    } else if (!e.shiftKey && (active === lastEl || !root.contains(active))) {
      e.preventDefault();
      focusOrLog(firstEl);
    }
  }

  root.addEventListener('keydown', onKeyDown, true);

  return function release() {
    root.removeEventListener('keydown', onKeyDown, true);
    for (const el of inertSiblings) if (!el.hasAttribute('data-inert-hold')) el.removeAttribute('inert');
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      focusOrLog(previouslyFocused);
    }
  };
}

module.exports = { trap, getFocusable };
