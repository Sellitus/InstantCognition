const { ipcRenderer } = require('electron');
const { PRIVATE_PARTITION } = require('../utils/historyRecorder');
const { endPrivateSession, loadPrivateWebview } = require('./privateTabs');

const DEFAULT_TAB_URL = 'https://www.google.com/';
const CLOSED_TAB_LIMIT = 25;

class SpaceManager {
  constructor(state, navigationManager, layoutManager) {
    this.state = state;
    this.navigationManager = navigationManager;
    this.layoutManager = layoutManager;
    this.findBarManager = null;
    this._lastSelectTime = 0;
    this._saveConfig = null; // set via setSaveCallback
    this._singleModeSpaceId = null; // space active before multi-space was enabled
    this._closedTabs = []; // { spaceId, url, title, private }, newest last; memory only
    this._initialUrls = new Map(); // spaceId -> URL its next webview starts at instead of home
  }

  setFindBarManager(findBarManager) {
    this.findBarManager = findBarManager;
  }

  /**
   * Get all spaces (library + ad-hoc) merged into a single lookup.
   */
  _allSpaces() {
    const spaces = this.state.get('spaces') || {};
    const adHoc = this.state.get('adHocSpaces') || {};
    return { ...spaces, ...adHoc };
  }

  setSaveCallback(fn) {
    this._saveConfig = fn;
    // Persist currentSpaceId explicitly so boot doesn't have to reconstruct
    // it from activeSpaces (which doesn't survive reorders).
    if (!this._currentSpaceWired && this.state && typeof this.state.on === 'function') {
      this._currentSpaceWired = true;
      this.state.on('change:currentSpaceId', () => this._persistCurrentSpaceId());
    }
  }

  select(newSpaceId, toggleOverride = false, skipTimeout = false) {
    const now = Date.now();
    if (!skipTimeout && now - this._lastSelectTime < 25) return;
    this._lastSelectTime = now;

    const currentId = this.state.get('currentSpaceId');
    const multiSpace = this.state.get('multiSpace');
    const activeSpaces = this.state.get('activeSpaces') || {};

    if (!toggleOverride && !multiSpace && currentId === newSpaceId) return;
    if (newSpaceId === null) newSpaceId = currentId;

    // Prevent toggling off the last visible tab in multi-mode.
    if (multiSpace && activeSpaces[newSpaceId] &&
        Object.values(activeSpaces).filter(Boolean).length === 1) {
      return;
    }

    // Multi-mode "deselect" = hide. Legacy semantic; reconciler owns the rest.
    if (multiSpace && activeSpaces[newSpaceId]) {
      this.toggleTabVisibility(newSpaceId);
      return;
    }

    // Enable space view if disabled
    if (!this.state.get('spaceViewActive')) {
      this.state.set('spaceViewActive', true);
    }

    this._activate(newSpaceId);
  }

  next() {
    if (this.state.get('multiSpace')) return;

    const currentId = this.state.get('currentSpaceId');
    const spaces = this.state.get('spaces');
    const keys = Object.keys(spaces);
    if (keys.length === 0) return;
    const currentIndex = keys.indexOf(currentId);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % keys.length;

    this.select(keys[nextIndex]);
  }

  previous() {
    if (this.state.get('multiSpace')) return;

    const currentId = this.state.get('currentSpaceId');
    const spaces = this.state.get('spaces');
    const keys = Object.keys(spaces);
    if (keys.length === 0) return;
    const currentIndex = keys.indexOf(currentId);
    const prevIndex = currentIndex <= 0 ? keys.length - 1 : currentIndex - 1;

    this.select(keys[prevIndex]);
  }

