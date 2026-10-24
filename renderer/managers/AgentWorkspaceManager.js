// AgentWorkspaceManager — owns the renderer-side webview container for the
// agent's isolated tab workspace (#agent-workspace-container).
//
// Receives `agent-workspace:tab-op` from main (origin: AgentTabOpsService) and
// creates / closes / focuses webviews INSIDE the dedicated container, never
// touching state.openTabs. After every change, broadcasts the new tab list to
// main via `agent-workspace:state-update` so AgentWorkspaceService can persist
// to the active conversation's .meta.json.
//
// `agent-workspace:restore` (main → here) clears the container and rebuilds
// it from a saved tab list. Used on conversation switch.
//
// viewMode controls visibility: when 'agent', this container is shown and the
// user's #space-container is hidden (and vice versa).

const { errMsg } = require('../../shared/errMsg');

let ipcRenderer;
try { ({ ipcRenderer } = require('electron')); } catch (_) {
  ipcRenderer = { send: () => {}, on: () => {}, invoke: () => Promise.resolve(null) };
}

// Toast is a DOM-backed singleton; keep the manager loadable without one.
let toast;
try { toast = require('../components/Toast'); } catch (_) { toast = null; }

class AgentWorkspaceManager {
  constructor({ state }) {
    this._state = state;
    this._container = null;
    this._wrappers = new Map(); // id -> wrapper div
    this._idSeq = 0;
    this._initialized = false;
    this._placementWarned = false;
  }

  initialize() {
    if (this._initialized) return;
    this._container = document.getElementById('agent-workspace-container');
    this._wireIpc();
    this._wireViewMode();
    this._hydrate();
    this._initialized = true;
  }

  // Move the agent container INTO .tab-bar-wrap so it occupies the same flex
  // slot as #space-container. Idempotent. Runs before every webview is created
  // and on every view-mode toggle. Moving a <webview> reloads its guest, so a
  // container that already holds one is never moved.
  _reparent() {
    if (!this._container) return;
    const wrap = document.getElementById('tab-bar-wrap');
    if (!wrap || this._container.parentNode === wrap) return;
    if (this._container.querySelector('webview')) {
      if (!this._placementWarned) {
        this._placementWarned = true;
        console.warn('[AgentWorkspace] container holds live webviews outside #tab-bar-wrap; left in place to avoid reloading them');
      }
      return;
    }
    wrap.appendChild(this._container);
  }

  _wireIpc() {
    ipcRenderer.on('agent-workspace:tab-op', (_e, payload) => this._handleTabOp(payload));
    ipcRenderer.on('agent-workspace:restore', (_e, payload) => this._handleRestore(payload));
  }

  _wireViewMode() {
    if (typeof this._state.on === 'function') {
      this._state.on('change:viewMode', (mode) => this._applyViewMode(mode));
    }
    this._applyViewMode(this._state.get('viewMode'));
  }

  _applyViewMode(mode) {
    if (!this._container) return;
    // Always ensure reparent — handles the case where TabBar built the wrap
    // after our initialize ran. Idempotent: no-op if already inside the wrap.
    this._reparent();
    const isAgent = mode === 'agent';
    this._container.style.display = isAgent ? 'flex' : 'none';
    const spaceContainer = document.getElementById('space-container');
    if (spaceContainer) spaceContainer.style.display = isAgent ? 'none' : '';
    if (isAgent) this._applyMultiClass();
  }

  _hydrate() {
    const load = () => ipcRenderer.invoke('agent-workspace:get-state');
    // One immediate retry: a transient IPC hiccup must not leave an empty
    // tab strip with no explanation. A second failure surfaces a sticky
    // toast (timeout 0) so the error outlives the broken strip.
    load()
      .catch(() => load())
      .then((s) => {
        if (!s || !Array.isArray(s.tabs)) return;
        // Mirror state into AppState so TabBar can render.
        this._state.set('agentWorkspace', {
          tabs: s.tabs.slice(),
          currentTabId: s.currentTabId || null,
        });
      })
      .catch((err) => {
        console.error('[AgentWorkspace] failed to load workspace state:', err);
        if (toast) toast.error(`Agent workspace state unavailable — the tab strip may be empty. (${errMsg(err)})`, { title: 'Agent workspace', timeout: 0 });
      });
  }

