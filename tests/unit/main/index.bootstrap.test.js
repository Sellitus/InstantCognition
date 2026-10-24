// Drives main/index.js's real bootstrap, window-creation, webview-attach and
// app-lifecycle logic. Only the Electron runtime boundary and heavy bootstrap
// collaborators (App, ConfigService, HttpAllowlistService, logger,
// errorHandler, recovery, child_process, fs) are mocked — the orchestration
// logic under test runs for real.

const path = require('path');

let mockApp;
let mockBrowserWindow;
let mockSession;
let mockGlobalShortcut;
let mockDialog;
let mainWindowStub;
let execFileSyncMock;

jest.mock('electron', () => {
  const EventEmitter = require('events');
  const app = new EventEmitter();
  const switchValues = {};
  Object.assign(app, {
    whenReady: jest.fn(() => Promise.resolve()),
    quit: jest.fn(),
    requestSingleInstanceLock: jest.fn(() => true),
    isPackaged: false,
    getName: jest.fn(() => 'InstantCognition'),
    setName: jest.fn(),
    disableHardwareAcceleration: jest.fn(),
    setUserTasks: jest.fn(),
    // getSwitchValue backs the merge in disableChromiumFeature — appendSwitch
    // replaces a multi-value switch rather than adding to it.
    commandLine: {
      appendSwitch: jest.fn((name, value) => { switchValues[name] = value; }),
      getSwitchValue: jest.fn((name) => switchValues[name] || ''),
    },
  });
  const BrowserWindow = jest.fn();
  BrowserWindow.getAllWindows = jest.fn(() => []);
  return {
    app,
    BrowserWindow,
    autoUpdater: new EventEmitter(),
    protocol: { registerSchemesAsPrivileged: jest.fn(), handle: jest.fn() },
    session: { defaultSession: { enableNetworkEmulation: jest.fn() } },
    globalShortcut: {
      register: jest.fn(() => true),
      unregister: jest.fn(),
      isRegistered: jest.fn(() => false),
    },
    dialog: { showErrorBox: jest.fn() },
    net: { fetch: jest.fn(() => Promise.resolve(new Response('ok'))) },
    ipcMain: {
      on: jest.fn(), removeHandler: jest.fn(), _invokeHandlers: new Map(),
      handle: jest.fn(function handle(channel, fn) { this._invokeHandlers.set(channel, fn); }),
    },
  };
});

jest.mock('../../../main/App', () =>
  jest.fn().mockImplementation(() => ({
    isAppQuitting: false,
    initialize: jest.fn(),
    setupLifecycleHandlers: jest.fn(),
  }))
);
jest.mock('../../../main/services/ConfigService', () => ({
  loadConfig: jest.fn(),
  getAll: jest.fn(() => ({ state: { windowBounds: { x: 5, y: 6, width: 1000, height: 700 } }, settings: {} })),
  set: jest.fn(),
}));
jest.mock('../../../main/services/HttpAllowlistService', () => ({
  applyStartupSwitch: jest.fn(),
}));
jest.mock('../../../main/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../main/utils/errorHandler', () => ({
  initialize: jest.fn(),
  handleError: jest.fn(),
  logRendererError: jest.fn(),
}));
jest.mock('../../../main/utils/recovery', () => ({
  checkRecoveryMode: jest.fn(() => false),
  resetFailureCount: jest.fn(),
  incrementFailureCount: jest.fn(),
  createRecoveryWindow: jest.fn(),
  setupRecoveryHandlers: jest.fn(),
}));
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn(() => true) }));
jest.mock('v8', () => ({ setFlagsFromString: jest.fn() }));

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function findHandler(mockFn, eventName) {
  const call = mockFn.mock.calls.find((c) => c[0] === eventName);
  return call && call[1];
}

function makeMainWindowStub() {
  const win = {
    on: jest.fn(),
    once: jest.fn(),
    loadFile: jest.fn(() => Promise.resolve()),
    show: jest.fn(),
    hide: jest.fn(),
    focus: jest.fn(),
    setBounds: jest.fn(),
    setMaxListeners: jest.fn(),
    isMinimized: jest.fn(() => false),
    isVisible: jest.fn(() => true),
    isFocused: jest.fn(() => false),
    isDestroyed: jest.fn(() => false),
    getBounds: jest.fn(() => ({ x: 1, y: 2, width: 800, height: 600 })),
    restore: jest.fn(),
    webContents: {
      on: jest.fn(),
      once: jest.fn(),
      send: jest.fn(),
      setWindowOpenHandler: jest.fn(),
      setWebRTCIPHandlingPolicy: jest.fn(),
      setBackgroundThrottling: jest.fn(),
      invalidate: jest.fn(),
    },
  };
  return win;
}

// entry 'main.js' boots through the real entry point (single-instance lock,
// open-url registration, first-launch argv) instead of main/index.js directly.
function bootOnPlatform(platform, { argv = [], entry = 'index' } = {}) {
  const originalPlatform = process.platform;
  const originalArgv = process.argv;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  process.argv = ['node', 'main.js', ...argv];

  jest.resetModules();
  // Re-apply mocks lost by resetModules.
  jest.doMock('../../../main/App', () =>
    jest.fn().mockImplementation(() => ({ isAppQuitting: false, initialize: jest.fn(), setupLifecycleHandlers: jest.fn() }))
  );
  jest.doMock('../../../main/services/ConfigService', () => ({
    loadConfig: jest.fn(),
    getAll: jest.fn(() => ({ state: { windowBounds: { x: 5, y: 6, width: 1000, height: 700 } }, settings: {} })),
    get: jest.fn((_path, fallback) => fallback),
    set: jest.fn(),
  }));
  jest.doMock('../../../main/services/HttpAllowlistService', () => ({ applyStartupSwitch: jest.fn() }));
  jest.doMock('../../../main/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  jest.doMock('../../../main/utils/errorHandler', () => ({ initialize: jest.fn(), handleError: jest.fn(), logRendererError: jest.fn() }));
  jest.doMock('../../../main/utils/recovery', () => ({
    checkRecoveryMode: jest.fn(() => false),
    resetFailureCount: jest.fn(),
    incrementFailureCount: jest.fn(),
    createRecoveryWindow: jest.fn(),
    setupRecoveryHandlers: jest.fn(),
  }));
  jest.doMock('child_process', () => ({ execFileSync: jest.fn() }));
  jest.doMock('fs', () => ({ existsSync: jest.fn(() => true) }));
  jest.doMock('v8', () => ({ setFlagsFromString: jest.fn() }));

  const electron = require('electron');
  mockApp = electron.app;
  mockBrowserWindow = electron.BrowserWindow;
  mockSession = electron.session;
  mockGlobalShortcut = electron.globalShortcut;
  mockDialog = electron.dialog;
  execFileSyncMock = require('child_process').execFileSync;

  mainWindowStub = makeMainWindowStub();
  mockBrowserWindow.mockImplementation(() => mainWindowStub);

  // main.js installs process-wide crash loggers; keep them off the Jest worker.
  const processOn = entry === 'main.js'
    ? jest.spyOn(process, 'on').mockImplementation(/** @type {any} */ (() => process))
    : null;
  try {
    require(entry === 'main.js' ? '../../../main.js' : '../../../main/index');
  } finally {
    if (processOn) processOn.mockRestore();
  }

  return {
    restore: () => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      process.argv = originalArgv;
    },
  };
}

