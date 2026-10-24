/** @jest-environment jsdom */

// focusTrap — modal focus containment. getFocusable filtering
// (disabled / aria-hidden / zero-size), trap setup (role/aria-modal,
// inert siblings, initial focus precedence), Tab + Shift+Tab wrapping
// (both edges, escaped focus, empty trap), and release (inert cleanup
// + focus restoration).

const { trap, getFocusable } = require('../../../../renderer/utils/focusTrap');

// jsdom has no layout, so getClientRects() is always empty — which would make
// getFocusable() filter out every element. Give elements a visible box.
function visible(el) {
  el.getClientRects = () => [{ width: 10, height: 10 }];
  return el;
}

function makeButton(label, parent) {
  const b = visible(document.createElement('button'));
  b.textContent = label;
  parent.appendChild(b);
  return b;
}

describe('getFocusable', () => {
  test('returns [] for a null root or one without querySelectorAll', () => {
    expect(getFocusable(null)).toEqual([]);
    expect(getFocusable({})).toEqual([]);
  });

  test('collects standard focusable elements in document order', () => {
    const root = document.createElement('div');
    const a = visible(document.createElement('a')); a.href = '#';
    const btn = visible(document.createElement('button'));
    const inp = visible(document.createElement('input'));
    root.append(a, btn, inp);
    document.body.appendChild(root);
    expect(getFocusable(root)).toEqual([a, btn, inp]);
  });

  test('excludes disabled, aria-hidden, and zero-size elements', () => {
    const root = document.createElement('div');
    const ok = visible(document.createElement('button'));
    const disabled = visible(document.createElement('button')); disabled.disabled = true;
    const hidden = visible(document.createElement('button')); hidden.setAttribute('aria-hidden', 'true');
    const zero = document.createElement('button'); zero.getClientRects = () => [];
    root.append(ok, disabled, hidden, zero);
    document.body.appendChild(root);
    expect(getFocusable(root)).toEqual([ok]);
  });

  test('elements without getClientRects are still considered focusable', () => {
    const root = document.createElement('div');
    const b = document.createElement('button');
    b.getClientRects = undefined;
    root.appendChild(b);
    document.body.appendChild(root);
    expect(getFocusable(root)).toEqual([b]);
  });
});

describe('trap setup', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  test('returns a no-op release for a null root', () => {
    const release = trap(null);
    expect(typeof release).toBe('function');
    expect(() => release()).not.toThrow();
  });

  test('sets role=dialog and aria-modal when not already present', () => {
    const root = document.createElement('div');
    makeButton('ok', root);
    document.body.appendChild(root);
    trap(root);
    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');
  });

  test('does not clobber a caller-provided role / aria-modal', () => {
    const root = document.createElement('div');
    root.setAttribute('role', 'alertdialog');
    root.setAttribute('aria-modal', 'false');
    makeButton('ok', root);
    document.body.appendChild(root);
    trap(root);
    expect(root.getAttribute('role')).toBe('alertdialog');
    expect(root.getAttribute('aria-modal')).toBe('false');
  });

  test('marks sibling body children inert and restores them on release', () => {
    const sibling = document.createElement('div');
    const alreadyInert = document.createElement('div');
    alreadyInert.setAttribute('inert', '');
    const root = document.createElement('div');
    makeButton('ok', root);
    document.body.append(sibling, alreadyInert, root);

    const release = trap(root);
    expect(sibling.hasAttribute('inert')).toBe(true);
    // A pre-inert sibling is left untouched (and not un-inerted on release).
    expect(alreadyInert.hasAttribute('inert')).toBe(true);

    release();
    expect(sibling.hasAttribute('inert')).toBe(false);
    expect(alreadyInert.hasAttribute('inert')).toBe(true);
  });

  test('skips a body child that contains the root', () => {
    const wrapper = document.createElement('div');
    const root = document.createElement('div');
    makeButton('ok', root);
    wrapper.appendChild(root);
    document.body.appendChild(wrapper);
    trap(root);
    // wrapper contains root → must NOT be inerted.
    expect(wrapper.hasAttribute('inert')).toBe(false);
  });

  test('initialFocus option is honored over the first focusable', () => {
    const root = document.createElement('div');
    makeButton('first', root);
    const target = makeButton('target', root);
    document.body.appendChild(root);
    trap(root, { initialFocus: target });
    expect(document.activeElement).toBe(target);
  });

  test('focuses the first focusable when no initialFocus is given', () => {
    const root = document.createElement('div');
    const first = makeButton('first', root);
    makeButton('second', root);
    document.body.appendChild(root);
    trap(root);
    expect(document.activeElement).toBe(first);
  });

  test('falls back to focusing the root (with tabindex) when nothing focusable', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    trap(root);
    expect(root.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(root);
  });

  test('does not overwrite an existing tabindex on the root fallback', () => {
    const root = document.createElement('div');
    root.setAttribute('tabindex', '0');
    document.body.appendChild(root);
    trap(root);
    expect(root.getAttribute('tabindex')).toBe('0');
  });
});

describe('trap Tab wrapping', () => {
  let root, first, last, release;
  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    first = makeButton('first', root);
    makeButton('middle', root);
    last = makeButton('last', root);
    document.body.appendChild(root);
    release = trap(root);
  });
  afterEach(() => release && release());

  function tab(target, shift = false) {
    const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
  }

  test('Tab on the last element wraps to the first', () => {
    last.focus();
    const ev = tab(last);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  test('Shift+Tab on the first element wraps to the last', () => {
    first.focus();
    const ev = tab(first, true);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  test('Tab from outside the root jumps to the first focusable', () => {
    const outside = makeButton('outside', document.body);
    outside.focus();
    const ev = tab(root);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  test('Shift+Tab from outside the root jumps to the last focusable', () => {
    const outside = makeButton('outside', document.body);
    outside.focus();
    const ev = tab(root, true);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  test('Tab in the middle is not intercepted (native order continues)', () => {
    first.focus();
    const ev = tab(first); // active === first, not last → no wrap
    expect(ev.defaultPrevented).toBe(false);
  });

  test('non-Tab keydown is ignored', () => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    root.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  test('Tab with no focusable descendants is swallowed (preventDefault)', () => {
    release(); // tear down the 3-button trap
    document.body.innerHTML = '';
    const empty = document.createElement('div');
    document.body.appendChild(empty);
    release = trap(empty);
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    empty.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('trap release', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  test('restores focus to the element focused before the trap opened', () => {
    const opener = makeButton('opener', document.body);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const root = document.createElement('div');
    makeButton('inside', root);
    document.body.appendChild(root);
    const release = trap(root);
    expect(document.activeElement).not.toBe(opener);

    release();
    expect(document.activeElement).toBe(opener);
  });

  test('release removes the keydown handler (no more wrapping)', () => {
    const root = document.createElement('div');
    const first = makeButton('first', root);
    const last = makeButton('last', root);
    document.body.appendChild(root);
    const release = trap(root);
    release();
    last.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(ev);
    // Handler detached → event not prevented, focus not forced to first.
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(last);
  });
});