  _handleTabOp(payload) {
    const { requestId, op, args } = payload || {};
    const reply = (result) => ipcRenderer.send('agent-workspace:tab-op-result', { requestId, ...result });
    try {
      // A background session's ops never move the tab the user is looking at;
      // main tracks that session's active tab itself.
      const background = !!(args && args.background);
      if (op === 'open') {
        const id = this._nextLocalId();
        const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : null;
        this._createTab(id, (args && args.url) || 'about:blank', sessionId);
        const ws = this._state.get('agentWorkspace') || {};
        if (!background || !ws.currentTabId || !this._wrappers.has(ws.currentTabId)) this._setCurrent(id);
        this._broadcastState();
        reply({ ok: true, spaceId: id });
      } else if (op === 'close') {
        const id = args && args.spaceId;
        if (this._wrappers.size <= 1) return reply({ ok: false, error: 'cannot_close_last_tab' });
        if (id) this._closeTab(id);
        this._realignCurrent();
        this._broadcastState();
        reply({ ok: true });
      } else if (op === 'focus') {
        const id = args && args.spaceId;
        if (id && this._wrappers.has(id)) {
          if (!background) { this._setCurrent(id); this._broadcastState(); }
          return reply({ ok: true });
        }
        return reply({ ok: false, error: 'tab_not_found' });
      } else if (op === 'duplicate') {
        // tabsTools already converts duplicate -> open at the main side.
        reply({ ok: false, error: 'duplicate_handled_by_main' });
      } else {
        reply({ ok: false, error: 'unknown_op' });
      }
    } catch (err) {
      reply({ ok: false, error: errMsg(err) });
    }
  }

  _handleRestore(payload) {
    const tabs = (payload && Array.isArray(payload.tabs)) ? payload.tabs : [];
    const desiredCurrent = (payload && payload.currentTabId) || null;
    for (const id of Array.from(this._wrappers.keys())) this._closeTab(id);
    for (const t of tabs) {
      if (t && t.id && t.url) this._createTab(t.id, t.url);
    }
    const firstId = tabs[0] && tabs[0].id;
    this._setCurrent(desiredCurrent && this._wrappers.has(desiredCurrent) ? desiredCurrent : firstId || null);
    this._broadcastState();
  }

  /**
   * @param {string} id
   * @param {string} url
   * @param {string|null} [sessionId] the session that opened it, echoed to main on every announce
   */
  _createTab(id, url, sessionId = null) {
    if (!this._container || this._wrappers.has(id)) return;
    this._reparent();
    const wrapper = document.createElement('div');
    wrapper.className = 'agent-tab-wrapper';
    wrapper.dataset.agentTabId = id;
    const wv = document.createElement('webview');
    wv.id = id;
    wv.className = 'agent-tab-browser';
    wv.setAttribute('allowpopups', '');
    wv.src = url || 'about:blank';
    wrapper.appendChild(wv);
    this._container.appendChild(wrapper);
    this._wrappers.set(id, wrapper);

    // Register the tab with main-process tabRegistry so the agent's tools can
    // resolve spaceId -> webContents. Fire on multiple events because:
    //   - did-attach: webContents is wired up; fires BEFORE the page loads
    //     (so works even if the webview is in a hidden / display:none container
    //     where dom-ready can be deferred)
    //   - dom-ready: backup if did-attach was missed (race)
    //   - did-navigate(-in-page): rebroadcast so url/title meta stays current
    //     even if Electron's per-webContents listener attached by tabRegistry
    //     hasn't fired yet. Cheap and idempotent.
    let lastWcId = null;
    const announce = () => {
      try {
        const wcId = wv.getWebContentsId();
        if (!wcId) return;
        lastWcId = wcId;
        const ws = this._state.get('agentWorkspace') || {};
        ipcRenderer.send('space-activity', { spaceId: id, isActive: id === ws.currentTabId, webContentsId: wcId, kind: 'agent', ...(sessionId ? { sessionId } : {}) });
      } catch (_) {}
    };
    wv.addEventListener('did-attach', announce);
    wv.addEventListener('dom-ready', announce);
    wv.addEventListener('did-navigate', () => { announce(); this._broadcastState(); });
    wv.addEventListener('did-navigate-in-page', () => { announce(); this._broadcastState(); });
    wv.addEventListener('page-title-updated', () => this._broadcastState());
    // Fallback: if neither event has fired by the next tick (rare, e.g. the
    // webview was destroyed before attach), do nothing — the next focus or
    // navigation will retry.
    setTimeout(() => { if (!lastWcId) announce(); }, 250);
  }