describe('main/index.js bootstrap', () => {
  let ctx;
  afterEach(() => { if (ctx) ctx.restore(); ctx = null; });

  describe('startup switches & platform branches', () => {
    test('non-win32 appends GPU optimization switches; does not disable HW accel', () => {
      ctx = bootOnPlatform('darwin');
      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('enable-hardware-acceleration');
      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('enable-gpu-rasterization');
      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('enable-zero-copy');
      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('ignore-gpu-blacklist');
      expect(mockApp.disableHardwareAcceleration).not.toHaveBeenCalled();
    });

    test('darwin runs the ApplePressAndHold defaults write', () => {
      ctx = bootOnPlatform('darwin');
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'defaults',
        ['write', 'InstantCognition', 'ApplePressAndHoldEnabled', '-bool', 'false'],
      );
    });

    test('darwin swallows a failing defaults write', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      jest.resetModules();
      jest.doMock('child_process', () => ({ execFileSync: jest.fn(() => { throw new Error('no defaults'); }) }));
      jest.doMock('../../../main/App', () => jest.fn().mockImplementation(() => ({ isAppQuitting: false, initialize: jest.fn(), setupLifecycleHandlers: jest.fn() })));
      jest.doMock('../../../main/services/ConfigService', () => ({ loadConfig: jest.fn(), getAll: jest.fn(() => ({ state: {}, settings: {} })), set: jest.fn() }));
      jest.doMock('../../../main/services/HttpAllowlistService', () => ({ applyStartupSwitch: jest.fn() }));
      jest.doMock('../../../main/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../../../main/utils/errorHandler', () => ({ initialize: jest.fn(), handleError: jest.fn(), logRendererError: jest.fn() }));
      jest.doMock('../../../main/utils/recovery', () => ({ checkRecoveryMode: jest.fn(() => false), resetFailureCount: jest.fn(), incrementFailureCount: jest.fn(), createRecoveryWindow: jest.fn(), setupRecoveryHandlers: jest.fn() }));
      jest.doMock('fs', () => ({ existsSync: jest.fn(() => true) }));
      jest.doMock('v8', () => ({ setFlagsFromString: jest.fn() }));
      expect(() => require('../../../main/index')).not.toThrow();
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    test('win32 disables hardware acceleration (skips GPU switches)', () => {
      ctx = bootOnPlatform('win32');
      expect(mockApp.disableHardwareAcceleration).toHaveBeenCalled();
      expect(mockApp.commandLine.appendSwitch).not.toHaveBeenCalledWith('enable-hardware-acceleration');
    });

    test('win32 honors settings.hardwareAcceleration="on" (appends GPU switches)', () => {
      // The default ConfigService mock's .get returns every fallback ('auto');
      // here it answers 'on' so the explicit override is honored on Windows.
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      jest.resetModules();
      jest.doMock('../../../main/App', () => jest.fn().mockImplementation(() => ({ isAppQuitting: false, initialize: jest.fn(), setupLifecycleHandlers: jest.fn() })));
      jest.doMock('../../../main/services/ConfigService', () => ({
        loadConfig: jest.fn(),
        getAll: jest.fn(() => ({ state: {}, settings: { hardwareAcceleration: 'on' } })),
        get: (p, d) => (p === 'settings.hardwareAcceleration' ? 'on' : d),
        set: jest.fn(),
      }));
      jest.doMock('../../../main/services/HttpAllowlistService', () => ({ applyStartupSwitch: jest.fn() }));
      jest.doMock('../../../main/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../../../main/utils/errorHandler', () => ({ initialize: jest.fn(), handleError: jest.fn(), logRendererError: jest.fn() }));
      jest.doMock('../../../main/utils/recovery', () => ({ checkRecoveryMode: jest.fn(() => false), resetFailureCount: jest.fn(), incrementFailureCount: jest.fn(), createRecoveryWindow: jest.fn(), setupRecoveryHandlers: jest.fn() }));
      jest.doMock('child_process', () => ({ execFileSync: jest.fn() }));
      jest.doMock('fs', () => ({ existsSync: jest.fn(() => true) }));
      jest.doMock('v8', () => ({ setFlagsFromString: jest.fn() }));

      const electron = require('electron');
      const app = electron.app;
      require('../../../main/index');

      expect(app.disableHardwareAcceleration).not.toHaveBeenCalled();
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-hardware-acceleration');

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    test('loads config early and applies HTTP allowlist startup switch', () => {
      ctx = bootOnPlatform('darwin');
      const cfg = require('../../../main/services/ConfigService');
      const allow = require('../../../main/services/HttpAllowlistService');
      expect(cfg.loadConfig).toHaveBeenCalled();
      expect(allow.applyStartupSwitch).toHaveBeenCalledWith(mockApp);
    });
  });

  describe('app.whenReady → window creation', () => {
    test('creates the main window with darwin alwaysOnTop and configured bounds', async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      expect(mockBrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
        x: 5, y: 6, width: 1000, height: 700, alwaysOnTop: true, show: false,
      }));
      expect(mockSession.defaultSession.enableNetworkEmulation).toHaveBeenCalledWith({ offline: false });
    });

    test('win32 main window is not alwaysOnTop', async () => {
      ctx = bootOnPlatform('win32');
      await flush();
      expect(mockBrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ alwaysOnTop: false }));
    });

    test('initializes App services and lifecycle, sets name, focuses window', async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      const App = require('../../../main/App');
      const instance = App.mock.results[0].value;
      expect(instance.initialize).toHaveBeenCalledWith(mainWindowStub, expect.any(Object));
      expect(instance.setupLifecycleHandlers).toHaveBeenCalled();
      expect(mockApp.setName).toHaveBeenCalledWith('InstantCognition');
      expect(mainWindowStub.focus).toHaveBeenCalled();
    });

    test('falls back to default bounds when config has no windowBounds', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      jest.resetModules();
      jest.doMock('../../../main/services/ConfigService', () => ({ loadConfig: jest.fn(), getAll: jest.fn(() => ({})), set: jest.fn() }));
      jest.doMock('../../../main/App', () => jest.fn().mockImplementation(() => ({ isAppQuitting: false, initialize: jest.fn(), setupLifecycleHandlers: jest.fn() })));
      jest.doMock('../../../main/services/HttpAllowlistService', () => ({ applyStartupSwitch: jest.fn() }));
      jest.doMock('../../../main/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../../../main/utils/errorHandler', () => ({ initialize: jest.fn(), handleError: jest.fn(), logRendererError: jest.fn() }));
      jest.doMock('../../../main/utils/recovery', () => ({ checkRecoveryMode: jest.fn(() => false), resetFailureCount: jest.fn(), incrementFailureCount: jest.fn(), createRecoveryWindow: jest.fn(), setupRecoveryHandlers: jest.fn() }));
      jest.doMock('child_process', () => ({ execFileSync: jest.fn() }));
      jest.doMock('fs', () => ({ existsSync: jest.fn(() => true) }));
      jest.doMock('v8', () => ({ setFlagsFromString: jest.fn() }));
      const electron = require('electron');
      const win = makeMainWindowStub();
      electron.BrowserWindow.mockImplementation(() => win);
      require('../../../main/index');
      await flush();
      expect(electron.BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ width: 1600, height: 900 }));
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    test('recovery mode short-circuits window creation', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      jest.resetModules();
      const recovery = {
        checkRecoveryMode: jest.fn(() => true),
        resetFailureCount: jest.fn(),
        incrementFailureCount: jest.fn(),
        createRecoveryWindow: jest.fn(),
        setupRecoveryHandlers: jest.fn(),
      };
      jest.doMock('../../../main/utils/recovery', () => recovery);
      jest.doMock('../../../main/App', () => jest.fn().mockImplementation(() => ({ isAppQuitting: false, initialize: jest.fn(), setupLifecycleHandlers: jest.fn() })));
      jest.doMock('../../../main/services/ConfigService', () => ({ loadConfig: jest.fn(), getAll: jest.fn(() => ({ state: {}, settings: {} })), set: jest.fn() }));
      jest.doMock('../../../main/services/HttpAllowlistService', () => ({ applyStartupSwitch: jest.fn() }));
      jest.doMock('../../../main/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../../../main/utils/errorHandler', () => ({ initialize: jest.fn(), handleError: jest.fn(), logRendererError: jest.fn() }));
      jest.doMock('child_process', () => ({ execFileSync: jest.fn() }));
      jest.doMock('fs', () => ({ existsSync: jest.fn(() => true) }));
      jest.doMock('v8', () => ({ setFlagsFromString: jest.fn() }));
      const electron = require('electron');
      electron.BrowserWindow.mockImplementation(() => makeMainWindowStub());
      require('../../../main/index');
      await flush();
      expect(recovery.createRecoveryWindow).toHaveBeenCalled();
      expect(recovery.setupRecoveryHandlers).toHaveBeenCalled();
      expect(electron.BrowserWindow).not.toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    test('window creation failure quits the app', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      jest.resetModules();
      const errorHandler = { initialize: jest.fn(), handleError: jest.fn(), logRendererError: jest.fn() };
      jest.doMock('../../../main/utils/errorHandler', () => errorHandler);
      jest.doMock('../../../main/App', () => jest.fn().mockImplementation(() => ({ isAppQuitting: false, initialize: jest.fn(), setupLifecycleHandlers: jest.fn() })));
      jest.doMock('../../../main/services/ConfigService', () => ({ loadConfig: jest.fn(), getAll: jest.fn(() => ({ state: {}, settings: {} })), set: jest.fn() }));
      jest.doMock('../../../main/services/HttpAllowlistService', () => ({ applyStartupSwitch: jest.fn() }));
      jest.doMock('../../../main/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../../../main/utils/recovery', () => ({ checkRecoveryMode: jest.fn(() => false), resetFailureCount: jest.fn(), incrementFailureCount: jest.fn(), createRecoveryWindow: jest.fn(), setupRecoveryHandlers: jest.fn() }));
      jest.doMock('child_process', () => ({ execFileSync: jest.fn() }));
      jest.doMock('fs', () => ({ existsSync: jest.fn(() => true) }));
      jest.doMock('v8', () => ({ setFlagsFromString: jest.fn() }));
      const electron = require('electron');
      electron.BrowserWindow.mockImplementation(() => { throw new Error('GPU crash'); });
      require('../../../main/index');
      await flush();
      expect(errorHandler.handleError).toHaveBeenCalledWith('Window Creation Failed', expect.any(Error), true);
      expect(electron.app.quit).toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
  });

  describe('createMainWindow wiring', () => {
    beforeEach(async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
    });

    test('close handler hides instead of quitting when not quitting', () => {
      const onClose = findHandler(mainWindowStub.on, 'close');
      const event = { preventDefault: jest.fn() };
      onClose(event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(mainWindowStub.hide).toHaveBeenCalled();
    });

    test('an update install lets the window close instead of hiding it', () => {
      const appInstance = require('../../../main/App').mock.results[0].value;
      require('electron').autoUpdater.emit('before-quit-for-update');
      const event = { preventDefault: jest.fn() };
      findHandler(mainWindowStub.on, 'close')(event);
      expect(appInstance.isAppQuitting).toBe(true);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mainWindowStub.hide).not.toHaveBeenCalled();
    });

    test('the shell window runs sandboxed, isolated and without Node behind the shell preload', () => {
      const prefs = mockBrowserWindow.mock.calls[0][0].webPreferences;
      expect(prefs).toMatchObject({
        preload: path.join(__dirname, '../../../main/preload/shell.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
      });
    });

    test('every IPC handler checks its sender: the shell window is trusted, a tab is refused', () => {
      const { ipcMain } = require('electron');
      const fn = jest.fn(() => 'ok');
      ipcMain.handle('probe:write', fn);
      const handler = ipcMain._invokeHandlers.get('probe:write');
      const top = (url) => ({ url, parent: null });
      expect(handler({ sender: mainWindowStub.webContents, senderFrame: top('file:///app/index.html') })).toBe('ok');
      const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => handler({ sender: { getType: () => 'webview' }, senderFrame: top('https://evil.example/') })).toThrow("forbidden: 'probe:write'");
      } finally { errors.mockRestore(); }
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('the artifact scheme is registered as privileged before the app is ready', () => {
      expect(require('electron').protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
        { scheme: 'ic-artifact', privileges: { standard: true, secure: true } },
      ]);
    });

    test('will-navigate keeps the shell on index.html', () => {
      const onWillNav = findHandler(mainWindowStub.webContents.on, 'will-navigate');
      const blocked = ['file:///etc/passwd', 'https://evil.example/', 'http://127.0.0.1:8080/', 'data:text/html,<script>1</script>'];
      for (const url of blocked) {
        const ev = { preventDefault: jest.fn() };
        onWillNav(ev, url);
        expect(ev.preventDefault).toHaveBeenCalled();
      }
      const indexUrl = require('url').pathToFileURL(path.join(__dirname, '../../../index.html')).href;
      const ok = { preventDefault: jest.fn() };
      onWillNav(ok, `${indexUrl}#settings`);
      expect(ok.preventDefault).not.toHaveBeenCalled();
    });

    test('will-attach-webview strips Node and pins the preload', () => {
      const onAttach = findHandler(mainWindowStub.webContents.on, 'will-attach-webview');
      const prefs = { nodeIntegration: true, contextIsolation: false, nodeIntegrationInSubFrames: true, preload: '/tmp/evil.js' };
      onAttach({}, prefs, { src: 'https://x' });
      expect(prefs).toEqual({
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../../../main/preload.js'),
      });
    });

    test('will-frame-navigate pins sub-frames to staged artifact documents but leaves the main frame alone', () => {
      const onFrameNav = findHandler(mainWindowStub.webContents.on, 'will-frame-navigate');
      for (const url of ['https://evil.example/', 'about:srcdoc', 'ic-artifact://asset/mermaid.min.js', 'ic-artifact://frame.evil/x']) {
        const escape = { isMainFrame: false, url, preventDefault: jest.fn() };
        onFrameNav(escape);
        expect(escape.preventDefault).toHaveBeenCalledTimes(1);
      }
      for (const url of [`ic-artifact://frame/${'a'.repeat(32)}`, 'about:blank']) {
        const staged = { isMainFrame: false, url, preventDefault: jest.fn() };
        onFrameNav(staged);
        expect(staged.preventDefault).not.toHaveBeenCalled();
      }
      const main = { isMainFrame: true, url: 'https://ok.com/', preventDefault: jest.fn() };
      onFrameNav(main);
      expect(main.preventDefault).not.toHaveBeenCalled();
    });

    test('the shell window keeps WebRTC off direct UDP (artifact frames cannot reach STUN/TURN over UDP)', () => {
      expect(mainWindowStub.webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
    });

    test('window open handler never opens a shell window; web links become in-app tabs', () => {
      const handler = mainWindowStub.webContents.setWindowOpenHandler.mock.calls[0][0];
      mainWindowStub.webContents.send.mockClear();
      expect(handler({ url: 'file:///x' })).toEqual({ action: 'deny' });
      expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
      expect(mainWindowStub.webContents.send).not.toHaveBeenCalledWith('open-new-tab', expect.anything());
      expect(handler({ url: 'https://x.example/' })).toEqual({ action: 'deny' });
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-new-tab', 'https://x.example/');
    });

    test('ready-to-show shows the window (wrapped show notifies renderer)', () => {
      const ready = findHandler(mainWindowStub.once, 'ready-to-show');
      ready();
      // Production replaces mainWindow.show with a wrapper that restores
      // bounds and emits window-shown — observable proxies for "shown".
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('window-shown');
    });

    test('move/resize while visible persists bounds (debounced)', () => {
      jest.useFakeTimers();
      const onMove = findHandler(mainWindowStub.on, 'move');
      const onResize = findHandler(mainWindowStub.on, 'resize');
      expect(typeof onMove).toBe('function');
      expect(typeof onResize).toBe('function');
      onMove();
      onResize();
      jest.advanceTimersByTime(150); // flush the 100ms debounce
      const cfg = require('../../../main/services/ConfigService');
      expect(cfg.set).toHaveBeenCalledWith('state.windowBounds', expect.objectContaining({
        x: 1, y: 2, width: 800, height: 600,
      }));
      jest.useRealTimers();
    });

    test('console-message at error level forwards to errorHandler', () => {
      const onConsole = findHandler(mainWindowStub.webContents.on, 'console-message');
      onConsole({}, 3, 'boom', 12, 'app.js');
      const errorHandler = require('../../../main/utils/errorHandler');
      expect(errorHandler.logRendererError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    });

    test('console-message at non-error level is ignored', () => {
      const onConsole = findHandler(mainWindowStub.webContents.on, 'console-message');
      const errorHandler = require('../../../main/utils/errorHandler');
      errorHandler.logRendererError.mockClear();
      onConsole({}, 1, 'info', 1, 'a.js');
      expect(errorHandler.logRendererError).not.toHaveBeenCalled();
    });

    test('swipe gesture sends navigation to active view', () => {
      const onSwipe = findHandler(mainWindowStub.on, 'swipe');
      onSwipe({}, 'left');
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('navigateBackActive');
      onSwipe({}, 'right');
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('navigateForwardActive');
    });

    test('before-input-event handles mouse back/forward and Cmd+[ keys', () => {
      const onInput = findHandler(mainWindowStub.webContents.on, 'before-input-event');
      onInput({}, { type: 'mouseDown', button: 'back' });
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('navigateBackActive');
      const keyEv = { preventDefault: jest.fn() };
      onInput(keyEv, { type: 'keyDown', key: '[', meta: true, control: false });
      expect(keyEv.preventDefault).toHaveBeenCalled();
    });

    test('focus registers nav shortcuts, blur unregisters', () => {
      const onFocus = findHandler(mainWindowStub.on, 'focus');
      const onBlur = findHandler(mainWindowStub.on, 'blur');
      onFocus();
      expect(mockGlobalShortcut.register).toHaveBeenCalledWith('CommandOrControl+[', expect.any(Function));
      expect(mockGlobalShortcut.register).toHaveBeenCalledWith('CommandOrControl+]', expect.any(Function));
      // invoke the registered shortcut callbacks
      const backCb = mockGlobalShortcut.register.mock.calls.find((c) => c[0] === 'CommandOrControl+[')[1];
      backCb();
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('navigateBackActive');
      onBlur();
      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('CommandOrControl+[');
      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('CommandOrControl+]');
    });

    test('show wrapper restores saved bounds and notifies renderer', () => {
      const ready = findHandler(mainWindowStub.once, 'ready-to-show');
      ready(); // captures savedBounds then calls wrapped show()
      expect(mainWindowStub.setBounds).toHaveBeenCalled();
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('window-shown');
    });
  });

  describe('did-attach-webview chain', () => {
    let webviewContents;

    beforeEach(async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      const onAttach = findHandler(mainWindowStub.webContents.on, 'did-attach-webview');
      webviewContents = {
        id: 11,
        on: jest.fn(),
        setWindowOpenHandler: jest.fn(),
        isAudioMuted: jest.fn(() => false),
        isLoading: jest.fn(() => false),
        reload: jest.fn(),
        executeJavaScript: jest.fn(() => Promise.resolve()),
      };
      onAttach(null, webviewContents);
    });

    test('webview will-navigate blocks file:', () => {
      const h = findHandler(webviewContents.on, 'will-navigate');
      const ev = { preventDefault: jest.fn() };
      h(ev, 'file:///x');
      expect(ev.preventDefault).toHaveBeenCalled();
    });

    test('audio-state-changed forwards tab audio state', () => {
      const h = findHandler(webviewContents.on, 'audio-state-changed');
      h({ audible: true });
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('tab:audio-state', expect.objectContaining({
        webContentsId: 11, audible: true, muted: false,
      }));
    });

    test('setWindowOpenHandler: real popup is allowed', () => {
      const h = webviewContents.setWindowOpenHandler.mock.calls[0][0];
      const res = h({ url: 'https://accounts.google.com', disposition: 'new-window', features: 'width=500,height=600' });
      expect(res.action).toBe('allow');
      expect(res.overrideBrowserWindowOptions.webPreferences.sandbox).toBe(true);
    });

    test('setWindowOpenHandler: file: denied', () => {
      const h = webviewContents.setWindowOpenHandler.mock.calls[0][0];
      expect(h({ url: 'file:///x', disposition: 'new-window' })).toEqual({ action: 'deny' });
    });

    test('setWindowOpenHandler: foreground-tab routes to a new in-app tab', () => {
      const h = webviewContents.setWindowOpenHandler.mock.calls[0][0];
      const res = h({ url: 'https://x.com', disposition: 'foreground-tab' });
      expect(res).toEqual({ action: 'deny' });
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-new-tab', 'https://x.com');
    });

    test('setWindowOpenHandler: other disposition falls back to open-url', () => {
      const h = webviewContents.setWindowOpenHandler.mock.calls[0][0];
      const res = h({ url: 'https://x.com', disposition: 'save-to-disk' });
      expect(res).toEqual({ action: 'deny' });
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-url', 'https://x.com');
    });

    test('open handler sends are skipped, not thrown, when the main window is destroyed', () => {
      const h = webviewContents.setWindowOpenHandler.mock.calls[0][0];
      mainWindowStub.isDestroyed.mockReturnValue(true);
      expect(() => h({ url: 'https://x.com', disposition: 'foreground-tab' })).not.toThrow();
      expect(() => h({ url: 'https://y.com', disposition: 'save-to-disk' })).not.toThrow();
      expect(mainWindowStub.webContents.send).not.toHaveBeenCalledWith('open-new-tab', 'https://x.com');
      expect(mainWindowStub.webContents.send).not.toHaveBeenCalledWith('open-url', 'https://y.com');
    });

    describe('links opened from a private tab', () => {
      const privateSession = { partition: 'private' };
      let popup;
      beforeEach(() => {
        const sessionService = require('../../../main/services/SessionService');
        sessionService._setSessionModule({ fromPartition: jest.fn(() => privateSession) });
        sessionService.initialize({});
        webviewContents.session = privateSession;
        popup = {
          isDestroyed: jest.fn(() => false), isVisible: jest.fn(() => true), show: jest.fn(),
          moveTop: jest.fn(), focus: jest.fn(), setAlwaysOnTop: jest.fn(), once: jest.fn(),
          webContents: { once: jest.fn(), on: jest.fn(), setWindowOpenHandler: jest.fn(), session: privateSession },
        };
      });
      const sentPlainTab = () => mainWindowStub.webContents.send.mock.calls
        .some(([channel, payload]) => channel === 'open-new-tab' && typeof payload === 'string');

      test.each(['foreground-tab', 'background-tab', 'new-window'])('%s opens a private tab', (disposition) => {
        const h = webviewContents.setWindowOpenHandler.mock.calls[0][0];
        expect(h({ url: 'https://x.com', disposition })).toEqual({ action: 'deny' });
        expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-new-tab', { url: 'https://x.com', private: true });
        expect(sentPlainTab()).toBe(false);
      });

      test('the open-url fallback opens a private tab, never the default-session browser view', () => {
        const h = webviewContents.setWindowOpenHandler.mock.calls[0][0];
        h({ url: 'https://x.com', disposition: 'other' });
        expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-new-tab', { url: 'https://x.com', private: true });
        expect(mainWindowStub.webContents.send).not.toHaveBeenCalledWith('open-url', expect.anything());
      });

      test('links inside a native popup a private tab opened stay private', () => {
        findHandler(webviewContents.on, 'did-create-window')(popup);
        const h = popup.webContents.setWindowOpenHandler.mock.calls[0][0];
        h({ url: 'https://y.com', disposition: 'foreground-tab' });
        h({ url: 'https://z.com', disposition: 'other' });
        expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-new-tab', { url: 'https://y.com', private: true });
        expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-new-tab', { url: 'https://z.com', private: true });
        expect(mainWindowStub.webContents.send).not.toHaveBeenCalledWith('open-url', expect.anything());
      });

      test('a default-session tab keeps sending the plain URL', () => {
        webviewContents.session = { partition: 'default' };
        popup.webContents.session = { partition: 'default' };
        const h = webviewContents.setWindowOpenHandler.mock.calls[0][0];
        h({ url: 'https://x.com', disposition: 'foreground-tab' });
        h({ url: 'https://w.com', disposition: 'other' });
        findHandler(webviewContents.on, 'did-create-window')(popup);
        popup.webContents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://y.com', disposition: 'foreground-tab' });
        expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-new-tab', 'https://x.com');
        expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-url', 'https://w.com');
        expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-new-tab', 'https://y.com');
      });
    });

    test('did-create-window raises an OAuth popup on darwin', () => {
      const onCreate = findHandler(webviewContents.on, 'did-create-window');
      const popup = {
        isDestroyed: jest.fn(() => false),
        isVisible: jest.fn(() => false),
        show: jest.fn(),
        moveTop: jest.fn(),
        focus: jest.fn(),
        setAlwaysOnTop: jest.fn(),
        once: jest.fn(),
        webContents: { once: jest.fn(), on: jest.fn(), setWindowOpenHandler: jest.fn() },
      };
      onCreate(popup);
      const raise = findHandler(popup.once, 'ready-to-show');
      raise();
      expect(popup.setAlwaysOnTop).toHaveBeenCalledWith(true, 'modal-panel');
      expect(popup.moveTop).toHaveBeenCalled();
      expect(popup.focus).toHaveBeenCalled();
    });

    test('did-fail-load with -7 reloads the contents', () => {
      const h = findHandler(webviewContents.on, 'did-fail-load');
      h({}, -7, 'TIMED_OUT', 'https://x', true);
      expect(webviewContents.reload).toHaveBeenCalled();
    });

    test('did-fail-load on main frame surfaces site-blocked popup', () => {
      const h = findHandler(webviewContents.on, 'did-fail-load');
      h({}, -106, 'NO_INTERNET', 'https://blocked.com', true);
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('site-blocked:show', expect.objectContaining({
        webContentsId: 11, url: 'https://blocked.com', errorCode: -106, httpFallback: null, httpsDowngrade: false,
      }));
    });

    test('did-fail-load ignores subframe and ERR_ABORTED', () => {
      const h = findHandler(webviewContents.on, 'did-fail-load');
      mainWindowStub.webContents.send.mockClear();
      h({}, -106, 'x', 'https://y', false); // subframe
      h({}, -3, 'aborted', 'https://y', true); // ERR_ABORTED
      h({}, -106, 'x', 'about:blank', true); // internal scheme
      expect(mainWindowStub.webContents.send).not.toHaveBeenCalledWith('site-blocked:show', expect.anything());
    });

    test('webview before-input-event navigates attached contents', () => {
      webviewContents.navigationHistory = { goBack: jest.fn(), goForward: jest.fn() };
      const h = findHandler(webviewContents.on, 'before-input-event');
      h({}, { type: 'mouseDown', button: 'back' });
      expect(webviewContents.navigationHistory.goBack).toHaveBeenCalled();
      const ev = { preventDefault: jest.fn() };
      h(ev, { type: 'keyDown', key: ']', meta: true, control: false });
      expect(ev.preventDefault).toHaveBeenCalled();
      expect(webviewContents.navigationHistory.goForward).toHaveBeenCalled();
    });

    describe('shortcut forwarding from a focused page', () => {
      const keyDown = (key, mods = {}) => ({
        type: 'keyDown', key, code: `Key${key.toUpperCase()}`, meta: false, control: false, alt: false, shift: false, ...mods,
      });
      const forwardedSends = () => mainWindowStub.webContents.send.mock.calls.filter((c) => c[0] === 'shortcut:forwarded');

      test('Cmd+E is swallowed and forwarded as view.flip; Cmd+Shift+A as panel.chat', () => {
        const h = findHandler(webviewContents.on, 'before-input-event');
        const ev = { preventDefault: jest.fn() };
        h(ev, keyDown('e', { meta: true }));
        expect(ev.preventDefault).toHaveBeenCalled();
        h({ preventDefault: jest.fn() }, keyDown('A', { meta: true, shift: true }));
        expect(forwardedSends()).toEqual([
          ['shortcut:forwarded', { action: 'view.flip' }],
          ['shortcut:forwarded', { action: 'panel.chat' }],
        ]);
      });

      test('a remapped flip chord is honored and the old one is left to the page', () => {
        const cfg = require('../../../main/services/ConfigService');
        cfg.get.mockImplementation((p, d) => (p === 'settings.shortcuts' ? { 'view.flip': { key: 'CmdOrCtrl+Alt+J' } } : d));
        const h = findHandler(webviewContents.on, 'before-input-event');
        const oldChord = { preventDefault: jest.fn() };
        h(oldChord, keyDown('e', { meta: true }));
        expect(oldChord.preventDefault).not.toHaveBeenCalled();
        // macOS Alt rewrites the key ('∆'), so the match falls back to input.code.
        h({ preventDefault: jest.fn() }, { ...keyDown('j', { meta: true, alt: true }), key: '∆' });
        expect(forwardedSends()).toEqual([['shortcut:forwarded', { action: 'view.flip' }]]);
      });

      test('a held chord is swallowed but not re-sent; unrelated keys and Ctrl+E on macOS pass through', () => {
        const h = findHandler(webviewContents.on, 'before-input-event');
        const held = { preventDefault: jest.fn() };
        h(held, { ...keyDown('e', { meta: true }), isAutoRepeat: true });
        expect(held.preventDefault).toHaveBeenCalled();
        const plain = { preventDefault: jest.fn() };
        h(plain, keyDown('e'));
        const ctrl = { preventDefault: jest.fn() };
        h(ctrl, keyDown('e', { control: true }));
        const extra = { preventDefault: jest.fn() };
        h(extra, keyDown('e', { meta: true, shift: true }));
        expect(plain.preventDefault).not.toHaveBeenCalled();
        expect(ctrl.preventDefault).not.toHaveBeenCalled();
        expect(extra.preventDefault).not.toHaveBeenCalled();
        expect(forwardedSends()).toEqual([]);
      });
    });

    test('dom-ready injects the mouse nav handler', () => {
      const h = findHandler(webviewContents.on, 'dom-ready');
      h();
      expect(webviewContents.executeJavaScript).toHaveBeenCalled();
    });
  });

  describe('app lifecycle handlers', () => {
    test('second-instance restores and focuses the window', async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      mainWindowStub.isMinimized.mockReturnValue(true);
      mainWindowStub.isVisible.mockReturnValue(false);
      mainWindowStub.isFocused.mockReturnValue(false);
      mockApp.emit('second-instance');
      expect(mainWindowStub.restore).toHaveBeenCalled();
      expect(mainWindowStub.focus).toHaveBeenCalled();
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('window-shown');
    });

    test('window-all-closed quits on non-darwin', async () => {
      ctx = bootOnPlatform('win32');
      await flush();
      mockApp.quit.mockClear();
      mockApp.emit('window-all-closed');
      expect(mockApp.quit).toHaveBeenCalled();
    });

    test('window-all-closed does not quit on darwin', async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      mockApp.quit.mockClear();
      mockApp.emit('window-all-closed');
      expect(mockApp.quit).not.toHaveBeenCalled();
    });

    test('activate recreates window when none exist', async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      mockBrowserWindow.getAllWindows.mockReturnValue([]);
      mockBrowserWindow.mockClear();
      mockApp.emit('activate');
      expect(mockBrowserWindow).toHaveBeenCalled();
    });

    test('activate shows existing window when windows exist', async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      mockBrowserWindow.getAllWindows.mockReturnValue([{}]);
      mainWindowStub.webContents.send.mockClear();
      mockApp.emit('activate');
      // Wrapped show() emits window-shown — observable proxy for show().
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('window-shown');
    });

    // Toggling throttling on a minimized (hidden) widget desyncs Chromium's
    // visibility state and blanks the window's content minutes later — see the
    // HAZARD note in services/visibilityThrottling.js. Chromium throttles
    // minimized windows on its own.
    test('browser-window-created wires no background-throttling toggles', async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      const childWin = { on: jest.fn(), webContents: { setBackgroundThrottling: jest.fn() } };
      mockApp.emit('browser-window-created', {}, childWin);

      expect(findHandler(childWin.on, 'minimize')).toBeUndefined();
      expect(findHandler(childWin.on, 'restore')).toBeUndefined();
      expect(childWin.webContents.setBackgroundThrottling).not.toHaveBeenCalled();
    });

    test('Windows disables native occlusion calculation; other platforms do not', async () => {
      ctx = bootOnPlatform('win32');
      await flush();
      expect(mockApp.commandLine.appendSwitch)
        .toHaveBeenCalledWith('disable-features', 'CalculateNativeWinOcclusion');

      mockApp.commandLine.appendSwitch.mockClear();
      ctx = bootOnPlatform('darwin');
      await flush();
      expect(mockApp.commandLine.appendSwitch)
        .not.toHaveBeenCalledWith('disable-features', expect.stringContaining('CalculateNativeWinOcclusion'));
    });

    test('show() forces a repaint so an evicted compositor surface comes back', async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      mainWindowStub.webContents.invalidate.mockClear();
      mainWindowStub.show();
      expect(mainWindowStub.webContents.invalidate).toHaveBeenCalled();
    });
  });

  describe('links handed over by other apps', () => {
    let errorSpy;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errorSpy.mockRestore(); });

    const tabSends = () => mainWindowStub.webContents.send.mock.calls.filter((c) => c[0] === 'open-new-tab');
    const shellLoaded = () => findHandler(mainWindowStub.webContents.on, 'did-finish-load')();

    test('macOS open-url before ready is queued, then opened as a tab once the shell has loaded', async () => {
      ctx = bootOnPlatform('darwin', { entry: 'main.js' });
      const event = { preventDefault: jest.fn() };
      mockApp.emit('open-url', event, 'https://mac.example/page');
      expect(event.preventDefault).toHaveBeenCalled();
      await flush();
      expect(tabSends()).toEqual([]);
      shellLoaded();
      expect(tabSends()).toEqual([['open-new-tab', 'https://mac.example/page']]);
    });

    test('open-url after the shell has loaded opens a tab and brings the window forward', async () => {
      ctx = bootOnPlatform('darwin', { entry: 'main.js' });
      await flush();
      shellLoaded();
      mainWindowStub.isVisible.mockReturnValue(false);
      mainWindowStub.webContents.send.mockClear();
      mockApp.emit('open-url', { preventDefault: jest.fn() }, 'http://live.example/');
      expect(tabSends()).toEqual([['open-new-tab', 'http://live.example/']]);
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('window-shown');
    });

    test('open-url refuses and logs a non-web scheme', async () => {
      ctx = bootOnPlatform('darwin', { entry: 'main.js' });
      await flush();
      shellLoaded();
      mockApp.emit('open-url', { preventDefault: jest.fn() }, 'javascript:alert(1)');
      mockApp.emit('open-url', { preventDefault: jest.fn() }, 'file:///etc/passwd');
      expect(tabSends()).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('refused'), 'javascript:alert(1)');
    });

    test('a URL on the first launch command line opens once the shell has loaded', async () => {
      ctx = bootOnPlatform('win32', { entry: 'main.js', argv: ['--squirrel-firstrun', 'https://first.example/'] });
      await flush();
      expect(tabSends()).toEqual([]);
      shellLoaded();
      expect(tabSends()).toEqual([['open-new-tab', 'https://first.example/']]);
    });

    test('second-instance opens only the http(s) URLs in its argv', async () => {
      ctx = bootOnPlatform('win32');
      await flush();
      shellLoaded();
      const argv = [
        'C:\\Program Files\\InstantCognition\\InstantCognition.exe',
        '--original-process-start-time=13350000000',
        'C:\\Users\\u\\Downloads\\page.html',
        'javascript:alert(1)',
        'https://second.example/a',
      ];
      mockApp.emit('second-instance', {}, argv, 'C:\\');
      expect(tabSends()).toEqual([['open-new-tab', 'https://second.example/a']]);
      expect(mainWindowStub.focus).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('refused'), 'javascript:alert(1)');
    });

    test('second-instance links that arrive before the shell loads wait for it', async () => {
      ctx = bootOnPlatform('linux');
      await flush();
      mockApp.emit('second-instance', {}, ['/opt/ic/instantcognition', 'http://early.example/'], '/home/u');
      expect(tabSends()).toEqual([]);
      shellLoaded();
      expect(tabSends()).toEqual([['open-new-tab', 'http://early.example/']]);
    });

    test('a closed main window stops delivery until the next shell load', async () => {
      ctx = bootOnPlatform('darwin', { entry: 'main.js' });
      await flush();
      shellLoaded();
      findHandler(mainWindowStub.on, 'closed')();
      mockApp.emit('open-url', { preventDefault: jest.fn() }, 'https://after-close.example/');
      expect(tabSends()).toEqual([]);
      shellLoaded();
      expect(tabSends()).toEqual([['open-new-tab', 'https://after-close.example/']]);
    });
  });

  describe('webview reload-after-timeout on window show', () => {
    let webviewContents;

    beforeEach(async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      const onAttach = findHandler(mainWindowStub.webContents.on, 'did-attach-webview');
      webviewContents = {
        id: 21,
        on: jest.fn(),
        setWindowOpenHandler: jest.fn(),
        isAudioMuted: jest.fn(() => false),
        isLoading: jest.fn(() => true),
        isDestroyed: jest.fn(() => false),
        reload: jest.fn(),
        executeJavaScript: jest.fn(() => Promise.resolve()),
      };
      onAttach(null, webviewContents);
    });

    const fireWindowEvent = (evt) => mainWindowStub.on.mock.calls
      .filter((c) => c[0] === evt)
      .forEach((c) => c[1]());

    test('-7 (TIMED_OUT) failure reloads the webview and returns early', () => {
      const onFail = findHandler(webviewContents.on, 'did-fail-load');
      mainWindowStub.webContents.send.mockClear();
      onFail({}, -7, 'TIMED_OUT', 'https://x.com', true);
      expect(webviewContents.reload).toHaveBeenCalled();
      // returns early — no site-blocked popup for the transient -7 case
      expect(mainWindowStub.webContents.send).not.toHaveBeenCalledWith('site-blocked:show', expect.anything());
    });

    test('site-blocked send failure is swallowed', () => {
      const onFail = findHandler(webviewContents.on, 'did-fail-load');
      mainWindowStub.webContents.send.mockImplementation(() => { throw new Error('renderer gone'); });
      expect(() => onFail({}, -106, 'x', 'https://x.com', true)).not.toThrow();
    });

    test('a timed-out webview is retried on the next window show, once only', () => {
      findHandler(webviewContents.on, 'did-fail-load')({}, -7, 'TIMED_OUT', 'https://x.com', true);
      webviewContents.reload.mockClear();

      fireWindowEvent('show');
      expect(webviewContents.reload).toHaveBeenCalledTimes(1);

      // The retry is one-shot: a second show must not reload a tab the user may
      // by now be reading.
      webviewContents.reload.mockClear();
      fireWindowEvent('show');
      expect(webviewContents.reload).not.toHaveBeenCalled();
    });

    test('did-start-loading clears a pending retry', () => {
      findHandler(webviewContents.on, 'did-fail-load')({}, -7, 'TIMED_OUT', 'https://x.com', true);
      findHandler(webviewContents.on, 'did-start-loading')();
      webviewContents.reload.mockClear();

      fireWindowEvent('show');
      expect(webviewContents.reload).not.toHaveBeenCalled();
    });

    test('a destroyed webview is dropped from the retry set', () => {
      findHandler(webviewContents.on, 'did-fail-load')({}, -7, 'TIMED_OUT', 'https://x.com', true);
      findHandler(webviewContents.on, 'destroyed')();
      webviewContents.reload.mockClear();

      expect(() => fireWindowEvent('show')).not.toThrow();
      expect(webviewContents.reload).not.toHaveBeenCalled();
    });

    // Regression: four mainWindow listeners were registered per attached
    // webview and never removed, so a long session leaked them and tripped the
    // max-listeners ceiling.
    test('attaching more webviews adds no per-webview window listeners', () => {
      const countShow = () => mainWindowStub.on.mock.calls.filter((c) => c[0] === 'show').length;
      const before = countShow();
      const onAttach = findHandler(mainWindowStub.webContents.on, 'did-attach-webview');

      for (const id of [41, 42, 43]) {
        onAttach(null, {
          id,
          on: jest.fn(),
          setWindowOpenHandler: jest.fn(),
          isAudioMuted: jest.fn(() => false),
          isLoading: jest.fn(() => true),
          isDestroyed: jest.fn(() => false),
          reload: jest.fn(),
          executeJavaScript: jest.fn(() => Promise.resolve()),
        });
      }

      expect(countShow()).toBe(before);
    });

    test('a crashed webview renderer reloads, bounded by the restart cap', () => {
      const onGone = findHandler(webviewContents.on, 'render-process-gone');
      expect(typeof onGone).toBe('function');

      for (let i = 0; i < 3; i += 1) onGone({}, { reason: 'crashed' });
      expect(webviewContents.reload).toHaveBeenCalledTimes(3);

      // Past the cap it gives up rather than looping on a page that always dies.
      webviewContents.reload.mockClear();
      onGone({}, { reason: 'crashed' });
      expect(webviewContents.reload).not.toHaveBeenCalled();
    });

    test('a clean renderer exit is not treated as a crash', () => {
      findHandler(webviewContents.on, 'render-process-gone')({}, { reason: 'clean-exit' });
      expect(webviewContents.reload).not.toHaveBeenCalled();
    });

    test('a successful load resets the crash budget', () => {
      const onGone = findHandler(webviewContents.on, 'render-process-gone');
      for (let i = 0; i < 3; i += 1) onGone({}, { reason: 'crashed' });

      findHandler(webviewContents.on, 'did-finish-load')();
      webviewContents.reload.mockClear();

      onGone({}, { reason: 'crashed' });
      expect(webviewContents.reload).toHaveBeenCalledTimes(1);
    });

    test('injects mouse-nav handler immediately when not loading', async () => {
      const onAttach = findHandler(mainWindowStub.webContents.on, 'did-attach-webview');
      const wc2 = {
        id: 22,
        on: jest.fn(),
        setWindowOpenHandler: jest.fn(),
        isAudioMuted: jest.fn(() => false),
        isLoading: jest.fn(() => false),
        reload: jest.fn(),
        executeJavaScript: jest.fn(() => Promise.resolve()),
      };
      onAttach(null, wc2);
      expect(wc2.executeJavaScript).toHaveBeenCalled();
    });

    test('audio-state-changed is swallowed when window is destroyed', () => {
      const onAudio = findHandler(webviewContents.on, 'audio-state-changed');
      mainWindowStub.isDestroyed.mockReturnValue(true);
      expect(() => onAudio({ audible: true })).not.toThrow();
    });
  });

  describe('nested OAuth popup chain', () => {
    test('a chained popup (OAuth → 2FA) is raised and routes correctly', async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      const onAttach = findHandler(mainWindowStub.webContents.on, 'did-attach-webview');
      const webviewContents = {
        id: 31, on: jest.fn(), setWindowOpenHandler: jest.fn(),
        isAudioMuted: jest.fn(() => false), isLoading: jest.fn(() => false),
        reload: jest.fn(), executeJavaScript: jest.fn(() => Promise.resolve()),
      };
      onAttach(null, webviewContents);

      const onCreate = findHandler(webviewContents.on, 'did-create-window');
      const popup = {
        isDestroyed: jest.fn(() => false), isVisible: jest.fn(() => true),
        show: jest.fn(), moveTop: jest.fn(), focus: jest.fn(), setAlwaysOnTop: jest.fn(),
        once: jest.fn(), webContents: { once: jest.fn(), on: jest.fn(), setWindowOpenHandler: jest.fn() },
      };
      onCreate(popup);

      // popup's own window-open handler: nested popup is allowed
      const popupOpenHandler = popup.webContents.setWindowOpenHandler.mock.calls[0][0];
      expect(popupOpenHandler({ url: 'file:///x' })).toEqual({ action: 'deny' });
      expect(popupOpenHandler({ url: 'https://2fa', disposition: 'new-window', features: 'width=400,height=500' }).action).toBe('allow');
      expect(popupOpenHandler({ url: 'https://t', disposition: 'background-tab' })).toEqual({ action: 'deny' });
      expect(popupOpenHandler({ url: 'https://s', disposition: 'save-to-disk' })).toEqual({ action: 'deny' });

      // popup will-navigate blocks file:
      const popWillNav = findHandler(popup.webContents.on, 'will-navigate');
      const ev = { preventDefault: jest.fn() };
      popWillNav(ev, 'file:///y');
      expect(ev.preventDefault).toHaveBeenCalled();

      // chained nested popup raised on darwin
      const onNested = findHandler(popup.webContents.on, 'did-create-window');
      const nested = {
        isDestroyed: jest.fn(() => false), isVisible: jest.fn(() => false),
        show: jest.fn(), moveTop: jest.fn(), focus: jest.fn(), setAlwaysOnTop: jest.fn(),
        once: jest.fn(), webContents: { once: jest.fn(), on: jest.fn(), setWindowOpenHandler: jest.fn() },
      };
      onNested(nested);
      const raiseNested = findHandler(nested.once, 'ready-to-show');
      raiseNested();
      expect(nested.show).toHaveBeenCalled();
      expect(nested.setAlwaysOnTop).toHaveBeenCalledWith(true, 'modal-panel');
      expect(nested.moveTop).toHaveBeenCalled();
      expect(nested.focus).toHaveBeenCalled();

      // The nested popup is held to the same policy, so the chain never
      // reaches a window with Electron's default open handler.
      const nestedOpen = nested.webContents.setWindowOpenHandler.mock.calls[0][0];
      expect(nestedOpen({ url: 'file:///z' })).toEqual({ action: 'deny' });
      expect(nestedOpen({ url: 'https://deeper', disposition: 'new-window', features: 'popup=yes' }).overrideBrowserWindowOptions.webPreferences)
        .toEqual({ nodeIntegration: false, contextIsolation: true, webviewTag: false, sandbox: true });
      expect(nestedOpen({ url: 'https://tab', disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
      expect(mainWindowStub.webContents.send).toHaveBeenCalledWith('open-new-tab', 'https://tab');
      const nestedNav = { preventDefault: jest.fn() };
      findHandler(nested.webContents.on, 'will-navigate')(nestedNav, 'file:///etc/passwd');
      expect(nestedNav.preventDefault).toHaveBeenCalled();
      expect(findHandler(nested.webContents.on, 'did-create-window')).toEqual(expect.any(Function));
    });

    test('popup raise is a no-op when popup already destroyed', async () => {
      ctx = bootOnPlatform('darwin');
      await flush();
      const onAttach = findHandler(mainWindowStub.webContents.on, 'did-attach-webview');
      const webviewContents = {
        id: 32, on: jest.fn(), setWindowOpenHandler: jest.fn(),
        isAudioMuted: jest.fn(() => false), isLoading: jest.fn(() => false),
        reload: jest.fn(), executeJavaScript: jest.fn(() => Promise.resolve()),
      };
      onAttach(null, webviewContents);
      const onCreate = findHandler(webviewContents.on, 'did-create-window');
      const popup = {
        isDestroyed: jest.fn(() => true), isVisible: jest.fn(() => false),
        show: jest.fn(), moveTop: jest.fn(), focus: jest.fn(), setAlwaysOnTop: jest.fn(),
        once: jest.fn(), webContents: { once: jest.fn(), on: jest.fn(), setWindowOpenHandler: jest.fn() },
      };
      onCreate(popup);
      const raise = findHandler(popup.once, 'ready-to-show');
      raise();
      expect(popup.moveTop).not.toHaveBeenCalled();
    });
  });

  describe('index.html load handling', () => {
    test('shows error box when index.html is missing', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      jest.resetModules();
      jest.doMock('fs', () => ({ existsSync: jest.fn(() => false) }));
      jest.doMock('../../../main/App', () => jest.fn().mockImplementation(() => ({ isAppQuitting: false, initialize: jest.fn(), setupLifecycleHandlers: jest.fn() })));
      jest.doMock('../../../main/services/ConfigService', () => ({ loadConfig: jest.fn(), getAll: jest.fn(() => ({ state: {}, settings: {} })), set: jest.fn() }));
      jest.doMock('../../../main/services/HttpAllowlistService', () => ({ applyStartupSwitch: jest.fn() }));
      jest.doMock('../../../main/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../../../main/utils/errorHandler', () => ({ initialize: jest.fn(), handleError: jest.fn(), logRendererError: jest.fn() }));
      jest.doMock('../../../main/utils/recovery', () => ({ checkRecoveryMode: jest.fn(() => false), resetFailureCount: jest.fn(), incrementFailureCount: jest.fn(), createRecoveryWindow: jest.fn(), setupRecoveryHandlers: jest.fn() }));
      jest.doMock('child_process', () => ({ execFileSync: jest.fn() }));
      jest.doMock('v8', () => ({ setFlagsFromString: jest.fn() }));
      const electron = require('electron');
      const win = makeMainWindowStub();
      electron.BrowserWindow.mockImplementation(() => win);
      require('../../../main/index');
      await flush();
      expect(electron.dialog.showErrorBox).toHaveBeenCalledWith('File Not Found', expect.stringContaining('index.html'));
      expect(win.loadFile).not.toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    test('handles a loadFile rejection via errorHandler', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      jest.resetModules();
      const errorHandler = { initialize: jest.fn(), handleError: jest.fn(), logRendererError: jest.fn() };
      jest.doMock('../../../main/utils/errorHandler', () => errorHandler);
      jest.doMock('fs', () => ({ existsSync: jest.fn(() => true) }));
      jest.doMock('../../../main/App', () => jest.fn().mockImplementation(() => ({ isAppQuitting: false, initialize: jest.fn(), setupLifecycleHandlers: jest.fn() })));
      jest.doMock('../../../main/services/ConfigService', () => ({ loadConfig: jest.fn(), getAll: jest.fn(() => ({ state: {}, settings: {} })), set: jest.fn() }));
      jest.doMock('../../../main/services/HttpAllowlistService', () => ({ applyStartupSwitch: jest.fn() }));
      jest.doMock('../../../main/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../../../main/utils/recovery', () => ({ checkRecoveryMode: jest.fn(() => false), resetFailureCount: jest.fn(), incrementFailureCount: jest.fn(), createRecoveryWindow: jest.fn(), setupRecoveryHandlers: jest.fn() }));
      jest.doMock('child_process', () => ({ execFileSync: jest.fn() }));
      jest.doMock('v8', () => ({ setFlagsFromString: jest.fn() }));
      const electron = require('electron');
      const win = makeMainWindowStub();
      win.loadFile = jest.fn(() => Promise.reject(new Error('disk error')));
      electron.BrowserWindow.mockImplementation(() => win);
      require('../../../main/index');
      await flush();
      expect(errorHandler.handleError).toHaveBeenCalledWith('Failed to load index.html', expect.any(Error), true);
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    test('a rejection caused by quitting is logged, not escalated to a critical dialog', async () => {
      // The load promise only settles once every guest webview does, so a quit
      // in the first seconds rejects it. Escalating that pops a modal dialog
      // which then blocks the quit itself.
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      jest.resetModules();
      const errorHandler = { initialize: jest.fn(), handleError: jest.fn(), logRendererError: jest.fn() };
      jest.doMock('../../../main/utils/errorHandler', () => errorHandler);
      jest.doMock('fs', () => ({ existsSync: jest.fn(() => true) }));
      jest.doMock('../../../main/App', () => jest.fn().mockImplementation(() => ({ isAppQuitting: true, initialize: jest.fn(), setupLifecycleHandlers: jest.fn() })));
      jest.doMock('../../../main/services/ConfigService', () => ({ loadConfig: jest.fn(), getAll: jest.fn(() => ({ state: {}, settings: {} })), set: jest.fn() }));
      jest.doMock('../../../main/services/HttpAllowlistService', () => ({ applyStartupSwitch: jest.fn() }));
      jest.doMock('../../../main/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../../../main/utils/recovery', () => ({ checkRecoveryMode: jest.fn(() => false), resetFailureCount: jest.fn(), incrementFailureCount: jest.fn(), createRecoveryWindow: jest.fn(), setupRecoveryHandlers: jest.fn() }));
      jest.doMock('child_process', () => ({ execFileSync: jest.fn() }));
      jest.doMock('v8', () => ({ setFlagsFromString: jest.fn() }));
      const electron = require('electron');
      const win = makeMainWindowStub();
      win.loadFile = jest.fn(() => Promise.reject(new Error("ERR_FAILED (-2) loading 'file:///index.html'")));
      electron.BrowserWindow.mockImplementation(() => win);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      require('../../../main/index');
      await flush();
      expect(errorHandler.handleError).not.toHaveBeenCalled();
      expect(electron.dialog.showErrorBox).not.toHaveBeenCalledWith('Load Error', expect.any(String));
      expect(warnSpy).toHaveBeenCalledWith('index.html load aborted during shutdown:', expect.stringContaining('ERR_FAILED'));
      warnSpy.mockRestore();
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
  });
});