  close(spaceId) {
    const allSpaces = this._allSpaces();

    if (!spaceId) {
      // The focused tab is the state's, not the last webview navigation
      // touched: that one goes stale on the browser view and on a hidden tab,
      // and a stale id makes the close verb a silent no-op.
      spaceId = this.state.get('currentSpaceId');
    }
    if (!spaceId) {
      const wv = this.navigationManager.getActiveWebview();
      if (wv) spaceId = wv.id;
    }

    // Only close valid spaces (ignore browser-webview and other non-space IDs)
    if (!spaceId || !allSpaces[spaceId]) return;

    this.closeTab(spaceId);
  }

  // ─── New tab verbs (Phase 1 tab model) ──────────────────────────────────
  // openTabs is the ordered list of open tab ids, decoupled from library
  // (spaceOrder). hiddenTabs is the subset hidden in multi-mode. These
  // primitives live alongside activeSpaces until all consumers migrate.

  /**
   * Open a space as a new tab, or focus it if already open. Default entry point
   * for sidebar/library/new-tab clicks. In multi-mode this also un-hides the
   * tab (so opening from the library always makes it visible).
   */
  openTab(spaceId) {
    const allSpaces = this._allSpaces();
    if (!allSpaces[spaceId]) return;
    // _activate handles add-to-openTabs, un-hide, ensure wrapper, reconcile.
    this._activate(spaceId);
  }

  /**
   * Close a tab — removes from openTabs, picks a neighbor as new current.
   * Never closes the last remaining tab.
   */
  closeTab(spaceId) {
    // Pinned tabs cannot be closed without unpinning first
    const pinned = this.state.get('pinnedTabs') || [];
    if (pinned.includes(spaceId)) return;

    const openTabs = this.state.get('openTabs') || [];
    const idx = openTabs.indexOf(spaceId);
    if (idx === -1) return;
    if (openTabs.length <= 1) return; // never close the last tab

    // Before the ad-hoc entry and the webview holding the page URL go away.
    this._rememberClosedTab(spaceId);

    const nextOpen = openTabs.slice();
    nextOpen.splice(idx, 1);
    this.state.set('openTabs', nextOpen);
    this._persistOpenTabs();

    const hidden = this.state.get('hiddenTabs') || [];
    if (hidden.includes(spaceId)) {
      this.state.set('hiddenTabs', hidden.filter((id) => id !== spaceId));
      this._persistHiddenTabs();
    }

    // If the closed tab was current, pick neighbor (prefer next, fall back to previous).
    if (this.state.get('currentSpaceId') === spaceId) {
      const neighborIdx = idx < nextOpen.length ? idx : nextOpen.length - 1;
      this.state.set('currentSpaceId', nextOpen[neighborIdx]);
    }

    // Multi-mode safety: if every remaining tab is hidden, un-hide the new
    // focus so the layout always renders something.
    if (this.state.get('multiSpace')) {
      const updatedHidden = this.state.get('hiddenTabs') || [];
      const anyVisible = nextOpen.some((id) => !updatedHidden.includes(id));
      if (!anyVisible) {
        const focus = this.state.get('currentSpaceId');
        if (focus) {
          this.state.set('hiddenTabs', updatedHidden.filter((id) => id !== focus));
          this._persistHiddenTabs();
        }
      }
    }

    // Clean up ad-hoc space entry if this was a URL-based tab
    const wasPrivate = this.isPrivateTab(spaceId);
    const adHoc = this.state.get('adHocSpaces') || {};
    if (adHoc[spaceId]) {
      const adHocNext = { ...adHoc };
      delete adHocNext[spaceId];
      this.state.set('adHocSpaces', adHocNext);
      this._persistAdHocSpaces();
    }

    // Tear down the wrapper + IPC; the reconciler runs inside _deactivate.
    this._deactivate(spaceId);
    if (wasPrivate && !nextOpen.some((id) => this.isPrivateTab(id))) endPrivateSession(this._closedTabs);
  }

