// @ts-nocheck
// LibraryWindow — one Dropdown-hosted window for Ask, Bookmarks, History,
// Downloads, Notifications and Extensions. Every user-initiated fetch shows
// skeleton rows, then rows, an empty state, or an error with a retry button.
// Download progress events patch rows in place without re-fetching.
const { ipcRenderer, shell } = require('electron');
const { confirm } = require('./ConfirmDialog');
const toast = require('./Toast');
const Dropdown = require('./dropdown/Dropdown');
const { iconHTML } = require('./Icon');
const { createVoiceInputButton } = require('./VoiceInputButton');
const { escapeHtml, escapeAttr } = require('../utils/html');

const FILTER_DEBOUNCE_MS = 150;
const SKELETON_ROWS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

const TABS = [
  { id: 'ask', label: 'Ask', icon: 'sparkles', noun: 'results', placeholder: 'Ask about something you read or saved… (Enter)' },
  { id: 'bookmarks', label: 'Bookmarks', icon: 'bookmark', noun: 'bookmarks', placeholder: 'Filter bookmarks…' },
  { id: 'history', label: 'History', icon: 'history', noun: 'history', placeholder: 'Filter history…' },
  { id: 'downloads', label: 'Downloads', icon: 'download', noun: 'downloads', placeholder: 'Filter downloads…' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', noun: 'notifications', placeholder: '' },
  { id: 'extensions', label: 'Extensions', icon: 'extensions', noun: 'extensions', placeholder: '' },
];
const FILTER_TABS = new Set(['bookmarks', 'history', 'downloads']);

function errText(err) {
  return (err && err.message) || String(err || 'unknown error');
}

function formatTime(ts) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDateTime(ts) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleString();
}

function timeAgo(ts) {
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / (60 * 1000)) + 'm ago';
  if (diff < DAY_MS) return Math.floor(diff / (60 * 60 * 1000)) + 'h ago';
  return new Date(ts).toLocaleString();
}

/** Local-calendar day heading: Today, Yesterday, or a locale date. */
function dayLabel(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return 'Earlier';
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (ts >= start) return 'Today';
  const yesterday = new Date(start);
  yesterday.setDate(yesterday.getDate() - 1);
  if (ts >= yesterday.getTime()) return 'Yesterday';
  const d = new Date(ts);
  const opts = { weekday: 'long', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(v) : v.toFixed(v >= 10 ? 0 : 1)) + ' ' + units[i];
}

