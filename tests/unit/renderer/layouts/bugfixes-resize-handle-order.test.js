// Regression: with 3+ active tabs in side-by-side or stacked mode, every
// resize handle must sit between its two neighbor wrappers.
//
// Original bug: wrappers got integer `style.order` (0, 1, 2) and handles
// tried fractional orders (0.5, 1.5). CSS `order` accepts <integer> only
// and silently drops fractional values, so both handles fell back to the
// default order (0) and ended up adjacent at the start of the flex row,
// leaving no resize seam between tabs 2 and 3.

const SideBySideLayout = require('../../../../renderer/layouts/SideBySideLayout');
const StackedLayout = require('../../../../renderer/layouts/StackedLayout');

function createMockContainer(ids) {
  const wrappers = [];
  ids.forEach((id) => {
    const wv = document.createElement('div');
    wv.id = id;
    wv.classList.add('space-browser');
    const wrapper = document.createElement('div');
    wrapper.className = 'space-webview-wrapper';
    wrapper.dataset.spaceId = id;
    wrapper.appendChild(wv);
    wrappers.push(wrapper);
  });
  const container = document.createElement('div');
  container.id = 'space-container';
  wrappers.forEach((w) => container.appendChild(w));
  container._wrappers = wrappers;
  return container;
}

function wrapperOrders(container) {
  return container._wrappers.map((w) => w.style.order);
}

function handleOrders(container) {
  return Array.from(container.querySelectorAll('.space-resize-handle'))
    .map((h) => h.style.order);
}

describe('resize handle order interleaving (bugfix)', () => {
  test('SideBySideLayout: 3 tabs → handles at odd integers between wrappers', () => {
    const container = createMockContainer(['t1', 't2', 't3']);
    new SideBySideLayout().apply(
      container,
      { t1: true, t2: true, t3: true },
      't1',
      ['t1', 't2', 't3']
    );

    expect(wrapperOrders(container)).toEqual(['0', '2', '4']);
    expect(handleOrders(container)).toEqual(['1', '3']);
  });

  test('StackedLayout: 3 tabs → handles at odd integers between wrappers', () => {
    const container = createMockContainer(['t1', 't2', 't3']);
    new StackedLayout().apply(
      container,
      { t1: true, t2: true, t3: true },
      't1',
      ['t1', 't2', 't3']
    );

    expect(wrapperOrders(container)).toEqual(['0', '2', '4']);
    expect(handleOrders(container)).toEqual(['1', '3']);
  });

  test('SideBySideLayout: every handle.order is an integer (no fractional values)', () => {
    const container = createMockContainer(['a', 'b', 'c', 'd']);
    new SideBySideLayout().apply(
      container,
      { a: true, b: true, c: true, d: true },
      'a',
      ['a', 'b', 'c', 'd']
    );

    handleOrders(container).forEach((o) => {
      const n = Number(o);
      expect(Number.isInteger(n)).toBe(true);
    });
  });

  test('SideBySideLayout: handles slot strictly between their two wrappers', () => {
    const container = createMockContainer(['a', 'b', 'c']);
    new SideBySideLayout().apply(
      container,
      { a: true, b: true, c: true },
      'a',
      ['a', 'b', 'c']
    );

    const orderOf = (id) =>
      Number(container._wrappers.find((w) => w.dataset.spaceId === id).style.order);

    container.querySelectorAll('.space-resize-handle').forEach((h) => {
      const ho = Number(h.style.order);
      const lo = orderOf(h.dataset.leftId);
      const ro = orderOf(h.dataset.rightId);
      expect(ho).toBeGreaterThan(lo);
      expect(ho).toBeLessThan(ro);
    });
  });
});
