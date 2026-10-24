// AgentWorkspaceService — owns the agent's isolated tab workspace state.
//
// The agent's tabs are tracked SEPARATELY from the user's `state.openTabs` so
// the user's foreground tab bar stays clean while the agent browses. The
// renderer's AgentWorkspaceManager owns the actual webview elements (mounted
// in #agent-workspace-container); this service mirrors the state in the main
// process and persists it to AgentHistoryService so each conversation gets
// its own restorable tab snapshot.
//
// Lifecycle keyed on agent `taskId` (the conversation ID):
//   - setActiveConversation({taskId, isNew}): on a new task, clear and emit a
//     fresh blank tab; on a resumed task, read the saved meta and broadcast
//     a restore directive to the renderer.
//   - The renderer broadcasts state-update events back as the agent navigates
//     and the service debounces a write to the conversation's `.meta.json`.

const { errMsg } = require('../../shared/errMsg');

const DEFAULT_BLANK_URL = 'about:blank';

class AgentWorkspaceService {
  constructor() {
    this._mainWindow = null;
    this._historyService = null;
    this._configService = null;
    this._state = { tabs: [], currentTabId: null, conversationId: null };
    this._persistTimer = null;
    this._persistDelayMs = 250;
    this._seq = 0;
  }

  bindWindow(mainWindow) { this._mainWindow = mainWindow; }
  bindHistory(historyService) { this._historyService = historyService; }
  bindConfig(configService) { this._configService = configService; }

  getState() { return JSON.parse(JSON.stringify(this._state)); }

  // Bind the workspace's current state to a freshly-minted taskId (e.g. after
  // agent:task-started fires). No clear/restore — just retags so subsequent
  // state-update broadcasts persist to <taskId>.meta.json.
  bindConversationId(taskId) {
    this._state.conversationId = taskId || null;
    this._schedulePersist();
  }

  // Called by AgentPanel before agent:start. New conversation -> clear and
  // open one fresh tab. Existing conversation -> load the saved snapshot
  // from .meta.json and tell the renderer to restore.
  setActiveConversation({ taskId, isNew }) {
    const id = taskId || null;
    this._state.conversationId = id;
    if (isNew || !id) {
      this._reset();
      const homeUrl = this._configService
        ? (this._configService.get('settings.browserHomeUrl', DEFAULT_BLANK_URL) || DEFAULT_BLANK_URL)
        : DEFAULT_BLANK_URL;
      this._broadcast('agent-workspace:restore', {
        tabs: [{ id: this._nextId(), url: homeUrl }],
        currentTabId: null, // renderer picks first
      });
      return;
    }
    const meta = this._readMeta(id);
    const saved = meta && meta.agentWorkspace;
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
      this._state.tabs = saved.tabs.map((t) => ({ id: t.id, url: t.url }));
      this._state.currentTabId = saved.currentTabId || (saved.tabs[0] && saved.tabs[0].id) || null;
      this._broadcast('agent-workspace:restore', {
        tabs: this._state.tabs.slice(),
        currentTabId: this._state.currentTabId,
      });
    } else {
      // Conversation exists but has no saved workspace — treat as new.
      this._reset();
      const homeUrl = this._configService
        ? (this._configService.get('settings.browserHomeUrl', DEFAULT_BLANK_URL) || DEFAULT_BLANK_URL)
        : DEFAULT_BLANK_URL;
      this._broadcast('agent-workspace:restore', {
        tabs: [{ id: this._nextId(), url: homeUrl }],
        currentTabId: null,
      });
    }
  }

  // Receive an authoritative state snapshot from the renderer after the
  // workspace has changed (tab opened/closed/focused, URL changed). The
  // renderer is the source of truth for what's actually loaded; we mirror
  // here for read-back to other consumers and persist.
  applyStateFromRenderer({ tabs, currentTabId }) {
    if (!Array.isArray(tabs)) return;
    this._state.tabs = tabs.map((t) => ({
      id: String(t.id || ''),
      url: String(t.url || ''),
      title: t.title ? String(t.title) : undefined,
    })).filter((t) => t.id);
    this._state.currentTabId = currentTabId ? String(currentTabId) : (this._state.tabs[0] && this._state.tabs[0].id) || null;
    this._schedulePersist();
  }

  // Replace the workspace's tab set with persona starter tabs. Called by
  // AgentService.startTask after the router resolves a persona that has
  // starterTabs defined. No-op if the list is empty or this is a follow-up
  // conversation (avoids overwriting tabs the agent already opened).
  seedStarterTabs(starterTabs) {
    if (!Array.isArray(starterTabs) || starterTabs.length === 0) return;
    const tabs = starterTabs
      .filter((t) => t && (typeof t === 'string' ? true : !!t.url))
      .slice(0, 6)
      .map((t) => ({ id: this._nextId(), url: typeof t === 'string' ? t : String(t.url) }));
    if (!tabs.length) return;
    this._state.tabs = tabs.slice();
    this._state.currentTabId = tabs[0].id;
    this._broadcast('agent-workspace:restore', { tabs: tabs.slice(), currentTabId: tabs[0].id });
    this._schedulePersist();
  }

  _nextId() {
    this._seq += 1;
    return `agent-tab-${Date.now().toString(36)}-${this._seq}`;
  }

  _reset() {
    this._state.tabs = [];
    this._state.currentTabId = null;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
  }

  _broadcast(channel, payload) {
    const mw = this._mainWindow;
    if (!mw || (typeof mw.isDestroyed === 'function' && mw.isDestroyed())) return;
    try { mw.webContents.send(channel, payload); } catch (_) { /* ignore */ }
  }

  _schedulePersist() {
    if (!this._historyService || !this._state.conversationId) return;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistNow();
    }, this._persistDelayMs);
  }

  _persistNow() {
    const id = this._state.conversationId;
    if (!id || !this._historyService || typeof this._historyService.writeMeta !== 'function') return;
    try {
      this._historyService.writeMeta(id, {
        agentWorkspace: {
          tabs: this._state.tabs.map((t) => ({ id: t.id, url: t.url })),
          currentTabId: this._state.currentTabId,
        },
      });
    } catch (err) {
      console.warn('[agent-workspace] persist failed:', errMsg(err));
    }
  }

  _readMeta(id) {
    if (!this._historyService || typeof this._historyService.readMeta !== 'function') return null;
    try { return this._historyService.readMeta(id); } catch (_) { return null; }
  }

  // Test hooks
  _flushPersist() { if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; this._persistNow(); } }
  _setPersistDelay(ms) { this._persistDelayMs = Math.max(0, ms || 0); }
}

const instance = new AgentWorkspaceService();
module.exports = instance;
module.exports.AgentWorkspaceService = AgentWorkspaceService;
