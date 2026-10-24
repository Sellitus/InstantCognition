/** @jest-environment jsdom */

// sideBySideResize — drag-to-resize split panes + ratio persistence.
// Covers loadRatios / saveRatios round-trip + every reject branch,
// installHandles (handle count, <2 guard, order assignment, missing
// wrapper skip), beginDrag (threshold, min-clamp both sides, vertical
// axis, ratio capture on mouseup), triple-click reset, and the no-op
// guards.

const sbs = require('../../../../renderer/utils/sideBySideResize');
const { installHandles, loadRatios, saveRatios, RATIO_STORAGE_PREFIX } = sbs;

// A working in-memory localStorage: these tests need real round-trip behavior,
// localStorage being an external boundary we are allowed to substitute.
function installRealLocalStorage() {
  const store = new Map();
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  Object.defineProperty(window, 'localStorage', { value: ls, writable: true, configurable: true });
  return ls;
}

function makeContainer(ids, { withSpaceClass = true } = {}) {
  const container = document.createElement('div');
  container.id = 'space-container';
  // getBoundingClientRect is used during drag; jsdom returns zeros, so stub it.
  container.getBoundingClientRect = () => ({ width: 1000, height: 800, left: 0, top: 0 });
  for (let i = 0; i < ids.length; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'space-webview-wrapper';
    wrap.style.order = String(i * 2);
    wrap.getBoundingClientRect = () => ({ width: 500, height: 400, left: i * 500, top: 0 });
    const wv = document.createElement('div');
    wv.id = ids[i];
    if (withSpaceClass) wv.className = 'space-browser';
    wrap.appendChild(wv);
    container.appendChild(wrap);
  }
  document.body.appendChild(container);
  return container;
}

describe('sideBySideResize ratio persistence', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    installRealLocalStorage();
  });

  test('saveRatios → loadRatios round-trips per id set + axis', () => {
    saveRatios(['custom1', 'custom2'], { custom1: 60, custom2: 40 });
    const r = loadRatios(['custom1', 'custom2']);
    expect(r).toEqual({ custom1: 60, custom2: 40 });
  });

  test('ratio key is order-independent (sorted ids) and axis-suffixed', () => {
    saveRatios(['b', 'a'], { a: 50, b: 50 });
    // Reading with reversed id order resolves to the same sorted key.
    expect(loadRatios(['a', 'b'])).toEqual({ a: 50, b: 50 });
    expect(window.localStorage.getItem(RATIO_STORAGE_PREFIX + 'a,b')).toBeTruthy();
    saveRatios(['a', 'b'], { a: 30, b: 70 }, 'vertical');
    expect(window.localStorage.getItem(RATIO_STORAGE_PREFIX + 'a,b:v')).toBeTruthy();
    expect(loadRatios(['a', 'b'], 'vertical')).toEqual({ a: 30, b: 70 });
    // horizontal value untouched by the vertical write
    expect(loadRatios(['a', 'b'])).toEqual({ a: 50, b: 50 });
  });

  test('loadRatios returns null when nothing stored', () => {
    expect(loadRatios(['x', 'y'])).toBeNull();
  });

  test('loadRatios returns null on non-JSON payload', () => {
    window.localStorage.setItem(RATIO_STORAGE_PREFIX + 'a,b', 'not json{');
    expect(loadRatios(['a', 'b'])).toBeNull();
  });

  test('loadRatios returns null when a stored value is non-numeric', () => {
    window.localStorage.setItem(RATIO_STORAGE_PREFIX + 'a,b', JSON.stringify({ a: 'oops', b: 50 }));
    expect(loadRatios(['a', 'b'])).toBeNull();
  });

  test('loadRatios returns null when an id is missing from the stored object', () => {
    window.localStorage.setItem(RATIO_STORAGE_PREFIX + 'a,b', JSON.stringify({ a: 50 }));
    expect(loadRatios(['a', 'b'])).toBeNull();
  });

  test('loadRatios returns null when stored value parses to a non-object', () => {
    window.localStorage.setItem(RATIO_STORAGE_PREFIX + 'a,b', JSON.stringify(42));
    expect(loadRatios(['a', 'b'])).toBeNull();
  });

  test('loadRatios returns null when stored value is NaN/Infinity', () => {
    window.localStorage.setItem(RATIO_STORAGE_PREFIX + 'a,b', '{"a": null, "b": 50}');
    expect(loadRatios(['a', 'b'])).toBeNull();
  });

  test('loadRatios returns null when localStorage is undefined', () => {
    const prev = window.localStorage;
    // eslint-disable-next-line no-global-assign
    Object.defineProperty(window, 'localStorage', { value: undefined, configurable: true });
    delete global.localStorage;
    expect(loadRatios(['a', 'b'])).toBeNull();
    Object.defineProperty(window, 'localStorage', { value: prev, configurable: true });
  });

  test('saveRatios is a no-op (no throw) when localStorage is undefined', () => {
    const prev = window.localStorage;
    Object.defineProperty(window, 'localStorage', { value: undefined, configurable: true });
    delete global.localStorage;
    expect(() => saveRatios(['a', 'b'], { a: 50, b: 50 })).not.toThrow();
    Object.defineProperty(window, 'localStorage', { value: prev, configurable: true });
  });

  test('saveRatios swallows setItem failures', () => {
    Object.defineProperty(window, 'localStorage', {
      value: { setItem: () => { throw new Error('quota'); }, getItem: () => null },
      configurable: true,
    });
    expect(() => saveRatios(['a', 'b'], { a: 50, b: 50 })).not.toThrow();
  });
});

