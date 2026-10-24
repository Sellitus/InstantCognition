// ViewShellManager — flips the app between browser mode (page first, the
// Assistant as a right sidebar) and assistant mode (the Assistant as the main
// pane, the existing #tab-bar-wrap as a collapsible right dock).
//
// Invariants (a reparented <webview> reloads its guest and loses page state):
//   - never move, remove or reinsert a <webview>/iframe; layout is CSS on body
//     classes plus flex order;
//   - the collapsed dock is translated off-canvas, never display:none or zero
//     width, so its guests keep painting for capturePage;
//   - never write #space-container's inline display (LayoutManager owns it);
//   - the only element this manager makes inert is the collapsed dock wrap.

const { ShellStore, WIDTH_BOUNDS } = require('../core/ShellStore');
const AssistantShell = require('../components/assistant/AssistantShell');
const { captureRects, playFlip } = require('../fx/flip');
const { springEasing } = require('../fx/motion');
const modalStack = require('../utils/modalStack');

const FLIP_SELECTOR = '#assistant-shell, #tab-bar-wrap';
const FLIP_CLASS = 'assistant-flipping';
const MODE_CLASSES = { browser: 'app-mode-browser', assistant: 'app-mode-assistant' };
const BROWSING_EVENTS = ['agent:step-planned', 'agent:step-acted'];

const keyOfId = (el) => el.id;

function subscribe(set, cb, name) {
  if (typeof cb !== 'function') throw new TypeError(`ViewShellManager.${name} expects a function`);
  set.add(cb);
  return () => { set.delete(cb); };
}

// web_search runs in main without touching a tab, so it never needs the dock.
function isBrowsingPayload(payload) {
  const calls = payload && Array.isArray(payload.calls) ? payload.calls : [];
  return calls.some((c) => c && typeof c.name === 'string' && c.name.startsWith('browser.') && c.name !== 'browser.web_search');
}

/**
 * @typedef {object} PanelHost
 * @property {() => HTMLElement} getContent
 * @property {() => void} focusComposer
 *
 * @typedef {object} ViewShellDeps
 * @property {ShellStore} [store]
 * @property {{ on: (channel: string, fn: (...args: any[]) => void) => unknown }} [ipc]
 * @property {() => any} [getContext]        { navigationManager, browserViewManager, state }
 * @property {() => string} [getMotionLevel] 'full' | 'subtle' | 'off'
 * @property {() => number} [modalDepth]
 * @property {string} [flipLabel]
 */

class ViewShellManager {
  /** @param {ViewShellDeps} [deps] */
  constructor(deps) {
    const d = deps || {};
    this.store = d.store || new ShellStore();
    this._ipc = d.ipc || null;
    this._getContext = d.getContext || (() => ({}));
    this._getMotionLevel = d.getMotionLevel || (() => 'off');
    this._modalDepth = d.modalDepth || (() => modalStack.depth());
    this._flipLabel = d.flipLabel || 'Switch to browser view';
    /** @type {PanelHost|null} */ this._panel = null;
    /** @type {AssistantShell|null} */ this._shell = null;
    /** @type {Set<(visible: boolean) => void>} */ this._visibilityListeners = new Set();
    /** @type {Set<(mode: string) => void>} */ this._modeListeners = new Set();
    /** @type {HTMLElement|null} */ this._returnFocus = null;
    this._forcedSpaceView = false;
    this._flipTimer = null;
    this._lastVisible = false;
    this._lastMode = this.store.get('appMode');
    this._initialized = false;
    this.store.on('change', () => this.apply());
  }

  /** @param {PanelHost} panel */
  attachPanel(panel) {
    if (!panel || typeof panel.getContent !== 'function' || typeof panel.focusComposer !== 'function') {
      throw new TypeError('ViewShellManager.attachPanel requires getContent and focusComposer');
    }
    this._panel = panel;
  }

  initialize() {
    if (this._initialized) return this;
    if (!this._panel) throw new Error('ViewShellManager.initialize: attachPanel must run first');
    this._initialized = true;
    if (this._ipc) {
      for (const ch of BROWSING_EVENTS) this._ipc.on(ch, (_e, payload) => this._onAgentStep(payload));
    }
    if (this.store.get('appMode') === 'assistant') this._showSpaceView();
    this.apply();
    return this;
  }

