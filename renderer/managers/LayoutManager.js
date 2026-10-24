const { createLayout } = require('../layouts/LayoutRegistry');
const fx = require('../fx');

class LayoutManager {
  constructor(state) {
    this.state = state;
    this.currentLayout = null;
    this.currentLayoutName = null;
    this.container = null;
    // Optional SpaceManager ref for defense-in-depth wrapper creation in refresh().
    // SpaceManager is the canonical owner of wrappers; if a caller bypasses the
    // reconciler and sets activeSpaces directly, refresh() will still ensure the
    // DOM exists for every active id before the layout iterates wrappers.
    this._spaceManager = null;
  }

  setSpaceManager(spaceManager) {
    this._spaceManager = spaceManager;
  }

  initialize() {
    this.container = document.getElementById('space-container');
    const multiSpace = this.state.get('multiSpace');
    const config = this.state.get('config');
    const savedLayout = config && config.settings && config.settings.lastLayout;
    this.setLayout(multiSpace ? (savedLayout || 'sideBySide') : 'single');

    this.state.on('change:multiSpace', (enabled) => {
      const config = this.state.get('config');
      const savedLayout = config && config.settings && config.settings.lastLayout;
      this.setLayout(enabled ? (savedLayout || 'sideBySide') : 'single');
    });

    this.state.on('change:activeSpaces', () => {
      this.refresh();
    });

    this.state.on('change:currentSpaceId', () => {
      this.refresh();
    });

    this.state.on('change:openTabs', () => {
      this.refresh();
    });

    this.state.on('change:hiddenTabs', () => {
      this.refresh();
    });
  }

  setLayout(name) {
    if (this.currentLayoutName === name) return;

    if (this.currentLayout && this.container) {
      this.currentLayout.teardown(this.container);
    }

    this.currentLayoutName = name;
    this.currentLayout = createLayout(name);
    this.state.set('currentLayout', name);
    this.refresh();
  }

  refresh() {
    if (!this.currentLayout || !this.container) return;
    const activeSpaces = this.state.get('activeSpaces') || {};
    // Defence in depth: if any caller set activeSpaces directly (bypassing
    // SpaceManager._syncActiveSpaces), make sure every active id has a wrapper
    // before the layout iterates. Without this, the layout silently skips
    // tabs that have no DOM wrapper.
    if (this._spaceManager && typeof this._spaceManager._ensureWrapper === 'function') {
      for (const id of Object.keys(activeSpaces)) {
        if (activeSpaces[id]) this._spaceManager._ensureWrapper(id);
      }
    }
    // Pass openTabs as the ordering source. Layouts use it for CSS flex `order`
    // so drag-reorder in the tab bar immediately reorders the multi-view.
    // Falls back to spaceOrder for legacy call paths during migration.
    const openTabs = this.state.get('openTabs');
    const orderSource = Array.isArray(openTabs) && openTabs.length > 0
      ? openTabs
      : this.state.get('spaceOrder');
    const settle = fx.layoutBeforeApply(this.container);
    this.currentLayout.apply(
      this.container,
      activeSpaces,
      this.state.get('currentSpaceId'),
      orderSource
    );
    settle();
  }

  getLayoutName() {
    return this.currentLayoutName;
  }
}

module.exports = LayoutManager;
