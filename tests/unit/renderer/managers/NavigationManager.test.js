const AppState = require('../../../../renderer/core/AppState');
const NavigationManager = require('../../../../renderer/managers/NavigationManager');

describe('NavigationManager', () => {
  let state;
  let nav;

  beforeEach(() => {
    state = new AppState();
    nav = new NavigationManager(state);
    // Set up DOM fixtures for testing
    const container = document.createElement('div');
    container.id = 'space-container';
    const wv1 = document.createElement('div');
    wv1.id = 'custom1';
    wv1.classList.add('space-browser', 'active');
    container.appendChild(wv1);
    document.body.appendChild(container);

    const browserContainer = document.createElement('div');
    browserContainer.id = 'browser-container';
    const bwv = document.createElement('div');
    bwv.id = 'browser-webview';
    bwv.classList.add('web-browser');
    browserContainer.appendChild(bwv);
    document.body.appendChild(browserContainer);
  });

  afterEach(() => {
    document.body.textContent = '';
  });

  test('back() calls goBack on active webview', () => {
    const wv = document.getElementById('custom1');
    wv.canGoBack = jest.fn(() => true);
    wv.goBack = jest.fn();
    wv.focus = jest.fn();
    nav.setActiveWebview(wv);

    nav.back();
    expect(wv.goBack).toHaveBeenCalled();
  });

  test('forward() calls goForward on active webview', () => {
    const wv = document.getElementById('custom1');
    wv.canGoForward = jest.fn(() => true);
    wv.goForward = jest.fn();
    wv.focus = jest.fn();
    nav.setActiveWebview(wv);

    nav.forward();
    expect(wv.goForward).toHaveBeenCalled();
  });

  test('refresh() calls reload on active webview', () => {
    const wv = document.getElementById('custom1');
    wv.reload = jest.fn();
    wv.focus = jest.fn();
    nav.setActiveWebview(wv);

    nav.refresh();
    expect(wv.reload).toHaveBeenCalled();
  });

  test('getActiveWebview returns space by currentSpaceId', () => {
    nav._lastActiveWebview = null;
    state.set('currentSpaceId', 'custom1');

    const result = nav.getActiveWebview();
    expect(result).not.toBeNull();
    expect(result.id).toBe('custom1');
  });

  test('getActiveWebview falls back to browser-webview when no space set', () => {
    nav._lastActiveWebview = null;
    state.set('currentSpaceId', null);

    const result = nav.getActiveWebview();
    expect(result).not.toBeNull();
    expect(result.id).toBe('browser-webview');
  });

  test('getActiveWebview clears stale disconnected webview reference', () => {
    const detached = document.createElement('div');
    detached.id = 'detached-wv';
    // Not appended to DOM, so isConnected = false
    nav._lastActiveWebview = detached;
    state.set('currentSpaceId', 'custom1');

    const result = nav.getActiveWebview();
    expect(result.id).toBe('custom1');
    expect(nav._lastActiveWebview).toBeNull();
  });

  test('focusWebview calls focus on the element', () => {
    const wv = document.getElementById('custom1');
    wv.focus = jest.fn();
    nav.focusWebview('custom1');
    expect(wv.focus).toHaveBeenCalled();
  });

  test('focusWebview does nothing for null id', () => {
    expect(() => nav.focusWebview(null)).not.toThrow();
  });

  test('focusWebview does nothing for nonexistent id', () => {
    expect(() => nav.focusWebview('nonexistent')).not.toThrow();
  });

  test('zoomIn increases zoom level by 0.5', () => {
    const wv = document.getElementById('custom1');
    wv.getZoomLevel = jest.fn(() => 0);
    wv.setZoomLevel = jest.fn();
    nav.setActiveWebview(wv);

    nav.zoomIn();
    expect(wv.setZoomLevel).toHaveBeenCalledWith(0.5);
  });

  test('zoomOut decreases zoom level by 0.5', () => {
    const wv = document.getElementById('custom1');
    wv.getZoomLevel = jest.fn(() => 1.0);
    wv.setZoomLevel = jest.fn();
    nav.setActiveWebview(wv);

    nav.zoomOut();
    expect(wv.setZoomLevel).toHaveBeenCalledWith(0.5);
  });

  test('zoomReset sets zoom level to 0', () => {
    const wv = document.getElementById('custom1');
    wv.setZoomLevel = jest.fn();
    nav.setActiveWebview(wv);

    nav.zoomReset();
    expect(wv.setZoomLevel).toHaveBeenCalledWith(0);
  });

  describe('guarded navigation no-ops', () => {
    test('back() does not call goBack when canGoBack is false', () => {
      const wv = document.getElementById('custom1');
      wv.canGoBack = jest.fn(() => false);
      wv.goBack = jest.fn();
      wv.focus = jest.fn();
      nav.setActiveWebview(wv);
      nav.back();
      expect(wv.goBack).not.toHaveBeenCalled();
      expect(wv.focus).toHaveBeenCalled(); // still focuses
    });

    test('forward() does not call goForward when canGoForward is false', () => {
      const wv = document.getElementById('custom1');
      wv.canGoForward = jest.fn(() => false);
      wv.goForward = jest.fn();
      wv.focus = jest.fn();
      nav.setActiveWebview(wv);
      nav.forward();
      expect(wv.goForward).not.toHaveBeenCalled();
    });

    test('back/forward/refresh are safe when there is no active webview', () => {
      nav._lastActiveWebview = null;
      state.set('currentSpaceId', null);
      document.getElementById('browser-webview').remove();
      expect(() => { nav.back(); nav.forward(); nav.refresh(); }).not.toThrow();
    });

    test('zoomIn/Out/Reset no-op when webview lacks setZoomLevel', () => {
      const wv = document.getElementById('custom1');
      nav.setActiveWebview(wv);
      expect(() => { nav.zoomIn(); nav.zoomOut(); nav.zoomReset(); }).not.toThrow();
    });
  });

  describe('hover tracking', () => {
    test('mouseover on a wrapper sets the hovered webview', () => {
      const wrapper = document.createElement('div');
      wrapper.className = 'space-webview-wrapper';
      const wv = document.createElement('webview');
      wrapper.appendChild(wv);
      document.body.appendChild(wrapper);

      wv.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(nav.getHoveredWebview()).toBe(wv);
    });

    test('mouseover outside any wrapper clears the hovered webview', () => {
      const wrapper = document.createElement('div');
      wrapper.className = 'space-webview-wrapper';
      const wv = document.createElement('webview');
      wrapper.appendChild(wv);
      document.body.appendChild(wrapper);
      wv.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(nav.getHoveredWebview()).toBe(wv);

      const loose = document.createElement('div');
      document.body.appendChild(loose);
      loose.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(nav.getHoveredWebview()).toBeNull();
    });

    test('getHoveredWebview returns null for a disconnected hovered element', () => {
      const wrapper = document.createElement('div');
      wrapper.className = 'space-webview-wrapper';
      const wv = document.createElement('webview');
      wrapper.appendChild(wv);
      document.body.appendChild(wrapper);
      wv.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      wrapper.remove(); // now wv.isConnected === false
      expect(nav.getHoveredWebview()).toBeNull();
    });

    test('mouseleave on documentElement clears the hovered webview', () => {
      const wrapper = document.createElement('div');
      wrapper.className = 'space-webview-wrapper';
      const wv = document.createElement('webview');
      wrapper.appendChild(wv);
      document.body.appendChild(wrapper);
      wv.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

      document.documentElement.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      expect(nav.getHoveredWebview()).toBeNull();
    });

    test('getCursorTargetWebview prefers the hovered webview, else the active one', () => {
      const active = document.getElementById('custom1');
      nav.setActiveWebview(active);
      expect(nav.getCursorTargetWebview()).toBe(active); // nothing hovered

      const wrapper = document.createElement('div');
      wrapper.className = 'space-webview-wrapper';
      const hovered = document.createElement('webview');
      wrapper.appendChild(hovered);
      document.body.appendChild(wrapper);
      hovered.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(nav.getCursorTargetWebview()).toBe(hovered);
    });
  });

  describe('home() and _homeReset', () => {
    test('home() resets the browser webview when it is active', () => {
      const spy = jest.spyOn(nav, '_homeReset');
      const bwv = document.getElementById('browser-webview');
      nav.setActiveWebview(bwv);
      nav.home();
      expect(spy).toHaveBeenCalledWith('browser');
      spy.mockRestore();
    });

    test('home() resets the space webview by id when a space is active', () => {
      const spy = jest.spyOn(nav, '_homeReset');
      const wv = document.getElementById('custom1');
      nav.setActiveWebview(wv);
      nav.home();
      expect(spy).toHaveBeenCalledWith('space', 'custom1');
      spy.mockRestore();
    });

    test('home() is a no-op with no active webview', () => {
      nav._lastActiveWebview = null;
      state.set('currentSpaceId', null);
      document.getElementById('browser-webview').remove();
      expect(() => nav.home()).not.toThrow();
    });

    test('_homeReset("browser") replaces the old browser webview in its container', () => {
      // Reuse the single fixture #browser-container created in beforeEach.
      const container = document.getElementById('browser-container');
      const old = container.querySelector('.web-browser');
      state.set('config', { settings: { browserHomeUrl: 'https://home.example/' } });

      nav._homeReset('browser');
      const fresh = container.querySelector('.web-browser');
      expect(fresh.id).toBe('browser-webview');
      expect(fresh.src).toBe('https://home.example/');
      expect(container.contains(old)).toBe(false);
      expect(nav._lastActiveWebview).toBe(fresh);
    });

    test('_homeReset("browser") appends when no old browser webview exists', () => {
      const container = document.getElementById('browser-container');
      container.innerHTML = ''; // no existing .web-browser
      state.set('config', { settings: {} });
      nav._homeReset('browser');
      expect(container.querySelector('#browser-webview')).toBeTruthy();
    });

    test('_homeReset("browser") bails when there is no browser-container', () => {
      document.getElementById('browser-container').remove();
      state.set('config', { settings: {} });
      expect(() => nav._homeReset('browser')).not.toThrow();
    });

    test('_homeReset("space", id) replaces the webview inside its wrapper', () => {
      const container = document.getElementById('space-container');
      const wrapper = document.createElement('div');
      wrapper.className = 'space-webview-wrapper';
      const old = document.getElementById('custom1');
      old.parentNode.removeChild(old);
      wrapper.appendChild(old);
      container.appendChild(wrapper);
      state.set('config', { spaces: { custom1: { url: 'https://c1.example/' } } });
      state.set('activeSpaces', { custom1: true });

      nav._homeReset('space', 'custom1');
      const fresh = document.getElementById('custom1');
      expect(fresh.src).toBe('https://c1.example/');
      expect(fresh.parentElement).toBe(wrapper);
      expect(nav._lastActiveWebview).toBe(fresh);
    });

    test('_homeReset("space", id) creates a wrapper when the space is new', () => {
      const container = document.getElementById('space-container');
      state.set('config', { spaces: {} }); // unknown id → google fallback url
      nav._homeReset('space', 'customNew');
      const fresh = document.getElementById('customNew');
      expect(fresh).toBeTruthy();
      expect(fresh.src).toBe('https://www.google.com/');
      expect(fresh.parentElement.className).toBe('space-webview-wrapper');
      expect(container.contains(fresh)).toBe(true);
    });

    test('_homeReset("space", id) sends an ad-hoc tab back to its own URL', () => {
      state.set('config', { spaces: {} });
      state.set('adHocSpaces', { tab_1: { url: 'https://docs.example/start' } });
      nav._homeReset('space', 'tab_1');
      expect(document.getElementById('tab_1').src).toBe('https://docs.example/start');
    });

    // A <webview>'s partition is fixed by its first navigation, so the fixture
    // records the partition attribute at the moment src is first set.
    function recordPartitionAtSrc() {
      const realCreate = document.createElement.bind(document);
      return jest.spyOn(document, 'createElement').mockImplementation((tag, opts) => {
        const el = realCreate(tag, opts);
        if (tag === 'webview') {
          let src = '';
          Object.defineProperty(el, 'src', {
            configurable: true,
            get: () => src,
            set: (value) => { src = value; if (!('partitionAtSrc' in el)) el.partitionAtSrc = el.getAttribute('partition'); },
          });
        }
        return el;
      });
    }

    test('_homeReset("space", id) keeps a private tab in the private partition', () => {
      const spy = recordPartitionAtSrc();
      const wrapper = document.createElement('div');
      wrapper.className = 'space-webview-wrapper';
      const old = document.createElement('div');
      old.id = 'tab_9';
      old.setAttribute('partition', 'private');
      wrapper.appendChild(old);
      document.getElementById('space-container').appendChild(wrapper);
      state.set('config', { spaces: {} });
      state.set('adHocSpaces', { tab_9: { url: 'https://secret.example/', private: true } });

      nav._homeReset('space', 'tab_9');
      const fresh = document.getElementById('tab_9');
      expect(fresh.partitionAtSrc).toBe('private');
      expect(fresh.src).toBe('https://secret.example/');
      spy.mockRestore();
    });

    test('_homeReset("space", id) mounts a private tab with no old webview in the private partition', () => {
      const spy = recordPartitionAtSrc();
      state.set('config', { spaces: {} });
      state.set('adHocSpaces', { tab_9: { url: 'https://secret.example/', private: true } });
      nav._homeReset('space', 'tab_9');
      expect(document.getElementById('tab_9').partitionAtSrc).toBe('private');
      spy.mockRestore();
    });

    test('_homeReset gives a regular tab and the browser view no partition', () => {
      const spy = recordPartitionAtSrc();
      state.set('config', { spaces: { customNew: { url: 'https://c1.example/' } }, settings: {} });
      nav._homeReset('space', 'customNew');
      nav._homeReset('browser');
      expect(document.getElementById('customNew').partitionAtSrc).toBeNull();
      expect(document.getElementById('browser-webview').partitionAtSrc).toBeNull();
      spy.mockRestore();
    });

    test('_homeReset("browser") keeps the partition of the browser view it replaces', () => {
      const spy = recordPartitionAtSrc();
      document.getElementById('browser-webview').setAttribute('partition', 'private');
      state.set('config', { settings: { browserHomeUrl: 'https://home.example/' } });
      nav._homeReset('browser');
      expect(document.getElementById('browser-webview').partitionAtSrc).toBe('private');
      spy.mockRestore();
    });

    test('_homeReset closes the find bar when one is wired', () => {
      const findBar = { close: jest.fn() };
      nav.setFindBarManager(findBar);
      state.set('config', { settings: {} });
      nav._homeReset('browser'); // uses the fixture #browser-container
      expect(findBar.close).toHaveBeenCalled();
    });
  });

  describe('browser-specific navigation', () => {
    test('browserBack triggers goBack on the browser webview when possible', () => {
      const bwv = document.getElementById('browser-webview');
      bwv.canGoBack = jest.fn(() => true);
      bwv.goBack = jest.fn();
      bwv.focus = jest.fn();
      nav.browserBack();
      expect(bwv.goBack).toHaveBeenCalled();
    });

    test('browserForward respects canGoForward=false', () => {
      const bwv = document.getElementById('browser-webview');
      bwv.canGoForward = jest.fn(() => false);
      bwv.goForward = jest.fn();
      bwv.focus = jest.fn();
      nav.browserForward();
      expect(bwv.goForward).not.toHaveBeenCalled();
    });
  });

  describe('zoom persistence', () => {
    test('_saveZoomLevel persists when persistZoomLevels is enabled', () => {
      const wv = document.getElementById('custom1');
      wv.getZoomLevel = jest.fn(() => 1.5);
      wv.setZoomLevel = jest.fn();
      const config = { settings: { persistZoomLevels: true } };
      state.set('config', config);
      window.saveSettings = jest.fn();
      nav.setActiveWebview(wv);

      nav.zoomIn();
      expect(config.state.zoomLevels.custom1).toBe(1.5);
      expect(window.saveSettings).toHaveBeenCalledWith(config);
    });

    test('_saveZoomLevel is skipped for the browser webview', () => {
      const bwv = document.getElementById('browser-webview');
      bwv.getZoomLevel = jest.fn(() => 0);
      bwv.setZoomLevel = jest.fn();
      const config = { settings: { persistZoomLevels: true } };
      state.set('config', config);
      window.saveSettings = jest.fn();
      nav.setActiveWebview(bwv);

      nav.zoomIn();
      expect(window.saveSettings).not.toHaveBeenCalled();
    });

    test('_saveZoomLevel is skipped for a private tab, whose id must not reach config', () => {
      const wv = document.getElementById('custom1');
      wv.setAttribute('partition', 'private');
      wv.getZoomLevel = jest.fn(() => 2);
      wv.setZoomLevel = jest.fn();
      const config = { settings: { persistZoomLevels: true } };
      state.set('config', config);
      window.saveSettings = jest.fn();
      nav.setActiveWebview(wv);
      nav.zoomIn();
      expect(wv.setZoomLevel).toHaveBeenCalled();
      expect(config.state).toBeUndefined();
      expect(window.saveSettings).not.toHaveBeenCalled();
    });

    test('_saveZoomLevel is skipped when persistZoomLevels is off', () => {
      const wv = document.getElementById('custom1');
      wv.getZoomLevel = jest.fn(() => 1);
      wv.setZoomLevel = jest.fn();
      state.set('config', { settings: { persistZoomLevels: false } });
      window.saveSettings = jest.fn();
      nav.setActiveWebview(wv);
      nav.zoomReset();
      expect(window.saveSettings).not.toHaveBeenCalled();
    });

    test('restoreZoomLevel applies a persisted level', () => {
      const wv = document.getElementById('custom1');
      wv.setZoomLevel = jest.fn();
      state.set('config', { settings: { persistZoomLevels: true }, state: { zoomLevels: { custom1: 2 } } });
      nav.restoreZoomLevel(wv);
      expect(wv.setZoomLevel).toHaveBeenCalledWith(2);
    });

    test('restoreZoomLevel ignores the browser webview and missing levels', () => {
      const bwv = document.getElementById('browser-webview');
      bwv.setZoomLevel = jest.fn();
      state.set('config', { settings: { persistZoomLevels: true }, state: { zoomLevels: {} } });
      nav.restoreZoomLevel(bwv);
      expect(bwv.setZoomLevel).not.toHaveBeenCalled();

      const wv = document.getElementById('custom1');
      wv.setZoomLevel = jest.fn();
      nav.restoreZoomLevel(wv); // no entry for custom1
      expect(wv.setZoomLevel).not.toHaveBeenCalled();
    });

    test('restoreZoomLevel no-ops when persistence disabled or no zoomLevels', () => {
      const wv = document.getElementById('custom1');
      wv.setZoomLevel = jest.fn();
      state.set('config', { settings: { persistZoomLevels: false } });
      nav.restoreZoomLevel(wv);
      state.set('config', { settings: { persistZoomLevels: true } });
      nav.restoreZoomLevel(wv);
      expect(wv.setZoomLevel).not.toHaveBeenCalled();
    });
  });

  describe('focusWebview', () => {
    test('focuses immediately and runs the focus script when the webview is ready', () => {
      const wv = document.getElementById('custom1');
      wv.focus = jest.fn();
      wv.isReady = jest.fn(() => true);
      wv.executeJavaScript = jest.fn(() => Promise.resolve());
      nav.focusWebview('custom1');
      expect(wv.focus).toHaveBeenCalled();
      expect(wv.executeJavaScript).toHaveBeenCalled();
    });

    test('defers the focus script until dom-ready when not yet ready', () => {
      const wv = document.getElementById('custom1');
      wv.focus = jest.fn();
      wv.isReady = jest.fn(() => false);
      wv.executeJavaScript = jest.fn(() => Promise.resolve());
      let domReadyCb = null;
      wv.addEventListener = jest.fn((evt, cb) => { if (evt === 'dom-ready') domReadyCb = cb; });
      nav.focusWebview('custom1');
      expect(wv.executeJavaScript).not.toHaveBeenCalled();
      domReadyCb();
      expect(wv.executeJavaScript).toHaveBeenCalled();
    });

    test('a throwing focus() does not abort the caller but is reported', () => {
      const wv = document.getElementById('custom1');
      wv.focus = () => { throw new Error('focus boom'); };
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => nav.focusWebview('custom1')).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not focus webview'), expect.objectContaining({ message: 'focus boom' }));
      warn.mockRestore();
    });
  });
});
