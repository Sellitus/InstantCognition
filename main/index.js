// ##### index.js — InstantCognition Main Process Bootstrap
// This file handles early initialization, window creation, and delegates
// all service/IPC logic to App.js and the services in main/services/.

console.log('[MAIN] Starting InstantCognition main process...');

// Initialize error handler first
let errorHandler;
try {
  errorHandler = require('./utils/errorHandler');
} catch (error) {
  console.error('[MAIN] Failed to load error handler:', error);
  errorHandler = null;
}

// Initialize recovery mode
let recoveryMode;
try {
  recoveryMode = require('./utils/recovery');
} catch (error) {
  console.error('[MAIN] Failed to load recovery mode:', error);
  recoveryMode = null;
}

const v8 = require('v8');
const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  protocol,
  ipcMain,
} = require('electron');

// Every IPC listener checks its sender; installed before any handler registers.
const ipcSenderPolicy = require('./utils/ipcSenderPolicy');
ipcSenderPolicy.install(ipcMain);

// Privileged schemes must be registered before app 'ready'; this file loads
// synchronously from main.js ahead of it.
require('./services/artifactFrames').registerScheme(protocol);

// macOS: enable key repeat in text inputs (disable press-and-hold accent menu)
if (process.platform === 'darwin') {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('defaults', ['write', app.getName(), 'ApplePressAndHoldEnabled', '-bool', 'false']);
  } catch (_) { /* ignore — macOS UX nicety, OK if defaults command isn't available */ }
}

const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const EventEmitter = require('events');
const fs = require('fs');

EventEmitter.defaultMaxListeners = 50;

const configService = require('./services/ConfigService');
const App = require('./App');
const logger = require('./utils/logger');
const visibilityThrottling = require('./services/visibilityThrottling');
const externalLinks = require('./services/externalLinks');
const { errMsg } = require('../shared/errMsg');
const { FRAME_ORIGIN: ARTIFACT_FRAME_ORIGIN } = require('../shared/artifactFrame');
const {
  DOM_MOUSE_BUTTONS,
  NAVIGATION_ACTIONS,
  getNavigationActionForElectronMouseButton,
  getNavigationActionForKeyInput,
  getNavigationActionForSwipe,
} = require('../shared/navigationInput');

// Process error handlers are registered in main.js (entry point) and errorHandler.js

// Override console in packaged builds so logs land in winston, not the
// terminal-less console. Use app.isPackaged (electron-builder doesn't set
// NODE_ENV) but allow --no-sandbox dev runs to keep their console.
if (app.isPackaged && !process.argv.includes('--no-sandbox')) {
  global.console.log = (...args) => logger.info(args.join(' '));
  global.console.error = (...args) => logger.error(args.join(' '));
}

// Load config early
configService.loadConfig();

// Hardware acceleration policy. 'auto' (default) keeps the legacy behavior
// (off on Windows where some drivers corrupt rendering, on elsewhere); 'on'
// forces it on; 'off' forces it off. Must run before app.ready.
const hwAccelSetting = typeof configService.get === 'function'
  ? configService.get('settings.hardwareAcceleration', 'auto')
  : 'auto';
const hwAccel = hwAccelSetting === 'on' || hwAccelSetting === 'off'
  ? hwAccelSetting
  : (process.platform === 'win32' ? 'off' : 'on');
if (hwAccel === 'off') {
  app.disableHardwareAcceleration();
} else {
  app.commandLine.appendSwitch('enable-hardware-acceleration');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('ignore-gpu-blacklist');
}

// appendSwitch('disable-features', …) REPLACES any prior value rather than
// merging, so every feature name has to go through here or the last writer
// silently wins.
function disableChromiumFeature(name) {
  const existing = app.commandLine.getSwitchValue('disable-features');
  const names = existing ? existing.split(',').filter(Boolean) : [];
  if (names.includes(name)) return;
  names.push(name);
  app.commandLine.appendSwitch('disable-features', names.join(','));
}

// Windows marks a hidden window occluded and releases its compositor surface;
// the webview panes then come back blank on unhide until the app restarts.
if (process.platform === 'win32') {
  disableChromiumFeature('CalculateNativeWinOcclusion');
}

// Whitelist HTTP origins from space URLs before app is ready
const httpAllowlistService = require('./services/HttpAllowlistService');
const browsingPrivacy = require('./services/BrowsingPrivacyService');
const sessionService = require('./services/SessionService');
httpAllowlistService.applyStartupSwitch(app);

