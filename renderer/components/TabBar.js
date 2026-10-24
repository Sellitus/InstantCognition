// TabBar.js — persistent tab strip showing openTabs in order.
// Multi-mode: click toggles visibility + shifts focus. Single-mode: click focuses.
// Ctrl/Cmd+Click toggles multi-view. Right-click opens a context menu.
// Drag-and-drop reorders openTabs, which drives the multi-view layout order
// via CSS flex `order`. Supports both horizontal and vertical orientation.

let ipcRenderer;
try { ({ ipcRenderer } = require('electron')); } catch (_) { ipcRenderer = null; }
let iconHTMLFn = null;
let iconFn = null;
try {
  const iconMod = require('./Icon');
  iconHTMLFn = iconMod.iconHTML;
  iconFn = iconMod.icon;
} catch (_) { /* no icons available */ }

const fx = require('../fx');
const TabBarActions = require('./TabBarActions');

// Tab operations are best-effort at the UI edge: one failing step must not
// abort the rest of the click handler around it. It is logged, never swallowed.
function logTabOp(op, err) {
  console.error(`[TabBar] ${op} failed:`, (err instanceof Error && err.message) || err);
}

// Map of known space names to logo file names in assets/ai-logos/
const LOGO_MAP = {
  chatgpt: 'chatgpt-logo-white.png',
  claude: 'claude-logo-white.png',
  gemini: 'gemini-logo-black-and-white.png',
  copilot: 'copilot-logo-black-and-white.png',
  perplexity: 'perplexity-logo-white.png',
  'perplexity labs': 'perplexity-labs-logo-white.png',
  mistral: 'mistral-logo-black-and-white.png',
};

class TabBar {
  constructor() {
    this.bar = null;
    this._state = null;
    this._spaceManager = null;
    this._navigationManager = null;
    this._newTabPicker = null;
    this._panels = null;
    this._actions = null;
    this._menu = null;
    this._menuSpaceId = null;
    this._audioByWebContentsId = new Map();
    this._audioWired = false;
  }

  _wireAudioIPC() {
    if (this._audioWired || !ipcRenderer || !ipcRenderer.on) return;
    this._audioWired = true;
    ipcRenderer.on('tab:audio-state', (_e, payload = {}) => {
      if (typeof payload.webContentsId !== 'number') return;
      this._audioByWebContentsId.set(payload.webContentsId, {
        audible: !!payload.audible,
        muted: !!payload.muted,
      });
      this.render();
    });
  }

  _audioStateForSpace(spaceId) {
    if (typeof document === 'undefined') return null;
    const wv = /** @type {any} */ (document.getElementById(spaceId));
    if (!wv || typeof wv.getWebContentsId !== 'function') return null;
    let wcId;
    try { wcId = wv.getWebContentsId(); } catch (_) { return null; }
    return this._audioByWebContentsId.get(wcId) || null;
  }

  initialize({ state, spaceManager, navigationManager, panels }) {
    this._state = state;
    this._spaceManager = spaceManager;
    this._navigationManager = navigationManager;
    this._panels = panels || null;
    this._buildDom();
    if (this._actions) this._actions.destroy();
    this._actions = iconFn ? new TabBarActions({ state, spaceManager, navigationManager, panels }) : null;
    this._buildMenu();
    this._wireState();
    this._wireAudioIPC();
    this.render();
  }

  bookmarkActivePage() {
    return this._actions ? this._actions.bookmarkActivePage() : Promise.resolve();
  }

  // Unread notification count on the Library pill.
  setNotificationBadge(count) {
    if (this._actions) this._actions.setBadge(count);
  }

  setUpdateNudge(nudge) {
    if (this._actions) this._actions.setUpdateNudge(nudge);
  }

  setNewTabPicker(picker) {
    this._newTabPicker = picker;
  }

  _buildDom() {
    if (!document || !document.body) return;
    if (document.getElementById('tab-bar')) {
      this.bar = document.getElementById('tab-bar');
      return;
    }
    const spaceContainer = document.getElementById('space-container');
    if (!spaceContainer || !spaceContainer.parentNode) return;

    const wrap = document.createElement('div');
    wrap.id = 'tab-bar-wrap';
    wrap.className = 'tab-bar-wrap';

    const bar = document.createElement('div');
    bar.id = 'tab-bar';
    bar.className = 'tab-bar';
    bar.setAttribute('role', 'tablist');
    // aria-orientation is set by ChromeBar based on chromeLayout (horizontal
    // for top/bottom, vertical for left/right). Default to horizontal so
    // assistive tech has a value before ChromeBar.initialize() runs.
    bar.setAttribute('aria-orientation', 'horizontal');
    bar.setAttribute('aria-label', 'Open tabs');
    wrap.appendChild(bar);

    spaceContainer.parentNode.insertBefore(wrap, spaceContainer);
    wrap.appendChild(spaceContainer);

    bar.addEventListener('keydown', (e) => this._onTabKeydown(e));

    this.bar = bar;
  }

