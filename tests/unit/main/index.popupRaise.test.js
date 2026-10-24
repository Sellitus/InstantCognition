// Regression contract for the OAuth/login popup z-order fix.
//
// The main window is alwaysOnTop ('floating' macOS window level). A popup
// (Google login / OAuth) opened from a webview must be raised to a window
// level STRICTLY above the main window, or it renders behind it on macOS.
// moveTop()/focus() alone cannot lift a window above a higher window level,
// so the fix calls popupWin.setAlwaysOnTop(true, 'modal-panel') on darwin.
//
// These tests drive the real did-attach-webview -> did-create-window ->
// raise() closure in main/index.js. Only the Electron runtime boundary and
// the heavy bootstrap collaborators (App, ConfigService, logger) are mocked;
// the popup-raise logic under test runs for real.

jest.mock('electron', () => {
  const BrowserWindow = jest.fn();
  BrowserWindow.getAllWindows = jest.fn(() => []);
  return {
    app: {
      on: jest.fn(),
      whenReady: jest.fn(() => Promise.resolve()),
      quit: jest.fn(),
      exit: jest.fn(),
      relaunch: jest.fn(),
      isReady: jest.fn(() => true),
      isPackaged: false,
      getName: jest.fn(() => 'InstantCognition'),
      setName: jest.fn(),
      getPath: jest.fn((n) => `/mock/${n}`),
      getAppPath: jest.fn(() => '/mock/app'),
      setPath: jest.fn(),
      setUserTasks: jest.fn(),
      disableHardwareAcceleration: jest.fn(),
      commandLine: { appendSwitch: jest.fn(), getSwitchValue: jest.fn(() => '') },
      dock: { hide: jest.fn(), show: jest.fn() },
    },
    BrowserWindow,
    protocol: {
      registerSchemesAsPrivileged: jest.fn(),
      handle: jest.fn(),
    },
    session: {
      defaultSession: { enableNetworkEmulation: jest.fn() },
    },
    globalShortcut: {
      register: jest.fn(() => true),
      unregister: jest.fn(),
      unregisterAll: jest.fn(),
      isRegistered: jest.fn(() => false),
    },
    dialog: { showErrorBox: jest.fn(), showMessageBox: jest.fn() },
    net: { fetch: jest.fn() },
    autoUpdater: { on: jest.fn() },
    shell: { openExternal: jest.fn() },
    ipcMain: { on: jest.fn(), handle: jest.fn(), removeHandler: jest.fn() },
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
  getAll: jest.fn(() => ({ state: {}, settings: {} })),
  set: jest.fn(),
}));
jest.mock('../../../main/services/HttpAllowlistService', () => ({
  applyStartupSwitch: jest.fn(),
}));
jest.mock('../../../main/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
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
}));

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// Build a main-window stub rich enough for createMainWindow() to run through
// the did-attach-webview registration without throwing.
function makeMainWindowStub() {
  return {
    on: jest.fn(),
    once: jest.fn(),
    loadFile: jest.fn(() => Promise.resolve()),
    loadURL: jest.fn(() => Promise.resolve()),
    show: jest.fn(),
    hide: jest.fn(),
    focus: jest.fn(),
    restore: jest.fn(),
    setBounds: jest.fn(),
    setMaxListeners: jest.fn(),
    isMinimized: jest.fn(() => false),
    isVisible: jest.fn(() => false),
    isFocused: jest.fn(() => false),
    isDestroyed: jest.fn(() => false),
    getBounds: jest.fn(() => ({ x: 0, y: 0, width: 1600, height: 900 })),
    webContents: {
      on: jest.fn(),
      once: jest.fn(),
      send: jest.fn(),
      setWindowOpenHandler: jest.fn(),
      setWebRTCIPHandlingPolicy: jest.fn(),
    },
  };
}

// A popup/nested window stub. isVisible/isDestroyed are functions (real
// Electron windows expose them as methods — the raise() closure calls them).
function makePopupStub() {
  return {
    isDestroyed: jest.fn(() => false),
    isVisible: jest.fn(() => false),
    show: jest.fn(),
    moveTop: jest.fn(),
    focus: jest.fn(),
    setAlwaysOnTop: jest.fn(),
    once: jest.fn(),
    webContents: {
      once: jest.fn(),
      on: jest.fn(),
      setWindowOpenHandler: jest.fn(),
    },
  };
}

function findHandler(mockFn, eventName) {
  const call = mockFn.mock.calls.find((c) => c[0] === eventName);
  return call && call[1];
}

// Boot main/index.js on the given platform, then walk the real handler chain:
// did-attach-webview -> did-create-window -> raise (ready-to-show).
async function bootAndGetPopupRaise(platform) {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  jest.resetModules();
  const { BrowserWindow } = require('electron');
  const mainWindow = makeMainWindowStub();
  BrowserWindow.mockImplementation(() => mainWindow);

  require('../../../main/index');
  await flush();

  const didAttachWebview = findHandler(mainWindow.webContents.on, 'did-attach-webview');
  expect(typeof didAttachWebview).toBe('function');

  const webviewContents = {
    id: 1,
    on: jest.fn(),
    setWindowOpenHandler: jest.fn(),
    isAudioMuted: () => false,
    isLoading: () => true,
    reload: jest.fn(),
    executeJavaScript: jest.fn(() => Promise.resolve()),
  };
  didAttachWebview(null, webviewContents);

  const didCreateWindow = findHandler(webviewContents.on, 'did-create-window');
  expect(typeof didCreateWindow).toBe('function');

  const popup = makePopupStub();
  didCreateWindow(popup);

  const raise = findHandler(popup.once, 'ready-to-show');
  expect(typeof raise).toBe('function');

  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });

  return { popup, raise, didCreateWindow };
}

describe('main/index.js OAuth popup z-order raise', () => {
  test('on macOS, a popup is elevated above the alwaysOnTop main window', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { popup, raise } = await bootAndGetPopupRaise('darwin');

    raise();

    // 'modal-panel' is strictly above the main window's implicit 'floating'
    // level, so the popup stays in front even if the main window is
    // re-shown/focused mid-login.
    expect(popup.setAlwaysOnTop).toHaveBeenCalledWith(true, 'modal-panel');
    expect(popup.moveTop).toHaveBeenCalled();
    expect(popup.focus).toHaveBeenCalled();
  });

  test('off macOS, the popup window level is not changed (behavior unchanged)', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { popup, raise } = await bootAndGetPopupRaise('win32');

    raise();

    // Windows/Linux main window is not alwaysOnTop, so the bug does not occur
    // and the level must not be forced.
    expect(popup.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(popup.moveTop).toHaveBeenCalled();
    expect(popup.focus).toHaveBeenCalled();
  });

  test('on macOS, a chained popup (OAuth -> 2FA) is elevated the same way', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { popup } = await bootAndGetPopupRaise('darwin');

    const nestedDidCreateWindow = findHandler(popup.webContents.on, 'did-create-window');
    expect(typeof nestedDidCreateWindow).toBe('function');

    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const nested = makePopupStub();
    nestedDidCreateWindow(nested);

    const raiseNested = findHandler(nested.once, 'ready-to-show');
    expect(typeof raiseNested).toBe('function');
    raiseNested();

    expect(nested.setAlwaysOnTop).toHaveBeenCalledWith(true, 'modal-panel');
    expect(nested.moveTop).toHaveBeenCalled();
    expect(nested.focus).toHaveBeenCalled();
  });
});
