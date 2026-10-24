// AssistantShell — the #assistant-shell body child that hosts the Assistant
// panel. Browser mode: a resizable sidebar right of the page. Assistant mode:
// the main pane, with a dock rail (flip + dock toggle) and the dock's resize
// handle on its trailing edge next to #tab-bar-wrap. Layout lives in
// assistant-shell.css keyed off body classes; this only builds and syncs DOM.
//
// SidePanes is the panel's side-pane switcher (Artifacts / Sessions / Inbox)
// and its history-rail binding, both driven by ShellStore (sidePane,
// historyRailOpen). Assistant mode shows the open pane as a right column;
// the browser-mode sidebar shows it as a sheet over the thread. Nothing here
// sets `inert`: the page behind the sidebar stays usable.

const ResizeHandle = require('./ResizeHandle');
const BrowserDock = require('./BrowserDock');
const SessionsDashboard = require('./SessionsDashboard');
const InboxPane = require('./InboxPane');
const { icon } = require('../Icon');

const SHELL_ID = 'assistant-shell';
const PANES = [
  { id: 'sessions', label: 'Sessions', icon: 'agent' },
  { id: 'artifacts', label: 'Artifacts', icon: 'file' },
  { id: 'inbox', label: 'Inbox', icon: 'bell' },
];
// The shell is built by ViewShellManager from the panel's content element,
// so it finds that panel's SidePanes here rather than through its options.
/** @type {WeakMap<HTMLElement, SidePanes>} */
const panesByContent = new WeakMap();

/**
 * @typedef {object} WidthControl
 * @property {number} min
 * @property {number} max
 * @property {() => number} getWidth
 * @property {(px: number) => void} setWidth
 * @property {() => void} commit
 *
 * @typedef {object} AssistantShellOpts
 * @property {HTMLElement} content       the panel's root element
 * @property {() => void} onFlip
 * @property {() => void} onDockToggle
 * @property {string} flipLabel
 * @property {WidthControl} sidebar
 * @property {WidthControl} dock
 * @property {{ set: (k: string, v: any) => void }} [store] ShellStore, for the dock's recording/annotating state
 * @property {(text: string) => void} [sendAnnotation]
 */

class AssistantShell {
  /** @param {AssistantShellOpts} opts */
  constructor(opts) {
    if (!opts || !(opts.content instanceof HTMLElement)) throw new TypeError('AssistantShell requires a content element');
    if (typeof opts.onFlip !== 'function' || typeof opts.onDockToggle !== 'function') {
      throw new TypeError('AssistantShell requires onFlip and onDockToggle');
    }
    const root = document.createElement('div');
    root.id = SHELL_ID;
    root.className = 'assistant-shell';

    this.sidebarHandle = new ResizeHandle({ label: 'Resize assistant sidebar', controls: SHELL_ID, ...opts.sidebar });
    this.sidebarHandle.el.classList.add('assistant-resize-handle--sidebar');

    const region = document.createElement('section');
    region.id = 'agent-panel';
    region.className = 'assistant-shell-panel';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Assistant');
    region.appendChild(opts.content);

    const rail = document.createElement('div');
    rail.className = 'assistant-dock-rail';
    rail.setAttribute('role', 'toolbar');
    rail.setAttribute('aria-orientation', 'vertical');
    rail.setAttribute('aria-label', 'Browser dock');
    const flipBtn = document.createElement('button');
    flipBtn.type = 'button';
    flipBtn.className = 'assistant-dock-flip';
    flipBtn.setAttribute('aria-label', opts.flipLabel);
    flipBtn.title = opts.flipLabel;
    flipBtn.appendChild(icon('panelLeft'));
    flipBtn.addEventListener('click', () => opts.onFlip());
    this.dock = new BrowserDock({ onToggle: opts.onDockToggle, store: opts.store, sendAnnotation: opts.sendAnnotation });
    rail.append(flipBtn, this.dock.el);

    this.dockHandle = new ResizeHandle({ label: 'Resize browser dock', controls: 'tab-bar-wrap', ...opts.dock });
    this.dockHandle.el.classList.add('assistant-resize-handle--dock');

    root.append(this.sidebarHandle.el, region, rail, this.dockHandle.el);
    this.content = opts.content;
    this.root = root;
    this.region = region;
    this.rail = rail;
    this.flipBtn = flipBtn;
  }

  mount() {
    if (!this.root.isConnected) document.body.appendChild(this.root);
  }

