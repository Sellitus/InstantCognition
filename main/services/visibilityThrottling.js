// visibilityThrottling — main-window resource coordinator.
//
// HAZARD — never call `setBackgroundThrottling()` on a hidden widget. Electron
// force-calls `RenderWidgetHostImpl::WasShown()` when the widget is hidden,
// clearing `is_hidden_` while it is really still hidden. The next genuine show
// then skips `DelegatedFrameHost::WasShown` / `FrameEvictor::SetVisible(true)`,
// so the FrameEvictor still believes the surface is invisible and evicts the
// compositor frames on its ~5 minute timer — the pane renders blank until the
// app restarts (electron#42378, electron#50250, the latter closed as
// not-planned, so there is no upstream fix to wait for). Every call goes through
// `_syncThrottle`, which pushes only while the window is visible and otherwise
// defers to the next show.
//
// The hidden-window CPU savings do not depend on any of that: the window is
// created with Electron's default `backgroundThrottling: true`, so Chromium's
// own page-visibility path already idles rAF/setInterval in hidden webviews.
// This module deliberately never re-asserts it. Two seams live here:
//
//   • The agent override — an in-flight run lifts throttling so the guest's own
//     timers keep firing, and it is the only reason this module calls
//     `setBackgroundThrottling` at all. A run that *begins* while hidden stays
//     throttled until the next show; main-process-driven tools
//     (executeJavaScript, CDP, LLM streaming) are unaffected either way.
//
//   • The suspend/resume pub-sub, which parks heavyweight services (local LLM
//     subprocess, MCP servers, adblock auto-update, periodic GC) while hidden.
//     Subscribers get `suspend` on hide (gated by the same agent-active
//     override) and `resume` on show — one coordination point, so a future
//     "Pause while gaming" setting has exactly one switch to flip.

const { webContents } = require('electron');

// Guest visibility propagates asynchronously from the embedder, so
// `mainWindow.isVisible()` flipping to true does not yet mean the guests'
// RenderWidgetHosts have left the hidden state. Outlast that gap.
const THROTTLE_APPLY_DELAY_MS = 250;

class VisibilityThrottling {
  constructor() {
    this._window = null;
    this._session = null;
    this._agentActive = false;   // an agent run is currently in flight
    this._hidden = false;        // main window is currently hidden
    this._muted = false;         // audio-mute policy currently pushed
    // Electron's creation-time default. Tracks what we last pushed so a deferred
    // sync knows whether a diff is still outstanding.
    this._throttleApplied = true;
    this._applyTimer = null;
    this._unsubAgent = [];
    this._unsubWindow = [];
    this._suspendSubs = new Set();
    this._resumeSubs = new Set();
  }

  bind({ mainWindow, session, agentService }) {
    this._window = mainWindow || null;
    this._session = session || null;

    if (this._window && typeof this._window.on === 'function') {
      const onShow = () => this._setHidden(false);
      const onHide = () => this._setHidden(true);
      const onMinimize = () => this._setHidden(true);
      const onRestore = () => this._setHidden(false);
      this._window.on('show', onShow);
      this._window.on('hide', onHide);
      this._window.on('minimize', onMinimize);
      this._window.on('restore', onRestore);
      this._unsubWindow.push(() => this._safeOff(this._window, 'show', onShow));
      this._unsubWindow.push(() => this._safeOff(this._window, 'hide', onHide));
      this._unsubWindow.push(() => this._safeOff(this._window, 'minimize', onMinimize));
      this._unsubWindow.push(() => this._safeOff(this._window, 'restore', onRestore));
    }

    if (agentService && typeof agentService.on === 'function') {
      const onStart = () => this._setAgentActive(true);
      const onEnd = () => this._setAgentActive(false);
      agentService.on('task-started', onStart);
      agentService.on('task-completed', onEnd);
      agentService.on('task-failed', onEnd);
      this._unsubAgent.push(() => {
        if (typeof agentService.removeListener === 'function') {
          agentService.removeListener('task-started', onStart);
          agentService.removeListener('task-completed', onEnd);
          agentService.removeListener('task-failed', onEnd);
        }
      });
    }
  }

  onSuspend(fn) {
    if (typeof fn !== 'function') return () => {};
    this._suspendSubs.add(fn);
    return () => this._suspendSubs.delete(fn);
  }

  onResume(fn) {
    if (typeof fn !== 'function') return () => {};
    this._resumeSubs.add(fn);
    return () => this._resumeSubs.delete(fn);
  }

  _safeOff(emitter, event, listener) {
    try {
      if (emitter && typeof emitter.removeListener === 'function') emitter.removeListener(event, listener);
    } catch (err) {
      // removeListener on a destroyed emitter is the only expected failure.
      console.error('visibilityThrottling: removeListener failed for', event, ':', err instanceof Error ? err.message : err);
    }
  }

  _setHidden(hidden) {
    if (this._hidden === hidden) return;
    this._hidden = !!hidden;
    this._recompute();
  }

  _setAgentActive(active) {
    if (this._agentActive === active) return;
    this._agentActive = !!active;
    this._recompute();
  }