  _closeTab(id) {
    const wrapper = this._wrappers.get(id);
    if (!wrapper) return;
    try { wrapper.remove(); } catch (_) {}
    this._wrappers.delete(id);
    // Notify main so tabRegistry drops the entry. Without this, list_tabs
    // returns stale agent-tab-* ids and the agent later tries to focus
    // tabs that no longer exist in _wrappers (-> tab_not_found).
    try { ipcRenderer.send('space-closed', { spaceId: id }); } catch (_) {}
  }

  // After a close, a current id that no longer names an open tab moves to the first remaining one.
  _realignCurrent() {
    const ws = this._state.get('agentWorkspace') || {};
    if (ws.currentTabId && this._wrappers.has(ws.currentTabId)) return;
    this._setCurrent(this._wrappers.keys().next().value || null);
  }

  _setCurrent(id) {
    for (const [tabId, wrapper] of this._wrappers) {
      wrapper.classList.toggle('is-active', tabId === id);
    }
    const ws = this._state.get('agentWorkspace') || { tabs: [], currentTabId: null };
    this._state.set('agentWorkspace', { ...ws, currentTabId: id });
  }

  _broadcastState() {
    const tabs = [];
    for (const [id, wrapper] of this._wrappers) {
      const wv = /** @type {import('electron').WebviewTag | null} */ (wrapper.querySelector('webview'));
      let url = ''; let title = '';
      try { url = (wv && wv.getURL && wv.getURL()) || (wv && wv.src) || ''; } catch (_) { url = (wv && wv.src) || ''; }
      try { title = (wv && wv.getTitle && wv.getTitle()) || ''; } catch (_) {}
      tabs.push({ id, url, title });
    }
    const ws = this._state.get('agentWorkspace') || {};
    const currentTabId = ws.currentTabId || (tabs[0] && tabs[0].id) || null;
    this._state.set('agentWorkspace', { tabs, currentTabId });
    try { ipcRenderer.send('agent-workspace:state-update', { tabs, currentTabId }); } catch (_) {}
  }

  _nextLocalId() {
    this._idSeq += 1;
    return `agent-tab-${Date.now().toString(36)}-r${this._idSeq}`;
  }

  // Public: invoked by the TabBar toggle button + keyboard shortcut.
  toggleViewMode() {
    const cur = this._state.get('viewMode');
    this._state.set('viewMode', cur === 'agent' ? 'user' : 'agent');
  }

  setViewMode(mode) {
    if (mode === 'user' || mode === 'agent') this._state.set('viewMode', mode);
  }

  // View-state operations scoped to the agent workspace. These mutate the
  // agentWorkspace slice ONLY — the user-view multiSpace / currentLayout
  // never get touched. TabBar routes its multi-space + layout toggles here
  // when viewMode === 'agent' so user state is never corrupted by an agent-
  // view click.
  toggleMulti() {
    const ws = this._state.get('agentWorkspace') || {};
    this._state.set('agentWorkspace', { ...ws, multiSpace: !ws.multiSpace });
    this._applyMultiClass();
  }
  cycleLayout() {
    // Agent view supports only the two layouts that make sense for a
    // research workspace: single-tab focus, or side-by-side compare.
    const ws = this._state.get('agentWorkspace') || {};
    const next = ws.currentLayout === 'sideBySide' ? 'single' : 'sideBySide';
    this._state.set('agentWorkspace', { ...ws, currentLayout: next });
    this._applyMultiClass();
  }
  _applyMultiClass() {
    if (!this._container) return;
    const ws = this._state.get('agentWorkspace') || {};
    const showAll = !!ws.multiSpace || ws.currentLayout === 'sideBySide';
    this._container.classList.toggle('agent-workspace-multi', showAll);
  }

