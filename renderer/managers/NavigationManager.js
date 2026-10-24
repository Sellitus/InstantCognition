const { PRIVATE_PARTITION } = require('../utils/historyRecorder');

class NavigationManager {
  constructor(state) {
    this.state = state;
    this._lastActiveWebview = null;
    this._findBarManager = null;
    this._hoveredWebview = null;
    this._wireHoverTracking();
  }

  setFindBarManager(findBarManager) {
    this._findBarManager = findBarManager;
  }

  // Hover tracking — multi-mode shows several webviews at once. Mouse 4/5 must
  // navigate the *hovered* tab, not the keyboard-focused one. The cursor only
  // generates host-level mouseover events at the wrapper boundary because
  // `<webview>` is a single hit-target from the host page's POV; that's all we
  // need to know which wrapper the cursor is over right now.
  _wireHoverTracking() {
    if (typeof document === 'undefined') return;
    document.addEventListener('mouseover', (e) => {
      const tgt = /** @type {HTMLElement} */ (e.target);
      const wrapper = tgt && tgt.closest && tgt.closest('.space-webview-wrapper');
      if (!wrapper) { this._hoveredWebview = null; return; }
      const wv = /** @type {import('electron').WebviewTag | null} */ (wrapper.querySelector('webview'));
      this._hoveredWebview = wv && wv.isConnected ? wv : null;
    }, true);
    document.addEventListener('mouseleave', (e) => {
      if (e.target === document.documentElement) this._hoveredWebview = null;
    }, true);
  }

  getHoveredWebview() {
    return this._hoveredWebview && this._hoveredWebview.isConnected ? this._hoveredWebview : null;
  }

  // For mouse-driven nav (mouse 4/5, scroll-wheel back/forward) — prefer the
  // tab the cursor is on. Falls back to the focused tab when the cursor is
  // outside any webview (e.g. over the tab bar).
  getCursorTargetWebview() {
    return this.getHoveredWebview() || this.getActiveWebview();
  }

  getActiveWebview() {
    if (this._lastActiveWebview && this._lastActiveWebview.isConnected) {
      return this._lastActiveWebview;
    }
    this._lastActiveWebview = null;

    const currentId = this.state.get('currentSpaceId');
    if (currentId) {
      const wv = document.getElementById(currentId);
      if (wv) return wv;
    }
    return document.getElementById('browser-webview');
  }

  setActiveWebview(webview) {
    this._lastActiveWebview = webview;
  }

  back() {
    const wv = this.getActiveWebview();
    if (wv && wv.canGoBack && wv.canGoBack()) {
      wv.goBack();
    }
    if (wv) this.focusWebview(wv.id);
  }

  forward() {
    const wv = this.getActiveWebview();
    if (wv && wv.canGoForward && wv.canGoForward()) {
      wv.goForward();
    }
    if (wv) this.focusWebview(wv.id);
  }

  refresh() {
    const wv = this.getActiveWebview();
    if (wv && wv.reload) {
      wv.reload();
    }
    if (wv) this.focusWebview(wv.id);
  }

  home() {
    const wv = this.getActiveWebview();
    if (!wv) return;

    const spaceId = wv.id;

    if (spaceId === 'browser-webview') {
      this._homeReset('browser');
    } else {
      this._homeReset('space', spaceId);
    }
  }

  browserBack() {
    const wv = /** @type {any} */ (document.getElementById('browser-webview'));
    if (wv && wv.canGoBack && wv.canGoBack()) wv.goBack();
    this.focusWebview('browser-webview');
  }

  browserForward() {
    const wv = /** @type {any} */ (document.getElementById('browser-webview'));
    if (wv && wv.canGoForward && wv.canGoForward()) wv.goForward();
    this.focusWebview('browser-webview');
  }

  zoomIn() {
    const wv = this.getActiveWebview();
    if (wv && wv.setZoomLevel) {
      wv.setZoomLevel((wv.getZoomLevel() || 0) + 0.5);
      this._saveZoomLevel(wv);
    }
  }

  zoomOut() {
    const wv = this.getActiveWebview();
    if (wv && wv.setZoomLevel) {
      wv.setZoomLevel((wv.getZoomLevel() || 0) - 0.5);
      this._saveZoomLevel(wv);
    }
  }

  zoomReset() {
    const wv = this.getActiveWebview();
    if (wv && wv.setZoomLevel) {
      wv.setZoomLevel(0);
      this._saveZoomLevel(wv);
    }
  }

