/** @jest-environment jsdom */

// ipcBridge — renderer-side IPC listener registration + delegation.
// Covers every channel handler, both branches of every guard
// (wv present / absent, openLinkExternal on / off, manager method
// present / absent), the visibilitychange + window-shown window-
// stabilization logic, and the voice hotkey handler.

jest.mock('electron', () => {
  const listeners = {};
  return {
    ipcRenderer: {
      on: jest.fn((channel, handler) => {
        if (!listeners[channel]) listeners[channel] = [];
        listeners[channel].push(handler);
      }),
      send: jest.fn(),
      invoke: jest.fn(),
      _listeners: listeners,
    },
    shell: { openExternal: jest.fn() },
  };
});

const mockOverlay = {
  bindConfig: jest.fn(),
  isActive: jest.fn(() => false),
  start: jest.fn(),
  stop: jest.fn(),
  voiceUnavailableMessage: jest.fn(() => 'VOICE-REASON-SENTINEL'),
};
jest.mock('../../../../renderer/components/VoiceCaptureOverlay', () => mockOverlay);

const { ipcRenderer, shell } = require('electron');
const { registerAll } = require('../../../../renderer/ipc/ipcBridge');

function trigger(channel, ...args) {
  const handlers = ipcRenderer._listeners[channel];
  if (handlers) handlers.forEach((h) => h({}, ...args));
  return !!handlers;
}

function triggerWithEvent(channel, event, ...args) {
  const handlers = ipcRenderer._listeners[channel];
  if (handlers) handlers.forEach((h) => h(event, ...args));
}