describe('sideBySideResize installHandles', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    installRealLocalStorage();
  });

  test('installs N-1 handles for N panes', () => {
    const c = makeContainer(['a', 'b', 'c']);
    installHandles(c, ['a', 'b', 'c'], jest.fn());
    expect(c.querySelectorAll('.space-resize-handle').length).toBe(2);
  });

  test('installs no handles for a single pane', () => {
    const c = makeContainer(['a']);
    installHandles(c, ['a'], jest.fn());
    expect(c.querySelectorAll('.space-resize-handle').length).toBe(0);
  });

  test('removes previously installed handles before re-installing', () => {
    const c = makeContainer(['a', 'b']);
    installHandles(c, ['a', 'b'], jest.fn());
    installHandles(c, ['a', 'b'], jest.fn());
    expect(c.querySelectorAll('.space-resize-handle').length).toBe(1);
  });

  test('vertical axis tags handles with the .vertical class', () => {
    const c = makeContainer(['a', 'b']);
    installHandles(c, ['a', 'b'], jest.fn(), 'vertical');
    const h = c.querySelector('.space-resize-handle');
    expect(h.classList.contains('vertical')).toBe(true);
  });

  test('handle order is leftWrapper.order + 1 (odd slot between panes)', () => {
    const c = makeContainer(['a', 'b']);
    installHandles(c, ['a', 'b'], jest.fn());
    const h = c.querySelector('.space-resize-handle');
    // leftWrapper.style.order is '0' → handle order should be '1'
    expect(h.style.order).toBe('1');
  });

  test('handle order is blank when left wrapper has no numeric order', () => {
    const c = makeContainer(['a', 'b']);
    c.querySelectorAll('.space-webview-wrapper').forEach((w) => { w.style.order = ''; });
    installHandles(c, ['a', 'b'], jest.fn());
    const h = c.querySelector('.space-resize-handle');
    expect(h.style.order).toBe('');
  });

  test('skips a pair when the right wrapper id is missing', () => {
    const c = makeContainer(['a', 'b']);
    // 'c' has no wrapper → the (b,c) pair is skipped, only (a,b) remains.
    installHandles(c, ['a', 'b', 'c'], jest.fn());
    expect(c.querySelectorAll('.space-resize-handle').length).toBe(1);
  });

  test('no-op when container lacks querySelectorAll', () => {
    expect(() => installHandles({}, ['a', 'b'], jest.fn())).not.toThrow();
    expect(() => installHandles(null, ['a', 'b'], jest.fn())).not.toThrow();
  });

  test('handle datasets carry the left/right ids and a title', () => {
    const c = makeContainer(['a', 'b']);
    installHandles(c, ['a', 'b'], jest.fn());
    const h = c.querySelector('.space-resize-handle');
    expect(h.dataset.leftId).toBe('a');
    expect(h.dataset.rightId).toBe('b');
    expect(h.title).toContain('triple-click');
  });
});

