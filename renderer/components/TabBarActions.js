// TabBarActions.js — the controls at the end of the tab strip: a More menu
// holding the view and page toggles, an Assistant-view pill that flips the
// app mode, labeled Assistant and Library pills, a
// Settings button, and an Update pill that appears only while an app update
// waits: a downloaded one for a restart, or one this build can only download. Toggle state lives in AppState, so the menu re-reads it
// on every open and the More button carries a dot while any toggle is off its
// default. View toggles route to the agent workspace while the agent view is
// active so they never mutate user-view state.

let ipcRenderer;
try { ({ ipcRenderer } = require('electron')); } catch (_) { ipcRenderer = null; }

const { icon } = require('./Icon');
const Menu = require('./menu/Menu');
const Tooltip = require('./Tooltip');
const toast = require('./Toast');
const { confirm } = require('./ConfirmDialog');
const shortcutManager = require('../utils/shortcuts');
const { formatShortcut } = require('../utils/shortcuts');
const { unreadCount } = require('./assistant/InboxPane');

const LAYOUT_NAMES = { single: 'Single', sideBySide: 'Side by side', grid: 'Grid', stacked: 'Stacked', twoRow: 'Two rows' };

// `defaultOn` marks the toggle's resting state; the More dot lights when any
// toggle differs from it. `dot:false` keeps a mode toggle off the dot, and
// `requires` names the panel an entry needs, so an unwired one never renders.
const MENU_ACTIONS = [
  { id: 'tabbar-assistant-view', icon: 'panelLeft', label: 'Assistant View',  action: 'flip',          toggle: true, group: 'View', shortcut: 'view.flip', requires: 'viewShell', dot: false },
  { id: 'tabbar-multi-space',    icon: 'multi',    label: 'Multi-Space',           action: 'multiSpace',    toggle: true, group: 'View', shortcut: 'view.multiSpace' },
  { id: 'tabbar-layout',         icon: 'layout',   label: 'Cycle Layout',          action: 'layout',                      group: 'View' },
  { id: 'tabbar-space-view',     icon: 'tab',      label: 'Space View',            action: 'spaceView',     toggle: true, group: 'View', shortcut: 'view.space', defaultOn: true },
  { id: 'tabbar-browser-view',   icon: 'screen',   label: 'Browser View',          action: 'browserView',   toggle: true, group: 'View', shortcut: 'view.browser' },
  { id: 'tabbar-bookmark',       icon: 'bookmark', label: 'Bookmark Page',         action: 'bookmark',                    group: 'Page' },
  { id: 'tabbar-find',           icon: 'search',   label: 'Find in Page',          action: 'find',          toggle: true, group: 'Page', shortcut: 'find.toggle' },
  { id: 'tabbar-external-links', icon: 'external', label: 'Open Links Externally', action: 'externalLinks', toggle: true, group: 'Page' },
];

const PANEL_ACTIONS = [
  { id: 'tabbar-flip',      icon: 'panelLeft', label: 'Assistant view', action: 'flip', shortcut: 'view.flip', panel: 'viewShell', pill: true, requires: 'viewShell', badge: true },
  { id: 'tabbar-assistant', icon: 'sparkles', label: 'Assistant', action: 'assistant', shortcut: 'panel.chat',    panel: 'agentPanel', pill: true },
  { id: 'tabbar-library',   icon: 'library',  label: 'Library',   action: 'library',   shortcut: 'panel.library', panel: 'libraryWindow', pill: true, badge: true },
  { id: 'tabbar-settings',  icon: 'settings', label: 'Settings',  action: 'settings',  shortcut: 'app.settings',  panel: 'settingsMenu' },
];

function shortcutText(action) {
  if (!action) return '';
  const entry = shortcutManager.getShortcut(action);
  return entry ? formatShortcut(entry.key) : '';
}

