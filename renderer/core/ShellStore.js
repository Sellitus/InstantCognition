// ShellStore — observable state for the assistant shell (app mode, sidebar,
// browser dock). A sibling of AppState so the shell's keys never crowd it.
// Hydrates from and persists to settings.assistant.* via configBridge.

const EventEmitter = require('events');
const defaultBridge = require('./configBridge');

const MODES = ['browser', 'assistant'];
const SIDE_PANES = ['artifacts', 'sessions', 'inbox'];
const DEFAULT_SIDEBAR_WIDTH = 420;
const DEFAULT_DOCK_WIDTH = 520;
const WIDTH_BOUNDS = {
  sidebarWidth: { min: 320, max: 960, fallback: DEFAULT_SIDEBAR_WIDTH },
  dockWidth: { min: 360, max: 1400, fallback: DEFAULT_DOCK_WIDTH },
};
const BOOLEAN_KEYS = ['sidebarOpen', 'dockOpen', 'dockUserCollapsed', 'historyRailOpen', 'annotating', 'recording'];
const PERSIST_PATHS = {
  appMode: 'settings.assistant.lastMode',
  sidebarWidth: 'settings.assistant.sidebarWidth',
  dockWidth: 'settings.assistant.dockWidth',
};

// Non-numeric, non-finite or non-positive widths are corrupt config, not a
// user choice, so they reset to the default instead of pinning to a bound.
function clampWidth(key, value) {
  const b = WIDTH_BOUNDS[key];
  if (!b) throw new TypeError(`ShellStore: ${key} is not a width key`);
  const n = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'boolean' || value === null || value === '' || !Number.isFinite(n) || n <= 0) return b.fallback;
  return Math.round(Math.min(b.max, Math.max(b.min, n)));
}

function resolveStartMode(startMode, lastMode) {
  if (startMode === 'browser' || startMode === 'assistant') return startMode;
  return MODES.includes(lastMode) ? lastMode : 'browser';
}

/**
 * @typedef {{ get: (path: string, fallback?: any) => any, set: (path: string, value: any) => void }} ShellBridge
 */

class ShellStore extends EventEmitter {
  /** @param {{ bridge?: ShellBridge }} [opts] */
  constructor(opts) {
    super();
    /** @type {ShellBridge} */
    this._bridge = (opts && opts.bridge) || defaultBridge;
    this._state = {
      appMode: 'browser',
      sidebarOpen: false,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      dockOpen: false,
      dockWidth: DEFAULT_DOCK_WIDTH,
      dockUserCollapsed: false,
      historyRailOpen: false,
      sidePane: null,
      annotating: false,
      recording: false,
    };
  }

  get(key) { return this._state[key]; }

  snapshot() { return { ...this._state }; }

  hydrate() {
    const a = this._bridge.get('settings.assistant', {}) || {};
    this._state.appMode = resolveStartMode(a.startMode, a.lastMode);
    this._state.sidebarWidth = clampWidth('sidebarWidth', a.sidebarWidth === undefined ? DEFAULT_SIDEBAR_WIDTH : a.sidebarWidth);
    this._state.dockWidth = clampWidth('dockWidth', a.dockWidth === undefined ? DEFAULT_DOCK_WIDTH : a.dockWidth);
    this.emit('change', { key: null, value: null });
    return this.snapshot();
  }

  // Throws on an invalid value: a caller passing a bad mode is a bug to surface.
  set(key, value) {
    const next = this._validate(key, value);
    if (this._state[key] === next) return false;
    this._state[key] = next;
    this.emit(`change:${key}`, next);
    this.emit('change', { key, value: next });
    if (key === 'appMode') this._bridge.set(PERSIST_PATHS.appMode, next);
    return true;
  }

  // Widths update live during a drag; only the committed value is persisted.
  commitWidth(key) {
    if (!WIDTH_BOUNDS[key]) throw new TypeError(`ShellStore: ${key} is not a width key`);
    this._bridge.set(PERSIST_PATHS[key], this._state[key]);
  }

  _validate(key, value) {
    if (key === 'appMode') {
      if (!MODES.includes(value)) throw new TypeError(`ShellStore: invalid appMode ${String(value)}`);
      return value;
    }
    if (key === 'sidePane') {
      if (value !== null && !SIDE_PANES.includes(value)) throw new TypeError(`ShellStore: invalid sidePane ${String(value)}`);
      return value;
    }
    if (WIDTH_BOUNDS[key]) return clampWidth(key, value);
    if (BOOLEAN_KEYS.includes(key)) {
      if (typeof value !== 'boolean') throw new TypeError(`ShellStore: ${key} must be boolean`);
      return value;
    }
    throw new TypeError(`ShellStore: unknown key ${String(key)}`);
  }
}

module.exports = { ShellStore, clampWidth, resolveStartMode, WIDTH_BOUNDS, MODES };
