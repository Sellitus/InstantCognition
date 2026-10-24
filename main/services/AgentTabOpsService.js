// AgentTabOpsService — RPC bridge so main-process agent tools can ask the
// renderer to create / close / focus / duplicate tabs in the agent workspace.
//
// The renderer owns the webview DOM; main cannot open a tab on its own. We
// send an `agent-workspace:tab-op` IPC with a requestId. The renderer's
// AgentWorkspaceManager (NOT SpaceManager — agent tabs are isolated from the
// user's tab bar) executes the op, replies with `agent-workspace:tab-op-result`,
// and broadcasts the new workspace state. This service keeps a Map of pending
// promises keyed by requestId.
//
// forSession(id) is the per-session surface agent runs use: ops carry the
// sessionId in their args, a tab it opens is tagged with the session in
// tabRegistry, and it refuses to close/focus/duplicate another session's tab
// or a private tab.
// A background surface marks its ops `background` so the renderer keeps the
// tab the user is looking at; the session's own active tab lives in
// tabRegistry instead.

const { safeSend } = require('../utils/safeSend');
const tabRegistry = require('./tabRegistry');

const DEFAULT_TIMEOUT = 10000;

class AgentTabOpsService {
  constructor() {
    this._mainWindow = null;
    this._ipcMain = null;
    this._pending = new Map(); // requestId -> { resolve, reject, timer }
    this._seq = 0;
  }

  bind(mainWindow, ipcMain) {
    this._mainWindow = mainWindow;
    this._ipcMain = ipcMain;
    if (!ipcMain || typeof ipcMain.on !== 'function') return;
    ipcMain.on('agent-workspace:tab-op-result', (_event, payload) => this._onResult(payload));
  }

  _onResult(payload) {
    if (!payload || !payload.requestId) return;
    const pending = this._pending.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pending.delete(payload.requestId);
    if (payload.ok) pending.resolve(payload);
    else pending.reject(new Error(payload.error || 'tab_op_failed'));
  }

  _send(op, args) {
    return new Promise((resolve, reject) => {
      const mw = this._mainWindow;
      if (!mw) { reject(new Error('no_main_window')); return; }
      const requestId = `tabop_${Date.now()}_${++this._seq}`;
      const timer = setTimeout(() => {
        if (this._pending.has(requestId)) {
          this._pending.delete(requestId);
          reject(new Error('tab_op_timeout'));
        }
      }, (args && args.timeoutMs) || DEFAULT_TIMEOUT);
      this._pending.set(requestId, { resolve, reject, timer });
      // safeSend guards both win.isDestroyed() and webContents.isDestroyed() —
      // the latter can be destroyed independently during reload/teardown. Outer
      // try/catch covers the residual race where wc.send throws between the
      // isDestroyed check and the syscall.
      try {
        if (!safeSend(mw, 'agent-workspace:tab-op', { requestId, op, args: args || {} })) {
          clearTimeout(timer);
          this._pending.delete(requestId);
          reject(new Error('no_main_window'));
        }
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        reject(err);
      }
    });
  }

  openTab(url) { return this._send('open', { url }); }
  closeTab(spaceId) { return this._send('close', { spaceId }); }
  focusTab(spaceId) { return this._send('focus', { spaceId }); }
  duplicateTab(spaceId) { return this._send('duplicate', { spaceId }); }

  /**
   * Tab ops scoped to one session. `session` is an id, null (untagged ops) or
   * a getter read per call, for a host whose session changes between runs.
   * @param {string|null|(() => string|null)} session
   * @param {{ background?: boolean }} [opts]
   */
  forSession(session, opts = {}) {
    const current = typeof session === 'function' ? session : () => session;
    const background = opts.background === true;
    const owned = (spaceId) => {
      const sid = current() || null;
      const entry = tabRegistry.get(spaceId);
      if (entry && entry.private) throw new Error('private_tab');
      if (entry && entry.sessionId && entry.sessionId !== sid) throw new Error('tab_not_owned');
      return sid;
    };
    const withSession = (args, sid) => {
      const out = sid ? { ...args, sessionId: sid } : args;
      return background ? { ...out, background: true } : out;
    };
    return {
      openTab: async (url) => {
        const sid = current() || null;
        const res = await this._send('open', withSession({ url }, sid));
        if (sid && res && res.spaceId) {
          tabRegistry.setMeta(res.spaceId, { sessionId: sid });
          tabRegistry.setSessionActive(sid, res.spaceId);
        }
        return res;
      },
      closeTab: async (spaceId) => this._send('close', withSession({ spaceId }, owned(spaceId))),
      focusTab: async (spaceId) => {
        const sid = owned(spaceId);
        const res = await this._send('focus', withSession({ spaceId }, sid));
        if (sid && res && res.ok !== false) tabRegistry.setSessionActive(sid, spaceId);
        return res;
      },
      duplicateTab: async (spaceId) => this._send('duplicate', withSession({ spaceId }, owned(spaceId))),
      forSession: (next, nextOpts) => this.forSession(next, nextOpts || opts),
    };
  }

  // Test hook
  _reset() {
    for (const { timer, reject } of this._pending.values()) {
      clearTimeout(timer);
      try { reject(new Error('reset')); } catch (_) { /* ignore — reset is best-effort cleanup, individual reject failures shouldn't abort the loop */ }
    }
    this._pending.clear();
  }
}

const instance = new AgentTabOpsService();
module.exports = instance;
module.exports.AgentTabOpsService = AgentTabOpsService;
