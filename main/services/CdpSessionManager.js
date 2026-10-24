// CdpSessionManager — thin wrapper around Electron's webContents.debugger
// (Chrome DevTools Protocol 1.3). One session per WebContents, lazy attach.
//
// Agent tools call send(wc, method, params) to drive real pointer/keyboard
// events, accessibility-tree queries, and DOM box models. When attach fails
// (e.g. DevTools already open) callers can detect isAttached(wc) and fall
// back to the existing executeJavaScript path.
//
// Also caches the most recent AX snapshot per WebContents so subsequent
// idx-based actions can resolve element references without re-snapshotting.

const DEFAULT_PROTOCOL = '1.3';

class CdpSessionManager {
  constructor() {
    this._sessions = new Map(); // webContentsId -> { wc, attached, snapshot, snapshotToken }
  }

  _getOrCreate(wc) {
    const id = wc && typeof wc.id === 'number' ? wc.id : (wc && wc.getWebContentsId ? wc.getWebContentsId() : null);
    if (id == null) throw new Error('webContents has no id');
    let s = this._sessions.get(id);
    if (!s) {
      s = { id, wc, attached: false, snapshot: null, snapshotToken: null, destroyed: false,
        staleDueToNavigation: false, lastNavigatedUrl: null };
      this._sessions.set(id, s);
      if (typeof wc.once === 'function') {
        wc.once('destroyed', () => {
          s.destroyed = true;
          this._sessions.delete(id);
        });
      }
      // A navigation (full or in-page/SPA route change) invalidates the cached
      // AX snapshot — idx values from the prior page no longer resolve. Marking
      // it stale (rather than just null) lets resolveIdx tell the model *why*.
      const onNavigate = (url) => {
        if (!s || s.destroyed) return;
        s.snapshot = null;
        s.snapshotToken = null;
        s.staleDueToNavigation = true;
        s.lastNavigatedUrl = url || null;
      };
      if (typeof wc.on === 'function') {
        wc.on('did-navigate', (_e, url) => onNavigate(url));
        wc.on('did-navigate-in-page', (_e, url) => onNavigate(url));
      }
    }
    return s;
  }

  isAttached(wc) {
    try {
      const s = this._sessions.get(wc && wc.id);
      return !!(s && s.attached && wc && wc.debugger && wc.debugger.isAttached());
    } catch (_) { return false; }
  }

  // Returns true on success, false if attach failed. Never throws.
  tryAttach(wc) {
    try {
      if (!wc || !wc.debugger) return false;
      const s = this._getOrCreate(wc);
      if (s.destroyed) return false;
      if (wc.debugger.isAttached()) { s.attached = true; return true; }
      wc.debugger.attach(DEFAULT_PROTOCOL);
      s.attached = true;
      return true;
    } catch (_) { return false; }
  }

  // Throws on failure — callers that want fallback should use tryAttach first.
  attach(wc) {
    if (!this.tryAttach(wc)) throw new Error('cdp_attach_failed');
  }

  detach(wc) {
    try {
      const s = this._sessions.get(wc && wc.id);
      if (!s) return;
      if (wc.debugger && wc.debugger.isAttached()) wc.debugger.detach();
      s.attached = false;
    } catch (_) { /* best effort */ }
  }

  async send(wc, method, params) {
    if (!this.isAttached(wc) && !this.tryAttach(wc)) throw new Error('cdp_not_attached');
    return wc.debugger.sendCommand(method, params || {});
  }

  // Snapshot cache helpers — tools store the normalized AX snapshot so that
  // subsequent idx-based actions (click_idx, hover_idx, type_text with idx)
  // can resolve element references without re-querying the full AX tree.
  setSnapshot(wc, snapshot) {
    const s = this._getOrCreate(wc);
    s.snapshot = snapshot || null;
    s.snapshotToken = snapshot && snapshot.token ? snapshot.token : null;
    s.staleDueToNavigation = false;
  }

  getSnapshot(wc) {
    const s = this._sessions.get(wc && wc.id);
    return s ? s.snapshot : null;
  }

  // True if the page navigated since the last snapshot_ax was cached. Tools
  // surface this to the model so it re-snapshots instead of guessing idx.
  isStaleDueToNavigation(wc) {
    const s = this._sessions.get(wc && wc.id);
    return !!(s && s.staleDueToNavigation);
  }

  // Reset state for tests
  _reset() { this._sessions.clear(); }
}

const instance = new CdpSessionManager();
module.exports = instance;
module.exports.CdpSessionManager = CdpSessionManager;