describe('ipcBridge', () => {
  let mockManagers;
  let activeWebview;
  let cursorWebview;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(ipcRenderer._listeners)) {
      delete ipcRenderer._listeners[key];
    }
    document.body.innerHTML = '';
    mockOverlay.isActive.mockReturnValue(false);

    activeWebview = {
      id: 'custom1',
      goBack: jest.fn(),
      goForward: jest.fn(),
      reload: jest.fn(),
      loadURL: jest.fn(),
      src: '',
      style: {},
    };
    cursorWebview = {
      id: 'custom2',
      goBack: jest.fn(),
      goForward: jest.fn(),
      reload: jest.fn(),
    };

    mockManagers = {
      navigationManager: {
        back: jest.fn(), forward: jest.fn(), home: jest.fn(),
        browserBack: jest.fn(), browserForward: jest.fn(),
        zoomIn: jest.fn(), zoomOut: jest.fn(), zoomReset: jest.fn(),
        focusWebview: jest.fn(),
        getActiveWebview: jest.fn(() => activeWebview),
        getCursorTargetWebview: jest.fn(() => cursorWebview),
        setActiveWebview: jest.fn(),
        _homeReset: jest.fn(),
      },
      findBarManager: { toggle: jest.fn(), findNext: jest.fn(), findPrev: jest.fn(), close: jest.fn() },
      browserViewManager: {
        toggle: jest.fn(), toggleSpace: jest.fn(), toggleView: jest.fn(),
      },
      spaceManager: {
        next: jest.fn(), previous: jest.fn(), close: jest.fn(), toggleMulti: jest.fn(),
        openTab: jest.fn(), openAdHocTab: jest.fn(),
      },
      state: { get: jest.fn(() => false), set: jest.fn() },
    };

    registerAll(mockManagers);
  });

  describe('Registration', () => {
    test('registers at least 35 distinct IPC channels', () => {
      const channels = Object.keys(ipcRenderer._listeners);
      expect(channels.length).toBeGreaterThanOrEqual(35);
    });
  });

  describe('Space selection', () => {
    test('select-next-space → spaceManager.next()', () => {
      trigger('select-next-space');
      expect(mockManagers.spaceManager.next).toHaveBeenCalled();
    });
    test('select-previous-space → spaceManager.previous()', () => {
      trigger('select-previous-space');
      expect(mockManagers.spaceManager.previous).toHaveBeenCalled();
    });
    test('selectSpace → spaceManager.openTab(id)', () => {
      trigger('selectSpace', 'custom7');
      expect(mockManagers.spaceManager.openTab).toHaveBeenCalledWith('custom7');
    });
  });

  describe('Space-specific navigation', () => {
    test('navigateBackSpace → back()', () => {
      trigger('navigateBackSpace');
      expect(mockManagers.navigationManager.back).toHaveBeenCalled();
    });
    test('navigateForwardSpace → forward()', () => {
      trigger('navigateForwardSpace');
      expect(mockManagers.navigationManager.forward).toHaveBeenCalled();
    });
    test('navigateBackBrowser → browserBack()', () => {
      trigger('navigateBackBrowser');
      expect(mockManagers.navigationManager.browserBack).toHaveBeenCalled();
    });
    test('navigateForwardBrowser → browserForward()', () => {
      trigger('navigateForwardBrowser');
      expect(mockManagers.navigationManager.browserForward).toHaveBeenCalled();
    });
  });

  describe('Active-view (cursor target) navigation', () => {
    test('navigateBackActive uses cursor webview when it has goBack', () => {
      trigger('navigateBackActive');
      expect(cursorWebview.goBack).toHaveBeenCalled();
    });
    test('navigateBackActive no-ops when cursor webview missing', () => {
      mockManagers.navigationManager.getCursorTargetWebview.mockReturnValue(null);
      expect(() => trigger('navigateBackActive')).not.toThrow();
    });
    test('navigateBackActive no-ops when cursor webview lacks goBack', () => {
      mockManagers.navigationManager.getCursorTargetWebview.mockReturnValue({ id: 'x' });
      expect(() => trigger('navigateBackActive')).not.toThrow();
    });
    test('navigateForwardActive uses cursor webview', () => {
      trigger('navigateForwardActive');
      expect(cursorWebview.goForward).toHaveBeenCalled();
    });
    test('navigateForwardActive no-ops when cursor webview lacks goForward', () => {
      mockManagers.navigationManager.getCursorTargetWebview.mockReturnValue({ id: 'x' });
      expect(() => trigger('navigateForwardActive')).not.toThrow();
    });
    test('refreshActive uses cursor webview reload', () => {
      trigger('refreshActive');
      expect(cursorWebview.reload).toHaveBeenCalled();
    });
    test('refreshActive no-ops when cursor webview lacks reload', () => {
      mockManagers.navigationManager.getCursorTargetWebview.mockReturnValue({ id: 'x' });
      expect(() => trigger('refreshActive')).not.toThrow();
    });
  });

  describe('Home navigation', () => {
    test('navigateHomeReset → home()', () => {
      trigger('navigateHomeReset');
      expect(mockManagers.navigationManager.home).toHaveBeenCalled();
    });
    test('navigateHomeActive → home()', () => {
      trigger('navigateHomeActive');
      expect(mockManagers.navigationManager.home).toHaveBeenCalled();
    });
    test('navigateHomeBrowser → _homeReset("browser")', () => {
      trigger('navigateHomeBrowser');
      expect(mockManagers.navigationManager._homeReset).toHaveBeenCalledWith('browser');
    });
    test('navigateHomeForWebContents resets the matching space webview', () => {
      const wv = document.createElement('webview');
      wv.id = 'custom3';
      wv.getWebContentsId = () => 42;
      document.body.appendChild(wv);
      trigger('navigateHomeForWebContents', 42);
      expect(mockManagers.navigationManager._homeReset).toHaveBeenCalledWith('space', 'custom3');
    });
    test('navigateHomeForWebContents resets browser when match is browser-webview', () => {
      const wv = document.createElement('webview');
      wv.id = 'browser-webview';
      wv.getWebContentsId = () => 99;
      document.body.appendChild(wv);
      trigger('navigateHomeForWebContents', 99);
      expect(mockManagers.navigationManager._homeReset).toHaveBeenCalledWith('browser', 'browser-webview');
    });
    test('navigateHomeForWebContents falls back to home() when no match', () => {
      trigger('navigateHomeForWebContents', 123);
      expect(mockManagers.navigationManager.home).toHaveBeenCalled();
    });
  });

  describe('Preload-bounce navigation', () => {
    test('navigate-back uses active webview', () => {
      trigger('navigate-back');
      expect(activeWebview.goBack).toHaveBeenCalled();
    });
    test('navigate-back no-ops when active webview missing', () => {
      mockManagers.navigationManager.getActiveWebview.mockReturnValue(null);
      expect(() => trigger('navigate-back')).not.toThrow();
    });
    test('navigate-forward uses active webview', () => {
      trigger('navigate-forward');
      expect(activeWebview.goForward).toHaveBeenCalled();
    });
    test('navigate-forward no-ops when active webview lacks goForward', () => {
      mockManagers.navigationManager.getActiveWebview.mockReturnValue({ id: 'x' });
      expect(() => trigger('navigate-forward')).not.toThrow();
    });
    test('navigate-refresh uses active webview', () => {
      trigger('navigate-refresh');
      expect(activeWebview.reload).toHaveBeenCalled();
    });
    test('navigate-refresh no-ops when active webview lacks reload', () => {
      mockManagers.navigationManager.getActiveWebview.mockReturnValue({ id: 'x' });
      expect(() => trigger('navigate-refresh')).not.toThrow();
    });
    test('navigate-home → home()', () => {
      trigger('navigate-home');
      expect(mockManagers.navigationManager.home).toHaveBeenCalled();
    });
  });

  describe('Find', () => {
    test('toggleFindBar → toggle()', () => {
      trigger('toggleFindBar');
      expect(mockManagers.findBarManager.toggle).toHaveBeenCalled();
    });
    test('findBarForward → findNext()', () => {
      trigger('findBarForward');
      expect(mockManagers.findBarManager.findNext).toHaveBeenCalled();
    });
    test('findBarBack → findPrev()', () => {
      trigger('findBarBack');
      expect(mockManagers.findBarManager.findPrev).toHaveBeenCalled();
    });
    test('close-find-bar → close()', () => {
      trigger('close-find-bar');
      expect(mockManagers.findBarManager.close).toHaveBeenCalled();
    });
  });

  describe('View toggling', () => {
    test('toggleSpaceView → browserViewManager.toggleSpace()', () => {
      trigger('toggleSpaceView');
      expect(mockManagers.browserViewManager.toggleSpace).toHaveBeenCalled();
    });
    test('toggleBrowserView → browserViewManager.toggle()', () => {
      trigger('toggleBrowserView');
      expect(mockManagers.browserViewManager.toggle).toHaveBeenCalled();
    });
    test('toggleMultiSpace → spaceManager.toggleMulti()', () => {
      trigger('toggleMultiSpace');
      expect(mockManagers.spaceManager.toggleMulti).toHaveBeenCalled();
    });
    test('toggleView → browserViewManager.toggleView()', () => {
      trigger('toggleView');
      expect(mockManagers.browserViewManager.toggleView).toHaveBeenCalled();
    });
    test('resetView runs the full reset sequence', () => {
      trigger('resetView');
      expect(mockManagers.browserViewManager.toggleSpace).toHaveBeenCalledWith(true, false);
      expect(mockManagers.browserViewManager.toggle).toHaveBeenCalledWith(false, true);
      expect(mockManagers.navigationManager._homeReset).toHaveBeenCalledWith('browser');
      expect(mockManagers.navigationManager.home).toHaveBeenCalled();
    });
    test('closeActiveSpace → spaceManager.close()', () => {
      trigger('closeActiveSpace');
      expect(mockManagers.spaceManager.close).toHaveBeenCalled();
    });
    test('focusWebviewByWebContents sets the matching webview active', () => {
      const wv = document.createElement('webview');
      wv.id = 'custom4';
      wv.getWebContentsId = () => 7;
      document.body.appendChild(wv);
      trigger('focusWebviewByWebContents', 7);
      expect(mockManagers.navigationManager.setActiveWebview).toHaveBeenCalledWith(wv);
    });
    test('focusWebviewByWebContents no-ops with no match', () => {
      expect(() => trigger('focusWebviewByWebContents', 555)).not.toThrow();
      expect(mockManagers.navigationManager.setActiveWebview).not.toHaveBeenCalled();
    });
    test('closeWebviewByWebContents closes browser when match is browser-webview', () => {
      const wv = document.createElement('webview');
      wv.id = 'browser-webview';
      wv.getWebContentsId = () => 11;
      document.body.appendChild(wv);
      trigger('closeWebviewByWebContents', 11);
      expect(mockManagers.browserViewManager.toggle).toHaveBeenCalledWith(false, true);
    });
    test('closeWebviewByWebContents closes the matching space tab', () => {
      const wv = document.createElement('webview');
      wv.id = 'custom8';
      wv.getWebContentsId = () => 22;
      document.body.appendChild(wv);
      trigger('closeWebviewByWebContents', 22);
      expect(mockManagers.spaceManager.close).toHaveBeenCalledWith('custom8');
    });
    test('closeWebviewByWebContents falls back to spaceManager.close() with no match', () => {
      trigger('closeWebviewByWebContents', 999);
      expect(mockManagers.spaceManager.close).toHaveBeenCalledWith();
    });
    test('closeBrowser toggles browser off and resets home', () => {
      trigger('closeBrowser');
      expect(mockManagers.browserViewManager.toggle).toHaveBeenCalledWith(false, true);
      expect(mockManagers.navigationManager._homeReset).toHaveBeenCalledWith('browser');
    });
    test('closeActiveWebview hides the active webview when present', () => {
      trigger('closeActiveWebview');
      expect(activeWebview.style.display).toBe('none');
    });
    test('closeActiveWebview no-ops when no active webview', () => {
      mockManagers.navigationManager.getActiveWebview.mockReturnValue(null);
      expect(() => trigger('closeActiveWebview')).not.toThrow();
    });
  });

  describe('Zoom', () => {
    test('zoomInActive → zoomIn()', () => {
      trigger('zoomInActive');
      expect(mockManagers.navigationManager.zoomIn).toHaveBeenCalled();
    });
    test('zoomOutActive → zoomOut()', () => {
      trigger('zoomOutActive');
      expect(mockManagers.navigationManager.zoomOut).toHaveBeenCalled();
    });
    test('zoomResetActive → zoomReset()', () => {
      trigger('zoomResetActive');
      expect(mockManagers.navigationManager.zoomReset).toHaveBeenCalled();
    });
  });

  describe('URL handling', () => {
    test('open-url with openLinkExternal=true uses shell.openExternal', () => {
      mockManagers.state.get.mockImplementation((k) => k === 'openLinkExternal');
      trigger('open-url', 'https://ext.example.com');
      expect(shell.openExternal).toHaveBeenCalledWith('https://ext.example.com');
    });
    test('open-url with openLinkExternal=false loads into the browser webview', () => {
      mockManagers.state.get.mockReturnValue(false);
      const wv = document.createElement('webview');
      wv.id = 'browser-webview';
      wv.loadURL = jest.fn();
      document.body.appendChild(wv);
      trigger('open-url', 'https://in.example.com');
      expect(mockManagers.browserViewManager.toggle).toHaveBeenCalledWith(true);
      expect(wv.loadURL).toHaveBeenCalledWith('https://in.example.com');
    });
    test.each([
      'file:///Users/x/Downloads/run.command',
      'smb://attacker/share/x.exe',
      'ms-msdt:/id PCWDiagnostic',
      'javascript:alert(document.cookie)',
    ])('open-url refuses %s on both the external and in-app paths', (url) => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      const wv = document.createElement('webview');
      wv.id = 'browser-webview';
      wv.loadURL = jest.fn();
      document.body.appendChild(wv);
      mockManagers.state.get.mockImplementation((k) => k === 'openLinkExternal');
      trigger('open-url', url);
      mockManagers.state.get.mockReturnValue(false);
      trigger('open-url', url);
      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(wv.loadURL).not.toHaveBeenCalled();
      wv.remove();
      err.mockRestore();
    });
    test('open-url passes mailto: to the OS only on the external path', () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockManagers.state.get.mockImplementation((k) => k === 'openLinkExternal');
      trigger('open-url', 'mailto:a@b.c');
      expect(shell.openExternal).toHaveBeenCalledWith('mailto:a@b.c');
      err.mockRestore();
    });
    test('open-url internal path no-ops gracefully when browser webview absent', () => {
      mockManagers.state.get.mockReturnValue(false);
      expect(() => trigger('open-url', 'https://nope.example.com')).not.toThrow();
      expect(mockManagers.browserViewManager.toggle).toHaveBeenCalledWith(true);
    });
    test('open-new-tab with a url routes through openAdHocTab', () => {
      trigger('open-new-tab', 'https://tab.example.com');
      expect(mockManagers.spaceManager.openAdHocTab).toHaveBeenCalledWith('https://tab.example.com');
    });
    test('open-new-tab marked private opens a private tab, not a normal one', () => {
      mockManagers.spaceManager.openPrivateTab = jest.fn();
      trigger('open-new-tab', { url: 'https://priv.example.com', private: true });
      expect(mockManagers.spaceManager.openPrivateTab).toHaveBeenCalledWith('https://priv.example.com');
      expect(mockManagers.spaceManager.openAdHocTab).not.toHaveBeenCalled();
    });
    test('open-new-tab with a non-private object payload opens a normal tab', () => {
      mockManagers.spaceManager.openPrivateTab = jest.fn();
      trigger('open-new-tab', { url: 'https://obj.example.com' });
      expect(mockManagers.spaceManager.openAdHocTab).toHaveBeenCalledWith('https://obj.example.com');
      expect(mockManagers.spaceManager.openPrivateTab).not.toHaveBeenCalled();
    });
    test('a private link never falls back to the default-session browser webview', () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      const wv = document.createElement('webview');
      wv.id = 'browser-webview';
      wv.loadURL = jest.fn();
      document.body.appendChild(wv);
      trigger('open-new-tab', { url: 'https://priv.example.com', private: true });
      expect(wv.loadURL).not.toHaveBeenCalled();
      expect(mockManagers.spaceManager.openAdHocTab).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledWith(expect.stringContaining('openPrivateTab'));
      wv.remove();
      err.mockRestore();
    });
    test('open-new-tab with empty url is ignored', () => {
      trigger('open-new-tab', '');
      expect(mockManagers.spaceManager.openAdHocTab).not.toHaveBeenCalled();
    });
    test('open-new-tab falls back to browser webview when openAdHocTab missing', () => {
      delete mockManagers.spaceManager.openAdHocTab;
      const wv = document.createElement('webview');
      wv.id = 'browser-webview';
      wv.loadURL = jest.fn();
      document.body.appendChild(wv);
      trigger('open-new-tab', 'https://fb.example.com');
      expect(mockManagers.browserViewManager.toggle).toHaveBeenCalledWith(true);
      expect(wv.loadURL).toHaveBeenCalledWith('https://fb.example.com');
    });
    test('navigate-to-url prepends https:// for bare hosts', () => {
      trigger('navigate-to-url', { url: 'example.com' });
      expect(activeWebview.src).toBe('https://example.com');
    });
    test('navigate-to-url keeps an existing http:// scheme', () => {
      trigger('navigate-to-url', { url: 'http://plain.example.com' });
      expect(activeWebview.src).toBe('http://plain.example.com');
    });
    test('navigate-to-url no-ops when no active webview', () => {
      mockManagers.navigationManager.getActiveWebview.mockReturnValue(null);
      expect(() => trigger('navigate-to-url', { url: 'https://x.example.com' })).not.toThrow();
    });
  });

  describe('window-shown stabilization', () => {
    afterEach(() => { window.requestAnimationFrame = origRaf; });
    let origRaf;
    beforeEach(() => { origRaf = window.requestAnimationFrame; });

    test('adds stabilizing classes and focuses currentSpaceId webview', () => {
      mockManagers.state.get.mockImplementation((k) => (k === 'currentSpaceId' ? 'custom1' : false));
      window.requestAnimationFrame = jest.fn();
      trigger('window-shown');
      expect(document.body.classList.contains('window-stabilizing')).toBe(true);
      expect(document.body.classList.contains('suppress-transitions')).toBe(true);
      expect(mockManagers.navigationManager.focusWebview).toHaveBeenCalledWith('custom1');
    });
    test('window-shown without currentSpaceId does not focus', () => {
      mockManagers.state.get.mockReturnValue(null);
      window.requestAnimationFrame = jest.fn();
      trigger('window-shown');
      expect(mockManagers.navigationManager.focusWebview).not.toHaveBeenCalled();
    });
    test('window-shown reveal path uses requestAnimationFrame double-rAF', () => {
      mockManagers.state.get.mockReturnValue(null);
      const raf = jest.fn();
      window.requestAnimationFrame = raf;
      trigger('window-shown');
      expect(raf).toHaveBeenCalled();
    });
    test('window-shown reveal falls back to setTimeout when rAF unavailable', () => {
      mockManagers.state.get.mockReturnValue(null);
      window.requestAnimationFrame = undefined;
      jest.useFakeTimers();
      trigger('window-shown');
      expect(document.body.classList.contains('window-stabilizing')).toBe(true);
      jest.advanceTimersByTime(40);
      // reveal() ran via the setTimeout(reveal, 32) fallback path.
      expect(document.body.classList.contains('window-stabilizing')).toBe(false);
      expect(document.body.classList.contains('suppress-transitions')).toBe(true);
      jest.advanceTimersByTime(260);
      expect(document.body.classList.contains('suppress-transitions')).toBe(false);
      jest.useRealTimers();
    });
  });

  describe('visibilitychange stabilization', () => {
    afterEach(() => { window.requestAnimationFrame = origRaf; });
    let origRaf;
    beforeEach(() => { origRaf = window.requestAnimationFrame; });

    test('hidden → arms stabilizing classes; visible → invokes rAF reveal', () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(document.body.classList.contains('window-stabilizing')).toBe(true);
      expect(document.body.classList.contains('suppress-transitions')).toBe(true);

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      const raf = jest.fn();
      window.requestAnimationFrame = raf;
      document.dispatchEvent(new Event('visibilitychange'));
      expect(raf).toHaveBeenCalled();
    });

    test('visible release path falls back to setTimeout without rAF', () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(document.body.classList.contains('window-stabilizing')).toBe(true);
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      window.requestAnimationFrame = undefined;
      jest.useFakeTimers();
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(40);
      expect(document.body.classList.contains('window-stabilizing')).toBe(false);
      jest.useRealTimers();
    });
  });

  describe('voice:hotkey-toggle', () => {
    afterEach(() => {
      // Real Toast singleton — clear dedup window, timers and stack DOM so
      // each test renders its own toast (mirrors Toast.test.js resetToast).
      const toastService = require('../../../../renderer/components/Toast');
      toastService._queue.length = 0;
      for (const rec of toastService._visible.slice()) {
        if (rec.timerId) clearTimeout(rec.timerId);
        if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      }
      toastService._visible.length = 0;
      toastService._lastShown.clear();
      if (toastService._container && toastService._container.parentNode) {
        toastService._container.parentNode.removeChild(toastService._container);
      }
      toastService._container = null;
    });
    test('starts the overlay when voice is available and overlay idle', async () => {
      ipcRenderer.invoke.mockResolvedValue({ available: true });
      mockManagers.state.get.mockImplementation((k) =>
        (k === 'config' ? { settings: { voice: { lang: 'en' } } } : false));
      mockOverlay.isActive.mockReturnValue(false);
      await ipcRenderer._listeners['voice:hotkey-toggle'][0]({});
      expect(mockOverlay.bindConfig).toHaveBeenCalledWith({ lang: 'en' });
      expect(mockOverlay.start).toHaveBeenCalledWith({ pressToTalk: false });
    });
    test('stops the overlay when it is already active', async () => {
      ipcRenderer.invoke.mockResolvedValue({ available: true });
      mockManagers.state.get.mockReturnValue({});
      mockOverlay.isActive.mockReturnValue(true);
      await ipcRenderer._listeners['voice:hotkey-toggle'][0]({});
      expect(mockOverlay.stop).toHaveBeenCalled();
      expect(mockOverlay.start).not.toHaveBeenCalled();
    });
    test('never starts or stops recording when voice is unavailable', async () => {
      ipcRenderer.invoke.mockResolvedValue({ available: false });
      await ipcRenderer._listeners['voice:hotkey-toggle'][0]({});
      expect(mockOverlay.start).not.toHaveBeenCalled();
      expect(mockOverlay.stop).not.toHaveBeenCalled();
    });
    test('shows the friendly reason toast when voice is unavailable', async () => {
      const reply = { available: false, enabled: true, reason: 'model_not_bundled' };
      ipcRenderer.invoke.mockResolvedValue(reply);
      await ipcRenderer._listeners['voice:hotkey-toggle'][0]({});
      expect(mockOverlay.voiceUnavailableMessage).toHaveBeenCalledWith(reply);
      const toast = document.querySelector('.toast-error');
      expect(toast).not.toBeNull();
      expect(toast.querySelector('.toast-title').textContent).toBe('Voice input');
      expect(toast.textContent).toContain('VOICE-REASON-SENTINEL');
      expect(mockOverlay.start).not.toHaveBeenCalled();
      expect(mockOverlay.stop).not.toHaveBeenCalled();
    });
    test('swallows errors when the availability probe rejects', async () => {
      ipcRenderer.invoke.mockRejectedValue(new Error('ipc down'));
      await expect(ipcRenderer._listeners['voice:hotkey-toggle'][0]({})).resolves.toBeUndefined();
      expect(mockOverlay.start).not.toHaveBeenCalled();
    });
    test('binds an empty voice config when none is present', async () => {
      ipcRenderer.invoke.mockResolvedValue({ available: true });
      mockManagers.state.get.mockReturnValue(undefined);
      mockOverlay.isActive.mockReturnValue(false);
      await ipcRenderer._listeners['voice:hotkey-toggle'][0]({});
      expect(mockOverlay.bindConfig).toHaveBeenCalledWith({});
    });
  });

  describe('shortcut:register-failed', () => {
    afterEach(() => { document.querySelectorAll('.toast-stack').forEach((n) => n.remove()); });

    test('shows an error toast naming the combo that could not be registered', () => {
      ipcRenderer._listeners['shortcut:register-failed'][0]({}, { shortcut: 'Alt+Shift+Space' });
      const toast = document.querySelector('.toast-error');
      expect(toast).not.toBeNull();
      expect(toast.textContent).toContain('"Alt+Shift+Space" could not be registered');
    });

    test('a malformed payload still surfaces the failure', () => {
      ipcRenderer._listeners['shortcut:register-failed'][0]({}, null);
      expect(document.querySelector('.toast-error').textContent).toContain('A global shortcut');
    });
  });

  // Real Toast singleton: clear dedup, timers and stack DOM so each test sees
  // only its own toasts.
  function resetToast() {
    const toastService = require('../../../../renderer/components/Toast');
    toastService._queue.length = 0;
    for (const rec of toastService._visible.slice()) {
      if (rec.timerId) clearTimeout(rec.timerId);
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    }
    toastService._visible.length = 0;
    toastService._lastShown.clear();
    if (toastService._container && toastService._container.parentNode) {
      toastService._container.parentNode.removeChild(toastService._container);
    }
    toastService._container = null;
  }

  describe('tab menu actions', () => {
    let errorSpy;
    beforeEach(() => { resetToast(); errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errorSpy.mockRestore(); resetToast(); });

    test('tabs:reopen-closed → spaceManager.reopenClosedTab()', () => {
      mockManagers.spaceManager.reopenClosedTab = jest.fn();
      trigger('tabs:reopen-closed');
      expect(mockManagers.spaceManager.reopenClosedTab).toHaveBeenCalledWith();
    });

    test('tabs:new-private → spaceManager.openPrivateTab() with no URL', () => {
      mockManagers.spaceManager.openPrivateTab = jest.fn();
      trigger('tabs:new-private');
      expect(mockManagers.spaceManager.openPrivateTab).toHaveBeenCalledWith();
    });

    test('a space manager without the tab action reports it instead of doing nothing', () => {
      trigger('tabs:reopen-closed');
      trigger('tabs:new-private');
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(document.querySelectorAll('.toast-error')).toHaveLength(2);
    });
  });

  describe('page print / save as PDF', () => {
    let errorSpy;
    beforeEach(() => { resetToast(); errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errorSpy.mockRestore(); resetToast(); });

    const flush = () => new Promise((r) => setTimeout(r, 0));

    test.each([
      ['page:print-active', 'page:print'],
      ['page:save-pdf-active', 'page:save-pdf'],
    ])('%s asks main to act on the active tab by webContents id', (channel, invoked) => {
      activeWebview.getWebContentsId = jest.fn(() => 31);
      ipcRenderer.invoke.mockResolvedValue(true);
      trigger(channel);
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(invoked, 31);
    });

    test('with no active page it reports instead of invoking main', () => {
      mockManagers.navigationManager.getActiveWebview.mockReturnValue(null);
      trigger('page:print-active');
      expect(ipcRenderer.invoke).not.toHaveBeenCalled();
      expect(document.querySelector('.toast-error').textContent).toContain('There is no open page to print.');
      expect(errorSpy).toHaveBeenCalled();
    });

    test('a webview that is not attached yet is reported, not thrown', () => {
      activeWebview.getWebContentsId = jest.fn(() => { throw new Error('The WebView must be attached to the DOM'); });
      expect(() => trigger('page:save-pdf-active')).not.toThrow();
      expect(ipcRenderer.invoke).not.toHaveBeenCalled();
      expect(document.querySelector('.toast-error').textContent).toContain('There is no open page to save.');
    });

    test('a rejected invoke surfaces as a toast', async () => {
      activeWebview.getWebContentsId = jest.fn(() => 31);
      ipcRenderer.invoke.mockRejectedValue(new Error('No handler registered'));
      trigger('page:print-active');
      await flush();
      expect(document.querySelector('.toast-error').textContent).toContain('No handler registered');
      expect(errorSpy).toHaveBeenCalled();
    });

    test('page:action-failed from main shows its title and message', () => {
      trigger('page:action-failed', { title: 'Save as PDF', message: 'Could not save out.pdf: EACCES.' });
      const toast = document.querySelector('.toast-error');
      expect(toast.querySelector('.toast-title').textContent).toBe('Save as PDF');
      expect(toast.textContent).toContain('Could not save out.pdf: EACCES.');
    });

    test('a malformed page:action-failed payload still shows a failure', () => {
      trigger('page:action-failed', null);
      expect(document.querySelector('.toast-error')).not.toBeNull();
    });
  });
});