  getMode() { return this.store.get('appMode'); }

  isPanelVisible() {
    return this.store.get('appMode') === 'assistant' || this.store.get('sidebarOpen');
  }

  /** True when `node` sits inside the shell (panel, rail or handles). */
  contains(node) { return !!this._shell && this._shell.contains(node); }

  /**
   * @param {'browser'|'assistant'} mode
   * @param {{ focus?: boolean }} [opts]
   * @returns {boolean} true when the mode changed
   */
  setMode(mode, opts) {
    if (mode !== 'browser' && mode !== 'assistant') throw new TypeError(`ViewShellManager.setMode: invalid mode ${String(mode)}`);
    if (mode === this.store.get('appMode')) return false;
    if (!this._panel) throw new Error('ViewShellManager.setMode: no panel attached');
    const focus = !opts || opts.focus !== false;
    if (mode === 'assistant') {
      this._rememberFocus();
      this._showSpaceView();
    }
    const before = this._captureFlip();
    this.store.set('appMode', mode);
    if (mode === 'browser') this._restoreSpaceView();
    this._playFlip(before);
    if (focus) {
      if (mode === 'assistant') this._panel.focusComposer();
      else this._returnFocusToPage();
    }
    return true;
  }

  flip() {
    return this.setMode(this.store.get('appMode') === 'assistant' ? 'browser' : 'assistant');
  }

  // The keyboard path: a modal or the shortcut recorder owns the keyboard, so
  // the flip chord must not yank the layout out from under it.
  requestFlip() {
    if (!this._panel) return false;
    if (this._modalDepth() > 0) return false;
    if (document.body.classList.contains('recording-shortcut') || this.store.get('recording')) return false;
    return this.flip();
  }

  openSidebar() {
    if (!this._panel) throw new Error('ViewShellManager.openSidebar: no panel attached');
    if (this.store.get('appMode') === 'browser' && !this.store.get('sidebarOpen')) {
      this._rememberFocus();
      this.store.set('sidebarOpen', true);
    }
  }

  /** @param {{ restoreFocus?: boolean }} [opts] */
  closeSidebar(opts) {
    const restore = !opts || opts.restoreFocus !== false;
    const hadFocus = this.contains(document.activeElement);
    this.store.set('sidebarOpen', false);
    if (restore && hadFocus) this._returnFocusToPage();
  }

  /**
   * @param {boolean} open
   * @param {{ user?: boolean }} [opts] user=true records an explicit choice,
   *   which suppresses auto-open until the user reopens the dock.
   */
  setDockOpen(open, opts) {
    if (opts && opts.user) this.store.set('dockUserCollapsed', !open);
    const wrap = document.getElementById('tab-bar-wrap');
    const focusInDock = !open && !!wrap && wrap.contains(document.activeElement);
    this.store.set('dockOpen', open);
    if (focusInDock && this._panel) this._panel.focusComposer();
  }

  toggleDock() { this.setDockOpen(!this.store.get('dockOpen'), { user: true }); }

  _onAgentStep(payload) {
    if (this.store.get('appMode') !== 'assistant') return;
    if (this.store.get('dockOpen') || this.store.get('dockUserCollapsed')) return;
    if (isBrowsingPayload(payload)) this.setDockOpen(true);
  }

  _widthControl(key) {
    const b = WIDTH_BOUNDS[key];
    return {
      min: b.min, max: b.max,
      getWidth: () => this.store.get(key),
      setWidth: (px) => { this.store.set(key, px); },
      commit: () => this.store.commitWidth(key),
    };
  }

  /** @param {(visible: boolean) => void} cb @returns {() => void} */
  onVisibilityChange(cb) { return subscribe(this._visibilityListeners, cb, 'onVisibilityChange'); }

  /** @param {(mode: string) => void} cb @returns {() => void} */
  onModeChange(cb) { return subscribe(this._modeListeners, cb, 'onModeChange'); }