  /**
   * Tear down DOM + IPC for tabs that a main-side write (spaces:remove in the
   * settings editor) removed from openTabs. The caller has already applied
   * the post-removal tab arrays and re-pointed currentSpaceId, so each id
   * gets a full _deactivate here (wrapper removal + space-closed + focus),
   * the same teardown closeTab performs — without closeTab's tab-model
   * bookkeeping. Ids with no mounted webview degrade to the IPC teardown,
   * which is idempotent.
   */
  pruneRemovedTabs(removedIds) {
    if (!Array.isArray(removedIds) || removedIds.length === 0) return;
    for (const id of removedIds) {
      this._deactivate(id);
    }
  }

  /**
   * Focus a tab without toggling or closing. Used by TabBar single-mode clicks
   * and for shifting focus in multi-mode.
   */
  focusTab(spaceId) {
    const openTabs = this.state.get('openTabs') || [];
    if (!openTabs.includes(spaceId)) return;

    const multiSpace = this.state.get('multiSpace');
    if (multiSpace) {
      // In multi-mode, just shift currentSpaceId — no activate/deactivate
      this.state.set('currentSpaceId', spaceId);
      if (this.navigationManager && this.navigationManager.focusWebview) {
        this.navigationManager.focusWebview(spaceId);
      }
    } else {
      // In single-mode, activate (swaps visible webview)
      this._activate(spaceId);
    }
  }

  /**
   * Multi-mode only: toggle the visibility of a tab in the side-by-side layout.
   * Drives the canonical inputs (`hiddenTabs` + focus) and lets `_syncActiveSpaces`
   * derive `activeSpaces` and lazy-create the DOM wrapper if needed. Refuses to
   * hide the last visible tab — the layout would otherwise render nothing.
   */
  toggleTabVisibility(spaceId) {
    if (!this.state.get('multiSpace')) return;
    const openTabs = this.state.get('openTabs') || [];
    if (!openTabs.includes(spaceId)) return;

    const hidden = this.state.get('hiddenTabs') || [];
    const isHidden = hidden.includes(spaceId);
    const next = isHidden
      ? hidden.filter((id) => id !== spaceId)
      : [...hidden, spaceId];

    // Block hiding the last visible tab — empty multi-mode is a dead UI state.
    if (!isHidden) {
      const stillVisible = openTabs.filter((id) => !next.includes(id));
      if (stillVisible.length === 0) return;
    }

    this.state.set('hiddenTabs', next);
    this._persistHiddenTabs();

    // If we just hid the focused tab, move focus to the first still-visible tab.
    if (!isHidden && this.state.get('currentSpaceId') === spaceId) {
      const nextFocus = openTabs.find((id) => !next.includes(id));
      if (nextFocus) this.state.set('currentSpaceId', nextFocus);
    }

    this._syncActiveSpaces();
  }

  /**
   * Replace the openTabs order. Triggers layout refresh so side-by-side/grid
   * re-position wrappers via CSS flex `order` keyed on the new index.
   */
  reorderTabs(newOrder) {
    if (!Array.isArray(newOrder)) return;
    const openTabs = this.state.get('openTabs') || [];
    // Validate: newOrder must be a permutation of openTabs
    if (newOrder.length !== openTabs.length) return;
    const sortedA = [...newOrder].sort();
    const sortedB = [...openTabs].sort();
    if (!sortedA.every((id, i) => id === sortedB[i])) return;

    this.state.set('openTabs', newOrder.slice());
    this._persistOpenTabs();
    if (this.layoutManager) this.layoutManager.refresh();
  }

  /**
   * Open an arbitrary URL as an ad-hoc tab (not from the space library).
   * Returns the generated tab ID.
   */
  openAdHocTab(url) {
    if (!url) return null;
    return this._openAdHoc(url);
  }

  /**
   * Open a tab in the in-memory private partition. It is never written to
   * config or history; its cookies, storage and cache are shared with the other
   * open private tabs and wiped when the last of them closes. Returns its tab ID.
   */
  openPrivateTab(url) {
    return this._openAdHoc(url || DEFAULT_TAB_URL, { private: true });
  }