  // Public: tab-management invoked by TabBar context menu in agent mode.
  // Refuses to close the last tab so the workspace always has at least one.
  closeTab(id) {
    if (!id || !this._wrappers.has(id)) return;
    if (this._wrappers.size <= 1) return;
    const ws = this._state.get('agentWorkspace') || {};
    const wasActive = ws.currentTabId === id;
    this._closeTab(id);
    if (wasActive) {
      const remaining = Array.from(this._wrappers.keys());
      this._setCurrent(remaining[0] || null);
    }
    this._broadcastState();
  }

  closeOtherTabs(id) {
    if (!id || !this._wrappers.has(id)) return;
    const others = Array.from(this._wrappers.keys()).filter((x) => x !== id);
    if (!others.length) return;
    for (const other of others) this._closeTab(other);
    this._setCurrent(id);
    this._broadcastState();
  }

  closeTabsToRight(id) {
    if (!id || !this._wrappers.has(id)) return;
    const ids = Array.from(this._wrappers.keys());
    const idx = ids.indexOf(id);
    if (idx === -1) return;
    const toClose = ids.slice(idx + 1);
    if (!toClose.length) return;
    const ws = this._state.get('agentWorkspace') || {};
    const currentWasClosed = toClose.includes(ws.currentTabId);
    for (const other of toClose) this._closeTab(other);
    if (currentWasClosed) this._setCurrent(id);
    this._broadcastState();
  }

  // Reorder the agent workspace tabs in place (TabBar drag in agent view).
  // Reorders the wrappers Map so _broadcastState keeps the order, the DOM so
  // the multi-view flex order follows, then persists via the state-update.
  reorderTabs(newOrder) {
    if (!Array.isArray(newOrder)) return;
    const ws = this._state.get('agentWorkspace') || { tabs: [] };
    const ids = (ws.tabs || []).map((t) => t.id);
    if (ids.length === 0) return; // nothing to reorder — stay quiet, no broadcast
    // Validate: newOrder must be a permutation of the current agent tab ids.
    if (newOrder.length !== ids.length) return;
    if (!newOrder.every((id) => ids.includes(id))) return;
    for (const id of newOrder) {
      const w = this._wrappers.get(id);
      if (!w) continue;
      this._wrappers.delete(id);
      this._wrappers.set(id, w);
      if (this._container) this._container.appendChild(w);
    }
    const byId = new Map((ws.tabs || []).map((t) => [t.id, t]));
    const tabs = newOrder.map((id) => {
      const t = byId.get(id) || {};
      return { id, url: t.url || '', title: t.title || '' };
    });
    this._state.set('agentWorkspace', { ...ws, tabs });
    try { ipcRenderer.send('agent-workspace:state-update', { tabs, currentTabId: ws.currentTabId || null }); } catch (_) {}
  }

  // Public: make the agent workspace visible in side-by-side so every open
  // source pane is shown at once. Used by Research Report Mode when the agent
  // opens its cited sources so the user sees them appear live.
  revealWorkspace() {
    this.setViewMode('agent');
    const ws = this._state.get('agentWorkspace') || {};
    if (ws.currentLayout !== 'sideBySide') {
      this._state.set('agentWorkspace', { ...ws, currentLayout: 'sideBySide' });
    }
    this._applyMultiClass();
  }

  // Public: bring a specific pane to the foreground. Wired to Research Report
  // citation clicks ([N] in the rendered report) — reveals the workspace,
  // marks the cited source current, scrolls it into view and flashes it.
  focusSource(spaceId) {
    const wrapper = spaceId && this._wrappers.get(spaceId);
    if (!wrapper) return false;
    this.revealWorkspace();
    this._setCurrent(spaceId);
    try { wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
    wrapper.classList.add('is-citation-flash');
    setTimeout(() => { try { wrapper.classList.remove('is-citation-flash'); } catch (_) {} }, 1200);
    return true;
  }
}

module.exports = AgentWorkspaceManager;