  /** @param {{ appMode: string, sidebarOpen: boolean, dockOpen: boolean, sidePane?: string|null, historyRailOpen?: boolean }} state */
  sync(state) {
    const assistant = state.appMode === 'assistant';
    const visible = assistant || state.sidebarOpen;
    // Collapsed is visibility:hidden in CSS (out of tab order and the a11y
    // tree) and never inert: the shell must not inert anything.
    if (visible) this.root.removeAttribute('aria-hidden');
    else this.root.setAttribute('aria-hidden', 'true');
    this.sidebarHandle.el.hidden = assistant || !state.sidebarOpen;
    this.rail.hidden = !assistant;
    this.dockHandle.el.hidden = !(assistant && state.dockOpen);
    this.sidebarHandle.sync();
    this.dockHandle.sync();
    this.dock.sync(state);
    const panes = panesByContent.get(this.content);
    if (panes) panes.sync(state);
  }

  contains(node) { return !!node && this.root.contains(node); }
}


function errText(err) {
  return (err instanceof Error && err.message) || String(err);
}

/**
 * @typedef {{ get: (key: string) => any, set: (key: string, value: any) => boolean }} PaneStore
 * @typedef {{ isOpen: () => boolean, setOpen: (open: boolean) => void }} RailControl
 *
 * @typedef {object} SidePanesOpts
 * @property {HTMLElement} content           the panel's root (.agent-panel)
 * @property {() => (PaneStore|null)} getStore the ShellStore, once a shell is bound
 * @property {any} [host]                    the panel: loadSession(id), onSessionChange(cb), _openHistoryRun(id), _scopeMatches(payload)
 * @property {import('./SessionList')} [sessionList]
 * @property {RailControl} [historyRail]
 * @property {any} [ipc]
 * @property {any} [toast]
 * @property {any} [notifier]                passed to SessionsDashboard
 */

class SidePanes {
  /** @param {SidePanesOpts} opts */
  constructor(opts) {
    if (!opts || !(opts.content instanceof HTMLElement)) throw new TypeError('SidePanes requires the panel content element');
    if (typeof opts.getStore !== 'function') throw new TypeError('SidePanes requires getStore');
    this._content = opts.content;
    this._getStore = opts.getStore;
    this._host = opts.host || null;
    this._sessionList = opts.sessionList || null;
    this._rail = opts.historyRail || null;
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    this._toast = opts.toast || require('../Toast');
    // Used only while no shell is bound (a panel built before its shell).
    this._local = { sidePane: null, historyRailOpen: false, appMode: 'browser' };
    this._activeSessionId = null;
    this._shownPane = null;
    this._railSeeded = false;
    /** @type {any} */ this._artifacts = null;

    this._buildTabs();
    this._buildSheet();
    const open = (id) => this.openSession(id);
    this.dashboard = new SessionsDashboard({ container: this._panels.sessions, ipc: this._ipc, onOpen: open, toast: this._toast, notifier: opts.notifier });
    this.inbox = new InboxPane({ container: this._panels.inbox, ipc: this._ipc, onOpen: open });
    if (this._sessionList) this._offSelect = this._sessionList.onSelect((id) => this.openSession(id));

    // The panel reports which session its thread shows; a panel without that
    // hook is followed through the foreground runs it starts.
    const h = this._host;
    if (h && typeof h.onSessionChange === 'function') {
      this._offSessionChange = h.onSessionChange((s) => this.setActiveSession(typeof s === 'string' ? s : (s && s.sessionId) || null));
    } else {
      this._onTaskStarted = (_e, payload) => {
        if (!payload || typeof payload.sessionId !== 'string') return;
        if (h && typeof h._scopeMatches === 'function' && !h._scopeMatches(payload)) return;
        this.setActiveSession(payload.sessionId);
      };
      this._ipc.on('agent:task-started', this._onTaskStarted);
    }
    this._observeRail();
    panesByContent.set(this._content, this);
    this._seedRail();
    this._render();
  }

  /** The SidePanes mounted on a panel's content element, if any. */
  static forContent(content) { return panesByContent.get(content) || null; }

