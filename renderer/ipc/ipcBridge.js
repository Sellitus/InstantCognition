const { ipcRenderer, shell } = require('electron');

/**
 * Register all renderer-side IPC listeners using existing channel names.
 * Delegates to the appropriate manager for each message.
 */
function registerAll(managers) {
  const { navigationManager, findBarManager, browserViewManager, spaceManager, state } = managers;

  // === Space selection ===
  ipcRenderer.on('select-next-space', () => spaceManager.next());
  ipcRenderer.on('select-previous-space', () => spaceManager.previous());
  ipcRenderer.on('selectSpace', (_, spaceId) => spaceManager.openTab(spaceId));

  // === Navigation (space-specific) ===
  ipcRenderer.on('navigateBackSpace', () => navigationManager.back());
  ipcRenderer.on('navigateForwardSpace', () => navigationManager.forward());
  ipcRenderer.on('navigateBackBrowser', () => navigationManager.browserBack());
  ipcRenderer.on('navigateForwardBrowser', () => navigationManager.browserForward());

  // === Navigation (active view) ===
  // Mouse 4/5 events that hit the main window get bounced here as
  // navigateBackActive/Forward. In multi-mode the cursor may be over a
  // non-focused webview, so target the *cursor* webview rather than the
  // keyboard-focused one. Refresh is treated the same way for consistency
  // (Cmd+R is its own path).
  ipcRenderer.on('navigateBackActive', () => {
    const wv = navigationManager.getCursorTargetWebview();
    if (wv && wv.goBack) wv.goBack();
  });
  ipcRenderer.on('navigateForwardActive', () => {
    const wv = navigationManager.getCursorTargetWebview();
    if (wv && wv.goForward) wv.goForward();
  });
  ipcRenderer.on('refreshActive', () => {
    const wv = navigationManager.getCursorTargetWebview();
    if (wv && wv.reload) wv.reload();
  });
  ipcRenderer.on('navigateHomeReset', () => navigationManager.home());
  ipcRenderer.on('navigateHomeActive', () => navigationManager.home());
  ipcRenderer.on('navigateHomeForWebContents', (_, webContentsId) => {
    // Find the webview whose WebContents ID matches the right-clicked one
    const webviews = /** @type {any[]} */ (Array.from(document.querySelectorAll('webview')));
    for (const wv of webviews) {
      if (wv.getWebContentsId && wv.getWebContentsId() === webContentsId) {
        navigationManager._homeReset(
          wv.id === 'browser-webview' ? 'browser' : 'space',
          wv.id
        );
        return;
      }
    }
    // Fallback if no match found
    navigationManager.home();
  });
  ipcRenderer.on('navigateHomeBrowser', () => {
    navigationManager._homeReset('browser');
  });

  // === Navigation (from preload bounce) ===
  ipcRenderer.on('navigate-back', () => {
    const wv = navigationManager.getActiveWebview();
    if (wv && wv.goBack) wv.goBack();
  });
  ipcRenderer.on('navigate-forward', () => {
    const wv = navigationManager.getActiveWebview();
    if (wv && wv.goForward) wv.goForward();
  });
  ipcRenderer.on('navigate-refresh', () => {
    const wv = navigationManager.getActiveWebview();
    if (wv && wv.reload) wv.reload();
  });
  ipcRenderer.on('navigate-home', () => navigationManager.home());

  // === Find ===
  ipcRenderer.on('toggleFindBar', () => findBarManager.toggle());
  ipcRenderer.on('findBarForward', () => findBarManager.findNext());
  ipcRenderer.on('findBarBack', () => findBarManager.findPrev());
  ipcRenderer.on('close-find-bar', () => findBarManager.close());

  // === View toggling ===
  ipcRenderer.on('toggleSpaceView', () => browserViewManager.toggleSpace());
  ipcRenderer.on('toggleBrowserView', () => browserViewManager.toggle());
  ipcRenderer.on('toggleMultiSpace', () => spaceManager.toggleMulti());
  ipcRenderer.on('toggleView', () => browserViewManager.toggleView());
  ipcRenderer.on('resetView', () => {
    browserViewManager.toggleSpace(true, false);
    browserViewManager.toggle(false, true);
    navigationManager._homeReset('browser');
    navigationManager.home();
  });
  ipcRenderer.on('closeActiveSpace', () => spaceManager.close());
  ipcRenderer.on('focusWebviewByWebContents', (_, webContentsId) => {
    const webviews = /** @type {any[]} */ (Array.from(document.querySelectorAll('webview')));
    for (const wv of webviews) {
      if (wv.getWebContentsId && wv.getWebContentsId() === webContentsId) {
        navigationManager.setActiveWebview(wv);
        return;
      }
    }
  });
  ipcRenderer.on('closeWebviewByWebContents', (_, webContentsId) => {
    const webviews = /** @type {any[]} */ (Array.from(document.querySelectorAll('webview')));
    for (const wv of webviews) {
      if (wv.getWebContentsId && wv.getWebContentsId() === webContentsId) {
        if (wv.id === 'browser-webview') {
          browserViewManager.toggle(false, true);
        } else {
          spaceManager.close(wv.id);
        }
        return;
      }
    }
    spaceManager.close();
  });
  ipcRenderer.on('closeBrowser', () => {
    browserViewManager.toggle(false, true);
    navigationManager._homeReset('browser');
  });
  ipcRenderer.on('closeActiveWebview', () => {
    const wv = navigationManager.getActiveWebview();
    if (wv) wv.style.display = 'none';
  });

  // === Zoom ===
  ipcRenderer.on('zoomInActive', () => navigationManager.zoomIn());
  ipcRenderer.on('zoomOutActive', () => navigationManager.zoomOut());
  ipcRenderer.on('zoomResetActive', () => navigationManager.zoomReset());

  // === URL handling ===
  // The URL is page-controlled (context-menu linkURL, popup targets). Only web
  // URLs may load, and only web + mailto may reach the OS: file:, smb:,
  // ms-msdt: and friends launch local programs via shell.openExternal, and
  // javascript: would run in whatever origin the browser view shows.
  ipcRenderer.on('open-url', (_, url) => {
    const openLinkExternal = state.get('openLinkExternal');
    const allowed = openLinkExternal ? /^(https?:|mailto:)/i : /^https?:/i;
    if (typeof url !== 'string' || !allowed.test(url)) {
      console.error('[ipcBridge] open-url refused a non-web URL:', String(url).slice(0, 200));
      require('../components/Toast').error('That link uses an unsupported scheme and was not opened.', { title: 'Link blocked' });
      return;
    }
    if (openLinkExternal) {
      shell.openExternal(url);
    } else {
      browserViewManager.toggle(true);
      const wv = /** @type {any} */ (document.getElementById('browser-webview'));
      if (wv) wv.loadURL(url);
    }
  });

  // target=_blank / Ctrl+click / window.open tab → open as a new in-app tab.
  // A link out of a private tab arrives as { url, private: true }.
  ipcRenderer.on('open-new-tab', (_, payload) => {
    const url = payload && typeof payload === 'object' ? payload.url : payload;
    if (!url) return;
    if (payload && payload.private) {
      // The browser webview runs in the default session, so it is no fallback here.
      if (spaceManager && typeof spaceManager.openPrivateTab === 'function') { spaceManager.openPrivateTab(url); return; }
      console.error('[ipcBridge] spaceManager.openPrivateTab is unavailable; a private link was not opened');
      require('../components/Toast').error('The link from the private tab could not open in a private tab.', { title: 'Link not opened' });
      return;
    }
    if (spaceManager && typeof spaceManager.openAdHocTab === 'function') {
      spaceManager.openAdHocTab(url);
    } else {
      browserViewManager.toggle(true);
      const wv = /** @type {any} */ (document.getElementById('browser-webview'));
      if (wv) wv.loadURL(url);
    }
  });

  // App menu tab actions (their accelerators fire even while a page has focus).
  const runTabAction = (method, label) => {
    if (spaceManager && typeof spaceManager[method] === 'function') {
      spaceManager[method]();
      return;
    }
    console.error(`[ipcBridge] spaceManager.${method} is unavailable`);
    require('../components/Toast').error(`${label} is not available right now.`);
  };
  ipcRenderer.on('tabs:reopen-closed', () => runTabAction('reopenClosedTab', 'Reopen Closed Tab'));
  ipcRenderer.on('tabs:new-private', () => runTabAction('openPrivateTab', 'New Private Tab'));

  // Print / Save as PDF from the app menu: main only knows webContents, so the
  // active tab is named by its webContents id. Failures in main come back on
  // page:action-failed.
  const reportPageFailure = (title, message) => {
    console.error(`[ipcBridge] ${title}: ${message}`);
    require('../components/Toast').error(message, { title });
  };
  const runPageAction = (channel, title, verb) => {
    const wv = /** @type {any} */ (navigationManager.getActiveWebview());
    let id = null;
    try {
      if (wv && typeof wv.getWebContentsId === 'function') id = wv.getWebContentsId();
    } catch (err) {
      console.error(`[ipcBridge] ${title}: active webview has no webContents yet:`, (err instanceof Error && err.message) || err);
    }
    if (typeof id !== 'number') {
      reportPageFailure(title, `There is no open page to ${verb}.`);
      return;
    }
    ipcRenderer.invoke(channel, id).catch((err) => {
      reportPageFailure(title, `Could not ${verb} the page: ${(err instanceof Error && err.message) || err}`);
    });
  };
  ipcRenderer.on('page:print-active', () => runPageAction('page:print', 'Print', 'print'));
  ipcRenderer.on('page:save-pdf-active', () => runPageAction('page:save-pdf', 'Save as PDF', 'save'));
  ipcRenderer.on('page:action-failed', (_, payload) => {
    const title = payload && typeof payload.title === 'string' ? payload.title : 'Page';
    const message = payload && typeof payload.message === 'string' ? payload.message : 'The page action failed.';
    require('../components/Toast').error(message, { title });
  });

  ipcRenderer.on('navigate-to-url', (_, { url: rawUrl }) => {
    let url = rawUrl;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    const wv = navigationManager.getActiveWebview();
    if (wv) wv.src = url;
  });


  // Window unhide stabilization. The user-facing symptom is "browser pages
  // shift to the right when first appearing" — Electron's show() sequence
  // (double setBounds, GPU layer reattach, and possibly a transient resize
  // event) lets the renderer paint at least one frame BEFORE final layout
  // is computed. CSS-transition suppression alone wasn't enough because
  // the shift isn't always from a transition; it's the page-area layout
  // settling.
  //
  // Strategy: hide the page content (visibility:hidden via the
  // .window-stabilizing class) the moment the window is hidden, and
  // re-show only after a few animation frames post-show — long enough
  // for layout to fully settle and the OS unhide animation to complete.
  // The chrome bar / OS frame are unaffected (visibility:hidden only
  // collapses the page-area paint; OS chrome still renders). Paired with
  // the existing .suppress-transitions guard for transition-based jank.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    let clearTimer = null;
    const arm = () => {
      if (!document.body) return;
      document.body.classList.add('window-stabilizing');
      document.body.classList.add('suppress-transitions');
      if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    };
    const release = () => {
      if (!document.body) return;
      // Wait long enough for: 2 rAFs (style/layout/paint to settle), then a
      // small fixed delay to outlast the chrome-sidebar's 220ms width
      // transition if it was inadvertently triggered. After that, allow
      // animations again — the page content reveals fully laid-out, no shift.
      const reveal = () => {
        document.body.classList.remove('window-stabilizing');
        clearTimer = setTimeout(() => {
          document.body.classList.remove('suppress-transitions');
          clearTimer = null;
        }, 240);
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(reveal));
      } else {
        clearTimer = setTimeout(reveal, 32);
      }
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') release();
      else arm();
    });
    // If the window is already hidden when scripts first run (background
    // autostart), arm immediately so the first paint is shielded too.
    if (document.visibilityState === 'hidden') arm();
  }

  // Belt-and-suspenders for compositors where visibilitychange isn't
  // dispatched on Electron app-window hide/show (some Linux setups).
  ipcRenderer.on('window-shown', () => {
    if (document && document.body) {
      document.body.classList.add('window-stabilizing');
      document.body.classList.add('suppress-transitions');
      const reveal = () => {
        document.body.classList.remove('window-stabilizing');
        setTimeout(() => document.body.classList.remove('suppress-transitions'), 240);
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(reveal));
      } else {
        setTimeout(reveal, 32);
      }
    }
    const currentId = state.get('currentSpaceId');
    if (currentId) {
      navigationManager.focusWebview(currentId);
    }
  });

  // Agent tab operations are now owned by AgentWorkspaceManager — see
  // renderer/managers/AgentWorkspaceManager.js. The ops use a separate
  // channel (`agent-workspace:tab-op`) and a separate webview container so
  // agent-opened tabs never appear in the user's foreground tab bar.

  // Voice input — global Cmd+Shift+V hotkey (registered in main) toggles
  // the VoiceCaptureOverlay. Lazy-required so this module doesn't pull
  // VoiceCaptureOverlay into the boot path before the DOM is ready.
  ipcRenderer.on('voice:hotkey-toggle', async () => {
    try {
      const overlay = require('../components/VoiceCaptureOverlay');
      const r = await ipcRenderer.invoke('voice:available');
      if (!r || !r.available) {
        // Explain the dead chord instead of doing nothing.
        require('../components/Toast').error(overlay.voiceUnavailableMessage(r), { title: 'Voice input' });
        return;
      }
      const cfg = (state.get && state.get('config')) || {};
      overlay.bindConfig((cfg.settings && cfg.settings.voice) || {});
      if (overlay.isActive()) overlay.stop(); else overlay.start({ pressToTalk: false });
    } catch (_) { /* voice unavailable */ }
  });

  // A global shortcut (app hotkey or quick launcher) that the OS or another
  // app owns. Main keeps running without it; the user needs to know why the
  // chord does nothing.
  ipcRenderer.on('shortcut:register-failed', (_, payload) => {
    const combo = payload && typeof payload.shortcut === 'string' && payload.shortcut ? payload.shortcut : 'A global shortcut';
    require('../components/Toast').error(`"${combo}" could not be registered. Another app or the system may own it; choose a different shortcut in Settings.`);
  });
}

module.exports = { registerAll };