  isPrivateTab(spaceId) {
    const entry = (this.state.get('adHocSpaces') || {})[spaceId];
    return !!(entry && entry.private);
  }

  /**
   * Re-insert the live private tabs into a tab list that came back from
   * config (which never holds them), each after the tab it follows now.
   */
  withPrivateTabs(persistedTabs) {
    const live = this.state.get('openTabs') || [];
    const merged = persistedTabs.filter((id) => !this.isPrivateTab(id));
    live.forEach((id, i) => {
      if (!this.isPrivateTab(id)) return;
      const before = live.slice(0, i).reverse().find((prev) => merged.includes(prev));
      merged.splice(before === undefined ? 0 : merged.indexOf(before) + 1, 0, id);
    });
    return merged;
  }

  /**
   * Reopen the most recently closed tab at the page it was showing.
   * Returns false when nothing is left to reopen.
   */
  reopenClosedTab() {
    const entry = this._closedTabs.pop();
    if (!entry) return false;
    if (entry.private) return !!this.openPrivateTab(entry.url);
    const space = entry.spaceId ? (this.state.get('spaces') || {})[entry.spaceId] : null;
    // A deleted space, or one the user already reopened, comes back as a
    // plain tab so the open one is not navigated away from its page.
    if (!space || (this.state.get('openTabs') || []).includes(entry.spaceId)) {
      return !!this._openAdHoc(entry.url || DEFAULT_TAB_URL, { name: entry.title });
    }
    if (entry.url && entry.url !== space.url) this._initialUrls.set(entry.spaceId, entry.url);
    this.openTab(entry.spaceId);
    return true;
  }

  _rememberClosedTab(spaceId) {
    const meta = this._allSpaces()[spaceId];
    if (!meta) return;
    const wv = /** @type {any} */ (document.getElementById(spaceId));
    let url = meta.url;
    let title = meta.name;
    if (wv && typeof wv.getURL === 'function') {
      try {
        url = wv.getURL() || url;
        title = wv.getTitle() || title;
      } catch (err) {
        // getURL throws until the guest's dom-ready; src holds the URL it is loading.
        console.error('[spaces] closed tab page URL unreadable, keeping its src:', (err instanceof Error && err.message) || err);
        url = wv.src || url;
      }
    }
    const adHoc = !!(this.state.get('adHocSpaces') || {})[spaceId];
    this._closedTabs.push({ spaceId: adHoc ? null : spaceId, url, title, private: !!meta.private });
    if (this._closedTabs.length > CLOSED_TAB_LIMIT) this._closedTabs.shift();
  }

  _openAdHoc(url, extra = {}) {
    const adHoc = { ...(this.state.get('adHocSpaces') || {}) };
    // A popup burst opens several tabs in one millisecond; each needs its own id.
    let id = `tab_${Date.now()}`;
    for (let n = 2; adHoc[id]; n += 1) id = `tab_${Date.now()}_${n}`;
    let name = extra.name;
    if (!name) {
      try {
        name = new URL(url).hostname || url;
      } catch (_) {
        name = url.length > 30 ? url.slice(0, 30) + '...' : url;
      }
    }
    adHoc[id] = extra.private ? { name, url, type: 'ad-hoc', private: true } : { name, url, type: 'ad-hoc' };
    this.state.set('adHocSpaces', adHoc);
    this._persistAdHocSpaces();
    this.openTab(id);
    return id;
  }

  /**
   * Pin a tab. Pinned tabs persist across sessions and cannot be closed
   * without unpinning first.
   */
  pinTab(spaceId) {
    const pinned = (this.state.get('pinnedTabs') || []).slice();
    if (pinned.includes(spaceId) || this.isPrivateTab(spaceId)) return;
    pinned.push(spaceId);
    this.state.set('pinnedTabs', pinned);
    this._persistPinnedTabs();
  }

