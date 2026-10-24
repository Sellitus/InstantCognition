// configBridge — granular renderer ↔ main config IPC.
//
// Replaces the legacy `saveSettings(fullConfig)` pattern (which ships the
// entire config tree on every keystroke) with path-based set/update calls.
// Maintains a local cached snapshot loaded once via 'config:get-sync' at
// startup; mutations are sent immediately, and the main process re-broadcasts
// 'config:changed' so the cache stays current across renderer modules.
//
// Public API:
//   bridge.get(path, fallback?)      — dotted-path read from the local cache
//   bridge.set(path, value)          — fire-and-forget single-path write
//   bridge.update(partial)           — deep-merge partial into config
//   bridge.replace(cfg)              — full replace (legacy fallback)
//   bridge.onChange(handler)         — subscribe to all changes
//   bridge.onPathChange(path, fn)    — subscribe to a specific dotted path
//   bridge.refresh()                 — re-read from main (returns the snapshot)
//   bridge.snapshot()                — clone of the cached config

let ipcRenderer;
try {
  ({ ipcRenderer } = require('electron'));
} catch (_) {
  ipcRenderer = { send: () => {}, on: () => {}, sendSync: () => ({ config: null, resetReason: null }), invoke: () => Promise.resolve({ config: null, resetReason: null }) };
}

class ConfigBridge {
  constructor() {
    this._config = null;
    this._listeners = new Set();
    this._pathListeners = new Map(); // path -> Set<fn>
    this._wired = false;
  }

  initialize(initialConfig) {
    if (initialConfig && typeof initialConfig === 'object') {
      this._config = JSON.parse(JSON.stringify(initialConfig));
    }
    if (!this._wired) {
      ipcRenderer.on('config:changed', (_event, payload) => this._onIncomingChange(payload));
      this._wired = true;
    }
  }

  refresh() {
    try {
      const result = ipcRenderer.sendSync('config:get-sync');
      if (result && result.config) {
        this._config = JSON.parse(JSON.stringify(result.config));
      }
    } catch (err) {
      // Fail visible: a failed re-read leaves the cached snapshot stale, so
      // surface it instead of hiding the divergence.
      console.error('[configBridge] refresh() failed; cached snapshot may be stale:', err instanceof Error ? err.message : err);
    }
    return this.snapshot();
  }

  snapshot() {
    return this._config ? JSON.parse(JSON.stringify(this._config)) : null;
  }

  get(keyPath, fallback) {
    if (!this._config || !keyPath) return fallback;
    const parts = String(keyPath).split('.');
    let cur = this._config;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return fallback;
      cur = cur[p];
    }
    return cur === undefined ? fallback : cur;
  }

  set(keyPath, value) {
    if (!keyPath) return;
    if (typeof keyPath === 'string' && keyPath.split('.').some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) {
      return;
    }
    // Send first: a value IPC cannot clone throws here, before the cache diverges.
    ipcRenderer.send('config:set', { path: keyPath, value });
    this._applyLocal(keyPath, value);
  }

  update(partial) {
    if (!partial || typeof partial !== 'object') return;
    ipcRenderer.send('config:update', partial);
    if (this._config) this._deepMerge(this._config, partial);
  }

  replace(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    ipcRenderer.send('config:replace', cfg);
    this._config = JSON.parse(JSON.stringify(cfg));
  }

  onChange(handler) {
    if (typeof handler !== 'function') return () => {};
    this._listeners.add(handler);
    return () => this._listeners.delete(handler);
  }

  onPathChange(keyPath, handler) {
    if (!keyPath || typeof handler !== 'function') return () => {};
    if (!this._pathListeners.has(keyPath)) this._pathListeners.set(keyPath, new Set());
    this._pathListeners.get(keyPath).add(handler);
    return () => {
      const set = this._pathListeners.get(keyPath);
      if (set) set.delete(handler);
    };
  }

  // -- internals ----------------------------------------------------------

  _applyLocal(keyPath, value) {
    if (!this._config) return;
    const parts = String(keyPath).split('.');
    let cur = this._config;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
  }

  // Every subscriber runs even when one throws; the failures are rethrown
  // together afterwards so they reach the renderer error handler.
  _onIncomingChange(payload) {
    if (!payload || typeof payload !== 'object') return;
    const errors = [];
    if (payload.kind === 'set' && payload.path) {
      this._applyLocal(payload.path, payload.newValue);
      this._notifyPath(payload.path, payload.newValue, payload.oldValue, errors);
    } else if (payload.kind === 'update' || payload.kind === 'replace') {
      // Bulk mutations: refresh the cache so reads stay accurate, then replay
      // the per-path listeners for every registered path whose value the
      // bulk write actually changed — otherwise long-lived subscribers
      // (e.g. the chat panel's route mode / feature flags) stay stale after
      // a settings reset until some other set lands on the same path.
      const before = this._config;
      this.refresh();
      this._replayPathListeners(before, this._config, errors);
    }
    for (const fn of this._listeners) {
      try { fn(payload, this._config); } catch (err) { errors.push(err); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, `[configBridge] ${errors.length} config listeners failed`);
  }

  _notifyPath(keyPath, newValue, oldValue, errors) {
    const set = this._pathListeners.get(keyPath);
    if (!set) return;
    for (const fn of set) {
      try { fn(newValue, oldValue); } catch (err) { errors.push(err); }
    }
  }

  // After a bulk update/replace, fire every path listener whose dotted value
  // differs between `before` and `after`. Unchanged paths stay quiet so a no-op
  // broadcast does not cause a cascade of re-hydrations.
  _replayPathListeners(before, after, errors) {
    for (const [keyPath, set] of this._pathListeners) {
      const oldValue = this._readPath(before, keyPath);
      const newValue = this._readPath(after, keyPath);
      if (oldValue === newValue) continue;
      for (const fn of set) {
        try { fn(newValue, oldValue); } catch (err) { errors.push(err); }
      }
    }
  }

  _readPath(cfg, keyPath) {
    if (!cfg) return undefined;
    const parts = String(keyPath).split('.');
    let cur = cfg;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur;
  }

  _deepMerge(target, source) {
    for (const key of Object.keys(source)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const sv = source[key];
      if (sv && typeof sv === 'object' && !Array.isArray(sv)
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        this._deepMerge(target[key], sv);
      } else {
        target[key] = sv;
      }
    }
  }
}

module.exports = new ConfigBridge();