  _saveZoomLevel(wv) {
    if (!wv || !wv.id || wv.id === 'browser-webview') return;
    if (wv.getAttribute('partition') === PRIVATE_PARTITION) return;
    const config = this.state.get('config');
    if (!config || !config.settings || !config.settings.persistZoomLevels) return;
    if (!config.state) config.state = {};
    if (!config.state.zoomLevels) config.state.zoomLevels = {};
    config.state.zoomLevels[wv.id] = wv.getZoomLevel();
    if (window.saveSettings) window.saveSettings(config);
  }

  restoreZoomLevel(webview) {
    if (!webview || !webview.id || webview.id === 'browser-webview') return;
    const config = this.state.get('config');
    if (!config || !config.settings || !config.settings.persistZoomLevels) return;
    if (!config.state || !config.state.zoomLevels) return;
    const level = config.state.zoomLevels[webview.id];
    if (level !== undefined && webview.setZoomLevel) {
      webview.setZoomLevel(level);
    }
  }

  focusWebview(webviewId) {
    if (!webviewId) return;
    const wv = /** @type {any} */ (document.getElementById(webviewId));
    if (!wv) return;

    try {
      wv.focus();
    } catch (err) {
      // Focus is best-effort and runs from many event paths; a detached
      // webview throws here, which must not abort the caller.
      console.warn('[NavigationManager] could not focus webview:', err);
      return;
    }
    const attemptFocus = () => {
      if (!wv.executeJavaScript) return;
      // Rejects when the page navigates mid-call; focus is best-effort, so warn.
      wv.executeJavaScript(`
        (function() {
          const ta = document.querySelector('textarea, [contenteditable="true"], input[type="text"]');
          if (ta) ta.focus();
        })();
      `).catch((err) => console.warn('[NavigationManager] could not focus the page input:', err));
    };

    if (wv.isReady && wv.isReady()) {
      attemptFocus();
    } else {
      wv.addEventListener('dom-ready', () => attemptFocus(), { once: true });
    }
  }

  _homeReset(type, spaceId) {
    if (this._findBarManager) this._findBarManager.close();
    const config = this.state.get('config');

    // Close find bar before replacing webview to avoid stale references
    if (this._findBarManager) {
      this._findBarManager.close();
    }

    if (type === 'browser') {
      const homeUrl = config && config.settings ? config.settings.browserHomeUrl : 'https://www.google.com/';
      const container = document.getElementById('browser-container');
      if (!container) return;
      const oldWv = container.querySelector('.web-browser');
      const newWv = document.createElement('webview');
      newWv.id = 'browser-webview';
      newWv.classList.add('web-browser');
      // The partition is fixed by the first navigation, so it precedes src.
      const partition = oldWv && oldWv.getAttribute('partition');
      if (partition) newWv.setAttribute('partition', partition);
      newWv.src = homeUrl;
      newWv.setAttribute('allowpopups', '');

      if (oldWv) {
        container.replaceChild(newWv, oldWv);
      } else {
        container.appendChild(newWv);
      }
      this.focusWebview('browser-webview');
      if (window._wireWebviewEvents) window._wireWebviewEvents(newWv);
      this._lastActiveWebview = newWv;
    } else if (type === 'space' && spaceId) {
      const space = (config && config.spaces && config.spaces[spaceId])
        || (this.state.get('adHocSpaces') || {})[spaceId];
      const url = space ? space.url : 'https://www.google.com/';

      const container = document.getElementById('space-container');
      if (!container) return;
      const oldWv = document.getElementById(spaceId);
      const newWv = document.createElement('webview');
      newWv.id = spaceId;
      newWv.classList.add('space-browser', 'active');
      const partition = (oldWv && oldWv.getAttribute('partition'))
        || (space && space.private ? PRIVATE_PARTITION : null);
      if (partition) newWv.setAttribute('partition', partition);
      newWv.src = url;
      newWv.setAttribute('allowpopups', '');

      if (oldWv) {
        const wrapper = oldWv.closest('.space-webview-wrapper');
        if (wrapper) {
          wrapper.replaceChild(newWv, oldWv);
        }
      } else {
        const wrapper = document.createElement('div');
        wrapper.className = 'space-webview-wrapper';
        wrapper.dataset.spaceId = spaceId;
        wrapper.appendChild(newWv);
        container.appendChild(wrapper);
      }
      // Trigger layout refresh so the new webview gets correct CSS order
      // in multi-space mode (the replaced element lost its style.order)
      const activeSpaces = this.state.get('activeSpaces');
      if (activeSpaces) {
        this.state.set('activeSpaces', { ...activeSpaces });
      }
      this.focusWebview(spaceId);
      if (window._wireWebviewEvents) window._wireWebviewEvents(newWv);
      this._lastActiveWebview = newWv;
    }
  }
}

module.exports = NavigationManager;