// Windows taskbar integration
if (os.platform() === 'win32') {
  app.setUserTasks([
    {
      program: process.execPath,
      arguments: '--new-window',
      iconPath: path.join(__dirname, '../assets/icon.ico'),
      iconIndex: 0,
      title: 'InstantCognition',
      description: 'InstantCognition',
    },
  ]);
}

// Debounce utility
const debounce = (func, wait) => {
  let timeout;
  return /** @this {unknown} */ function (...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), wait);
  };
};

// Host chords forwarded to the renderer while a webview has keyboard focus:
// the guest swallows the keydown, so the renderer's document listener never
// sees it. User remaps in settings.shortcuts win over these defaults.
const FORWARDED_SHORTCUT_DEFAULTS = { 'view.flip': 'CmdOrCtrl+E', 'panel.chat': 'CmdOrCtrl+Shift+A' };

function acceleratorMatchesInput(accel, input, platform) {
  if (typeof accel !== 'string' || !accel) return false;
  const want = { meta: false, control: false, alt: false, shift: false };
  let key = null;
  for (const raw of accel.split('+')) {
    const p = raw.trim().toLowerCase();
    if (p === 'cmdorctrl' || p === 'commandorcontrol') want[platform === 'darwin' ? 'meta' : 'control'] = true;
    else if (p === 'cmd' || p === 'command' || p === 'meta' || p === 'super') want.meta = true;
    else if (p === 'ctrl' || p === 'control') want.control = true;
    else if (p === 'alt' || p === 'option') want.alt = true;
    else if (p === 'shift') want.shift = true;
    else if (p) key = p;
  }
  if (!key) return false;
  if (!!input.meta !== want.meta || !!input.control !== want.control
    || !!input.alt !== want.alt || !!input.shift !== want.shift) return false;
  const typed = String(input.key || '').toLowerCase();
  // Alt/Option rewrites input.key on macOS (Alt+E types a dead key), so the
  // physical code is the reliable source for letters and digits.
  const code = /^(?:Key|Digit)([A-Z0-9])$/.exec(String(input.code || ''));
  return typed === key || (key === 'space' && typed === ' ') || (!!code && code[1].toLowerCase() === key);
}

function forwardedShortcutFor(input, shortcuts, platform) {
  const remaps = shortcuts && typeof shortcuts === 'object' ? shortcuts : {};
  for (const [action, fallback] of Object.entries(FORWARDED_SHORTCUT_DEFAULTS)) {
    const entry = remaps[action];
    const accel = typeof entry === 'string' ? entry
      : (entry && typeof entry === 'object' && typeof entry.key === 'string' ? entry.key : fallback);
    if (acceleratorMatchesInput(accel, input, platform)) return action;
  }
  return null;
}

// --- Main Window Creation ---
let mainWindow;
const appInstance = new App();

