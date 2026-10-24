const TwoRowLayout = require('../../../../renderer/layouts/TwoRowLayout');
const LayoutStrategy = require('../../../../renderer/layouts/LayoutStrategy');

function createMockContainer(ids) {
  const wrappers = [];
  const webviews = ids.map((id) => {
    const wv = document.createElement('div');
    wv.id = id;
    wv.classList.add('space-browser');

    const wrapper = document.createElement('div');
    wrapper.className = 'space-webview-wrapper';
    wrapper.dataset.spaceId = id;
    wrapper.appendChild(wv);
    wrappers.push(wrapper);
    return wv;
  });

  const container = document.createElement('div');
  container.id = 'space-container';
  wrappers.forEach((w) => container.appendChild(w));
  container._webviews = webviews;
  container._wrappers = wrappers;
  return container;
}

describe('TwoRowLayout bug fixes', () => {
  let layout;

  beforeEach(() => {
    layout = new TwoRowLayout();
    // TwoRowLayout.applyAccentColors reads window.config
    window.config = {
      spaces: {
        c1: { name: 'A', url: 'https://a.com/', color: '#ff0000' },
        c2: { name: 'B', url: 'https://b.com/', color: '#00ff00' },
        c3: { name: 'C', url: 'https://c.com/' }, // no color
      },
    };
  });

  afterEach(() => {
    delete window.config;
  });

  // ================================================================
  // MEDIUM #2: TwoRowLayout must call applyAccentColors
  // Spec: All layout strategies (SideBySide, Grid) call
  // LayoutStrategy.applyAccentColors after positioning. TwoRowLayout
  // was missing this call, so accent color borders were never applied.
  // ================================================================
  describe('MEDIUM: TwoRowLayout missing applyAccentColors', () => {
    test('apply() calls LayoutStrategy.applyAccentColors', () => {
      const spy = jest.spyOn(LayoutStrategy, 'applyAccentColors');
      const container = createMockContainer(['c1', 'c2']);

      layout.apply(container, { c1: true, c2: true }, 'c1');

      expect(spy).toHaveBeenCalledWith(container, { c1: true, c2: true });
      spy.mockRestore();
    });

    test('accent color border is applied to active spaces with color', () => {
      const container = createMockContainer(['c1', 'c2', 'c3']);
      layout.apply(container, { c1: true, c2: true, c3: true }, 'c1');

      // c1 has color #ff0000, should have border (jsdom converts hex to rgb)
      expect(container._wrappers[0].style.borderTop).toContain('3px solid');
      expect(container._wrappers[0].style.borderTop).toBeTruthy();
      // c2 has color #00ff00
      expect(container._wrappers[1].style.borderTop).toContain('3px solid');
      expect(container._wrappers[1].style.borderTop).toBeTruthy();
      // c3 has no color, should have no border
      expect(container._wrappers[2].style.borderTop).toBe('');
    });
  });

  // ================================================================
  // TwoRowLayout teardown should clean up gridColumn
  // ================================================================
  describe('TwoRowLayout teardown cleans gridColumn', () => {
    test('teardown clears gridColumn from all wrappers', () => {
      const container = createMockContainer(['c1', 'c2', 'c3']);
      layout.apply(container, { c1: true, c2: true, c3: true }, 'c1');

      // Some wrappers may have gridColumn set (odd count spanning)
      layout.teardown(container);

      container._wrappers.forEach((w) => {
        expect(w.style.gridColumn).toBe('');
      });
    });
  });
});
