// Quick launcher window: a frameless, always-on-top ask box centered on the
// display under the cursor. The BrowserWindow is built on the first show and
// reused afterwards; it hides on blur and on Esc. Navigation inside it is
// refused: http(s) links an answer carries are handed to `onOpenUrl`.
const path = require('path');
const ipcSenderPolicy = require('../utils/ipcSenderPolicy');

const WIDTH = 680;
const HEIGHT = 440;
// Vertical anchor as a fraction of the work area, Spotlight-style.
const TOP_FRACTION = 0.2;
const OPAQUE_BACKGROUND = '#11151c';

/** Bounds that center the launcher horizontally on `workArea`, near its top. */
function centeredBounds(workArea) {
  const width = Math.min(WIDTH, workArea.width);
  const height = Math.min(HEIGHT, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height * TOP_FRACTION - 40)),
    width,
    height,
  };
}

/**
 * @param {{ BrowserWindow: any, getScreen: () => any, htmlPath: string, platform?: string,
 *   getTheme?: () => string, onOpenUrl?: (url: string) => void, onHide?: () => void,
 *   onError?: (err: Error) => void }} deps
 */
function createLauncherWindow(deps) {
  const { BrowserWindow, getScreen, htmlPath } = deps;
  const platform = deps.platform || process.platform;
  // Transparent windows render black when the GPU is off (the Windows
  // default here), so only macOS gets the see-through rounded card.
  const transparent = platform === 'darwin';
  const getTheme = deps.getTheme || (() => 'dark');
  const onOpenUrl = deps.onOpenUrl || (() => {});
  const onHide = deps.onHide || (() => {});
  const onError = deps.onError || ((err) => { throw err; });
  let win = null;
  let loaded = false;

  const alive = () => !!win && !win.isDestroyed();
  const sendShown = () => { if (alive()) win.webContents.send('launcher:shown', { theme: getTheme() }); };
  const routeUrl = (event, url) => {
    event.preventDefault();
    if (/^https?:\/\//i.test(String(url))) onOpenUrl(url);
  };

  function build() {
    win = new BrowserWindow({
      width: WIDTH, height: HEIGHT, show: false, frame: false, transparent,
      backgroundColor: transparent ? '#00000000' : OPAQUE_BACKGROUND,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: true, title: 'Quick Ask',
      webPreferences: {
        // Same trust model as the main window's own UI: a bundled local page
        // that reaches main only through the shell preload's bridge.
        preload: path.join(__dirname, '..', 'preload', 'shell.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false,
        nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
        webSecurity: true, allowRunningInsecureContent: false, safeDialogs: true, spellcheck: false,
      },
    });
    ipcSenderPolicy.trustShell(win.webContents);
    loaded = false;
    // Above the main window, which floats at its own always-on-top level on macOS.
    if (platform === 'darwin') {
      win.setAlwaysOnTop(true, 'pop-up-menu');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    win.on('blur', () => hide());
    win.on('closed', () => { win = null; loaded = false; });
    win.webContents.on('will-navigate', routeUrl);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(String(url))) onOpenUrl(url);
      return { action: 'deny' };
    });
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        hide();
      }
    });
    win.webContents.once('did-finish-load', () => { loaded = true; sendShown(); });
    const building = win;
    Promise.resolve(win.loadFile(htmlPath)).catch((err) => {
      // A window torn down mid-load is not a load failure.
      if (building.isDestroyed()) return;
      building.destroy();
      onError(err instanceof Error ? err : new Error(String(err)));
    });
    return win;
  }

  function show() {
    if (!alive()) build();
    const screen = getScreen();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds(centeredBounds(display.workArea));
    win.show();
    win.focus();
    if (loaded) sendShown();
  }

  function hide() {
    if (!alive() || !win.isVisible()) return;
    win.hide();
    onHide();
  }

  return {
    show,
    hide,
    toggle() {
      if (alive() && win.isVisible() && win.isFocused()) hide();
      else show();
    },
    isVisible: () => alive() && win.isVisible(),
    /** True once a BrowserWindow exists (the first show builds it). */
    isBuilt: alive,
    send(channel, payload) {
      if (alive()) win.webContents.send(channel, payload);
    },
    destroy() {
      if (alive()) win.destroy();
      win = null;
      loaded = false;
    },
  };
}

let instance = null;

/** Process-wide launcher bound to the real Electron runtime; no window until the first show. */
function getLauncherWindow(overrides = {}) {
  if (!instance) {
    const electron = require('electron');
    instance = createLauncherWindow({
      BrowserWindow: electron.BrowserWindow,
      // `screen` is unusable before app 'ready', so it is resolved per show.
      getScreen: () => require('electron').screen,
      htmlPath: path.join(__dirname, '..', '..', 'launcher.html'),
      ...overrides,
    });
  }
  return instance;
}

/** Tears down the process-wide launcher window, if one was ever built. */
function disposeLauncherWindow() {
  if (instance) instance.destroy();
  instance = null;
}

module.exports = { createLauncherWindow, getLauncherWindow, disposeLauncherWindow, centeredBounds, WIDTH, HEIGHT };