function createMainWindow() {
  console.log('Creating main window...');
  const config = configService.getAll();
  if (!config.state) config.state = {};
  if (!config.settings) config.settings = {};

  const bounds = (config.state && config.state.windowBounds) || {
    width: 1600,
    height: 900,
  };

  const sess = require('electron').session.defaultSession;
  sess.enableNetworkEmulation({ offline: false });

  mainWindow = new BrowserWindow({
    ...bounds,
    hasShadow: false,
    fullScreenable: false,
    movable: true,
    collectionBehavior: undefined,
    alwaysOnTop: process.platform === 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'shell.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      enableRemoteModule: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      safeDialogs: true,
      // Chromium's own page-visibility path drops rAF/setInterval to idle in
      // every hidden webview — this is where the hidden-window CPU savings come
      // from, and it must stay declared here rather than pushed at runtime.
      // visibilityThrottling.js explains why re-asserting it via
      // setBackgroundThrottling on a hidden widget blanks the panes.
      backgroundThrottling: true,
      offscreen: false,
      enablePreferredSizeMode: true,
      spellcheck: false,
      enableWebSQL: false,
      v8CacheOptions: 'code',
    },
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'assets/icon.ico')
      : path.join(__dirname, '../assets/icon.ico'),
    navigateOnDragDrop: false,
    enableFileSystemAccess: false,
    show: false,
    paintWhenInitiallyHidden: false,
    backgroundColor: '#1e1e1e',
    minimizable: true,
    frame: true,
  });
  ipcSenderPolicy.trustShell(mainWindow.webContents);

  mainWindow.on('close', (event) => {
    if (!appInstance.isAppQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // The shell's IPC bridge reaches every main-process channel, so it must only
  // ever show index.html. Any other top-level navigation (a stray link, a
  // location assignment from rendered content) would hand a page that bridge.
  const shellIndexUrl = pathToFileURL(path.join(__dirname, '../index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (String(url).split(/[?#]/)[0] !== shellIndexUrl) event.preventDefault();
  });

  // The only sub-frames in the shell are sandboxed artifact iframes on
  // ic-artifact://frame/. CSP cannot stop a frame navigating itself, so pin
  // them to staged documents.
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    if (!String(event.url).startsWith(`${ARTIFACT_FRAME_ORIGIN}/`) && event.url !== 'about:blank') event.preventDefault();
  });
  // Artifact frames scrub the RTC constructors, but a frame reached through
  // window[n] before the scrub runs keeps them; no shell UI uses WebRTC, so
  // keep any ICE traffic off direct UDP.
  mainWindow.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');

  // Shell links (chat answers force target=_blank) open as in-app tabs; a bare
  // BrowserWindow would land under the floating main window on macOS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) routeToNewTab(url);
    return { action: 'deny' };
  });

  // Every guest's preload and prefs are set here, whatever the renderer's
  // attributes say, so the shell can never attach a guest with Node or a
  // foreign preload.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
  });

  mainWindow.setMaxListeners(50);

  // Preserve window position across hide/show and app restarts.
  // macOS repositions alwaysOnTop windows during show().
  // Strategy: continuously track bounds while visible (reliable),
  // then restore via setBounds both before and after show().
  let savedBounds = null;
  let isRestoring = false;

  // Save bounds to config AND in-memory on move/resize.
  // Skip during restore cycles to avoid saving macOS-repositioned values.
  const saveBoundsToConfig = debounce(() => {
    if (isRestoring || mainWindow.isMinimized()) return;
    const bounds = mainWindow.getBounds();
    configService.set('state.windowBounds', {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    });
  }, 100);

  mainWindow.on('move', () => {
    if (!isRestoring && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      savedBounds = mainWindow.getBounds();
    }
    saveBoundsToConfig();
  });
  mainWindow.on('resize', () => {
    if (!isRestoring && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      savedBounds = mainWindow.getBounds();
    }
    saveBoundsToConfig();
  });

  // Wrap show() to restore position. The isRestoring flag prevents
  // move/resize events during restoration from corrupting savedBounds.
  const originalShow = mainWindow.show.bind(mainWindow);
  mainWindow.show = () => {
    isRestoring = true;
    if (savedBounds) {
      mainWindow.setBounds(savedBounds);
    }
    originalShow();
    if (savedBounds) {
      mainWindow.setBounds(savedBounds);
    }
    isRestoring = false;
    // Force a full repaint of the window. Chromium can evict a long-hidden
    // window's compositor frames, which is what leaves the webview panes blank
    // on unhide; this is the API form of the "nudge the window and it comes
    // back" workaround.
    try { mainWindow.webContents.invalidate(); } catch (_) { /* window may be tearing down */ }
    mainWindow.webContents.send('window-shown');
  };

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    savedBounds = mainWindow.getBounds();
    mainWindow.show();
    setTimeout(() => {
      if (mainWindow.isVisible() && recoveryMode) {
        recoveryMode.resetFailureCount();
      }
    }, 5000);
  });

  // Log renderer errors
  mainWindow.webContents.on('console-message', (_, level, message, line, sourceId) => {
    if (level === 3 && errorHandler && errorHandler.logRendererError) {
      errorHandler.logRendererError({ message, source: `${sourceId}:${line}`, level: 'error' });
    }
  });

  const sendNavigationToActiveView = (action) => {
    if (action === NAVIGATION_ACTIONS.BACK) {
      mainWindow.webContents.send('navigateBackActive');
    } else if (action === NAVIGATION_ACTIONS.FORWARD) {
      mainWindow.webContents.send('navigateForwardActive');
    }
  };

  const navigateAttachedWebContents = (contents, action) => {
    if (action === NAVIGATION_ACTIONS.BACK) {
      contents.navigationHistory.goBack();
    } else if (action === NAVIGATION_ACTIONS.FORWARD) {
      contents.navigationHistory.goForward();
    }
  };

  // macOS swipe gesture support (some mice trigger swipe events)
  mainWindow.on('swipe', (_, direction) => {
    sendNavigationToActiveView(getNavigationActionForSwipe(direction));
  });

  // Mouse/keyboard back/forward support (main window — fallback when no webview has focus)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'mouseDown' && 'button' in input) {
      sendNavigationToActiveView(getNavigationActionForElectronMouseButton(input.button));
    }
    // Cmd+[ / Cmd+] (Logitech and macOS standard back/forward)
    if (input.type === 'keyDown') {
      const action = getNavigationActionForKeyInput(input);
      if (action) {
        event.preventDefault();
        sendNavigationToActiveView(action);
      }
    }
  });

  // Global shortcut for Cmd+[/Cmd+] — catches keystrokes at the system level.
  // This is the most aggressive approach: intercepts before any view processing.
  // Registered only while the window is focused to avoid interfering with other apps.
  const registerNavShortcuts = () => {
    if (!globalShortcut.isRegistered('CommandOrControl+[')) {
      // A false return means another app owns the combo; the menu
      // accelerator + before-input-event paths still work, so log and move on.
      const ok = globalShortcut.register('CommandOrControl+[', () => {
        sendNavigationToActiveView(NAVIGATION_ACTIONS.BACK);
      });
      if (!ok) console.warn('[NAV] Failed to register global CommandOrControl+[ shortcut');
    }
    if (!globalShortcut.isRegistered('CommandOrControl+]')) {
      const ok = globalShortcut.register('CommandOrControl+]', () => {
        sendNavigationToActiveView(NAVIGATION_ACTIONS.FORWARD);
      });
      if (!ok) console.warn('[NAV] Failed to register global CommandOrControl+] shortcut');
    }
  };
  const unregisterNavShortcuts = () => {
    globalShortcut.unregister('CommandOrControl+[');
    globalShortcut.unregister('CommandOrControl+]');
  };
  mainWindow.on('focus', registerNavShortcuts);
  mainWindow.on('blur', unregisterNavShortcuts);
  if (mainWindow.isFocused()) registerNavShortcuts();

  // Popup detection: window.open() with explicit width/height (or popup=yes) is
  // treated as a real popup window (OAuth flows rely on this). Everything else
  // is routed to an in-app tab so target=_blank / Ctrl+click act like a browser.
  function looksLikePopup(features) {
    if (!features) return false;
    return /\b(?:width|height|popup)\s*=/i.test(features);
  }

  // Popup-path sends can fire after the main window's contents are destroyed
  // (a webview's setWindowOpenHandler outlives the window); guard the same
  // way the other send sites in this file do.
  const sendToMainWindow = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  function routeToNewTab(url) {
    sendToMainWindow('open-new-tab', url);
  }

  // A link out of a private tab (or a popup it opened) must stay in the
  // in-memory session: a normal tab or the browser view would send its
  // default-session cookies and record it in config and history.
  function routeGuestLink(opener, url, disposition) {
    if (sessionService.isPrivateContents(opener)) {
      sendToMainWindow('open-new-tab', { url, private: true });
    } else if (disposition === 'foreground-tab' || disposition === 'background-tab' || disposition === 'new-window') {
      routeToNewTab(url);
    } else {
      // save-to-disk / other: the browser view pane or the system browser,
      // per the openLinkExternal setting.
      sendToMainWindow('open-url', url);
    }
  }

  // window.open from a page or a popup it opened, at any depth. A real popup
  // (OAuth, auth widgets) opens natively so window.opener and postMessage work,
  // inheriting the opener's session as OAuth requires; everything else becomes
  // an in-app tab, and file: is never reachable.
  /** @returns {(details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse} */
  function guestWindowOpenHandler(opener) {
    return ({ url, disposition, features }) => {
      if (url && url.startsWith('file:')) return { action: 'deny' };
      if (disposition === 'new-window' && looksLikePopup(features)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: { nodeIntegration: false, contextIsolation: true, webviewTag: false, sandbox: true },
          },
        };
      }
      routeGuestLink(opener, url, disposition);
      return { action: 'deny' };
    };
  }

  // Every popup gets the opener's policy, so a popup's own popups (OAuth ->
  // 2FA provider) are held to the same rules however deep the chain goes.
  function secureGuestWindow(popupWin) {
    // Electron's window.open does not always bring the new window forward; on
    // macOS the main window is alwaysOnTop at 'floating', so only a strictly
    // higher level keeps a login popup above it.
    const raise = () => {
      try {
        if (popupWin.isDestroyed && popupWin.isDestroyed()) return;
        if (!popupWin.isVisible()) popupWin.show();
        if (process.platform === 'darwin') popupWin.setAlwaysOnTop(true, 'modal-panel');
        popupWin.moveTop();
        popupWin.focus();
      } catch (err) { console.error('[main] could not raise a pop-up window:', errMsg(err)); }
    };
    popupWin.once('ready-to-show', raise);
    // Some providers never emit ready-to-show before the first paint finishes.
    popupWin.webContents.once('did-finish-load', raise);
    const popupContents = popupWin.webContents;
    popupContents.on('will-navigate', (event, url) => {
      if (url && url.startsWith('file:')) event.preventDefault();
    });
    popupContents.setWindowOpenHandler(guestWindowOpenHandler(popupContents));
    popupContents.on('did-create-window', secureGuestWindow);
  }

  // Links from other apps wait in externalLinks until the renderer's IPC
  // bridge is listening; a send before then is dropped.
  mainWindow.webContents.on('did-finish-load', () => {
    externalLinks.attach((url) => {
      routeToNewTab(url);
      revealMainWindow();
    });
  });
  mainWindow.on('closed', () => externalLinks.detach());

  // Webviews that hit ERR_TIMED_OUT and still owe a retry. One shared set plus
  // one set of window listeners serves every tab: registering four mainWindow
  // listeners per attached webview leaked them (nothing removed them on tab
  // close) and walked into the max-listeners ceiling on long sessions.
  const timedOutContents = new Set();
  const retryTimedOutContents = () => {
    if (timedOutContents.size === 0) return;
    const pending = [...timedOutContents];
    timedOutContents.clear();
    for (const wc of pending) {
      try { if (!wc.isDestroyed()) wc.reload(); } catch (_) { /* race on destroy */ }
    }
  };
  ['show', 'focus', 'restore', 'hide'].forEach((event) => {
    mainWindow.on(event, retryTimedOutContents);
  });

  // Bounds the reload loop when a guest crashes repeatedly on the same page.
  const MAX_RENDERER_RESTARTS = 3;
  const rendererRestarts = new WeakMap();

  // Webview attach handler — link routing and file-access guard.
  mainWindow.webContents.on('did-attach-webview', (_, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (url.startsWith('file:')) event.preventDefault();
    });

    contents.on('audio-state-changed', (event) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tab:audio-state', {
            webContentsId: contents.id,
            audible: !!event.audible,
            muted: typeof contents.isAudioMuted === 'function' ? contents.isAudioMuted() : false,
          });
        }
      } catch (_) { /* ignore */ }
    });

    contents.setWindowOpenHandler(guestWindowOpenHandler(contents));
    contents.on('did-create-window', secureGuestWindow);

    // Mouse and keyboard back/forward support for webviews.
    // No canGoBack()/canGoForward() guards — these return false for SPA pushState
    // navigations even though history.back() would succeed. goBack()/goForward()
    // already no-op gracefully when there's truly no history.
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'mouseDown' && 'button' in input) {
        const action = getNavigationActionForElectronMouseButton(input.button);
        if (action) navigateAttachedWebContents(contents, action);
      }
      if (input.type === 'keyDown') {
        const forwarded = forwardedShortcutFor(input, configService.get('settings.shortcuts', {}), process.platform);
        if (forwarded) {
          event.preventDefault();
          // A held chord would flip the layout on every repeat.
          if (!input.isAutoRepeat) sendToMainWindow('shortcut:forwarded', { action: forwarded });
          return;
        }
        const action = getNavigationActionForKeyInput(input);
        if (action) {
          event.preventDefault();
          navigateAttachedWebContents(contents, action);
        }
      }
    });

    // Inject mouse back/forward handler into the webview's main world.
    // This is needed because on macOS, mouse button events may not reach
    // the preload's isolated world. Injecting into the main world ensures
    // the handler runs even if contextIsolation blocks preload listeners.
    const injectMouseNavHandler = () => {
      contents.executeJavaScript(`
        if (!window.__icMouseNav) {
          window.__icMouseNav = true;
          window.addEventListener('pointerdown', function(e) {
            if (e.button === ${DOM_MOUSE_BUTTONS.BACK}) { e.preventDefault(); history.back(); }
            else if (e.button === ${DOM_MOUSE_BUTTONS.FORWARD}) { e.preventDefault(); history.forward(); }
          }, true);
          window.addEventListener('mousedown', function(e) {
            if (e.button === ${DOM_MOUSE_BUTTONS.BACK}) { history.back(); }
            else if (e.button === ${DOM_MOUSE_BUTTONS.FORWARD}) { history.forward(); }
          }, true);
        }
      `).catch(() => { /* ignore — injected handler is best-effort; main nav still works without it */ });
    };
    contents.on('dom-ready', injectMouseNavHandler);
    if (!contents.isLoading()) injectMouseNavHandler();

    contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (errorCode === -7) {
        contents.reload();
        // Mark the timeout so the next window show/focus/restore reloads again
        // in case the immediate reload failed silently (offline, captive portal,
        // hung DNS). Cleared on did-start-loading.
        timedOutContents.add(contents);
        return;
      }
      // Anything else on the MAIN frame surfaces a "site blocked / can't load"
      // popup so the user can choose to retry or allowlist the site. We skip
      // ERR_ABORTED (-3) — that fires when the user navigates away mid-load,
      // and showing a popup in that case would be noise.
      if (!isMainFrame) return;
      if (errorCode === -3) return;
      if (!validatedURL || /^(about:|chrome:|devtools:|ic:|data:|file:)/i.test(validatedURL)) return;
      if (browsingPrivacy.isUpgradeCancel(contents, validatedURL)) return;
      try {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send('site-blocked:show', {
            webContentsId: contents.id,
            url: validatedURL,
            errorCode,
            errorDescription: errorDescription || '',
            httpFallback: browsingPrivacy.httpFallbackFor(contents, validatedURL),
            httpsDowngrade: browsingPrivacy.isDowngradeCancel(contents, validatedURL),
          });
        }
      } catch (_) { /* renderer may not be ready yet */ }
    });

    // A crashed or OOM-killed guest renderer otherwise leaves the pane blank
    // until the whole app restarts — the app-level handler in errorHandler only
    // logs it.
    contents.on('render-process-gone', (_e, details) => {
      const reason = (details && details.reason) || 'unknown';
      if (reason === 'clean-exit') return;
      const attempts = (rendererRestarts.get(contents) || 0) + 1;
      rendererRestarts.set(contents, attempts);
      if (attempts > MAX_RENDERER_RESTARTS) {
        console.error(`Webview renderer gone (${reason}); giving up after ${MAX_RENDERER_RESTARTS} reloads`);
        return;
      }
      console.error(`Webview renderer gone (${reason}); reloading (attempt ${attempts})`);
      try { if (!contents.isDestroyed()) contents.reload(); } catch (_) { /* race on destroy */ }
    });

    contents.on('did-finish-load', () => {
      rendererRestarts.delete(contents);
    });

    contents.on('did-start-loading', () => {
      timedOutContents.delete(contents);
    });

    contents.on('destroyed', () => {
      timedOutContents.delete(contents);
    });
  });

  // Load the app HTML
  const htmlPath = path.join(__dirname, '../index.html');
  if (!fs.existsSync(htmlPath)) {
    dialog.showErrorBox('File Not Found', `Cannot find index.html at: ${htmlPath}`);
  } else {
    // This promise stays pending until every guest <webview> settles, which for
    // a streaming site can be minutes. Quitting inside that window rejects it
    // with ERR_FAILED/ERR_ABORTED — teardown, not a load failure. Escalating it
    // pops a modal error dialog that then blocks the very quit that caused it
    // (observed hanging shutdown for ~30s and segfaulting).
    const loadingWindow = mainWindow;
    mainWindow.loadFile(htmlPath).catch((error) => {
      if (appInstance.isAppQuitting || !loadingWindow || loadingWindow.isDestroyed()) {
        console.warn('index.html load aborted during shutdown:', (error instanceof Error && error.message) || error);
        return;
      }
      if (errorHandler && errorHandler.handleError) {
        errorHandler.handleError('Failed to load index.html', error, true);
      } else {
        dialog.showErrorBox('Load Error', `Failed to load index.html: ${error.message}`);
      }
    });
  }
}

