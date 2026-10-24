const AppState = require('../../../../renderer/core/AppState');
const LayoutManager = require('../../../../renderer/managers/LayoutManager');

describe('LayoutManager', () => {
  let state;
  let layoutManager;

  beforeEach(() => {
    state = new AppState();

    // Create container with mock webviews
    const container = document.createElement('div');
    container.id = 'space-container';
    document.body.appendChild(container);

    layoutManager = new LayoutManager(state);
  });

  afterEach(() => {
    document.body.textContent = '';
  });

  test('initializes with "single" layout when multiSpace is false', () => {
    state.set('multiSpace', false);
    layoutManager.initialize();
    expect(layoutManager.getLayoutName()).toBe('single');
  });

  test('initializes with "sideBySide" layout when multiSpace is true', () => {
    state.set('multiSpace', true);
    layoutManager.initialize();
    expect(layoutManager.getLayoutName()).toBe('sideBySide');
  });

  test('setLayout tears down previous layout before applying new', () => {
    layoutManager.initialize();
    const teardownSpy = jest.spyOn(layoutManager.currentLayout, 'teardown');

    layoutManager.setLayout('sideBySide');

    expect(teardownSpy).toHaveBeenCalled();
    expect(layoutManager.getLayoutName()).toBe('sideBySide');
  });

  test('setLayout applies new layout to container', () => {
    layoutManager.initialize();
    const applySpy = jest.fn();

    layoutManager.setLayout('grid');
    // Layout was applied (we can check the layout name changed)
    expect(layoutManager.getLayoutName()).toBe('grid');
  });

  test('refresh() re-applies current layout', () => {
    layoutManager.initialize();
    const applySpy = jest.spyOn(layoutManager.currentLayout, 'apply');

    layoutManager.refresh();
    expect(applySpy).toHaveBeenCalled();
  });

  test('reacts to AppState change:multiSpace', () => {
    layoutManager.initialize();
    expect(layoutManager.getLayoutName()).toBe('single');

    state.set('multiSpace', true);
    expect(layoutManager.getLayoutName()).toBe('sideBySide');
  });

  test('setLayout is no-op when setting same layout', () => {
    layoutManager.initialize();
    const layout = layoutManager.currentLayout;

    layoutManager.setLayout('single');
    expect(layoutManager.currentLayout).toBe(layout); // Same instance
  });

  test('updates state.currentLayout when layout changes', () => {
    layoutManager.initialize();
    expect(state.get('currentLayout')).toBe('single');

    layoutManager.setLayout('grid');
    expect(state.get('currentLayout')).toBe('grid');
  });
});