  _buildTabs() {
    const tabs = document.createElement('div');
    tabs.className = 'assistant-side-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Side panes');
    /** @type {Record<string, HTMLButtonElement>} */
    this._tabs = {};
    for (const p of PANES) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = `assistant-side-tab-${p.id}`;
      tab.className = 'assistant-side-tab';
      tab.dataset.pane = p.id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `assistant-side-panel-${p.id}`);
      tab.setAttribute('aria-label', p.label);
      tab.title = p.label;
      tab.appendChild(icon(p.icon));
      tab.addEventListener('click', () => this.togglePane(p.id));
      tabs.appendChild(tab);
      this._tabs[p.id] = tab;
    }
    tabs.addEventListener('keydown', (ev) => this._onTabKey(ev));
    const header = this._content.querySelector('.agent-panel-header');
    const anchor = header && header.querySelector('.agent-panel-new');
    if (header && anchor) header.insertBefore(tabs, anchor);
    else if (header) header.appendChild(tabs);
    else this._content.appendChild(tabs);
    this.tabsEl = tabs;
  }

  _buildSheet() {
    const sheet = document.createElement('aside');
    sheet.className = 'assistant-side-pane';
    sheet.hidden = true;
    const bar = document.createElement('div');
    bar.className = 'assistant-side-pane__bar';
    this._sheetTitle = document.createElement('span');
    this._sheetTitle.className = 'assistant-side-pane__title';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'assistant-side-pane__close';
    close.setAttribute('aria-label', 'Close side pane');
    close.title = 'Close (Esc)';
    close.appendChild(icon('close'));
    close.addEventListener('click', () => this.setPane(null, { focusTab: true }));
    bar.append(this._sheetTitle, close);
    sheet.appendChild(bar);
    /** @type {Record<string, HTMLElement>} */
    this._panels = {};
    for (const p of PANES) {
      const panel = document.createElement('div');
      panel.id = `assistant-side-panel-${p.id}`;
      panel.className = `assistant-side-pane__panel assistant-side-pane__panel--${p.id}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `assistant-side-tab-${p.id}`);
      panel.hidden = true;
      sheet.appendChild(panel);
      this._panels[p.id] = panel;
    }
    // Esc closes the pane before it can reach the panel's Esc-to-close.
    sheet.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || ev.defaultPrevented) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.setPane(null, { focusTab: true });
    });
    this._content.appendChild(sheet);
    this.sheetEl = sheet;
  }

  _state() {
    const store = this._getStore();
    if (!store) return this._local;
    return { sidePane: store.get('sidePane'), historyRailOpen: store.get('historyRailOpen'), appMode: store.get('appMode') };
  }

  _write(key, value) {
    const store = this._getStore();
    if (store) store.set(key, value);
    else this._local[key] = value;
  }

  /** @returns {string|null} */
  getPane() { return this._state().sidePane || null; }

  /**
   * @param {string|null} id 'artifacts' | 'sessions' | 'inbox', or null to close
   * @param {{ focusTab?: boolean }} [opts]
   */
  setPane(id, opts) {
    if (id !== null && !PANES.some((p) => p.id === id)) throw new TypeError(`SidePanes.setPane: unknown pane ${String(id)}`);
    const was = this.getPane();
    this._write('sidePane', id);
    this._render();
    if (opts && opts.focusTab) {
      const tab = this._tabs[id || was || PANES[0].id];
      if (tab) tab.focus();
    }
  }

  /** Opens `id`, or closes it when it is already the open pane. */
  togglePane(id) { this.setPane(this.getPane() === id ? null : id); }

  /**
   * Shows session history: the left column in assistant mode, the Sessions
   * sheet in the browser-mode sidebar, which is too narrow for the column.
   * @param {{ toggle?: boolean }} [opts] toggle closes history when it is showing
   * @returns {boolean} whether history is showing afterwards
   */
  showHistory(opts = {}) {
    if (this._state().appMode === 'assistant' && this._rail) {
      this._rail.setOpen(opts.toggle ? !this._rail.isOpen() : true);
      return this._rail.isOpen();
    }
    if (opts.toggle) this.togglePane('sessions');
    else this.setPane('sessions');
    return this.getPane() === 'sessions';
  }

  // Manual activation: arrows move focus between tabs, Enter/Space (the
  // button's click) opens one, so browsing the tabs never flips panes.
  _onTabKey(ev) {
    const order = PANES.map((p) => this._tabs[p.id]);
    const i = order.indexOf(/** @type {any} */ (ev.target));
    if (i < 0) return;
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (i + 1) % order.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (i - 1 + order.length) % order.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = order.length - 1;
    else if (ev.key === 'Escape' && this.getPane()) {
      ev.preventDefault();
      ev.stopPropagation();
      this.setPane(null, { focusTab: true });
      return;
    }
    if (next < 0) return;
    ev.preventDefault();
    for (const t of order) t.tabIndex = -1;
    order[next].tabIndex = 0;
    order[next].focus();
  }

  /** Called by AssistantShell.sync on every ShellStore change. */
  sync(state) {
    if (!this._railSeeded) this._seedRail();
    if (this._rail && this._railSeeded && typeof state.historyRailOpen === 'boolean' && state.historyRailOpen !== this._rail.isOpen()) {
      this._rail.setOpen(state.historyRailOpen);
    }
    this._render();
  }

  // HistoryRail persists its own open state per machine, so on first contact
  // with a store the rail's state wins; after that the store drives the rail.
  _seedRail() {
    if (!this._rail || this._railSeeded) return;
    const store = this._getStore();
    if (!store) return;
    this._railSeeded = true;
    const open = this._rail.isOpen();
    if (store.get('historyRailOpen') !== open) queueMicrotask(() => store.set('historyRailOpen', open));
  }

  // HistoryRail flips .is-history-open on the content for every path (its
  // buttons, Cmd+Shift+H, Cmd+K), so the class is what the store mirrors.
  _observeRail() {
    if (!this._rail || typeof MutationObserver === 'undefined') return;
    this._railObserver = new MutationObserver(() => {
      const open = this._content.classList.contains('is-history-open');
      const store = this._getStore();
      if (store && this._railSeeded && store.get('historyRailOpen') !== open) store.set('historyRailOpen', open);
      else if (!store) this._local.historyRailOpen = open;
    });
    this._railObserver.observe(this._content, { attributes: true, attributeFilter: ['class'] });
  }

  _render() {
    const pane = this.getPane();
    const focusIdx = Math.max(0, PANES.findIndex((p) => p.id === pane));
    PANES.forEach((p, idx) => {
      const tab = this._tabs[p.id];
      const selected = p.id === pane;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.classList.toggle('is-active', selected);
      if (!this.tabsEl.contains(document.activeElement)) tab.tabIndex = idx === focusIdx ? 0 : -1;
      this._panels[p.id].hidden = !selected;
    });
    this.sheetEl.hidden = !pane;
    this._content.classList.toggle('has-side-pane', !!pane);
    if (pane) {
      this.sheetEl.dataset.pane = pane;
      this._sheetTitle.textContent = PANES.find((p) => p.id === pane).label;
    } else delete this.sheetEl.dataset.pane;
    if (pane !== this._shownPane) {
      this._shownPane = pane;
      if (pane) this._onPaneShown(pane);
    }
  }

  _onPaneShown(pane) {
    if (pane === 'sessions') this.dashboard.refresh();
    else if (pane === 'inbox') this.inbox.refresh();
    else if (pane === 'artifacts') {
      if (!this._artifacts) {
        const ArtifactsPane = require('./ArtifactsPane');
        this._artifacts = new ArtifactsPane({ container: this._panels.artifacts, ipc: this._ipc });
        this._artifacts.setSession(this._activeSessionId);
      } else this._artifacts.refresh();
    }
  }

  getActiveSession() { return this._activeSessionId; }

  /** @param {string|null} id */
  setActiveSession(id) {
    const next = typeof id === 'string' && id ? id : null;
    if (next === this._activeSessionId) return;
    this._activeSessionId = next;
    if (this._artifacts) this._artifacts.setSession(next);
    if (this._sessionList && this._sessionList.getActive() !== next) this._sessionList.setActive(next);
  }

  /**
   * Shows a session in the panel. The panel's loader handles it when present;
   * an imported pre-session run replays through the legacy run view.
   * @param {string} id
   */
  openSession(id) {
    if (typeof id !== 'string' || !id) return Promise.resolve();
    const prev = this._activeSessionId;
    this.setActiveSession(id);
    // In the browser-mode sidebar the sheet covers the thread being opened.
    if (this._state().appMode !== 'assistant' && this.getPane()) this.setPane(null);
    const h = this._host;
    // The selection was shown optimistically; undo it unless the host has
    // since moved to another session itself.
    const fail = (err) => {
      if (this._activeSessionId === id) this.setActiveSession(prev);
      this._toast.error(`Couldn’t open the session: ${errText(err)}`);
    };
    if (h && typeof h.loadSession === 'function') {
      return Promise.resolve().then(() => h.loadSession(id)).then((res) => {
        if (res && res.ok === false) fail(new Error(res.error || 'the session could not be loaded'));
      }, fail);
    }
    const row = this._sessionList ? this._sessionList.get(id) : null;
    if (row && row.legacyRunId && h && typeof h._openHistoryRun === 'function') {
      return Promise.resolve().then(() => h._openHistoryRun(row.legacyRunId)).catch(fail);
    }
    fail(new Error('this Assistant has no session loader'));
    return Promise.resolve();
  }

  destroy() {
    if (this._onTaskStarted) this._ipc.removeListener('agent:task-started', this._onTaskStarted);
    if (this._offSessionChange) this._offSessionChange();
    if (this._offSelect) this._offSelect();
    if (this._railObserver) this._railObserver.disconnect();
    this.dashboard.destroy();
    this.inbox.destroy();
    if (this._artifacts) this._artifacts.destroy();
    this.tabsEl.remove();
    this.sheetEl.remove();
    this._content.classList.remove('has-side-pane');
    panesByContent.delete(this._content);
  }
}

module.exports = AssistantShell;
module.exports.SidePanes = SidePanes;
module.exports.SIDE_PANES = PANES;