  _recompute() {
    // Suspend is gated by the same agent-active override as throttling: a
    // running agent keeps the subprocess and timers alive even while hidden.
    const shouldSuspend = this._hidden && !this._agentActive;
    this._applyMute(shouldSuspend);
    this._syncThrottle();
    if (shouldSuspend) this._fireSubs(this._suspendSubs);
    else this._fireSubs(this._resumeSubs);
  }

  _fireSubs(subs) {
    for (const fn of subs) {
      try { fn(); } catch (err) {
        console.error('visibilityThrottling: subscriber failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  // Audio mute tracks visibility so a hidden webview cannot keep audio threads
  // warm on Windows. Unlike setBackgroundThrottling this carries no visibility
  // side effect, so it applies immediately on hide. The prior mute state is
  // cached so resume restores exactly what the user / site asked for.
  _applyMute(muted) {
    if (muted === this._muted) return;
    this._muted = muted;

    for (const wc of this._collectWebContents()) {
      if (!wc || typeof wc.setAudioMuted !== 'function' || typeof wc.isAudioMuted !== 'function') continue;
      if (muted) {
        try {
          if (!wc.isAudioMuted()) {
            wc.__icPrevAudioMuted = false;
            wc.setAudioMuted(true);
          } else {
            wc.__icPrevAudioMuted = true;
          }
        } catch (_) { /* race on destroy */ }
      } else if (wc.__icPrevAudioMuted === false) {
        try { wc.setAudioMuted(false); } catch (_) { /* race on destroy */ }
        wc.__icPrevAudioMuted = undefined;
      }
    }
  }

  // Schedule the agent override (or its removal) onto every webContents. The
  // push is deferred and re-guarded on visibility because calling
  // setBackgroundThrottling against a hidden widget blanks the pane — see the
  // HAZARD note at the top of the file. A push that cannot run now is picked up
  // by the next _recompute; window show always fires one, so no state is lost.
  _syncThrottle() {
    const desired = !this._agentActive;
    if (desired === this._throttleApplied) return;
    if (this._applyTimer) return;
    this._applyTimer = setTimeout(() => {
      this._applyTimer = null;
      this._flushThrottle();
    }, THROTTLE_APPLY_DELAY_MS);
    if (typeof this._applyTimer.unref === 'function') this._applyTimer.unref();
  }

  _flushThrottle() {
    const desired = !this._agentActive;
    if (desired === this._throttleApplied) return;
    if (!this._windowIsVisible()) return;

    for (const wc of this._collectWebContents()) {
      if (!wc || typeof wc.setBackgroundThrottling !== 'function') continue;
      try { wc.setBackgroundThrottling(desired); } catch (_) { /* race on destroy */ }
    }
    this._throttleApplied = desired;
  }

  _windowIsVisible() {
    const win = this._window;
    if (!win || typeof win.isVisible !== 'function') return false;
    try {
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;
      return !!win.isVisible();
    } catch (_) {
      // The window can be torn down between the guard and the call.
      return false;
    }
  }

  // A Set, not an array: the owner window's own webContents is also returned by
  // session.getAllWebContents(), and applying a policy to it twice is at best
  // wasted work.
  _collectWebContents() {
    const out = new Set();
    if (this._window && typeof this._window.webContents !== 'undefined' && this._window.webContents) {
      out.add(this._window.webContents);
    }
    const session = this._session;
    const all = [];
    if (session && typeof session.getAllWebContents === 'function') {
      try { for (const wc of session.getAllWebContents()) all.push(wc); }
      catch (_) { /* session may be torn down */ }
    } else if (webContents && typeof webContents.getAllWebContents === 'function') {
      try { for (const wc of webContents.getAllWebContents()) all.push(wc); }
      catch (_) { /* ignore */ }
    }
    for (const wc of all) {
      if (!wc) continue;
      // Skip contents hosted by a *different, visible* window — a shown OAuth
      // popup must keep running even while the main app is hidden. When the
      // owner can't be determined, include it (default to the main window's
      // policy) so its webview tabs are never missed on a false exclusion.
      if (this._hostedByVisibleOtherWindow(wc)) continue;
      out.add(wc);
    }
    return out;
  }

  _hostedByVisibleOtherWindow(wc) {
    if (!wc || typeof wc.getOwnerBrowserWindow !== 'function') return false;
    try {
      const owner = wc.getOwnerBrowserWindow();
      if (!owner || owner === this._window) return false;
      return !!(owner.isVisible && owner.isVisible());
    } catch (_) { return false; }
  }

  dispose() {
    if (this._applyTimer) {
      clearTimeout(this._applyTimer);
      this._applyTimer = null;
    }
    for (const off of [...this._unsubWindow, ...this._unsubAgent]) {
      try { off(); }
      catch (err) { console.error('visibilityThrottling: dispose listener failed:', err instanceof Error ? err.message : err); }
    }
    this._unsubWindow.length = 0;
    this._unsubAgent.length = 0;
    this._suspendSubs.clear();
    this._resumeSubs.clear();
    this._window = null;
    this._session = null;
  }
}

module.exports = new VisibilityThrottling();
module.exports.VisibilityThrottling = VisibilityThrottling;
