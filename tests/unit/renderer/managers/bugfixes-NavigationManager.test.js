const AppState = require('../../../../renderer/core/AppState');
const NavigationManager = require('../../../../renderer/managers/NavigationManager');
const FindBarManager = require('../../../../renderer/managers/FindBarManager');

describe('NavigationManager bug fixes', () => {
  let state;
  let nav;

  beforeEach(() => {
    state = new AppState();
    nav = new NavigationManager(state);

    // Set up DOM fixtures
    const container = document.createElement('div');
    container.id = 'space-container';
    document.body.appendChild(container);

    const browserContainer = document.createElement('div');
    browserContainer.id = 'browser-container';
    const bwv = document.createElement('div');
    bwv.id = 'browser-webview';
    bwv.classList.add('web-browser');
    browserContainer.appendChild(bwv);
    document.body.appendChild(browserContainer);

    const main = document.createElement('div');
    main.id = 'main-content';
    document.body.appendChild(main);
  });

  afterEach(() => {
    document.body.textContent = '';
  });

  // ================================================================
  // CRITICAL #2: Home reset must close find bar before replacing webview
  // Spec: _homeReset replaces the webview element. If FindBarManager holds
  // a reference to the old webview, find-in-page silently fails. The fix
  // closes the find bar before replacement.
  // ================================================================
  describe('CRITICAL: stale FindBar reference after Home reset', () => {
    test('_homeReset closes find bar before replacing browser webview', () => {
      const findBar = new FindBarManager(state, nav);
      nav.setFindBarManager(findBar);
      const closeSpy = jest.spyOn(findBar, 'close');

      state.initFromConfig({
        spaces: {},
        settings: { browserHomeUrl: 'https://google.com/' },
        state: {},
      });

      nav._homeReset('browser');

      expect(closeSpy).toHaveBeenCalled();
      closeSpy.mockRestore();
    });

    test('_homeReset closes find bar before replacing space webview', () => {
      const findBar = new FindBarManager(state, nav);
      nav.setFindBarManager(findBar);
      const closeSpy = jest.spyOn(findBar, 'close');

      // Create existing space webview to replace
      const container = document.getElementById('space-container');
      const wrapper = document.createElement('div');
      wrapper.className = 'space-webview-wrapper';
      wrapper.dataset.spaceId = 'custom1';
      const oldWv = document.createElement('div');
      oldWv.id = 'custom1';
      oldWv.classList.add('space-browser', 'active');
      wrapper.appendChild(oldWv);
      container.appendChild(wrapper);

      state.initFromConfig({
        spaces: { custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/' } },
        settings: {},
        state: {},
      });

      nav._homeReset('space', 'custom1');

      expect(closeSpy).toHaveBeenCalled();
      closeSpy.mockRestore();
    });

    test('FindBar _targetWebview is null after home reset closes it', () => {
      const findBar = new FindBarManager(state, nav);
      nav.setFindBarManager(findBar);

      // Simulate FindBar holding a reference to a webview
      const mockWv = { stopFindInPage: jest.fn(), isConnected: true };
      findBar._targetWebview = mockWv;
      findBar._requestId = 42;

      state.initFromConfig({
        spaces: {},
        settings: { browserHomeUrl: 'https://google.com/' },
        state: {},
      });

      nav._homeReset('browser');

      // After close(), targetWebview and requestId should be cleared
      expect(findBar._targetWebview).toBeNull();
      expect(findBar._requestId).toBeNull();
    });

    test('home reset works gracefully when no find bar manager set', () => {
      // No findBarManager set on nav
      state.initFromConfig({
        spaces: {},
        settings: { browserHomeUrl: 'https://google.com/' },
        state: {},
      });

      expect(() => nav._homeReset('browser')).not.toThrow();
    });
  });

  // ================================================================
  // MEDIUM #4: focusWebview dom-ready listener uses { once: true }
  // Spec: focusWebview must not accumulate dom-ready listeners on repeated
  // calls. Each call should attach at most one listener via { once: true }.
  // ================================================================
  describe('MEDIUM: focusWebview dom-ready listener accumulation', () => {
    test('dom-ready listener fires only once per focusWebview call', () => {
      const wv = document.createElement('div');
      wv.id = 'test-wv';
      wv.focus = jest.fn();
      wv.executeJavaScript = jest.fn().mockResolvedValue(undefined);
      // Not ready yet, so dom-ready listener will be attached
      wv.isReady = jest.fn(() => false);
      document.getElementById('space-container').appendChild(wv);

      // Add addEventListener spy before calling focusWebview
      const addListenerSpy = jest.spyOn(wv, 'addEventListener');

      nav.focusWebview('test-wv');
      nav.focusWebview('test-wv');
      nav.focusWebview('test-wv');

      // Each call should use { once: true } — check all calls had this option
      const domReadyCalls = addListenerSpy.mock.calls.filter(
        ([event]) => event === 'dom-ready'
      );

      domReadyCalls.forEach(([, , options]) => {
        expect(options).toEqual({ once: true });
      });

      addListenerSpy.mockRestore();
    });
  });
});
