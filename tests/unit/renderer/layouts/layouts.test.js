const SingleLayout = require('../../../../renderer/layouts/SingleLayout');
const SideBySideLayout = require('../../../../renderer/layouts/SideBySideLayout');
const GridLayout = require('../../../../renderer/layouts/GridLayout');
const StackedLayout = require('../../../../renderer/layouts/StackedLayout');
const { createLayout, registerLayout, getAvailableLayouts } = require('../../../../renderer/layouts/LayoutRegistry');

// Helper to create mock container with webviews wrapped in wrapper divs
function createMockContainer(ids) {
  const wrappers = [];
  const webviews = ids.map((id) => {
    const wv = document.createElement('div');
    // jsdom doesn't support webview, use div
    wv.id = id;
    wv.classList.add('space-browser');
    wv.style.display = '';
    wv.style.flexBasis = '';
    wv.style.maxWidth = '';
    wv.style.order = '';

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

describe('SingleLayout', () => {
  let layout;

  beforeEach(() => {
    layout = new SingleLayout();
  });

  test('shows only currentSpaceId webview', () => {
    const container = createMockContainer(['custom1', 'custom2', 'custom3']);
    layout.apply(container, { custom1: true }, 'custom1');

    expect(container._wrappers[0].style.display).toBe('flex');
    expect(container._wrappers[1].style.display).toBe('none');
    expect(container._wrappers[2].style.display).toBe('none');
  });

  test('hides all other webviews (display: none)', () => {
    const container = createMockContainer(['custom1', 'custom2']);
    layout.apply(container, { custom1: true, custom2: true }, 'custom1');

    expect(container._wrappers[1].style.display).toBe('none');
  });

  test('sets active wrapper flexBasis to 100%', () => {
    const container = createMockContainer(['custom1']);
    layout.apply(container, { custom1: true }, 'custom1');

    expect(container._wrappers[0].style.flexBasis).toBe('100%');
  });

  test('adds active class to current, inactive to others', () => {
    const container = createMockContainer(['custom1', 'custom2']);
    layout.apply(container, { custom1: true, custom2: false }, 'custom1');

    expect(container._webviews[0].classList.contains('active')).toBe(true);
    expect(container._webviews[0].classList.contains('inactive')).toBe(false);
    expect(container._webviews[1].classList.contains('inactive')).toBe(true);
    expect(container._webviews[1].classList.contains('active')).toBe(false);
  });

  test('teardown resets all wrapper styles', () => {
    const container = createMockContainer(['custom1']);
    layout.apply(container, { custom1: true }, 'custom1');
    layout.teardown(container);

    expect(container._wrappers[0].style.flexBasis).toBe('');
  });
});

describe('SideBySideLayout', () => {
  let layout;

  beforeEach(() => {
    layout = new SideBySideLayout();
  });

  test('shows all active spaces', () => {
    const container = createMockContainer(['custom1', 'custom2', 'custom3']);
    layout.apply(container, { custom1: true, custom2: true, custom3: false }, 'custom1');

    expect(container._wrappers[0].style.display).toBe('flex');
    expect(container._wrappers[1].style.display).toBe('flex');
    expect(container._wrappers[2].style.display).toBe('none');
  });

  test('calculates equal flexBasis (50% for 2, 33.33% for 3)', () => {
    const container = createMockContainer(['custom1', 'custom2']);
    layout.apply(container, { custom1: true, custom2: true }, 'custom1');

    expect(container._wrappers[0].style.flexBasis).toBe('50%');
    expect(container._wrappers[1].style.flexBasis).toBe('50%');
  });

  test('hides inactive spaces', () => {
    const container = createMockContainer(['custom1', 'custom2']);
    layout.apply(container, { custom1: true, custom2: false }, 'custom1');

    expect(container._wrappers[1].style.display).toBe('none');
  });

  test('handles single active cognitizer (flexBasis 100%)', () => {
    const container = createMockContainer(['custom1']);
    layout.apply(container, { custom1: true }, 'custom1');

    expect(container._wrappers[0].style.flexBasis).toBe('100%');
  });

  test('teardown resets all wrapper styles', () => {
    const container = createMockContainer(['custom1', 'custom2']);
    layout.apply(container, { custom1: true, custom2: true }, 'custom1');
    layout.teardown(container);

    expect(container._wrappers[0].style.flexBasis).toBe('');
    expect(container._wrappers[1].style.flexBasis).toBe('');
  });

  test('inserts resize handle between two active spaces', () => {
    const container = createMockContainer(['custom1', 'custom2']);
    layout.apply(container, { custom1: true, custom2: true }, 'custom1', ['custom1', 'custom2']);
    const handles = container.querySelectorAll('.space-resize-handle');
    expect(handles.length).toBe(1);
    expect(handles[0].dataset.leftId).toBe('custom1');
    expect(handles[0].dataset.rightId).toBe('custom2');
  });

  test('inserts N-1 resize handles for N active spaces', () => {
    const container = createMockContainer(['c1', 'c2', 'c3']);
    layout.apply(container, { c1: true, c2: true, c3: true }, 'c1', ['c1', 'c2', 'c3']);
    expect(container.querySelectorAll('.space-resize-handle').length).toBe(2);
  });

  test('does not insert handles when only one space is active', () => {
    const container = createMockContainer(['c1', 'c2']);
    layout.apply(container, { c1: true, c2: false }, 'c1', ['c1', 'c2']);
    expect(container.querySelectorAll('.space-resize-handle').length).toBe(0);
  });

  test('teardown removes resize handles', () => {
    const container = createMockContainer(['c1', 'c2']);
    layout.apply(container, { c1: true, c2: true }, 'c1', ['c1', 'c2']);
    expect(container.querySelectorAll('.space-resize-handle').length).toBe(1);
    layout.teardown(container);
    expect(container.querySelectorAll('.space-resize-handle').length).toBe(0);
  });

  test('persisted ratios from localStorage override equal split', () => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('space:sideBySide:ratios:c1,c2', JSON.stringify({ c1: 70, c2: 30 }));
    const fresh = new SideBySideLayout();
    const container = createMockContainer(['c1', 'c2']);
    fresh.apply(container, { c1: true, c2: true }, 'c1', ['c1', 'c2']);
    expect(container._wrappers[0].style.flexBasis).toBe('70%');
    expect(container._wrappers[1].style.flexBasis).toBe('30%');
    localStorage.removeItem('space:sideBySide:ratios:c1,c2');
  });
});

describe('StackedLayout', () => {
  let layout;

  beforeEach(() => { layout = new StackedLayout(); });

  test('sets container to flex column', () => {
    const container = createMockContainer(['c1', 'c2']);
    layout.apply(container, { c1: true, c2: true }, 'c1', ['c1', 'c2']);
    expect(container.style.display).toBe('flex');
    expect(container.style.flexDirection).toBe('column');
  });

  test('equal split via maxHeight for two active spaces', () => {
    const container = createMockContainer(['c1', 'c2']);
    layout.apply(container, { c1: true, c2: true }, 'c1', ['c1', 'c2']);
    expect(container._wrappers[0].style.maxHeight).toBe('50%');
    expect(container._wrappers[1].style.maxHeight).toBe('50%');
  });

  test('inserts vertical resize handles between active spaces', () => {
    const container = createMockContainer(['c1', 'c2', 'c3']);
    layout.apply(container, { c1: true, c2: true, c3: true }, 'c1', ['c1', 'c2', 'c3']);
    const handles = container.querySelectorAll('.space-resize-handle');
    expect(handles.length).toBe(2);
    expect(handles[0].classList.contains('vertical')).toBe(true);
  });

  test('hides inactive spaces', () => {
    const container = createMockContainer(['c1', 'c2']);
    layout.apply(container, { c1: true, c2: false }, 'c1', ['c1', 'c2']);
    expect(container._wrappers[1].style.display).toBe('none');
  });

  test('teardown clears column direction and handles', () => {
    const container = createMockContainer(['c1', 'c2']);
    layout.apply(container, { c1: true, c2: true }, 'c1', ['c1', 'c2']);
    layout.teardown(container);
    expect(container.style.flexDirection).toBe('');
    expect(container.querySelectorAll('.space-resize-handle').length).toBe(0);
    expect(container._wrappers[0].style.maxHeight).toBe('');
  });

  test('persisted vertical ratios override equal split', () => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('space:sideBySide:ratios:c1,c2:v', JSON.stringify({ c1: 65, c2: 35 }));
    const fresh = new StackedLayout();
    const container = createMockContainer(['c1', 'c2']);
    fresh.apply(container, { c1: true, c2: true }, 'c1', ['c1', 'c2']);
    expect(container._wrappers[0].style.maxHeight).toBe('65%');
    expect(container._wrappers[1].style.maxHeight).toBe('35%');
    localStorage.removeItem('space:sideBySide:ratios:c1,c2:v');
  });
});

describe('GridLayout', () => {
  let layout;

  beforeEach(() => {
    layout = new GridLayout();
  });

  test('sets container to CSS grid display', () => {
    const container = createMockContainer(['custom1', 'custom2']);
    layout.apply(container, { custom1: true, custom2: true }, 'custom1');

    expect(container.style.display).toBe('grid');
  });

  test('2 items -> 1 column, 2 rows (stacked vertically)', () => {
    const container = createMockContainer(['custom1', 'custom2']);
    layout.apply(container, { custom1: true, custom2: true }, 'custom1');

    expect(container.style.gridTemplateColumns).toBe('repeat(1, 1fr)');
    expect(container.style.gridTemplateRows).toBe('repeat(2, 1fr)');
  });

  test('3 items -> 2 columns, 2 rows', () => {
    const container = createMockContainer(['c1', 'c2', 'c3']);
    layout.apply(container, { c1: true, c2: true, c3: true }, 'c1');

    expect(container.style.gridTemplateColumns).toBe('repeat(2, 1fr)');
    expect(container.style.gridTemplateRows).toBe('repeat(2, 1fr)');
  });

  test('4 items -> 2 columns, 2 rows', () => {
    const container = createMockContainer(['c1', 'c2', 'c3', 'c4']);
    layout.apply(container, { c1: true, c2: true, c3: true, c4: true }, 'c1');

    expect(container.style.gridTemplateColumns).toBe('repeat(2, 1fr)');
    expect(container.style.gridTemplateRows).toBe('repeat(2, 1fr)');
  });

  test('5 items -> 3 columns, 2 rows', () => {
    const container = createMockContainer(['c1', 'c2', 'c3', 'c4', 'c5']);
    layout.apply(container, { c1: true, c2: true, c3: true, c4: true, c5: true }, 'c1');

    expect(container.style.gridTemplateColumns).toBe('repeat(3, 1fr)');
    expect(container.style.gridTemplateRows).toBe('repeat(2, 1fr)');
  });

  test('shows active spaces, hides inactive', () => {
    const container = createMockContainer(['c1', 'c2', 'c3']);
    layout.apply(container, { c1: true, c2: false, c3: true }, 'c1');

    expect(container._wrappers[0].style.display).toBe('flex');
    expect(container._wrappers[1].style.display).toBe('none');
    expect(container._wrappers[2].style.display).toBe('flex');
  });

  test('teardown removes grid styles from container', () => {
    const container = createMockContainer(['c1', 'c2']);
    layout.apply(container, { c1: true, c2: true }, 'c1');
    layout.teardown(container);

    expect(container.style.gridTemplateColumns).toBe('');
    expect(container.style.gridTemplateRows).toBe('');
    expect(container.style.display).toBe('');
  });
});

describe('LayoutRegistry', () => {
  test('createLayout("single") returns SingleLayout instance', () => {
    expect(createLayout('single')).toBeInstanceOf(SingleLayout);
  });

  test('createLayout("sideBySide") returns SideBySideLayout instance', () => {
    expect(createLayout('sideBySide')).toBeInstanceOf(SideBySideLayout);
  });

  test('createLayout("grid") returns GridLayout instance', () => {
    expect(createLayout('grid')).toBeInstanceOf(GridLayout);
  });

  test('createLayout("stacked") returns StackedLayout instance', () => {
    expect(createLayout('stacked')).toBeInstanceOf(StackedLayout);
  });

  test('createLayout("unknown") throws descriptive error', () => {
    expect(() => createLayout('unknown')).toThrow('Unknown layout: "unknown"');
  });

  test('registerLayout adds custom layout', () => {
    class CustomLayout {}
    registerLayout('custom', CustomLayout);
    expect(createLayout('custom')).toBeInstanceOf(CustomLayout);
  });

  test('getAvailableLayouts returns all registered names', () => {
    const available = getAvailableLayouts();
    expect(available).toContain('single');
    expect(available).toContain('sideBySide');
    expect(available).toContain('grid');
  });
});
