jest.mock('electron', () => ({
  ipcRenderer: { send: jest.fn(), on: jest.fn(), invoke: jest.fn() },
}));

const AppState = require('../../../../renderer/core/AppState');
const NavigationManager = require('../../../../renderer/managers/NavigationManager');
const SpaceManager = require('../../../../renderer/managers/SpaceManager');
const LayoutManager = require('../../../../renderer/managers/LayoutManager');

describe('SpaceManager bug fixes', () => {
  let state;
  let nav;
  let spaceManager;
  let layoutManager;
  let mockSave;

  beforeEach(() => {
    state = new AppState();
    nav = new NavigationManager(state);
    // A real LayoutManager is required: DOM-style teardown (gridColumn,
    // flex-basis, order, etc.) is owned by the active layout's teardown(),
    // not by SpaceManager directly. Tests that assert post-toggleMulti
    // DOM cleanliness must exercise the manager + layout pair end-to-end.
    layoutManager = new LayoutManager(state);
    spaceManager = new SpaceManager(state, nav, layoutManager);
    layoutManager.setSpaceManager(spaceManager);
    mockSave = jest.fn();
    spaceManager.setSaveCallback(mockSave);

    state.initFromConfig({
      spaces: {
        custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/', type: 'ai-service' },
        custom2: { name: 'Claude', url: 'https://claude.ai/', type: 'ai-service' },
        custom3: { name: 'Gemini', url: 'https://gemini.google.com/', type: 'ai-service' },
      },
      settings: { multiSpace: false, defaultSpace: 'custom1' },
      state: { activeSpaces: ['custom1'], lastActiveSpaces: [] },
    });

    const container = document.createElement('div');
    container.id = 'space-container';
    document.body.appendChild(container);

    // Layout must be initialized so its change-event subscriptions are wired;
    // toggleMulti relies on LayoutManager teardown to clean wrapper DOM.
    layoutManager.initialize();
  });

  afterEach(() => {
    document.body.textContent = '';
    jest.clearAllMocks();
  });

  // ================================================================
  // CRITICAL #1: _deactivate must update currentSpaceId
  // Spec: After deactivating a space in multi mode,
  // currentSpaceId must point to a remaining active space.
  // ================================================================
  describe('CRITICAL: stale currentSpaceId after deactivation', () => {
    beforeEach(() => {
      state.set('multiSpace', true);
      const config = state.get('config');
      if (config && config.settings) config.settings.multiSpace = true;
    });

    test('deactivating currentSpaceId switches to another active space', () => {
      // Activate custom1 and custom2
      spaceManager.select('custom1', false, true);
      spaceManager.select('custom2', false, true);

      expect(state.get('currentSpaceId')).toBe('custom2');

      // Now deactivate custom2 (the current one)
      spaceManager.select('custom2', false, true);

      // currentSpaceId must NOT still be custom2
      const currentId = state.get('currentSpaceId');
      expect(currentId).not.toBe('custom2');
      // It should be custom1 (the only remaining active)
      expect(currentId).toBe('custom1');
    });

    test('deactivating a non-current space keeps currentSpaceId unchanged', () => {
      spaceManager.select('custom1', false, true);
      spaceManager.select('custom2', false, true);
      spaceManager.select('custom3', false, true);

      // Current is custom3, deactivate custom1
      expect(state.get('currentSpaceId')).toBe('custom3');
      spaceManager.select('custom1', false, true);

      // current should remain custom3
      expect(state.get('currentSpaceId')).toBe('custom3');
    });

    test('deactivated space is marked inactive in activeSpaces', () => {
      spaceManager.select('custom1', false, true);
      spaceManager.select('custom2', false, true);
      spaceManager.select('custom3', false, true);

      spaceManager.select('custom2', false, true); // deactivate custom2

      const active = state.get('activeSpaces');
      expect(active.custom2).toBe(false);
      expect(active.custom1).toBe(true);
      expect(active.custom3).toBe(true);
    });
  });

  // ================================================================
  // HIGH #3: _deactivate crash when config.state.activeSpaces is undefined
  // Spec: _deactivate must not crash when activeSpaces is missing
  // ================================================================
  describe('HIGH: crash on missing activeSpaces in _deactivate', () => {
    beforeEach(() => {
      state.set('multiSpace', true);
      const config = state.get('config');
      if (config && config.settings) config.settings.multiSpace = true;
    });

    test('does not crash when config.state.activeSpaces is undefined', () => {
      spaceManager.select('custom1', false, true);
      spaceManager.select('custom2', false, true);

      // Remove activeSpaces to simulate the bug scenario
      const config = state.get('config');
      delete config.state.activeSpaces;

      // This should not throw
      expect(() => {
        spaceManager.select('custom1', false, true); // deactivate custom1
      }).not.toThrow();
    });

    test('does not crash when config.state is undefined', () => {
      spaceManager.select('custom1', false, true);
      spaceManager.select('custom2', false, true);

      const config = state.get('config');
      delete config.state;

      expect(() => {
        spaceManager.select('custom1', false, true);
      }).not.toThrow();
    });
  });

  // ================================================================
  // HIGH #4: toggleMulti must emit activeSpaces state change
  // Spec: When disabling multi-space, activeSpaces must be
  // updated via state.set() so LayoutManager gets notified.
  // ================================================================
  describe('HIGH: toggleMulti must emit activeSpaces change events', () => {
    test('disabling multi-space triggers activeSpaces state change', () => {
      // Enable multi and activate 2 spaces
      state.set('multiSpace', true);
      const config = state.get('config');
      if (config && config.settings) config.settings.multiSpace = true;

      spaceManager.select('custom1', false, true);
      spaceManager.select('custom2', false, true);

      const changeListener = jest.fn();
      state.on('change:activeSpaces', changeListener);

      // Disable multi-space
      spaceManager.toggleMulti();

      // The change event must have fired so LayoutManager can teardown
      expect(changeListener).toHaveBeenCalled();
    });

    test('disabling multi-space clears gridColumn on wrappers', () => {
      state.set('multiSpace', true);
      const config = state.get('config');
      if (config && config.settings) config.settings.multiSpace = true;

      spaceManager.select('custom1', false, true);
      spaceManager.select('custom2', false, true);

      // Simulate stale gridColumn styles
      const container = document.getElementById('space-container');
      const wrappers = container.querySelectorAll('.space-webview-wrapper');
      wrappers.forEach((w) => (w.style.gridColumn = 'span 2'));

      spaceManager.toggleMulti();

      // All wrappers should have gridColumn cleared
      const updatedWrappers = container.querySelectorAll('.space-webview-wrapper');
      updatedWrappers.forEach((w) => {
        expect(w.style.gridColumn).toBe('');
      });
    });
  });
});