  /**
   * Unpin a tab.
   */
  unpinTab(spaceId) {
    const pinned = (this.state.get('pinnedTabs') || []).slice();
    const idx = pinned.indexOf(spaceId);
    if (idx === -1) return;
    pinned.splice(idx, 1);
    this.state.set('pinnedTabs', pinned);
    this._persistPinnedTabs();
  }

  _persistField(field, value) {
    const config = this.state.get('config');
    if (!config || !config.state) return;
    config.state[field] = value;
    if (this._saveConfig) this._saveConfig(config);
  }
  // Private tabs stay out of config. hiddenTabs may still name one: it is an
  // opaque id that boot drops, and filtering it would make the config:changed
  // echo un-hide the tab.
  _persistPinnedTabs() { this._persistField('pinnedTabs', (this.state.get('pinnedTabs') || []).slice()); }
  _persistAdHocSpaces() {
    const adHoc = this.state.get('adHocSpaces') || {};
    this._persistField('adHocSpaces', Object.fromEntries(Object.entries(adHoc).filter(([, entry]) => !entry.private)));
  }
  _persistOpenTabs() { this._persistField('openTabs', (this.state.get('openTabs') || []).filter((id) => !this.isPrivateTab(id))); }
  _persistCurrentSpaceId() {
    const current = this.state.get('currentSpaceId');
    if (!this.isPrivateTab(current)) this._persistField('currentSpaceId', current || '');
  }
  _persistHiddenTabs() { this._persistField('hiddenTabs', (this.state.get('hiddenTabs') || []).slice()); }

  // Toggle between user view and the agent workspace. AgentWorkspaceManager
  // owns the actual webview swap; this just flips the state flag (which both
  // managers and TabBar listen to).
  setViewMode(mode) {
    const next = mode === 'agent' ? 'agent' : 'user';
    if (this.state.get('viewMode') !== next) this.state.set('viewMode', next);
  }
  toggleViewMode() {
    this.setViewMode(this.state.get('viewMode') === 'agent' ? 'user' : 'agent');
  }

  toggleMulti() {
    const config = this.state.get('config');
    const multiSpace = this.state.get('multiSpace');

    if (!multiSpace) {
      // single → multi: remember the single-mode focus, flip the flag, and let
      // the reconciler activate every open tab (modulo `hiddenTabs`, which is
      // empty per the multi→single cleanup below).
      this._singleModeSpaceId = this.state.get('currentSpaceId');
      this.state.set('multiSpace', true);
      if (config && config.settings) config.settings.multiSpace = true;
    } else {
      // multi → single: restore focus to the pre-multi tab (or keep current if
      // there's no memory), clear hiddenTabs (a multi-only concept), then let
      // the reconciler reduce activeSpaces to {currentSpaceId}. The other
      // wrappers stay mounted with display:none, so re-enabling multi has
      // zero reloads.
      const restoreId = this._singleModeSpaceId || this.state.get('currentSpaceId');
      this._singleModeSpaceId = null;
      this.state.set('multiSpace', false);
      if (config && config.settings) config.settings.multiSpace = false;
      if (restoreId) this.state.set('currentSpaceId', restoreId);

      const hiddenNow = this.state.get('hiddenTabs') || [];
      if (hiddenNow.length > 0) {
        this.state.set('hiddenTabs', []);
        this._persistHiddenTabs();
      }
    }

    this._syncActiveSpaces();

    if (this._saveConfig && config) this._saveConfig(config);
  }