// Single instance lock is handled in main.js (entry point)

// --- App Ready ---
app.whenReady().then(async () => {
  // Recovery mode check
  if (recoveryMode && recoveryMode.checkRecoveryMode()) {
    console.log('Starting in recovery mode...');
    recoveryMode.createRecoveryWindow();
    recoveryMode.setupRecoveryHandlers();
    return;
  }

  // Initialize error logging
  try {
    if (errorHandler) errorHandler.initialize();
  } catch (error) {
    console.error('Failed to initialize error handler:', error);
  }

  // V8 optimization
  v8.setFlagsFromString('--max-old-space-size=4096');
  v8.setFlagsFromString('--optimize-for-size');

  // Create the main window
  try {
    createMainWindow();
  } catch (error) {
    console.error('Failed to create main window:', error);
    if (recoveryMode) recoveryMode.incrementFailureCount();
    if (errorHandler && errorHandler.handleError) {
      errorHandler.handleError('Window Creation Failed', error, true);
    } else {
      dialog.showErrorBox('Window Creation Error', `Failed to create window: ${error instanceof Error ? error.message : String(error)}`);
    }
    appInstance.isAppQuitting = true;
    app.quit();
    return;
  }

  // Initialize all services and IPC handlers via App
  appInstance.initialize(mainWindow, { errorHandler, recoveryMode });
  appInstance.setupLifecycleHandlers();

  // Background-throttling policy: throttle every webContents while the window
  // is hidden (frees CPU/GPU for foreground workloads), but lift throttling
  // during an active agent run so LLM streaming and executeJavaScript keep working.
  try {
    const { session } = require('electron');
    const agentService = require('./services/AgentService');
    visibilityThrottling.bind({ mainWindow, session: session && session.defaultSession, agentService });

    // Park heavyweight background work while the window is hidden. The
    // pub-sub is gated by the same agent-active override that controls
    // backgroundThrottling, so an in-flight agent run keeps its engine.
    // Hooks may run when no engine is loaded — the service methods are no-ops
    // in that case; we surface unexpected errors instead of swallowing them.
    try {
      const llmService = require('./services/LLMService');
      visibilityThrottling.onSuspend(() => {
        try { llmService.pauseForVisibility(); }
        catch (err) { console.error('LLM pauseForVisibility failed:', errMsg(err)); }
      });
      visibilityThrottling.onResume(() => {
        llmService.resumeFromVisibility().catch((err) => console.error('LLM resumeFromVisibility failed:', errMsg(err)));
      });
    } catch (err) { console.error('Failed to bind LLM visibility hooks:', err instanceof Error ? err.message : err); }

    try {
      const mcpService = require('./services/McpService');
      visibilityThrottling.onSuspend(() => {
        mcpService.pauseForVisibility().catch((err) => console.error('MCP pauseForVisibility failed:', errMsg(err)));
      });
      visibilityThrottling.onResume(() => {
        mcpService.resumeFromVisibility().catch((err) => console.error('MCP resumeFromVisibility failed:', errMsg(err)));
      });
    } catch (err) { console.error('Failed to bind MCP visibility hooks:', err instanceof Error ? err.message : err); }
  } catch (err) {
    console.error('Failed to bind visibility throttling:', err instanceof Error ? err.message : err);
  }

  app.setName('InstantCognition');
  mainWindow.focus();
});

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  if (!mainWindow.isFocused()) mainWindow.focus();
  mainWindow.webContents.send('window-shown');
}

// --- App Lifecycle ---
app.on('second-instance', (_event, argv) => {
  revealMainWindow();
  externalLinks.openFromArgv(argv, 'second instance');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    appInstance.isAppQuitting = true;
    app.quit();
  }
});

// Squirrel.Mac's quitAndInstall closes every window before app 'before-quit'
// fires; without the flag the close handler hides the window and cancels the
// quit, so a downloaded update never installs.
if (process.platform === 'darwin') {
  require('electron').autoUpdater.on('before-quit-for-update', () => {
    appInstance.isAppQuitting = true;
  });
}

app.on('will-quit', () => {
  try { visibilityThrottling.dispose(); } catch (err) { console.error('visibilityThrottling dispose failed:', err instanceof Error ? err.message : err); }
  // The quick launcher window is built lazily by its hotkey (ipc/launcherHandlers).
  try { require('./launcher/launcherWindow').disposeLauncherWindow(); } catch (err) { console.error('launcher dispose failed:', err instanceof Error ? err.message : err); }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
    appInstance.initialize(mainWindow, { errorHandler, recoveryMode });
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  }
});

// Chromium throttles minimized windows on its own. Toggling
// setBackgroundThrottling here would only desync its visibility state — see the
// HAZARD note in services/visibilityThrottling.js.
