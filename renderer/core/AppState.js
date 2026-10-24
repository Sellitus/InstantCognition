const EventEmitter = require('events');

/**
 * Centralized application state for the renderer process.
 * Replaces 25+ global variables with an observable state container.
 * Modules subscribe to state changes instead of accessing globals.
 */
class AppState extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._state = {
      // Space state
      activeSpaces: {},
      currentSpaceId: '',
      loadedSpaces: {},
      defaultSpace: 'custom1',
      spaces: {},
      spaceOrder: [],
      fullNames: {},

      // Tab model (Phase 1 refactor — ordered, decoupled from library)
      openTabs: [],
      hiddenTabs: [],
      pinnedTabs: [],
      adHocSpaces: {},
      chromeLayout: 'left',

      // View state. viewMode='user'|'agent' swaps tab bar to agent workspace
      // (isolated tab area, not persisted across sessions).
      multiSpace: false,
      browserViewActive: false,
      spaceViewActive: true,
      currentLayout: 'single',
      openLinkExternal: false,
      viewMode: 'user',
      agentWorkspace: { tabs: [], currentTabId: null, multiSpace: false, currentLayout: 'single', hiddenTabs: [] },
      // UI state
      sidebarExpanded: false,
      menuExpanded: false,
      findBarVisible: false,

      // Config reference
      config: null,
    };
    this._batchDepth = 0;
    this._batchedChanges = [];
  }

  /**
   * Get a state value. Returns a LIVE reference for object/array values —
   * treat read-only; mutating in place skips the change event.
   */
  get(key) {
    return this._state[key];
  }

  /**
   * Set a state value. Emits 'change:key' if value changed.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    const oldValue = this._state[key];
    this._state[key] = value;

    if (oldValue !== value) {
      if (this._batchDepth > 0) {
        this._batchedChanges.push({ key, newValue: value, oldValue });
      } else {
        this.emit(`change:${key}`, value, oldValue);
        this.emit('change', { key, newValue: value, oldValue });
      }
    }
  }

  /**
   * Get a shallow copy of the entire state.
   * Mutations to the returned object don't affect internal state.
   * @returns {object}
   */
  getAll() {
    return { ...this._state };
  }

  /**
   * Batch multiple state changes. Change events are emitted
   * after the batch function completes, with duplicates suppressed.
   * @param {Function} fn - function that calls set() multiple times
   */
  batch(fn) {
    this._batchDepth++;
    try {
      fn();
    } finally {
      this._batchDepth--;
      if (this._batchDepth === 0 && this._batchedChanges.length > 0) {
        // Deduplicate by key — keep last newValue but FIRST oldValue (pre-batch state)
        const seen = new Map();
        for (const change of this._batchedChanges) {
          if (seen.has(change.key)) {
            // Update newValue but keep original oldValue
            const existing = seen.get(change.key);
            existing.newValue = change.newValue;
          } else {
            seen.set(change.key, { ...change });
          }
        }
        this._batchedChanges = [];

        for (const change of seen.values()) {
          this.emit(`change:${change.key}`, change.newValue, change.oldValue);
          this.emit('change', change);
        }
      }
    }
  }

  /**
   * Initialize state from a loaded config object.
   * @param {object} config - full config from disk
   */
  initFromConfig(config) {
    if (!config) return;

    this._state.config = config;

    if (config.spaces) {
      this._state.spaces = config.spaces;
    }
    if (config.spaceOrder) {
      this._state.spaceOrder = config.spaceOrder;
    }
    if (config.settings) {
      this._state.multiSpace = config.settings.multiSpace || false;
      this._state.openLinkExternal = config.settings.openLinkExternal || false;
      this._state.defaultSpace = config.settings.defaultSpace || 'custom1';
      const cl = config.settings.chromeLayout;
      this._state.chromeLayout = cl === 'sidebar' ? 'left'
        : cl === 'topBar' ? 'top'
        : (['top', 'bottom', 'left', 'right'].includes(cl) ? cl : 'left');
    }
    if (config.state && Array.isArray(config.state.openTabs)) {
      this._state.openTabs = config.state.openTabs.slice();
    } else if (config.state && Array.isArray(config.state.activeSpaces)) {
      this._state.openTabs = config.state.activeSpaces.slice();
    }
    if (config.state && Array.isArray(config.state.hiddenTabs)) {
      this._state.hiddenTabs = config.state.hiddenTabs.slice();
    }
    if (config.state && Array.isArray(config.state.pinnedTabs)) {
      this._state.pinnedTabs = config.state.pinnedTabs.slice();
    }
    if (config.state && config.state.adHocSpaces && typeof config.state.adHocSpaces === 'object') {
      this._state.adHocSpaces = { ...config.state.adHocSpaces };
    }
    // currentSpaceId: prefer explicit persisted value; legacy fallback to
    // activeSpaces tail. Validate it still exists in openTabs.
    const cs = config.state || {};
    const persisted = typeof cs.currentSpaceId === 'string' ? cs.currentSpaceId : null;
    const legacy = Array.isArray(cs.activeSpaces) && cs.activeSpaces.length ? cs.activeSpaces[cs.activeSpaces.length - 1] : null;
    const candidate = persisted || legacy;
    this._state.currentSpaceId = (candidate && this._state.openTabs.includes(candidate)) ? candidate : (this._state.openTabs[0] || this._state.defaultSpace);
    // Prune pinnedTabs against known ids so deleted spaces don't linger.
    const known = new Set(Object.keys(config.spaces || {}).concat(Object.keys(this._state.adHocSpaces || {})));
    if (this._state.pinnedTabs.length && known.size) {
      this._state.pinnedTabs = this._state.pinnedTabs.filter((id) => known.has(id));
    }
  }
}

module.exports = AppState;