  // Lazy-create the DOM wrapper + webview for `spaceId`. Idempotent — returns
  // the existing webview if one is already attached. This is the single place
  // the renderer instantiates a webview for a space; every entry point that
  // needs a tab visible must reach this helper (directly or via the reconciler).
  _ensureWrapper(spaceId) {
    const existing = document.getElementById(spaceId);
    if (existing && existing.isConnected) return existing;

    const allSpaces = this._allSpaces();
    if (!allSpaces[spaceId]) return null;

    const container = document.getElementById('space-container');
    if (!container) return null;

    const webview = document.createElement('webview');
    webview.id = spaceId;
    webview.classList.add('space-browser');
    webview.setAttribute('allowpopups', '');
    // A webview's partition is fixed by its first navigation.
    if (allSpaces[spaceId].private) webview.setAttribute('partition', PRIVATE_PARTITION);

    const wrapper = document.createElement('div');
    wrapper.className = 'space-webview-wrapper';
    wrapper.dataset.spaceId = spaceId;
    wrapper.appendChild(webview);
    container.appendChild(wrapper);

    // Set src AFTER attach so navigation starts cleanly. Setting before attach
    // is supported but has rare timing edge cases on some Electron versions.
    const url = this._initialUrls.get(spaceId) || allSpaces[spaceId].url || DEFAULT_TAB_URL;
    if (allSpaces[spaceId].private) loadPrivateWebview(webview, url);
    else webview.src = url;
    this._initialUrls.delete(spaceId);

    // Internal flag — not state-observable; signals "wrapper realized at least once."
    const loadedSpaces = this.state.get('loadedSpaces') || {};
    loadedSpaces[spaceId] = true;

    if (typeof window !== 'undefined' && window._wireWebviewEvents) {
      window._wireWebviewEvents(webview);
    }
    this._showLoadingOverlay(webview);
    return webview;
  }

  // Reconcile activeSpaces against the canonical inputs (openTabs, hiddenTabs,
  // multiSpace, currentSpaceId). This is the SINGLE place activeSpaces is
  // mutated. Every visibility-changing path calls this; no caller should write
  // to activeSpaces directly. Also ensures the DOM wrapper exists for every
  // newly-active tab, so the layout never tries to render against a missing
  // wrapper.
  //
  // Invariants:
  //   multi-mode  : activeSpaces[id] === (openTabs.includes(id) && !hiddenTabs.includes(id))
  //   single-mode : activeSpaces[id] === (id === currentSpaceId)
  _syncActiveSpaces() {
    const multiSpace = this.state.get('multiSpace');
    const openTabs = this.state.get('openTabs') || [];
    const hiddenTabs = this.state.get('hiddenTabs') || [];
    const currentSpaceId = this.state.get('currentSpaceId');
    const allSpaces = this._allSpaces();

    const next = {};
    for (const id of openTabs) {
      if (!allSpaces[id]) continue;
      next[id] = multiSpace ? !hiddenTabs.includes(id) : (id === currentSpaceId);
    }
    // Carry over keys we've seen before so layouts that iterate Object.keys
    // (e.g., applyAccentColors) see a stable picture; closed tabs are false.
    const prev = this.state.get('activeSpaces') || {};
    for (const id of Object.keys(prev)) {
      if (!(id in next)) next[id] = false;
    }

    // Lazy-create wrappers for every newly-active tab BEFORE layout sees the
    // state change (LayoutManager subscribes to change:activeSpaces).
    for (const id of openTabs) {
      if (next[id]) this._ensureWrapper(id);
    }

    this.state.set('activeSpaces', next);

    // Keep config.state.activeSpaces in sync so it survives restart.
    const config = this.state.get('config');
    if (config && config.state) {
      config.state.activeSpaces = Object.entries(next)
        .filter(([id, v]) => v && !this.isPrivateTab(id))
        .map(([id]) => id);
    }
  }