const DOWNLOAD_STATE_LABELS = {
  progressing: 'Downloading',
  interrupted: 'Interrupted',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function safeIconSrc(pathOrUrl) {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return '';
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://') || pathOrUrl.startsWith('data:')) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return 'file://' + pathOrUrl;
  if (/^[A-Za-z]:\\/.test(pathOrUrl)) return 'file:///' + pathOrUrl.replace(/\\/g, '/');
  return pathOrUrl;
}

class LibraryWindow {
  constructor() {
    this.contextProvider = null;
    this.content = null;
    this.tabs = null;
    this.input = null;
    this.list = null;
    this.statusEl = null;
    this.activeTab = 'ask';
    this._items = [];
    this._askMeta = null;
    this._loadError = null;
    this._dropdown = null;
    this._badgeListeners = new Set();
    this._openListeners = new Set();
    this._unreadCount = 0;
    this._badgeError = null;
    this._activeDownloadIds = new Set();
    this._fetchSeq = 0;
    this._filterTimer = null;
    this._wired = false;
  }

  initialize(contextProvider) {
    this.contextProvider = typeof contextProvider === 'function' ? contextProvider : () => ({});
    this._buildContent();
    this._dropdown = new Dropdown({
      id: 'library-window',
      size: 'xl',
      ariaLabel: 'Library',
      onOpen: () => this._emitOpenChange(true),
      onClose: () => this._emitOpenChange(false),
    });
    this._dropdown.setHeader({ title: 'Library', slot: this._buildHeaderSlot() });
    this._dropdown.mount(this.content);
    this._wireIpc();
    this._switchTab('ask');
    this._refreshNotificationBadge();
  }

  _buildHeaderSlot() {
    const slot = document.createElement('span');
    slot.className = 'library-window-status';
    slot.setAttribute('aria-live', 'polite');
    this.statusEl = slot;
    return slot;
  }

  _buildContent() {
    const root = document.createElement('div');
    root.className = 'library-window-content';

    const tabs = document.createElement('div');
    tabs.className = 'library-window-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Library sections');
    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'library-window-tab';
      btn.dataset.tab = tab.id;
      btn.id = 'library-window-tab-' + tab.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', 'library-window-panel');
      btn.innerHTML = ''
        + '<span class="library-window-tab-icon" aria-hidden="true">' + iconHTML(tab.icon) + '</span>'
        + '<span class="library-window-tab-label">' + escapeHtml(tab.label) + '</span>'
        + '<span class="library-window-tab-count" hidden></span>';
      btn.addEventListener('click', () => this._switchTab(tab.id));
      tabs.appendChild(btn);
    }
    tabs.addEventListener('keydown', (e) => this._onTabsKeydown(e));

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'library-window-filter';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('data-autofocus', 'true');
    input.addEventListener('input', () => {
      if (FILTER_TABS.has(this.activeTab)) this._scheduleFilterRefresh();
    });
    input.addEventListener('keydown', (e) => {
      if (this.activeTab === 'ask' && e.key === 'Enter') {
        e.preventDefault();
        this._refresh();
      }
    });
    const inputRow = document.createElement('div');
    inputRow.className = 'library-window-filter-row';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'library-window-filter-icon';
    searchIcon.setAttribute('aria-hidden', 'true');
    searchIcon.innerHTML = iconHTML('search');
    const voiceBtn = createVoiceInputButton({
      target: input,
      label: 'Dictate Library query',
      getConfig: () => {
        const ctx = this.contextProvider ? this.contextProvider() || {} : {};
        const cfg = ctx.state && typeof ctx.state.get === 'function' ? ctx.state.get('config') || {} : {};
        return (cfg.settings && cfg.settings.voice) || {};
      },
    });
    inputRow.append(searchIcon, input, voiceBtn);

    const controls = document.createElement('div');
    controls.className = 'library-window-controls';
    controls.innerHTML = ''
      + '<div class="library-window-controls-row library-window-notification-controls" hidden>'
      + '  <button type="button" class="library-btn notifications-panel-mark-all">' + iconHTML('check') + '<span>Mark all read</span></button>'
      + '  <button type="button" class="library-btn is-danger notifications-panel-clear-all">' + iconHTML('trash') + '<span>Clear all…</span></button>'
      + '</div>'
      + '<div class="library-window-controls-row library-window-extension-controls" hidden>'
      + '  <button type="button" class="library-btn is-primary extensions-panel-install-file">' + iconHTML('file') + '<span>Install from file…</span></button>'
      + '  <button type="button" class="library-btn extensions-panel-load">' + iconHTML('folder') + '<span>Load unpacked…</span></button>'
      + '  <button type="button" class="library-btn extensions-panel-refresh">' + iconHTML('refresh') + '<span>Refresh</span></button>'
      + '</div>'
      + '<div class="extensions-panel-install-row library-window-extension-install" hidden>'
      + '  <input type="text" class="extensions-panel-url" placeholder="Chrome Web Store URL, .crx/.zip URL, or extension ID" aria-label="Extension source" spellcheck="false" autocomplete="off">'
      + '  <button type="button" class="library-btn is-primary extensions-panel-install-url">Install</button>'
      + '</div>';

    const list = document.createElement('ul');
    list.className = 'library-window-list';
    list.id = 'library-window-panel';
    list.setAttribute('role', 'tabpanel');
    list.addEventListener('click', (e) => this._onListClick(e));

    const hint = document.createElement('div');
    hint.className = 'library-window-hint';

    const footer = document.createElement('div');
    footer.className = 'library-window-footer';
    const clearSiteDataBtn = document.createElement('button');
    clearSiteDataBtn.type = 'button';
    clearSiteDataBtn.className = 'library-btn library-window-clear-site-data';
    clearSiteDataBtn.textContent = 'Clear cookies & cache…';
    clearSiteDataBtn.addEventListener('click', () => this._clearSiteData());
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'library-btn is-danger library-window-clear';
    clearBtn.addEventListener('click', () => this._clearActive());
    footer.append(clearSiteDataBtn, clearBtn);

    root.append(tabs, inputRow, controls, list, hint, footer);

    controls.querySelector('.notifications-panel-mark-all').addEventListener('click', () => this._markAllRead());
    controls.querySelector('.notifications-panel-clear-all').addEventListener('click', () => this._clearAllNotifications());
    controls.querySelector('.extensions-panel-install-file').addEventListener('click', () => this._installExtension());
    controls.querySelector('.extensions-panel-load').addEventListener('click', () => this._loadExtension());
    controls.querySelector('.extensions-panel-refresh').addEventListener('click', () => this._refresh());
    controls.querySelector('.extensions-panel-install-url').addEventListener('click', () => this._installExtensionFromUrl());
    controls.querySelector('.extensions-panel-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._installExtensionFromUrl();
      }
    });

    this.content = root;
    this.tabs = tabs.querySelectorAll('.library-window-tab');
    this.input = input;
    this.inputRow = inputRow;
    this.controls = controls;
    this.list = list;
    this.hintEl = hint;
    this.footer = footer;
    this.clearBtn = clearBtn;
    this.clearSiteDataBtn = clearSiteDataBtn;
    this.urlInput = controls.querySelector('.extensions-panel-url');
  }

  _wireIpc() {
    if (this._wired) return;
    this._wired = true;
    ipcRenderer.on('downloads:started', (_e, payload) => this._onDownloadEvent('started', payload));
    ipcRenderer.on('downloads:updated', (_e, payload) => this._onDownloadEvent('updated', payload));
    ipcRenderer.on('downloads:done', (_e, payload) => this._onDownloadEvent('done', payload));
    ipcRenderer.on('notifications:added', (_e, payload) => this._onNotificationAdded(payload));
    ipcRenderer.on('notifications:replaced', (_e, payload) => this._onNotificationReplaced(payload));
    ipcRenderer.on('notifications:dismissed', (_e, payload) => this._onNotificationDismissed(payload));
    ipcRenderer.on('notifications:cleared', () => this._onNotificationsCleared());
    ipcRenderer.on('notifications:read-changed', (_e, payload) => this._onNotificationReadChanged(payload));
  }

  // -- Open state + badge subscriptions ------------------------------------

  isOpen() {
    return !!(this._dropdown && this._dropdown.isOpen());
  }

  /** Subscribe to open/close; returns an unsubscribe function. */
  onOpenChange(cb) {
    if (typeof cb !== 'function') throw new TypeError('LibraryWindow.onOpenChange expects a function');
    this._openListeners.add(cb);
    return () => { this._openListeners.delete(cb); };
  }

  _emitOpenChange(open) {
    if (!open) this._cancelFilterDebounce();
    for (const cb of Array.from(this._openListeners)) cb(open);
  }

  /** Subscribe to the unread-notification count; called immediately with the current count. */
  onBadgeChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('LibraryWindow.onBadgeChange expects a function');
    this._badgeListeners.add(fn);
    fn(this._unreadCount);
    return () => { this._badgeListeners.delete(fn); };
  }

  _emitBadge(count) {
    this._unreadCount = count;
    this._badgeError = null;
    this._renderTabCounts();
    for (const fn of this._badgeListeners) {
      try { fn(count); }
      catch (err) { console.error('[LibraryWindow] badge subscriber failed:', errText(err)); }
    }
  }

  // A failed count keeps the last known number rather than reporting a false
  // zero; the Notifications tab shows the failure until a later load works.
  _setBadgeError(message) {
    this._badgeError = message;
    this._renderTabCounts();
  }

  async _refreshNotificationBadge() {
    try {
      const items = await ipcRenderer.invoke('notifications:list') || [];
      this._emitBadge(items.reduce((n, item) => n + (item.read ? 0 : 1), 0));
    } catch (err) {
      console.error('[LibraryWindow] notification badge refresh failed:', errText(err));
      this._setBadgeError(errText(err));
    }
  }

  _renderTabCounts() {
    if (!this.tabs) return;
    this.tabs.forEach((tab) => {
      const id = tab.dataset.tab;
      const meta = TABS.find((t) => t.id === id);
      const countEl = tab.querySelector('.library-window-tab-count');
      let text = '';
      let title = meta.label;
      countEl.classList.remove('is-error');
      if (id === 'notifications') {
        if (this._badgeError) {
          text = '!';
          title = 'Notifications: couldn’t load the unread count (' + this._badgeError + ')';
          countEl.classList.add('is-error');
        } else if (this._unreadCount > 0) {
          text = this._unreadCount > 99 ? '99+' : String(this._unreadCount);
          title = 'Notifications: ' + this._unreadCount + ' unread';
        }
      } else if (id === 'downloads' && this._activeDownloadIds.size > 0) {
        text = String(this._activeDownloadIds.size);
        title = 'Downloads: ' + text + ' in progress';
      }
      countEl.textContent = text;
      countEl.hidden = !text;
      tab.title = title;
      tab.setAttribute('aria-label', title);
    });
  }

  // -- Tabs ----------------------------------------------------------------

  _onTabsKeydown(e) {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const idx = TABS.findIndex((t) => t.id === this.activeTab);
    let next = idx;
    if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = TABS.length - 1;
    this._switchTab(TABS[next].id);
    const btn = Array.from(this.tabs).find((t) => t.dataset.tab === TABS[next].id);
    if (btn) btn.focus();
  }

  _switchTab(name) {
    const next = TABS.find((tab) => tab.id === name) ? name : 'ask';
    this.activeTab = next;
    this.tabs.forEach((tab) => {
      const selected = tab.dataset.tab === next;
      tab.classList.toggle('selected', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    if (this.list) this.list.setAttribute('aria-labelledby', 'library-window-tab-' + next);
    this._cancelFilterDebounce();
    this.input.value = '';
    this._askMeta = null;
    const meta = TABS.find((tab) => tab.id === next);
    this.input.placeholder = meta.placeholder;
    this.input.setAttribute('aria-label', meta.placeholder.replace(/….*$/, '') || meta.label);
    this._syncChrome();
    this._renderTabCounts();
    this._refresh();
  }

  _syncChrome() {
    const isNotifications = this.activeTab === 'notifications';
    const isExtensions = this.activeTab === 'extensions';
    if (this.inputRow) this.inputRow.hidden = isNotifications || isExtensions;
    if (this.footer) this.footer.hidden = !['history', 'downloads'].includes(this.activeTab);
    // Cookies and cache are session-wide, so the button belongs with history
    // rather than with the downloads list.
    if (this.clearSiteDataBtn) this.clearSiteDataBtn.hidden = this.activeTab !== 'history';
    if (this.clearBtn) this.clearBtn.textContent = this.activeTab === 'downloads' ? 'Clear downloads…' : 'Clear history…';
    const notificationControls = this.controls.querySelector('.library-window-notification-controls');
    const extensionControls = this.controls.querySelector('.library-window-extension-controls');
    const extensionInstall = this.controls.querySelector('.library-window-extension-install');
    if (notificationControls) notificationControls.hidden = !isNotifications;
    if (extensionControls) extensionControls.hidden = !isExtensions;
    if (extensionInstall) extensionInstall.hidden = !isExtensions;
    if (this.hintEl) {
      this.hintEl.textContent = isNotifications
        ? 'Site notifications land here even while you work in another space.'
        : (isExtensions ? 'Install only extensions you trust. Electron supports a subset of Chrome extension APIs.' : '');
      this.hintEl.hidden = !(isNotifications || isExtensions);
    }
  }

  // -- Fetching ------------------------------------------------------------

  _scheduleFilterRefresh() {
    this._cancelFilterDebounce();
    this._filterTimer = setTimeout(() => {
      this._filterTimer = null;
      this._refresh();
    }, FILTER_DEBOUNCE_MS);
  }

  _cancelFilterDebounce() {
    if (this._filterTimer) {
      clearTimeout(this._filterTimer);
      this._filterTimer = null;
    }
  }

  /**
   * Reload the active tab. `quiet` keeps the current rows on screen (used by
   * background events); otherwise skeleton rows show until the fetch settles.
   * A newer refresh supersedes an older one still in flight.
   */
  async _refresh({ quiet = false } = {}) {
    this._cancelFilterDebounce();
    const tab = this.activeTab;
    const query = (this.input.value || '').trim();
    const seq = ++this._fetchSeq;
    this._setStatus('');
    this._loadError = null;
    if (tab === 'ask' && !query) {
      this._askMeta = null;
      this._items = [];
      this._render();
      return;
    }
    if (!quiet) this._renderSkeleton();
    let result;
    try {
      result = await this._fetchTab(tab, query);
    } catch (err) {
      if (seq !== this._fetchSeq) return;
      this._items = [];
      this._askMeta = null;
      this._loadError = errText(err);
      this._render();
      return;
    }
    if (seq !== this._fetchSeq) return;
    this._items = result.items;
    this._askMeta = result.askMeta || null;
    if (tab === 'notifications') this._emitBadge(this._items.reduce((n, item) => n + (item.read ? 0 : 1), 0));
    this._render();
  }

  async _fetchTab(tab, query) {
    if (tab === 'history') {
      const items = query
        ? await ipcRenderer.invoke('history:search', { query, limit: 200 })
        : await ipcRenderer.invoke('history:recent', { limit: 200 });
      return { items: items || [] };
    }
    if (tab === 'bookmarks') {
      const items = query
        ? await ipcRenderer.invoke('bookmarks:search', { query })
        : this._flattenTree(await ipcRenderer.invoke('bookmarks:tree'));
      return { items: items || [] };
    }
    if (tab === 'downloads') {
      const active = await ipcRenderer.invoke('downloads:active') || [];
      const history = await ipcRenderer.invoke('downloads:history') || [];
      this._activeDownloadIds = new Set(active.map((x) => x.id).filter(Boolean));
      this._renderTabCounts();
      const all = [...active.map((x) => ({ ...x, _state: 'active' })), ...history];
      const q = query.toLowerCase();
      return { items: q ? all.filter((d) => String(d.filename || '').toLowerCase().includes(q)) : all };
    }
    if (tab === 'ask') {
      const res = await ipcRenderer.invoke('browsing:ask', { query, limit: 50 });
      return {
        items: (res && Array.isArray(res.results)) ? res.results : [],
        askMeta: res
          ? { ok: res.ok !== false, mode: res.mode || '', note: res.note || res.error || '' }
          : { ok: false, mode: '', note: 'Search failed' },
      };
    }
    if (tab === 'notifications') return { items: await ipcRenderer.invoke('notifications:list') || [] };
    if (tab === 'extensions') return { items: await ipcRenderer.invoke('extensions:list') || [] };
    return { items: [] };
  }

  _flattenTree(node, out = []) {
    if (!node) return out;
    if (node.type === 'bookmark') out.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) this._flattenTree(child, out);
    return out;
  }

  // -- Rendering -----------------------------------------------------------

  _renderSkeleton() {
    if (!this.list) return;
    this.list.setAttribute('aria-busy', 'true');
    let html = '';
    for (let i = 0; i < SKELETON_ROWS; i++) {
      html += '<li class="library-skeleton" aria-hidden="true">'
        + '<span class="library-skeleton-icon"></span>'
        + '<span class="library-skeleton-lines"><span class="library-skeleton-line"></span><span class="library-skeleton-line is-short"></span></span>'
        + '</li>';
    }
    this.list.innerHTML = html;
  }

  _render() {
    if (!this.list) return;
    this.list.removeAttribute('aria-busy');
    if (this._loadError) {
      const meta = TABS.find((t) => t.id === this.activeTab);
      this.list.innerHTML = ''
        + '<li class="library-error" role="alert">'
        + '  <span class="library-error-icon" aria-hidden="true">' + iconHTML('warn') + '</span>'
        + '  <span class="library-error-title">Couldn’t load ' + escapeHtml(meta.noun) + '</span>'
        + '  <span class="library-error-detail">' + escapeHtml(this._loadError) + '</span>'
        + '  <button type="button" class="library-btn library-retry">' + iconHTML('refresh') + '<span>Try again</span></button>'
        + '</li>';
      return;
    }
    if (this.activeTab === 'notifications') {
      this._renderNotifications();
      return;
    }
    if (this.activeTab === 'extensions') {
      this._renderExtensions();
      return;
    }
    const status = this._askStatusHtml();
    if (!this._items.length) {
      this.list.innerHTML = status + this._emptyHtml(this._emptyText());
      return;
    }
    if (this.activeTab === 'history') {
      this.list.innerHTML = status + this._renderHistoryGroups();
      return;
    }
    this.list.innerHTML = status + this._items.map((item, i) => this._renderBrowserItem(item, i)).join('');
  }

  _emptyText() {
    const filtered = !!(this.input.value || '').trim();
    switch (this.activeTab) {
      case 'ask':
        if (!this._askMeta) return 'Ask about something you read or saved, then press Enter.';
        return this._askMeta.ok ? 'No matches in your history or bookmarks.' : 'Search is unavailable right now.';
      case 'bookmarks': return filtered ? 'No bookmarks match.' : 'No bookmarks yet. Press Cmd/Ctrl+D on a page to save it.';
      case 'history': return filtered ? 'No history matches.' : 'No browsing history yet.';
      case 'downloads': return filtered ? 'No downloads match.' : 'No downloads yet.';
      default: return 'Nothing here yet.';
    }
  }

  _emptyHtml(text, cls = 'browser-data-empty') {
    const meta = TABS.find((t) => t.id === this.activeTab);
    return '<li class="library-empty ' + cls + '">'
      + '<span class="library-empty-icon" aria-hidden="true">' + iconHTML(meta.icon) + '</span>'
      + '<span>' + escapeHtml(text) + '</span>'
      + '</li>';
  }

  _askStatusHtml() {
    if (this.activeTab !== 'ask' || !this._askMeta) return '';
    const bits = [];
    if (this._askMeta.mode) bits.push(this._askMeta.mode === 'hybrid' ? 'semantic + keyword' : 'keyword');
    if (this._askMeta.note) bits.push(escapeHtml(this._askMeta.note));
    return bits.length ? '<li class="browser-data-status">' + bits.join(' · ') + '</li>' : '';
  }

  _renderHistoryGroups() {
    const now = Date.now();
    let html = '';
    let current = null;
    this._items.forEach((item, i) => {
      const label = dayLabel(item.timestamp, now);
      if (label !== current) {
        current = label;
        html += '<li class="library-group-label" role="presentation">' + escapeHtml(label) + '</li>';
      }
      html += this._renderBrowserItem(item, i);
    });
    return html;
  }

  _renderBrowserItem(item, i) {
    if (this.activeTab === 'downloads') return this._renderDownload(item, i);
    const title = item.title || item.name || item.url || '';
    const subBits = [];
    if (this.activeTab === 'ask' && item.source) subBits.push(item.source);
    if (item.url) subBits.push(item.url);
    if (Number.isFinite(item.timestamp)) {
      subBits.push(this.activeTab === 'history' ? formatTime(item.timestamp) : formatDateTime(item.timestamp));
    }
    const icon = this.activeTab === 'bookmarks' || (this.activeTab === 'ask' && item.source === 'bookmark')
      ? 'bookmark' : 'globe';
    const removable = this.activeTab === 'bookmarks' || this.activeTab === 'history';
    const removeLabel = this.activeTab === 'bookmarks' ? 'Remove bookmark' : 'Remove from history';
    const remove = removable && item.id
      ? '  <button type="button" class="library-icon-btn bd-remove" data-id="' + escapeAttr(item.id) + '"'
        + ' title="' + removeLabel + '" aria-label="' + removeLabel + '">' + iconHTML('close') + '</button>'
      : '';
    return ''
      + '<li class="browser-data-item" data-index="' + i + '" data-url="' + escapeAttr(item.url || '') + '" title="' + escapeAttr(item.url || '') + '">'
      + '  <span class="bd-icon" aria-hidden="true">' + iconHTML(icon) + '</span>'
      + '  <div class="bd-main">'
      + '    <div class="bd-title">' + escapeHtml(title) + '</div>'
      + '    <div class="bd-sub">' + escapeHtml(subBits.join(' · ')) + '</div>'
      + '  </div>'
      + remove
      + '</li>';
  }

  _renderDownload(item, i) {
    const state = item.state || (item._state === 'active' ? 'progressing' : 'completed');
    const total = Number(item.totalBytes) || 0;
    const received = Number(item.receivedBytes) || 0;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((received / total) * 100))) : 0;
    const active = item._state === 'active' && state === 'progressing';
    const subBits = [DOWNLOAD_STATE_LABELS[state] || state];
    if (active) {
      if (total > 0) subBits.push(pct + '%', formatBytes(received) + ' of ' + formatBytes(total));
      else subBits.push(formatBytes(received));
    } else if (state === 'completed') {
      if (total > 0) subBits.push(formatBytes(total));
      if (Number.isFinite(item.completedAt)) subBits.push(formatDateTime(item.completedAt));
    }
    const progress = active
      ? '<div class="library-progress' + (total > 0 ? '' : ' is-indeterminate') + '" role="progressbar" aria-label="Download progress"'
        + ' aria-valuemin="0" aria-valuemax="100"' + (total > 0 ? ' aria-valuenow="' + pct + '"' : '') + '>'
        + '<span class="library-progress-bar" style="width:' + (total > 0 ? pct : 100) + '%"></span></div>'
      : '';
    const canOpen = state === 'completed' && !!item.savePath;
    const actions = canOpen
      ? '<div class="library-row-actions">'
        + '<button type="button" class="library-btn library-dl-open" data-action="open">Open</button>'
        + '<button type="button" class="library-icon-btn library-dl-reveal" data-action="reveal" title="Show in folder" aria-label="Show in folder">' + iconHTML('folder') + '</button>'
        + '</div>'
      : '';
    return ''
      + '<li class="browser-data-item library-download is-' + escapeAttr(state) + '" data-index="' + i + '" data-download-id="' + escapeAttr(item.id || '') + '">'
      + '  <span class="bd-icon" aria-hidden="true">' + iconHTML('download') + '</span>'
      + '  <div class="bd-main">'
      + '    <div class="bd-title">' + escapeHtml(item.filename || 'Download') + '</div>'
      + progress
      + '    <div class="bd-sub">' + escapeHtml(subBits.join(' · ')) + '</div>'
      + '  </div>'
      + actions
      + '</li>';
  }

  _renderNotifications() {
    if (!this._items.length) {
      this.list.innerHTML = this._emptyHtml('No notifications yet.', 'notifications-panel-empty');
      return;
    }
    this.list.innerHTML = this._items.map((item) => {
      const classes = 'notifications-panel-item' + (item.read ? '' : ' is-unread');
      const iconSrc = safeIconSrc(item.iconPath);
      const iconHtmlOut = iconSrc
        ? '<img class="notif-icon-img" src="' + escapeAttr(iconSrc) + '" alt="" />'
        : '<span class="notif-icon-fallback">' + iconHTML('bell') + '</span>';
      return ''
        + '<li class="' + classes + '" data-id="' + escapeAttr(item.id) + '">'
        + '  <div class="notif-icon">' + iconHtmlOut + '</div>'
        + '  <div class="notif-main">'
        + '    <div class="notif-title">' + escapeHtml(item.title || item.origin || 'Notification') + '</div>'
        + (item.body ? '    <div class="notif-body">' + escapeHtml(item.body) + '</div>' : '')
        + '    <div class="notif-meta">'
        + '      <span class="notif-origin">' + escapeHtml(item.origin || '') + '</span>'
        + '      <span class="notif-sep" aria-hidden="true">·</span>'
        + '      <span class="notif-time">' + escapeHtml(timeAgo(item.timestamp)) + '</span>'
        + (item.ephemeral ? '      <span class="notif-tag notif-tag-private">Private</span>' : '')
        + '    </div>'
        + '  </div>'
        + '  <div class="notif-actions">'
        + '    <button type="button" class="library-btn notif-open" data-action="open" title="Open the source tab">Open</button>'
        + '    <button type="button" class="library-icon-btn notif-dismiss" data-action="dismiss" title="Dismiss" aria-label="Dismiss notification">' + iconHTML('close') + '</button>'
        + '  </div>'
        + '</li>';
    }).join('');
  }

  _renderExtensions() {
    if (!this._items.length) {
      this.list.innerHTML = this._emptyHtml('No extensions installed.', 'extensions-panel-empty');
      return;
    }
    this.list.innerHTML = this._items.map((item, i) => ''
      + '<li class="extensions-panel-item" data-index="' + i + '">'
      + '  <span class="bd-icon" aria-hidden="true">' + iconHTML('extensions') + '</span>'
      + '  <div class="ext-meta">'
      + '    <div class="ext-name">' + escapeHtml(item.name || item.id || 'Extension') + '</div>'
      + '    <div class="ext-sub">' + escapeHtml(item.id || '') + (item.version ? ' · v' + escapeHtml(item.version) : '') + '</div>'
      + '    <div class="ext-path">' + escapeHtml(item.path || '') + '</div>'
      + '  </div>'
      + '  <button type="button" class="library-btn is-danger ext-remove" data-id="' + escapeAttr(item.id || '') + '" data-name="' + escapeAttr(item.name || item.id || 'extension') + '">Remove</button>'
      + '</li>').join('');
  }

  // -- Row actions ---------------------------------------------------------

  _onListClick(e) {
    if (e.target.closest('.library-retry')) {
      this._refresh();
      return;
    }
    if (this.activeTab === 'notifications') {
      this._onNotificationClick(e);
      return;
    }
    if (this.activeTab === 'extensions') {
      this._onExtensionClick(e);
      return;
    }
    const removeBtn = e.target.closest('.bd-remove');
    if (removeBtn) {
      this._removeRow(removeBtn.getAttribute('data-id'));
      return;
    }
    const li = e.target.closest('[data-index]');
    if (!li) return;
    const item = this._items[parseInt(li.getAttribute('data-index'), 10)];
    if (!item) return;
    if (this.activeTab === 'downloads') {
      const btn = e.target.closest('button[data-action]');
      if (btn) this._onDownloadAction(btn.getAttribute('data-action'), item);
      return;
    }
    if (!item.url) return;
    const ctx = this.contextProvider() || {};
    if (ctx.navigationManager && typeof ctx.navigationManager.navigateTo === 'function') {
      ctx.navigationManager.navigateTo(item.url);
      this.close();
      return;
    }
    const wv = ctx.navigationManager && typeof ctx.navigationManager.getActiveWebview === 'function'
      ? ctx.navigationManager.getActiveWebview() : null;
    if (wv && typeof wv.loadURL === 'function') {
      Promise.resolve(wv.loadURL(item.url)).catch((err) => toast.error('Couldn’t open ' + item.url + ': ' + errText(err)));
      this.close();
      return;
    }
    toast.error('No open tab to show ' + item.url + ' in.');
  }

  async _onDownloadAction(action, item) {
    const name = item.filename || 'the download';
    if (action === 'open') {
      let failure = '';
      try { failure = await shell.openPath(item.savePath); }
      catch (err) { failure = errText(err); }
      // openPath resolves to an error string ('' on success) instead of rejecting.
      if (failure) toast.error('Couldn’t open ' + name + ': ' + failure);
      return;
    }
    if (action === 'reveal') {
      try { shell.showItemInFolder(item.savePath); }
      catch (err) { toast.error('Couldn’t show ' + name + ' in its folder: ' + errText(err)); }
    }
  }

  _onDownloadEvent(kind, payload) {
    const id = payload && payload.id;
    if (id) {
      if (kind === 'done') this._activeDownloadIds.delete(id);
      else this._activeDownloadIds.add(id);
      this._renderTabCounts();
    }
    if (this.activeTab !== 'downloads' || !this.isOpen()) return;
    const idx = id ? this._items.findIndex((x) => x.id === id && x._state === 'active') : -1;
    if (kind === 'updated' && idx >= 0 && !this._loadError) {
      this._items[idx] = { ...this._items[idx], ...payload, _state: 'active' };
      this._render();
      return;
    }
    this._refresh({ quiet: true });
  }

  // Row-level delete for the two tabs that own removable records. The channel
  // and the wording follow the active tab; every other tab has no remove button.
  async _removeRow(id) {
    if (!id) return;
    const isBookmark = this.activeTab === 'bookmarks';
    const channel = isBookmark ? 'bookmarks:remove' : 'history:delete';
    try {
      await ipcRenderer.invoke(channel, id);
    } catch (err) {
      toast.error('Couldn’t remove ' + (isBookmark ? 'the bookmark' : 'the history entry') + ': ' + errText(err));
      return;
    }
    toast.success(isBookmark ? 'Bookmark removed' : 'Removed from history');
    await this._refresh({ quiet: true });
  }

  async _onNotificationClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('[data-id]');
    const id = row && row.getAttribute('data-id');
    if (!id) return;
    const action = btn.getAttribute('data-action');
    try {
      if (action === 'dismiss') await ipcRenderer.invoke('notifications:dismiss', id);
      if (action === 'open') {
        await ipcRenderer.invoke('notifications:mark-read', id);
        await ipcRenderer.invoke('notifications:activate', id);
      }
    } catch (err) {
      toast.error('Notification action failed: ' + errText(err));
    }
  }

  async _onExtensionClick(e) {
    const btn = e.target.closest('.ext-remove');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    if (!id) return;
    const name = btn.getAttribute('data-name') || 'this extension';
    const ok = await confirm({
      title: 'Remove extension?',
      message: `Remove “${name}”? You can load it again later from its source folder.`,
      confirmLabel: 'Remove',
      confirmKind: 'danger',
    });
    if (!ok) return;
    this._setStatus('Removing…');
    try {
      await ipcRenderer.invoke('extensions:remove', { id });
    } catch (err) {
      this._setStatus('');
      toast.error('Couldn’t remove ' + name + ': ' + errText(err));
      return;
    }
    this._setStatus('');
    await this._refresh({ quiet: true });
  }

  // Session-wide cookies, local storage and HTTP cache. Signs the user out of
  // every logged-in space, so it is confirmed separately from history.
  async _clearSiteData() {
    const ok = await confirm({
      title: 'Clear cookies and cache?',
      message: 'Signs you out of every site and empties the browser cache. History and downloads are not touched.',
      confirmLabel: 'Clear',
      confirmKind: 'danger',
    });
    if (!ok) return;
    try {
      const r = await ipcRenderer.invoke('session:clear-site-data');
      if (r && r.ok) toast.success('Cookies and cache cleared');
      else toast.error('Couldn’t clear cookies and cache' + (r && r.error ? ': ' + r.error : ''));
    } catch (err) {
      toast.error('Couldn’t clear cookies and cache: ' + errText(err));
    }
  }

  async _clearActive() {
    const labels = {
      history: { title: 'Clear history?', message: 'Remove all browsing history. This cannot be undone.', done: 'History cleared' },
      downloads: { title: 'Clear downloads?', message: 'Remove the list of finished downloads. The files themselves are not deleted.', done: 'Download list cleared' },
    };
    const meta = labels[this.activeTab];
    if (!meta) return;
    const ok = await confirm({ title: meta.title, message: meta.message, confirmLabel: 'Clear', confirmKind: 'danger' });
    if (!ok) return;
    try {
      if (this.activeTab === 'history') await ipcRenderer.invoke('history:clear');
      if (this.activeTab === 'downloads') await ipcRenderer.invoke('downloads:clear-history');
    } catch (err) {
      toast.error('Couldn’t clear: ' + errText(err));
      return;
    }
    toast.success(meta.done);
    await this._refresh();
  }

  async _markAllRead() {
    try {
      await ipcRenderer.invoke('notifications:mark-all-read');
    } catch (err) {
      toast.error('Couldn’t mark notifications read: ' + errText(err));
    }
  }

  async _clearAllNotifications() {
    if (!this._items.length) return;
    const ok = await confirm({
      title: 'Clear all notifications?',
      message: 'This removes every notification from the inbox. You cannot undo this.',
      confirmLabel: 'Clear all',
      confirmKind: 'danger',
    });
    if (!ok) return;
    try {
      await ipcRenderer.invoke('notifications:clear-all');
    } catch (err) {
      toast.error('Couldn’t clear notifications: ' + errText(err));
    }
  }

  markAllRead() { return this._markAllRead(); }
  clearAll() { return this._clearAllNotifications(); }

  async _loadExtension() {
    this._setStatus('Loading…');
    let result;
    try {
      result = await ipcRenderer.invoke('extensions:load', {});
    } catch (err) {
      this._setStatus('Load failed: ' + errText(err));
      return;
    }
    this._setStatus(result && result.id ? 'Loaded ' + (result.name || result.id) : '');
    await this._refresh({ quiet: true });
  }

  _installExtensionFromUrl() {
    const value = (this.urlInput && this.urlInput.value || '').trim();
    if (!value) {
      this._setStatus('Enter a Web Store URL, .crx/.zip URL, or extension ID.');
      return;
    }
    this._installExtension(value);
  }

  async _installExtension(source) {
    this._setStatus('Preparing…');
    let prep;
    try {
      prep = await ipcRenderer.invoke('extensions:install-prepare', { source });
    } catch (err) {
      this._setStatus('Install failed: ' + errText(err));
      return;
    }
    if (!prep || prep.ok === false) {
      this._setStatus(prep && prep.cancelled ? '' : 'Install failed: ' + ((prep && prep.error) || 'unknown error'));
      return;
    }
    const perms = (prep.permissions || []).join(', ') || 'no special permissions';
    const hosts = (prep.hostPermissions || []).join(', ') || 'no site access';
    const ok = await confirm({
      title: `Install “${prep.name}”?`,
      message: `${prep.name}${prep.version ? ' v' + prep.version : ''} requests permissions: ${perms}. Site access: ${hosts}. Only install extensions you trust.`,
      confirmLabel: 'Install',
      confirmKind: 'danger',
    });
    this._setStatus(ok ? 'Installing…' : '');
    let res;
    try {
      res = await ipcRenderer.invoke('extensions:install-commit', {
        staging: prep.staging,
        isDirectory: prep.isDirectory,
        accept: ok,
      });
    } catch (err) {
      this._setStatus('Install failed: ' + errText(err));
      return;
    }
    if (ok) {
      if (res && res.ok) {
        this._setStatus('Installed ' + (res.name || res.id || ''));
        if (this.urlInput) this.urlInput.value = '';
      } else {
        this._setStatus('Install failed: ' + ((res && res.error) || 'unknown error'));
      }
    }
    await this._refresh({ quiet: true });
  }

  // -- Notification events -------------------------------------------------

  _renderNotificationsIfShown() {
    if (this.activeTab === 'notifications' && this.isOpen() && !this._loadError) this._render();
  }

  _onNotificationAdded(payload) {
    if (!payload || !payload.record) return;
    if (this.activeTab === 'notifications') {
      this._items = [payload.record, ...this._items.filter((item) => item.id !== payload.record.id)];
    }
    if (payload.unreadCount != null) this._emitBadge(payload.unreadCount);
    this._renderNotificationsIfShown();
  }

  _onNotificationReplaced(payload) {
    if (!payload || !payload.record) return;
    if (this.activeTab === 'notifications') {
      this._items = this._items.filter((item) => item.id !== payload.previousId && item.id !== payload.record.id);
      this._items.unshift(payload.record);
    }
    if (payload.unreadCount != null) this._emitBadge(payload.unreadCount);
    this._renderNotificationsIfShown();
  }

  _onNotificationDismissed(payload) {
    if (!payload || !payload.id) return;
    if (this.activeTab === 'notifications') this._items = this._items.filter((item) => item.id !== payload.id);
    if (payload.unreadCount != null) this._emitBadge(payload.unreadCount);
    this._renderNotificationsIfShown();
  }

  _onNotificationsCleared() {
    if (this.activeTab === 'notifications') this._items = [];
    this._emitBadge(0);
    this._renderNotificationsIfShown();
  }

  _onNotificationReadChanged(payload) {
    if (!payload) return;
    if (this.activeTab === 'notifications') {
      if (payload.id) {
        const record = this._items.find((item) => item.id === payload.id);
        if (record) record.read = true;
      } else {
        this._items.forEach((item) => { item.read = true; });
      }
    }
    if (payload.unreadCount != null) this._emitBadge(payload.unreadCount);
    this._renderNotificationsIfShown();
  }

  _setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text || '';
  }

  open(options = {}) {
    if (!this._dropdown) return;
    this._switchTab(options.tab || this.activeTab || 'ask');
    if (this.activeTab === 'notifications') this._markAllRead();
    this._dropdown.open();
  }

  close() { if (this._dropdown) this._dropdown.close(); }

  toggle(options = {}) {
    if (!this._dropdown) return;
    if (this._dropdown.isOpen()) this.close();
    else this.open(options);
  }
}

module.exports = new LibraryWindow();