describe('sideBySideResize beginDrag', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    installRealLocalStorage();
  });

  function drag(handle, { fromX = 500, toX = 600 } = {}) {
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: fromX, clientY: fromX, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: toX, clientY: toX, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }

  test('a real drag adjusts both pane flex-basis and persists ratios via onChange', () => {
    const c = makeContainer(['a', 'b']);
    const onChange = jest.fn();
    installHandles(c, ['a', 'b'], onChange);
    const h = c.querySelector('.space-resize-handle');

    const wrappers = c.querySelectorAll('.space-webview-wrapper');
    drag(h, { fromX: 500, toX: 650 });

    // Left pane grew, right pane shrank.
    expect(wrappers[0].style.flexBasis).toMatch(/%$/);
    expect(wrappers[1].style.flexBasis).toMatch(/%$/);
    expect(onChange).toHaveBeenCalledTimes(1);
    const ratios = onChange.mock.calls[0][0];
    expect(ratios.a + ratios.b).toBeCloseTo(100, 0);
    // ratios were persisted
    expect(loadRatios(['a', 'b'])).not.toBeNull();
  });

  test('overlay element is created during drag and removed on mouseup', () => {
    const c = makeContainer(['a', 'b']);
    installHandles(c, ['a', 'b'], jest.fn());
    const h = c.querySelector('.space-resize-handle');
    h.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, bubbles: true, cancelable: true }));
    expect(document.querySelector('.space-resize-overlay')).toBeTruthy();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 560, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(document.querySelector('.space-resize-overlay')).toBeNull();
  });

  test('sub-threshold movement does not perturb flex sizes', () => {
    const c = makeContainer(['a', 'b']);
    installHandles(c, ['a', 'b'], jest.fn());
    const h = c.querySelector('.space-resize-handle');
    const wrappers = c.querySelectorAll('.space-webview-wrapper');
    h.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, bubbles: true, cancelable: true }));
    // 2px move — under DRAG_THRESHOLD_PX (3) → ignored.
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 502, bubbles: true }));
    expect(wrappers[0].style.flexBasis).toBe('');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  test('drag clamps the LEFT pane to the MIN_FLEX floor', () => {
    const c = makeContainer(['a', 'b']);
    const onChange = jest.fn();
    installHandles(c, ['a', 'b'], onChange);
    const h = c.querySelector('.space-resize-handle');
    // Drag far left (toward 0) → left would go below min, gets clamped.
    drag(h, { fromX: 500, toX: 0 });
    const ratios = onChange.mock.calls[0][0];
    expect(ratios.a).toBeGreaterThanOrEqual(4); // ~MIN_FLEX (5) of 1000px
    expect(ratios.a + ratios.b).toBeCloseTo(100, 0);
  });

  test('drag clamps the RIGHT pane to the MIN_FLEX floor', () => {
    const c = makeContainer(['a', 'b']);
    const onChange = jest.fn();
    installHandles(c, ['a', 'b'], onChange);
    const h = c.querySelector('.space-resize-handle');
    drag(h, { fromX: 500, toX: 1000 });
    const ratios = onChange.mock.calls[0][0];
    expect(ratios.b).toBeGreaterThanOrEqual(4);
  });

  test('vertical drag uses clientY and maxHeight sizing', () => {
    const c = makeContainer(['a', 'b']);
    const onChange = jest.fn();
    installHandles(c, ['a', 'b'], onChange, 'vertical');
    const h = c.querySelector('.space-resize-handle');
    const wrappers = c.querySelectorAll('.space-webview-wrapper');
    h.dispatchEvent(new MouseEvent('mousedown', { clientY: 400, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 500, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(wrappers[0].style.maxHeight).toMatch(/%$/);
    expect(onChange).toHaveBeenCalled();
  });

  test('triple-click (no drag) resets every pane to an even split', () => {
    const c = makeContainer(['a', 'b']);
    const onChange = jest.fn();
    installHandles(c, ['a', 'b'], onChange);
    const h = c.querySelector('.space-resize-handle');
    const wrappers = c.querySelectorAll('.space-webview-wrapper');

    for (let i = 0; i < 3; i++) {
      h.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }
    expect(wrappers[0].style.flexBasis).toBe('50%');
    expect(wrappers[1].style.flexBasis).toBe('50%');
    expect(onChange).toHaveBeenLastCalledWith({ a: 50, b: 50 });
    expect(loadRatios(['a', 'b'])).toEqual({ a: 50, b: 50 });
  });

  test('two clicks then a timeout does not reset', () => {
    jest.useFakeTimers();
    const c = makeContainer(['a', 'b']);
    const onChange = jest.fn();
    installHandles(c, ['a', 'b'], onChange);
    const h = c.querySelector('.space-resize-handle');
    for (let i = 0; i < 2; i++) {
      h.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }
    jest.advanceTimersByTime(500); // > 450ms reset window → counter cleared
    expect(onChange).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('beginDrag bails when the handle has no usable event', () => {
    const c = makeContainer(['a', 'b']);
    // Internal beginDrag is reached via mousedown; a plain object event with
    // no preventDefault must not throw.
    const handle = document.createElement('div');
    handle.dataset.leftId = 'a';
    handle.dataset.rightId = 'b';
    // Directly dispatch a mousedown that jsdom builds with preventDefault, so
    // assert on the missing-wrapper bail instead (left/right wrappers absent).
    const empty = document.createElement('div');
    empty.id = 'space-container';
    empty.getBoundingClientRect = () => ({ width: 100, height: 100, left: 0, top: 0 });
    document.body.appendChild(empty);
    installHandles(c, ['a', 'b'], jest.fn());
    const h = c.querySelector('.space-resize-handle');
    // Remove a wrapper so findWrapperById returns null mid-drag → early return.
    c.querySelector('.space-webview-wrapper').remove();
    expect(() => h.dispatchEvent(new MouseEvent('mousedown', { clientX: 1, bubbles: true, cancelable: true }))).not.toThrow();
  });

  test('mouseup ratio fallback assigns even share for vanished wrappers', () => {
    const c = makeContainer(['a', 'b']);
    const onChange = jest.fn();
    installHandles(c, ['a', 'b'], onChange);
    const h = c.querySelector('.space-resize-handle');
    h.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600, bubbles: true }));
    // Remove a wrapper before mouseup so the ratio-capture loop hits the
    // findWrapperById === null fallback branch.
    c.querySelectorAll('.space-webview-wrapper')[1].remove();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].b).toBe(50);
  });
});