  // The {isOpen, onOpenChange, toggle} shape TabBarActions binds pills to.
  asToggle() {
    return {
      isOpen: () => this.store.get('appMode') === 'assistant',
      onOpenChange: (cb) => this.onModeChange((mode) => cb(mode === 'assistant')),
      toggle: () => { this.requestFlip(); },
    };
  }

  apply() {
    const s = this.store.snapshot();
    const body = document.body;
    body.classList.toggle(MODE_CLASSES.browser, s.appMode === 'browser');
    body.classList.toggle(MODE_CLASSES.assistant, s.appMode === 'assistant');
    body.classList.toggle('assistant-sidebar-open', s.appMode === 'browser' && s.sidebarOpen);
    body.classList.toggle('assistant-dock-open', s.appMode === 'assistant' && s.dockOpen);
    body.style.setProperty('--assistant-sidebar-width', `${s.sidebarWidth}px`);
    body.style.setProperty('--dock-width', `${s.dockWidth}px`);
    const shell = this._ensureShell();
    if (shell) shell.sync(s);
    this._emitTransitions(s.appMode);
  }

  _ensureShell() {
    if (this._shell) return this._shell;
    if (!this._panel || !this.isPanelVisible()) return null;
    this._shell = new AssistantShell({
      content: this._panel.getContent(),
      onFlip: () => { this.requestFlip(); },
      onDockToggle: () => this.toggleDock(),
      store: this.store,
      flipLabel: this._flipLabel,
      sidebar: this._widthControl('sidebarWidth'),
      dock: this._widthControl('dockWidth'),
    });
    this._shell.mount();
    return this._shell;
  }

  _emitTransitions(mode) {
    const visible = this.isPanelVisible();
    if (visible !== this._lastVisible) {
      this._lastVisible = visible;
      for (const cb of Array.from(this._visibilityListeners)) cb(visible);
    }
    if (mode !== this._lastMode) {
      this._lastMode = mode;
      for (const cb of Array.from(this._modeListeners)) cb(mode);
    }
  }

  _rememberFocus() {
    const el = /** @type {HTMLElement|null} */ (document.activeElement);
    if (el && el !== document.body && !this.contains(el)) this._returnFocus = el;
  }

  _returnFocusToPage() {
    const el = this._returnFocus;
    this._returnFocus = null;
    if (el && el.isConnected && !el.closest('[inert]')) {
      el.focus();
      return;
    }
    const ctx = this._getContext() || {};
    const nav = ctx.navigationManager;
    const wv = nav && typeof nav.getActiveWebview === 'function' ? nav.getActiveWebview() : null;
    if (wv && typeof wv.focus === 'function') wv.focus();
  }

  // The dock shows #tab-bar-wrap, so a hidden space view would leave it empty.
  // Show it for assistant mode and put the user's view back on the way out.
  _showSpaceView() {
    const ctx = this._getContext() || {};
    const { state, browserViewManager } = ctx;
    if (!state || !browserViewManager || state.get('spaceViewActive') !== false) return;
    browserViewManager.toggleSpace(true);
    this._forcedSpaceView = true;
  }

  _restoreSpaceView() {
    if (!this._forcedSpaceView) return;
    this._forcedSpaceView = false;
    const ctx = this._getContext() || {};
    const { state, browserViewManager } = ctx;
    if (state && browserViewManager && state.get('spaceViewActive') === true) browserViewManager.toggleSpace(false, true);
  }

  _captureFlip() {
    if (this._getMotionLevel() === 'off') return null;
    return captureRects(document.body, FLIP_SELECTOR, keyOfId);
  }

  _playFlip(before) {
    if (!before) return;
    const spring = springEasing(this._getMotionLevel() === 'subtle' ? { stiffness: 320, damping: 32 } : undefined);
    document.body.classList.add(FLIP_CLASS);
    playFlip(document.body, FLIP_SELECTOR, keyOfId, before, { easing: spring.easing, duration: spring.duration, scale: false });
    if (this._flipTimer) clearTimeout(this._flipTimer);
    this._flipTimer = setTimeout(() => {
      this._flipTimer = null;
      document.body.classList.remove(FLIP_CLASS);
    }, spring.duration);
  }
}

module.exports = { ViewShellManager, isBrowsingPayload };