  _activate(spaceId) {
    const allSpaces = this._allSpaces();
    if (!allSpaces[spaceId]) return; // reject non-space IDs (e.g., 'browser-webview')

    // Add to openTabs (idempotent)
    const openTabs = this.state.get('openTabs') || [];
    if (!openTabs.includes(spaceId)) {
      const nextOpen = openTabs.slice();
      nextOpen.push(spaceId);
      this.state.set('openTabs', nextOpen);
      this._persistOpenTabs();
    }

    // Activating must un-hide
    const hidden = this.state.get('hiddenTabs') || [];
    if (hidden.includes(spaceId)) {
      this.state.set('hiddenTabs', hidden.filter((id) => id !== spaceId));
      this._persistHiddenTabs();
    }

    // Shift focus + close find bar
    this.state.set('currentSpaceId', spaceId);
    if (this.findBarManager) this.findBarManager.close();

    // Reconcile (creates wrapper if needed, sets activeSpaces, triggers layout)
    this._syncActiveSpaces();

    // IPC throttle: mark this webview active
    const webview = /** @type {any} */ (document.getElementById(spaceId));
    let wcId = null;
    try {
      if (webview && webview.getWebContentsId) wcId = webview.getWebContentsId();
    } catch (_) { /* webview not yet attached */ }
    ipcRenderer.send('space-activity', { spaceId, isActive: true, webContentsId: wcId });

    const config = this.state.get('config');
    if (this._saveConfig && config) this._saveConfig(config);
    this._pauseInactiveResumeActive();
    this.navigationManager.focusWebview(spaceId);
  }

  // Tear down DOM + IPC for a tab that's already been removed from openTabs
  // by the caller (closeTab). Pure cleanup — does not mutate openTabs/hiddenTabs;
  // those are the caller's responsibility so the closure semantics live in one place.
  _deactivate(spaceId) {
    // Remove the wrapper so the webview is fully destroyed (frees WebContents).
    const webview = document.getElementById(spaceId);
    if (webview) {
      const wrapper = /** @type {any} */ (webview.closest('.space-webview-wrapper'));
      // The strip holds IPC and webview listeners that outlive its DOM node.
      if (wrapper && wrapper._chromeStrip) {
        wrapper._chromeStrip.destroy();
        wrapper._chromeStrip = null;
      }
      if (wrapper && wrapper.parentNode) {
        wrapper.parentNode.removeChild(wrapper);
      }
    }

    ipcRenderer.send('space-closed', { spaceId });

    // Reconcile against the new canonical state (caller already mutated openTabs).
    this._syncActiveSpaces();

    const config = this.state.get('config');
    if (this._saveConfig && config) this._saveConfig(config);
    this._pauseInactiveResumeActive();
    this.navigationManager.focusWebview(this.state.get('currentSpaceId'));
  }

  _pauseInactiveResumeActive() {
    const send = (wv, isActive) => {
      let wcId = null;
      try { if (wv.getWebContentsId) wcId = wv.getWebContentsId(); } catch (err) { console.warn('[spaces] getWebContentsId failed for', wv.id, (err instanceof Error && err.message) || err); }
      ipcRenderer.send('space-activity', { spaceId: wv.id, isActive, webContentsId: wcId });
    };
    try {
      document.querySelectorAll('.space-browser.inactive').forEach((wv) => send(wv, false));
      document.querySelectorAll('.space-browser.active').forEach((wv) => send(wv, true));
    } catch (error) {
      console.error('Error managing space throttling:', error);
    }
  }

  _showLoadingOverlay(webview) {
    const wrapper = webview.closest('.space-webview-wrapper');
    if (!wrapper) return;

    const overlay = document.createElement('div');
    overlay.className = 'webview-loading-overlay';
    overlay.dataset.forWebview = webview.id;

    const spinner = document.createElement('div');
    spinner.className = 'webview-loading-spinner';
    overlay.appendChild(spinner);

    wrapper.appendChild(overlay);

    let safetyTimer = null;
    const removeOverlay = () => {
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      overlay.classList.add('fade-out');
      setTimeout(() => overlay.remove(), 300);
    };
    webview.addEventListener('did-finish-load', removeOverlay, { once: true });
    webview.addEventListener('did-fail-load', removeOverlay, { once: true });
    // Safety timeout cleared by removeOverlay so the closure isn't pinned 15s.
    safetyTimer = setTimeout(() => { if (overlay.parentNode) removeOverlay(); }, 15000);
  }
}

module.exports = SpaceManager;