class TabBarActions {
  /**
   * @param {{ state: any, spaceManager?: any, navigationManager?: any, panels?: any }} deps
   */
  constructor({ state, spaceManager, navigationManager, panels }) {
    this._state = state;
    this._spaceManager = spaceManager || null;
    this._navigationManager = navigationManager || null;
    this._panels = panels || {};
    this._buttons = new Map();
    this._panelOpen = new Map();
    this._unsubscribe = [];
    this._onResize = () => this.syncOverflow();
    this.el = this._build();
    this._menu = new Menu({
      anchor: this._moreBtn,
      side: 'chrome',
      align: 'end',
      ariaLabel: 'More tools',
      className: 'tab-bar-more-menu',
      items: () => this.menuItems(),
    });
    this._watchPanels();
    this._watchInbox();
    window.addEventListener('resize', this._onResize);
    this.sync();
  }

  _build() {
    const wrap = document.createElement('div');
    wrap.className = 'tab-bar-actions';

    const more = this._button({ id: 'tabbar-more', icon: 'more', label: 'More' });
    more.classList.add('tab-bar-more');
    const dot = document.createElement('span');
    dot.className = 'tab-bar-more-dot';
    dot.hidden = true;
    more.appendChild(dot);
    more.addEventListener('click', (e) => {
      e.preventDefault();
      this._menu.toggle();
    });
    this._moreBtn = more;
    this._moreDot = dot;
    wrap.appendChild(more);

    const sep = document.createElement('div');
    sep.className = 'tab-bar-action-sep';
    sep.setAttribute('role', 'separator');
    wrap.appendChild(sep);

    for (const cfg of PANEL_ACTIONS) {
      if (!this._wired(cfg)) continue;
      const btn = this._button(cfg);
      if (cfg.pill) btn.classList.add('tab-bar-pill', `tab-bar-pill--${cfg.action}`);
      btn.setAttribute('aria-pressed', 'false');
      if (cfg.badge) {
        const badge = document.createElement('span');
        badge.className = 'tab-bar-action-badge';
        badge.hidden = true;
        btn.appendChild(badge);
      }
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this.dispatch(cfg.action);
      });
      this._buttons.set(cfg.id, btn);
      wrap.appendChild(btn);
    }

    const update = this._button({ id: 'tabbar-update', icon: 'refresh', label: 'Update' });
    update.classList.add('tab-bar-pill', 'tab-bar-pill--update');
    update.hidden = true;
    update.addEventListener('click', (e) => {
      e.preventDefault();
      this.restartToUpdate();
    });
    this._updateBtn = update;
    this._updateVersion = null;
    this._updateUrl = null;
    wrap.appendChild(update);
    return wrap;
  }

  _wired(cfg) { return !cfg.requires || !!this._panels[cfg.requires]; }

  _button(cfg) {
    const btn = document.createElement('button');
    btn.id = cfg.id;
    btn.type = 'button';
    btn.className = 'tab-bar-action-btn';
    btn.setAttribute('aria-label', cfg.label);
    btn.appendChild(icon(cfg.icon));
    const label = document.createElement('span');
    label.className = 'tab-bar-action-btn-label';
    label.textContent = cfg.label;
    btn.appendChild(label);
    const keys = shortcutText(cfg.shortcut);
    Tooltip.attach(btn, keys ? `${cfg.label} · ${keys}` : cfg.label);
    return btn;
  }

  // Panels report open/close so their pill reads as pressed while showing.
  _watchPanels() {
    for (const cfg of PANEL_ACTIONS) {
      const panel = this._panels[cfg.panel];
      if (!panel || typeof panel.onOpenChange !== 'function') continue;
      this._unsubscribe.push(panel.onOpenChange((open) => {
        this._panelOpen.set(cfg.id, !!open);
        this._syncPanel(cfg.id);
      }));
      if (typeof panel.isOpen === 'function') this._panelOpen.set(cfg.id, !!panel.isOpen());
    }
  }

  _syncPanel(id) {
    const btn = this._buttons.get(id);
    if (!btn) return;
    const open = !!this._panelOpen.get(id);
    btn.classList.toggle('is-open', open);
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  menuItems() {
    const items = [];
    let group = null;
    for (const cfg of MENU_ACTIONS) {
      if (!this._wired(cfg)) continue;
      if (cfg.group !== group) {
        if (group !== null) items.push({ type: 'separator' });
        items.push({ type: 'label', label: cfg.group });
        group = cfg.group;
      }
      const item = {
        id: cfg.id,
        label: cfg.label,
        icon: cfg.icon,
        shortcut: shortcutText(cfg.shortcut),
        onSelect: () => this.dispatch(cfg.action),
      };
      if (cfg.toggle) item.checked = this.isActive(cfg.action);
      if (cfg.action === 'layout') item.description = LAYOUT_NAMES[this.layoutName()] || this.layoutName();
      items.push(item);
    }
    return items;
  }

  layoutName() {
    if (this._inAgentView()) {
      const ws = this._state.get('agentWorkspace') || {};
      return ws.currentLayout || 'single';
    }
    return this._state.get('currentLayout') || 'single';
  }

  _inAgentView() {
    return !!this._state && this._state.get('viewMode') === 'agent';
  }

  isActive(action) {
    const ws = this._state.get('agentWorkspace') || {};
    switch (action) {
      case 'multiSpace': return this._inAgentView() ? !!ws.multiSpace : !!this._state.get('multiSpace');
      case 'find': return !!this._state.get('findBarVisible');
      case 'externalLinks': return !!this._state.get('openLinkExternal');
      case 'browserView': return !!this._state.get('browserViewActive');
      case 'spaceView': return !!this._state.get('spaceViewActive');
      case 'flip': return !!(this._panels.viewShell && this._panels.viewShell.isOpen());
      default: return false;
    }
  }

  // Toggles currently away from their resting state, for the More dot.
  activeToggles() {
    return MENU_ACTIONS
      .filter((cfg) => cfg.toggle && cfg.dot !== false && this._wired(cfg) && this.isActive(cfg.action) !== !!cfg.defaultOn)
      .map((cfg) => cfg.label);
  }

  sync() {
    if (!this._state) return;
    const active = this.activeToggles();
    this._moreDot.hidden = active.length === 0;
    this._moreBtn.classList.toggle('has-active', active.length > 0);
    const label = active.length ? `More tools (${active.join(', ')})` : 'More tools';
    this._moreBtn.setAttribute('aria-label', label);
    Tooltip.attach(this._moreBtn, label);
    for (const cfg of PANEL_ACTIONS) this._syncPanel(cfg.id);
    this.syncOverflow();
  }

  // Tabs pass beneath the sticky group only when the strip overflows; only
  // then does the group need its opaque backing (fx.css drops it otherwise so
  // the ambient background runs unbroken).
  syncOverflow() {
    const bar = this.el.parentElement;
    if (!bar) return;
    const vertical = bar.classList.contains('tab-bar--vertical');
    const scroller = vertical ? bar.parentElement : bar;
    const over = !!scroller && (vertical
      ? scroller.scrollHeight > scroller.clientHeight + 1
      : scroller.scrollWidth > scroller.clientWidth + 1);
    bar.classList.toggle('is-overflowing', over);
  }

  // Unread inbox results (finished background sessions) ride on the
  // Assistant-view pill so they show from browser mode too.
  _watchInbox() {
    if (!ipcRenderer || typeof ipcRenderer.on !== 'function' || !this._buttons.has('tabbar-flip')) return;
    const show = (res) => {
      try { this.setInboxBadge(unreadCount(res)); } catch (err) { this._inboxBadgeError(err); }
    };
    this._onInboxChanged = (_e, payload) => {
      if (payload && Number.isFinite(payload.unread)) show(payload);
      else this._loadInboxBadge(show);
    };
    ipcRenderer.on('inbox:changed', this._onInboxChanged);
    this._loadInboxBadge(show);
  }

  _loadInboxBadge(show) {
    Promise.resolve()
      .then(() => ipcRenderer.invoke('inbox:list', {}))
      .then(show, (err) => this._inboxBadgeError(err));
  }

  // A count that cannot be read shows as "!" with the reason, never as zero.
  _inboxBadgeError(err) {
    const badge = this._badgeOf('tabbar-flip');
    if (!badge) return;
    const reason = (err instanceof Error && err.message) || String(err);
    badge.hidden = false;
    badge.textContent = '!';
    badge.classList.add('is-error');
    this._buttons.get('tabbar-flip').setAttribute('aria-label', `Assistant view (inbox unavailable: ${reason})`);
  }

  _badgeOf(id) {
    const btn = this._buttons.get(id);
    return btn ? /** @type {HTMLElement|null} */ (btn.querySelector('.tab-bar-action-badge')) : null;
  }

  /** Unread inbox count on the Assistant-view pill: hidden at 0, "99+" above 99. */
  setInboxBadge(count) {
    const n = Math.max(0, Math.floor(Number(count)) || 0);
    const badge = this._badgeOf('tabbar-flip');
    if (!badge) return;
    badge.classList.remove('is-error');
    badge.hidden = n === 0;
    badge.textContent = n === 0 ? '' : (n > 99 ? '99+' : String(n));
    this._buttons.get('tabbar-flip').setAttribute('aria-label', n === 0 ? 'Assistant view' : `Assistant view (${badge.textContent} unread)`);
  }

  setBadge(count) {
    const n = Math.max(0, Number(count) || 0);
    const btn = this._buttons.get('tabbar-library');
    const badge = btn && /** @type {HTMLElement} */ (btn.querySelector('.tab-bar-action-badge'));
    if (!badge) return;
    badge.hidden = n === 0;
    badge.textContent = n === 0 ? '' : (n > 99 ? '99+' : String(n));
    btn.setAttribute('aria-label', n === 0 ? 'Library' : `Library (${badge.textContent} unread)`);
  }

  // Chrome-style update nudge, driven by updater:nudge: shown once a
  // downloaded app update has waited a few days, warn-toned after a week. An
  // update with a url can only be installed from its release page, which the
  // pill opens instead of restarting.
  /** @param {{level: 'none'|'recommended'|'elevated', version: string|null, url?: string|null}|null} nudge */
  setUpdateNudge(nudge) {
    const level = nudge ? nudge.level : 'none';
    const show = level === 'recommended' || level === 'elevated';
    const btn = this._updateBtn;
    this._updateVersion = show && nudge.version ? nudge.version : null;
    this._updateUrl = show && nudge.url ? nudge.url : null;
    btn.hidden = !show;
    btn.classList.toggle('is-elevated', level === 'elevated');
    const version = this._updateVersion ? ` v${this._updateVersion}` : '';
    const label = this._updateUrl ? `Download update${version}` : `Restart to install update${version}`;
    btn.setAttribute('aria-label', label);
    Tooltip.attach(btn, label);
    this.syncOverflow();
  }

  async restartToUpdate() {
    if (!ipcRenderer) return;
    if (this._updateUrl) {
      ipcRenderer.send('open-external-url', this._updateUrl);
      return;
    }
    const version = this._updateVersion ? `v${this._updateVersion}` : 'the update';
    const ok = await confirm({
      title: 'Restart to update?',
      message: `InstantCognition will close, install ${version} with its security fixes, and reopen.`,
      confirmLabel: 'Restart',
      cancelLabel: 'Later',
    });
    if (!ok) return;
    try {
      const res = await ipcRenderer.invoke('updater:install');
      if (!res || !res.ok) toast.error((res && res.error) || 'Install failed.', { title: 'Updates' });
    } catch (err) {
      const message = (err instanceof Error && err.message) || String(err);
      console.error('[TabBar] update install failed:', message);
      toast.error('Could not install the update: ' + message, { title: 'Updates' });
    }
  }

  dispatch(action) {
    const p = this._panels;
    const wsm = p.agentWorkspaceManager || (typeof window !== 'undefined' && /** @type {any} */ (window).agentWorkspaceManager);
    const inAgentView = this._inAgentView();
    switch (action) {
      case 'multiSpace':
        if (inAgentView && wsm && typeof wsm.toggleMulti === 'function') wsm.toggleMulti();
        else if (this._spaceManager && typeof this._spaceManager.toggleMulti === 'function') this._spaceManager.toggleMulti();
        break;
      case 'layout':
        if (inAgentView && wsm && typeof wsm.cycleLayout === 'function') wsm.cycleLayout();
        else if (typeof p.cycleLayout === 'function') p.cycleLayout();
        break;
      case 'find':
        if (p.findBarManager && typeof p.findBarManager.toggle === 'function') p.findBarManager.toggle();
        break;
      case 'bookmark':
        this.bookmarkActivePage();
        break;
      case 'externalLinks':
        if (typeof p.toggleOpenLinkExternal === 'function') p.toggleOpenLinkExternal();
        break;
      case 'browserView':
        if (p.browserViewManager && typeof p.browserViewManager.toggle === 'function') p.browserViewManager.toggle();
        break;
      case 'spaceView':
        if (p.browserViewManager && typeof p.browserViewManager.toggleSpace === 'function') p.browserViewManager.toggleSpace();
        break;
      case 'flip':
        if (p.viewShell && typeof p.viewShell.toggle === 'function') p.viewShell.toggle();
        break;
      case 'assistant':
        if (p.agentPanel && typeof p.agentPanel.toggle === 'function') p.agentPanel.toggle();
        break;
      case 'library':
        if (p.libraryWindow && typeof p.libraryWindow.toggle === 'function') p.libraryWindow.toggle({ tab: 'ask' });
        break;
      case 'settings':
        if (p.settingsMenu && typeof p.settingsMenu.toggle === 'function') p.settingsMenu.toggle();
        break;
      default: break;
    }
  }

  // Star the focused tab's page. Toggles: pressing it on an already-bookmarked
  // URL removes that bookmark instead of adding a duplicate.
  async bookmarkActivePage() {
    if (!ipcRenderer) return;
    const nav = this._navigationManager;
    const wv = nav && typeof nav.getActiveWebview === 'function' ? nav.getActiveWebview() : null;
    let url = '';
    let title = '';
    try {
      if (wv && typeof wv.getURL === 'function') url = wv.getURL();
      if (wv && typeof wv.getTitle === 'function') title = wv.getTitle();
    } catch (err) {
      console.error('[TabBar] reading the active page failed:', (err instanceof Error && err.message) || err);
    }
    if (!/^https?:/i.test(url || '')) {
      toast.warn('Nothing to bookmark on this tab.');
      return;
    }
    try {
      const res = await ipcRenderer.invoke('bookmarks:toggle', { url, title });
      if (res && res.added) toast.success('Bookmarked');
      else toast.info('Bookmark removed');
    } catch (err) {
      const message = (err instanceof Error && err.message) || String(err);
      console.error('[TabBar] bookmark toggle failed:', message);
      toast.error('Could not save the bookmark: ' + message);
    }
  }

  closeMenu() {
    if (this._menu.isOpen()) this._menu.close({ restoreFocus: false });
  }

  destroy() {
    this._menu.destroy();
    window.removeEventListener('resize', this._onResize);
    for (const off of this._unsubscribe) off();
    this._unsubscribe = [];
    if (this._onInboxChanged && typeof ipcRenderer.removeListener === 'function') ipcRenderer.removeListener('inbox:changed', this._onInboxChanged);
    this._onInboxChanged = null;
  }
}

module.exports = TabBarActions;
module.exports.TabBarActions = TabBarActions;
module.exports.MENU_ACTIONS = MENU_ACTIONS;
module.exports.PANEL_ACTIONS = PANEL_ACTIONS;
