const AppState = require('../../../../renderer/core/AppState');
const NavigationManager = require('../../../../renderer/managers/NavigationManager');
const BrowserViewManager = require('../../../../renderer/managers/BrowserViewManager');

describe('BrowserViewManager bug fixes', () => {
  let state;
  let nav;
  let bvm;

  beforeEach(() => {
    state = new AppState();
    nav = new NavigationManager(state);
    bvm = new BrowserViewManager(state, nav);

    // Set up DOM
    const browserContainer = document.createElement('div');
    browserContainer.id = 'browser-container';
    document.body.appendChild(browserContainer);

    const cogContainer = document.createElement('div');
    cogContainer.id = 'space-container';
    document.body.appendChild(cogContainer);
  });

  afterEach(() => {
    document.body.textContent = '';
  });

  // ================================================================
  // MEDIUM #1: toggleView was a no-op when both views were active
  // Spec: When both browser and space views are active, toggleView
  // should hide the browser view and keep the space visible.
  // ================================================================
  describe('MEDIUM: toggleView no-op when both views active', () => {
    test('toggleView hides browser when both views are active', () => {
      // Start with both views active
      state.set('browserViewActive', true);
      state.set('spaceViewActive', true);

      bvm.toggleView();

      // Browser should now be hidden
      expect(state.get('browserViewActive')).toBe(false);
      // Cognitizer should remain active
      expect(state.get('spaceViewActive')).toBe(true);
    });

    test('toggleView cycles: both -> cog-only -> browser-only -> cog-only', () => {
      // Both active
      state.set('browserViewActive', true);
      state.set('spaceViewActive', true);

      bvm.toggleView();
      // After first toggle: browser hidden, cog active
      expect(state.get('browserViewActive')).toBe(false);
      expect(state.get('spaceViewActive')).toBe(true);

      bvm.toggleView();
      // After second toggle: browser shown, cog hidden
      expect(state.get('browserViewActive')).toBe(true);
      expect(state.get('spaceViewActive')).toBe(false);

      bvm.toggleView();
      // After third toggle: cog shown, browser hidden
      expect(state.get('browserViewActive')).toBe(false);
      expect(state.get('spaceViewActive')).toBe(true);
    });
  });
});