  // Roving-tabindex navigation across the tablist. Only the focused tab is in
  // the document tab order, so arrows are the only way out of it — without this
  // a keyboard user reaches one tab and is stuck there.
  _onTabKeydown(e) {
    const tabs = Array.from(this.bar.querySelectorAll('.tab-bar-tab'));
    if (!tabs.length) return;
    const current = e.target && e.target.closest ? e.target.closest('.tab-bar-tab') : null;
    if (!current) return;
    const idx = tabs.indexOf(current);
    if (idx === -1) return;

    let next = -1;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (idx - 1 + tabs.length) % tabs.length;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        next = (idx + 1) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        current.click();
        return;
      default:
        return;
    }

    e.preventDefault();
    const target = /** @type {HTMLElement} */ (tabs[next]);
    // Move the tab order with focus so a subsequent Tab leaves from here.
    for (const t of tabs) t.setAttribute('tabindex', t === target ? '0' : '-1');
    target.focus();
  }

  _buildMenu() {
    if (!document || !document.body) return;
    if (document.getElementById('tab-bar-context-menu')) {
      this._menu = document.getElementById('tab-bar-context-menu');
      return;
    }
    const menu = document.createElement('div');
    menu.id = 'tab-bar-context-menu';
    menu.className = 'tab-bar-context-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
    this._menu = menu;

    const dismiss = (e) => {
      if (!this._menu || this._menu.style.display === 'none') return;
      if (e && this._menu.contains(e.target)) return;
      this._hideMenu();
    };
    document.addEventListener('click', dismiss, true);
    document.addEventListener('contextmenu', (e) => {
      if (!this._menu || this._menu.style.display === 'none') return;
      if (this._menu.contains(/** @type {Node} */ (e.target))) return;
      this._hideMenu();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._hideMenu();
    });
  }

  _wireState() {
    if (!this._state) return;
    this._state.on('change:multiSpace', () => this.render());
    this._state.on('change:currentLayout', () => this.render());
    this._state.on('change:findBarVisible', () => this.render());
    this._state.on('change:openLinkExternal', () => this.render());
    this._state.on('change:browserViewActive', () => this.render());
    this._state.on('change:spaceViewActive', () => this.render());
    this._state.on('change:openTabs', () => this.render());
    this._state.on('change:hiddenTabs', () => this.render());
    this._state.on('change:currentSpaceId', () => this.render());
    this._state.on('change:pinnedTabs', () => this.render());
    this._state.on('change:spaces', () => this.render());
    this._state.on('change:config', () => this.render());
    this._state.on('change:adHocSpaces', () => this.render());
    this._state.on('change:viewMode', () => this.render());
    this._state.on('change:agentWorkspace', () => this.render());
  }

  render() {
    if (!this.bar || !this._state) return;
    const settle = fx.tabsBeforeRender(this.bar);
    const config = this._state.get('config');
    const spaces = (config && config.spaces) || {};
    const adHocSpaces = this._state.get('adHocSpaces') || {};
    const viewMode = this._state.get('viewMode') || 'user';
    this.bar.classList.toggle('tabbar--agent-mode', viewMode === 'agent');

    // In agent view, tabs come from the workspace mirror; in user view, from openTabs.
    let openTabs, currentId, multiSpace, hiddenTabs, pinnedTabs, allSpaces;
    if (viewMode === 'agent') {
      const ws = this._state.get('agentWorkspace') || { tabs: [], currentTabId: null };
      const adHoc = {};
      for (const t of (ws.tabs || [])) {
        let host = '';
        try { host = new URL(t.url).hostname; } catch (_) { host = t.url || t.id; }
        adHoc[t.id] = { name: t.title || host || t.id, url: t.url || '', type: 'agent' };
      }
      openTabs = (ws.tabs || []).map((t) => t.id);
      currentId = ws.currentTabId || (openTabs[0] || '');
      // Per-view-mode flags: agent view's multiSpace / hiddenTabs are stored
      // on agentWorkspace, NOT on state.* — that prevents agent-view toggles
      // from leaking into user-view state.
      multiSpace = !!ws.multiSpace;
      hiddenTabs = Array.isArray(ws.hiddenTabs) ? ws.hiddenTabs : [];
      pinnedTabs = [];
      allSpaces = adHoc;
    } else {
      openTabs = this._state.get('openTabs') || [];
      hiddenTabs = this._state.get('hiddenTabs') || [];
      pinnedTabs = this._state.get('pinnedTabs') || [];
      currentId = this._state.get('currentSpaceId');
      multiSpace = this._state.get('multiSpace');
      allSpaces = { ...spaces, ...adHocSpaces };
    }

    // Always show if there are tabs OR if we're in agent view (otherwise the
    // toggle button disappears and the user has no way back to their tabs).
    const shouldShow = openTabs.length >= 1 || viewMode === 'agent';
    if (!shouldShow) {
      this.bar.classList.remove('visible');
      this.bar.innerHTML = '';
      return;
    }

    this.bar.classList.add('visible');
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const actionFocus = this._actions && active && this._actions.el.contains(active) ? active : null;
    this.bar.innerHTML = '';

    // Defensive dedup — openTabs should never have duplicates, but if a stale
    // config or a race produced one we don't want two DOM tabs for the same id.
    const seen = new Set();
    const dedupedOpen = [];
    for (const id of openTabs) {
      if (seen.has(id)) continue;
      seen.add(id);
      dedupedOpen.push(id);
    }

    // Render pinned tabs first, then unpinned
    const pinnedIds = dedupedOpen.filter(id => pinnedTabs.includes(id));
    const unpinnedIds = dedupedOpen.filter(id => !pinnedTabs.includes(id));
    const orderedIds = [...pinnedIds, ...unpinnedIds];

    for (const id of orderedIds) {
      const meta = allSpaces[id];
      if (!meta) continue;

      const isPinned = pinnedTabs.includes(id);
      const isHidden = hiddenTabs.includes(id);
      // "Shown" = visible to the user right now. In single-mode only the
      // current tab is shown; in multi-mode every non-hidden open tab is.
      // This drives the .active class so the highlight (background + blue
      // left indicator) is consistent across all visible tabs — no more
      // asymmetry between "current" and "other visible" in multi-mode.
      const isShown = multiSpace ? !isHidden : (id === currentId);
      const isFocused = id === currentId;

      const tab = document.createElement('div');
      tab.className = 'tab-bar-tab';
      if (isShown) tab.classList.add('active');
      if (isHidden) tab.classList.add('hidden');
      if (isPinned) tab.classList.add('pinned');
      if (meta.private) tab.classList.add('private');
      if (multiSpace && isFocused && isShown) tab.classList.add('focused');
      tab.dataset.spaceId = id;
      tab.draggable = true;
      const tabName = meta.private ? `${meta.name || id} (private)` : (meta.name || id);
      tab.title = tabName;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', isShown ? 'true' : 'false');
      if (isFocused) tab.setAttribute('aria-current', 'true');
      tab.setAttribute('tabindex', isFocused ? '0' : '-1');
      tab.setAttribute('aria-label', tabName);

      // Tab icon
      const icon = this._createTabIcon(meta);
      tab.appendChild(icon);

      if (meta.private) {
        const badge = document.createElement('span');
        badge.className = 'tab-bar-private-badge';
        badge.setAttribute('aria-hidden', 'true');
        if (iconHTMLFn) badge.innerHTML = iconHTMLFn('private');
        tab.appendChild(badge);
      }

      // Tab label (hidden for pinned tabs via CSS)
      if (!isPinned) {
        const label = document.createElement('span');
        label.className = 'tab-bar-label';
        label.textContent = meta.name || id;
        tab.appendChild(label);
      }

      // Audio indicator — only shown when this tab is actually emitting sound
      // or has been muted mid-playback. Click toggles mute on the webview.
      const audio = this._audioStateForSpace(id);
      if (audio && (audio.audible || audio.muted) && iconHTMLFn) {
        const audioBtn = document.createElement('span');
        audioBtn.className = 'tab-bar-audio' + (audio.muted ? ' muted' : '');
        audioBtn.title = audio.muted ? 'Unmute tab' : 'Mute tab';
        audioBtn.innerHTML = iconHTMLFn(audio.muted ? 'speakerMute' : 'speaker');
        audioBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const wv = /** @type {any} */ (document.getElementById(id));
          if (!wv || typeof wv.setAudioMuted !== 'function') return;
          const nowMuted = !audio.muted;
          try { wv.setAudioMuted(nowMuted); } catch (_) { /* ignore */ }
          try {
            const wcId = wv.getWebContentsId();
            this._audioByWebContentsId.set(wcId, { audible: audio.audible, muted: nowMuted });
          } catch (_) { /* ignore */ }
          this.render();
        });
        tab.appendChild(audioBtn);
      }

      tab.addEventListener('click', (e) => {
        e.preventDefault();
        this._onClick(id, e);
      });
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._showMenu(id, e.clientX, e.clientY);
      });
      this._wireDrag(tab, id);

      this.bar.appendChild(tab);
    }

    // Add separator between pinned and unpinned if both exist
    if (pinnedIds.length > 0 && unpinnedIds.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'tab-bar-pin-separator';
      // Insert after the last pinned tab
      const firstUnpinned = this.bar.querySelector(
        `.tab-bar-tab[data-space-id="${unpinnedIds[0]}"]`
      );
      if (firstUnpinned) {
        this.bar.insertBefore(sep, firstUnpinned);
      }
    }

    const newTabBtn = document.createElement('button');
    newTabBtn.type = 'button';
    newTabBtn.className = 'tab-bar-new-tab-btn';
    newTabBtn.title = 'New Tab';
    newTabBtn.setAttribute('aria-label', 'New Tab');
    if (iconFn) newTabBtn.appendChild(iconFn('plus'));
    else newTabBtn.textContent = '+';
    newTabBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (this._newTabPicker) this._newTabPicker.open();
    });
    this.bar.appendChild(newTabBtn);

    // The action group is built once; render() clears bar.innerHTML, so it is
    // re-appended here, and focus inside it is restored after the detach.
    if (this._actions) {
      this.bar.appendChild(this._actions.el);
      this._actions.sync();
      if (actionFocus && document.contains(actionFocus)) actionFocus.focus({ preventScroll: true });
    }
    settle();
  }

  _createTabIcon(meta) {
    const icon = document.createElement('span');
    icon.className = 'tab-bar-icon';
    const name = (meta.name || '').toLowerCase();
    const logoFile = LOGO_MAP[name];
    if (logoFile) {
      const img = document.createElement('img');
      img.src = `./assets/ai-logos/${logoFile}`;
      img.className = 'tab-bar-icon-img';
      img.alt = '';
      img.draggable = false;
      icon.appendChild(img);
    } else {
      icon.textContent = (meta.name || '?')[0].toUpperCase();
    }
    return icon;
  }

  _onClick(id, event) {
    if (!this._spaceManager || !id) return;
    const multiSpace = this._state.get('multiSpace');

    // Ctrl/Cmd+Click: toggle multi-view visibility.
    //
    // From single-mode this enables multi-mode and makes the clicked tab
    // visible alongside the current one. Routing through openTab(id) is
    // critical — it ensures the wrapper exists and the tab is un-hidden.
    // Calling toggleTabVisibility on a tab whose wrapper was never created
    // would silently do nothing (the previous bug).
    if (event && (event.metaKey || event.ctrlKey)) {
      const enteringMulti = !multiSpace;

      if (enteringMulti) {
        // Each step is independent: openTab must still run when toggleMulti
        // throws, so the tab is not left invisible in a multi-mode layout.
        try { this._spaceManager.toggleMulti(); } catch (err) { logTabOp('toggleMulti', err); }
        try { this._spaceManager.openTab(id); } catch (err) { logTabOp('openTab', err); }
      } else {
        try { this._spaceManager.toggleTabVisibility(id); } catch (err) { logTabOp('toggleTabVisibility', err); }
      }

      // Auto-disable multi-space if only 1 visible tab remains.
      const openTabs = this._state.get('openTabs') || [];
      const updatedHidden = this._state.get('hiddenTabs') || [];
      const visibleCount = openTabs.filter(t => !updatedHidden.includes(t)).length;
      if (visibleCount <= 1 && this._state.get('multiSpace')) {
        try { this._spaceManager.toggleMulti(); } catch (err) { logTabOp('toggleMulti', err); }
      }
      return;
    }

    if (this._state && this._state.get('viewMode') === 'agent') {
      // In agent view, route the click through the workspace manager so the
      // user activates an AGENT tab (which lives in a separate webview tree).
      const wsm = (this._panels && this._panels.agentWorkspaceManager) || (typeof window !== 'undefined' && window.agentWorkspaceManager);
      if (wsm && typeof wsm._setCurrent === 'function') wsm._setCurrent(id);
      return;
    }
    if (multiSpace) {
      // Toggle visibility. Focus only follows when un-hiding — clicking a
      // visible tab to hide it must NOT leave focus on the now-invisible tab.
      const wasHidden = (this._state.get('hiddenTabs') || []).includes(id);
      try { this._spaceManager.toggleTabVisibility(id); } catch (err) { logTabOp('toggleTabVisibility', err); }
      if (wasHidden) {
        try { this._spaceManager.focusTab(id); } catch (err) { logTabOp('focusTab', err); }
      }
    } else {
      try { this._spaceManager.focusTab(id); } catch (err) { logTabOp('focusTab', err); }
    }
  }

  _wireDrag(tab, id) {
    tab.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      this.bar.querySelectorAll('.tab-bar-tab.drag-over').forEach((el) => {
        el.classList.remove('drag-over');
      });
    });
    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      tab.classList.add('drag-over');
    });
    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drag-over');
    });
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drag-over');
      const srcId = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (!srcId || srcId === id) return;
      // Drop position relative to target tab: left half = before, right half = after.
      // Without this the reorder always inserted before the target, which felt
      // sticky when dragging a tab rightward past several siblings.
      const rect = tab.getBoundingClientRect();
      const dropAfter = (e.clientX - rect.left) > (rect.width / 2);
      this._reorder(srcId, id, dropAfter);
    });
  }

  _reorder(srcId, targetId, after = false) {
    // Agent view reorders the agent workspace's tab order, not user openTabs
    // (which never contains agent tab ids) — the drop would otherwise
    // animate but silently do nothing.
    if (this._state && this._state.get('viewMode') === 'agent') {
      const wsm = (this._panels && this._panels.agentWorkspaceManager) || (typeof window !== 'undefined' && window.agentWorkspaceManager);
      const ws = this._state.get('agentWorkspace') || { tabs: [] };
      const ids = (ws.tabs || []).map((t) => t.id);
      const srcIdx = ids.indexOf(srcId);
      const targetIdx = ids.indexOf(targetId);
      if (srcIdx === -1 || targetIdx === -1 || !wsm) return;
      ids.splice(srcIdx, 1);
      const insertAt = ids.indexOf(targetId) + (after ? 1 : 0);
      ids.splice(insertAt, 0, srcId);
      try { wsm.reorderTabs(ids); } catch (err) { logTabOp('agent reorderTabs', err); }
      return;
    }
    const openTabs = (this._state.get('openTabs') || []).slice();
    const srcIdx = openTabs.indexOf(srcId);
    const targetIdx = openTabs.indexOf(targetId);
    if (srcIdx === -1 || targetIdx === -1) return;
    openTabs.splice(srcIdx, 1);
    const insertAt = openTabs.indexOf(targetId) + (after ? 1 : 0);
    openTabs.splice(insertAt, 0, srcId);
    try { this._spaceManager.reorderTabs(openTabs); } catch (err) { logTabOp('reorderTabs', err); }
  }

  _showMenu(spaceId, x, y) {
    if (!this._menu) return;
    this._menuSpaceId = spaceId;

    // View-mode awareness: in agent mode the menu must operate on the
    // agent workspace's tab list and methods, not the user's openTabs.
    // Otherwise "Close Tabs to the Right" finds an agent id not in
    // state.openTabs (tabIndex === -1), slices ALL user tabs, and closes
    // them — silently destroying the user's session.
    const isAgent = this._state && this._state.get('viewMode') === 'agent';
    const wsm = isAgent ? ((this._panels && this._panels.agentWorkspaceManager) || (typeof window !== 'undefined' && window.agentWorkspaceManager)) : null;

    const tabIds = isAgent
      ? ((this._state.get('agentWorkspace') || {}).tabs || []).map((t) => t.id)
      : (this._state.get('openTabs') || []);
    const pinnedTabs = isAgent ? [] : (this._state.get('pinnedTabs') || []);
    const isPinned = pinnedTabs.includes(spaceId);
    const isPrivate = !isAgent && !!((this._state.get('adHocSpaces') || {})[spaceId] || {}).private;
    const canClose = tabIds.length > 1 && !isPinned;
    const closeReason = isPinned ? 'Pinned — unpin first' : "Can't close the last tab";
    const tabIndex = tabIds.indexOf(spaceId);

    const closeOne = (id) => {
      if (isAgent) {
        if (wsm && typeof wsm.closeTab === 'function') wsm.closeTab(id);
      } else {
        try { this._spaceManager.closeTab(id); } catch (err) { logTabOp('closeTab', err); }
      }
    };

    this._menu.innerHTML = '';

    // Close Tab
    this._addMenuItem('Close Tab', canClose, () => closeOne(spaceId), closeReason);

    // Close Other Tabs
    const otherCloseable = tabIds.filter(id => id !== spaceId && !pinnedTabs.includes(id));
    this._addMenuItem('Close Other Tabs', otherCloseable.length > 0, () => {
      if (isAgent) {
        if (wsm && typeof wsm.closeOtherTabs === 'function') wsm.closeOtherTabs(spaceId);
      } else {
        for (const id of otherCloseable) closeOne(id);
      }
    });

    // Close Tabs to the Right
    const rightTabs = tabIndex >= 0 ? tabIds.slice(tabIndex + 1).filter(id => !pinnedTabs.includes(id)) : [];
    this._addMenuItem('Close Tabs to the Right', rightTabs.length > 0, () => {
      if (isAgent) {
        if (wsm && typeof wsm.closeTabsToRight === 'function') wsm.closeTabsToRight(spaceId);
      } else {
        for (const id of rightTabs) closeOne(id);
      }
    });

    // Separator
    this._addSeparator();

    // Duplicate Tab — only in user mode (agent duplicate goes via tools)
    this._addMenuItem('Duplicate Tab', !isAgent, () => {
      try { this._spaceManager.openTab(spaceId); } catch (err) { logTabOp('openTab', err); }
    });

    // Pin / Unpin — user mode only (agent workspace has no pinning concept)
    // Pins persist across restarts; a private tab must not.
    this._addMenuItem(isPinned ? 'Unpin Tab' : 'Pin Tab', !isAgent && !isPrivate, () => {
      try {
        if (isPinned) this._spaceManager.unpinTab(spaceId);
        else this._spaceManager.pinTab(spaceId);
      } catch (err) { logTabOp(isPinned ? 'unpinTab' : 'pinTab', err); }
    }, isPrivate ? "Private tabs can't be pinned" : undefined);

    // Separator
    this._addSeparator();

    // Reload — works in both modes (just reloads the matching webview).
    this._addMenuItem('Reload', true, () => {
      const wv = /** @type {any} */ (document.getElementById(spaceId));
      if (wv && typeof wv.reload === 'function') wv.reload();
    });

    // Go Home — user mode only (agent navigation isn't address-bar driven).
    this._addMenuItem('Go Home', !isAgent, () => {
      if (this._navigationManager && this._navigationManager.home) {
        // Focus this tab first, then go home
        try { this._spaceManager.focusTab(spaceId); } catch (err) { logTabOp('focusTab', err); }
        setTimeout(() => {
          try { this._navigationManager.home(); } catch (err) { logTabOp('navigate home', err); }
        }, 50);
      }
    });

    this._menu.style.display = 'block';
    const menuW = this._menu.offsetWidth;
    const menuH = this._menu.offsetHeight;
    const maxX = window.innerWidth - menuW - 4;
    const maxY = window.innerHeight - menuH - 4;
    this._menu.style.left = Math.min(x, maxX) + 'px';
    this._menu.style.top = Math.min(y, maxY) + 'px';
  }

  _addMenuItem(label, enabled, handler, disabledReason) {
    const item = document.createElement('div');
    item.className = 'tab-bar-context-menu-item' + (enabled ? '' : ' disabled');
    item.textContent = label;
    if (!enabled && disabledReason) {
      item.title = disabledReason;
      item.setAttribute('aria-label', `${label} (${disabledReason})`);
    }
    if (enabled) {
      item.addEventListener('click', () => {
        this._hideMenu();
        handler();
      });
    }
    this._menu.appendChild(item);
  }

  _addSeparator() {
    const sep = document.createElement('div');
    sep.className = 'tab-bar-context-menu-separator';
    this._menu.appendChild(sep);
  }

  _hideMenu() {
    if (this._menu) this._menu.style.display = 'none';
    this._menuSpaceId = null;
  }
}

module.exports = new TabBar();
