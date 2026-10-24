// TabChromeStrip — per-tab navigation + URL strip + per-tab agent button.
// One instance per visible space wrapper. Operates exclusively on its own
// sibling <webview> (no global "active webview" lookup, no IPC).
//
// Why per-instance: in multi-mode, several webviews are visible at once; the
// global URL bar can only reflect one of them. Each strip stays in sync with
// its own webview's URL/back/forward/loading state, so users can navigate
// individual panes without first focusing them.

const { ipcRenderer } = require('electron');
const { resolveNavigationUrl, searchUrlFor } = require('../utils/urlNavigate');
const { icon } = require('./Icon');
const OmniboxSuggest = require('./OmniboxSuggest');
const { PRIVATE_PARTITION } = require('../utils/historyRecorder');

class TabChromeStrip {
  constructor({ spaceId, agentPanel, readerView, getTabTitle, getHomeUrl, getSearchEngine, getCustomEngines, getSettings }) {
    this.spaceId = String(spaceId);
    this._agentPanel = agentPanel || null;
    this._readerView = readerView || null;
    this._getTabTitle = typeof getTabTitle === 'function' ? getTabTitle : () => null;
    this._getHomeUrl = typeof getHomeUrl === 'function' ? getHomeUrl : () => null;
    this._getSearchEngine = typeof getSearchEngine === 'function' ? getSearchEngine : () => 'google';
    this._getCustomEngines = typeof getCustomEngines === 'function' ? getCustomEngines : () => [];
    this._getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this._suggest = null;
    this._wv = null;
    this._root = null;
    this._urlInput = null;
    this._backBtn = null;
    this._forwardBtn = null;
    this._reloadBtn = null;
    this._homeBtn = null;
    this._agentBtn = null;
    this._statusEl = null;
    this._wvHandlers = null;
    this._ipcHandlers = null;
    this._loading = false;
  }

  mount(wrapper, webview) {
    if (!wrapper || !webview) return;
    this._wv = webview;
    this._root = this._buildDom();
    // Prepend so the strip sits ABOVE the webview. CSS sets the wrapper to
    // flex-direction: column, so this is the chrome row + the webview below.
    wrapper.insertBefore(this._root, wrapper.firstChild);
    this._wireWebview(webview);
    this._wireIpc();
    this._sync();
  }

  // Re-bind to a freshly-replaced webview (NavigationManager._homeReset
  // builds a new <webview> element under the same spaceId). Keep the same
  // strip DOM so the user's URL field doesn't briefly flash empty.
  rebind(newWebview) {
    if (!newWebview || newWebview === this._wv) return;
    this._unwireWebview();
    this._wv = newWebview;
    this._wireWebview(newWebview);
    this._sync();
  }

  destroy() {
    if (this._suggest) { this._suggest.destroy(); this._suggest = null; }
    this._unwireWebview();
    this._unwireIpc();
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
    this._wv = null;
  }

  _buildDom() {
    const root = document.createElement('div');
    root.className = 'tab-chrome-strip';
    root.dataset.spaceId = this.spaceId;

    this._backBtn = this._mkButton('back', 'Back (this tab)', () => { if (this._wv && this._wv.canGoBack && this._wv.canGoBack()) this._wv.goBack(); });
    this._forwardBtn = this._mkButton('forward', 'Forward (this tab)', () => { if (this._wv && this._wv.canGoForward && this._wv.canGoForward()) this._wv.goForward(); });
    this._reloadBtn = this._mkButton('refresh', 'Reload (this tab)', () => { if (this._wv && this._wv.reload) this._wv.reload(); });
    // Per-tab home: navigates back to the URL the tab was created with — for
    // predefined spaces (e.g. Perplexity) that's the configured space URL;
    // for ad-hoc tabs it's the URL the user opened it with. Disabled if we
    // can't resolve a home URL for this spaceId.
    this._homeBtn = this._mkButton('home', 'Home (this tab)', () => this._goHome());

    const urlInput = document.createElement('input');
    urlInput.className = 'tab-chrome-url';
    urlInput.type = 'text';
    urlInput.spellcheck = false;
    urlInput.autocomplete = 'off';
    urlInput.placeholder = 'Enter URL or search…';
    urlInput.addEventListener('keydown', (e) => {
      if (this._suggest && this._suggest.handleKey(e)) return;
      if (e.key === 'Enter') { e.preventDefault(); this._submitUrl(); }
      else if (e.key === 'Escape') { this._sync(); urlInput.blur(); }
    });
    urlInput.addEventListener('focus', () => urlInput.select());
    this._urlInput = urlInput;

    this._readerBtn = this._mkButton('library', 'Reader (clean reading view, read aloud)', () => this._openReaderForTab());
    this._readerBtn.classList.add('tab-chrome-reader-btn');

    this._copilotBtn = this._mkButton('sparkles', 'Page Copilot (summarize / ask about this tab)', () => this._openCopilotForTab());
    this._copilotBtn.classList.add('tab-chrome-copilot-btn');

    this._agentBtn = this._mkButton('agent', 'Agent on this tab', () => this._openAgentForTab());
    this._agentBtn.classList.add('tab-chrome-agent-btn');

    const status = document.createElement('span');
    status.className = 'tab-chrome-agent-status';
    status.dataset.status = 'idle';
    status.title = 'Agent status (this tab)';
    this._statusEl = status;

    root.appendChild(this._backBtn);
    root.appendChild(this._forwardBtn);
    root.appendChild(this._reloadBtn);
    root.appendChild(this._homeBtn);
    root.appendChild(urlInput);
    root.appendChild(this._readerBtn);
    root.appendChild(this._copilotBtn);
    root.appendChild(this._agentBtn);
    root.appendChild(status);
    this._suggest = new OmniboxSuggest(urlInput, {
      // In a private tab typed text never leaves the app, and normal-profile
      // history and bookmarks are not listed under it.
      getSettings: () => (this._wv && this._wv.getAttribute('partition') === PRIVATE_PARTITION
        ? { ...this._getSettings(), addressBarSearchHistory: false, searchSuggestionsEnabled: false }
        : this._getSettings()),
      onPick: (row) => this._navigate(row.type === 'url'
        ? row.value
        : searchUrlFor(row.value, this._getSearchEngine(), this._getCustomEngines())),
    });
    this._suggest.attach(root);
    return root;
  }

  _mkButton(iconName, title, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab-chrome-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.appendChild(icon(iconName));
    btn.addEventListener('click', (e) => { e.preventDefault(); handler(); });
    return btn;
  }

  _submitUrl() {
    if (!this._wv || !this._urlInput) return;
    const url = resolveNavigationUrl(this._urlInput.value, this._getSearchEngine(), this._getCustomEngines());
    if (!url) return;
    try { this._wv.src = url; } catch (_) { /* ignore */ }
  }

  _navigate(url) {
    if (!this._wv || !url) return;
    this._urlInput.value = url;
    this._wv.src = url;
    this._urlInput.blur();
  }

  _goHome() {
    if (!this._wv) return;
    const url = this._getHomeUrl(this.spaceId);
    if (!url) return;
    try { this._wv.src = url; } catch (_) { /* ignore */ }
  }

  _openAgentForTab() {
    if (!this._agentPanel || typeof this._agentPanel.open !== 'function') return;
    const title = this._getTabTitle(this.spaceId) || null;
    this._agentPanel.open({ scope: 'tab', tabId: this.spaceId, tabTitle: title });
  }

  _openCopilotForTab() {
    if (!this._agentPanel || typeof this._agentPanel.openChatAction !== 'function') return;
    const title = this._getTabTitle(this.spaceId) || null;
    this._agentPanel.openChatAction('summarize', { scope: 'tab', tabId: this.spaceId, tabTitle: title });
  }

  _openReaderForTab() {
    if (!this._readerView || typeof this._readerView.open !== 'function') return;
    this._readerView.open({ spaceId: this.spaceId });
  }

  _wireWebview(wv) {
    const onNav = () => this._sync();
    const onLoadStart = () => { this._loading = true; this._setReloadBusy(true); };
    const onLoadStop = () => { this._loading = false; this._setReloadBusy(false); this._sync(); };
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    wv.addEventListener('page-title-updated', onNav);
    wv.addEventListener('did-start-loading', onLoadStart);
    wv.addEventListener('did-stop-loading', onLoadStop);
    wv.addEventListener('dom-ready', onNav);
    this._wvHandlers = { onNav, onLoadStart, onLoadStop };
  }

  _unwireWebview() {
    if (!this._wv || !this._wvHandlers) return;
    const { onNav, onLoadStart, onLoadStop } = this._wvHandlers;
    try {
      this._wv.removeEventListener('did-navigate', onNav);
      this._wv.removeEventListener('did-navigate-in-page', onNav);
      this._wv.removeEventListener('page-title-updated', onNav);
      this._wv.removeEventListener('did-start-loading', onLoadStart);
      this._wv.removeEventListener('did-stop-loading', onLoadStop);
      this._wv.removeEventListener('dom-ready', onNav);
    } catch (_) { /* webview already gone */ }
    this._wvHandlers = null;
  }

  _wireIpc() {
    const matches = (p) => p && p.scope === 'tab' && p.tabId && String(p.tabId) === this.spaceId;
    const onStart = (_e, p) => { if (matches(p)) this._setStatus('running'); };
    const onDone = (_e, p) => { if (matches(p)) this._setStatus(p && p.ok ? 'done' : (p && p.reason ? 'failed' : 'stopped')); };
    const onFail = (_e, p) => { if (matches(p)) this._setStatus('error'); };
    ipcRenderer.on('agent:task-started', onStart);
    ipcRenderer.on('agent:task-completed', onDone);
    ipcRenderer.on('agent:task-failed', onFail);
    this._ipcHandlers = { onStart, onDone, onFail };
  }

  _unwireIpc() {
    if (!this._ipcHandlers) return;
    const { onStart, onDone, onFail } = this._ipcHandlers;
    try {
      ipcRenderer.removeListener('agent:task-started', onStart);
      ipcRenderer.removeListener('agent:task-completed', onDone);
      ipcRenderer.removeListener('agent:task-failed', onFail);
    } catch (_) { /* ignore */ }
    this._ipcHandlers = null;
  }

  _setStatus(status) {
    if (!this._statusEl) return;
    this._statusEl.dataset.status = status;
  }

  _setReloadBusy(busy) {
    if (!this._reloadBtn) return;
    this._reloadBtn.classList.toggle('is-loading', !!busy);
  }

  _sync() {
    if (!this._wv || !this._urlInput) return;
    // Don't clobber what the user is typing.
    if (document.activeElement !== this._urlInput) {
      try {
        const url = typeof this._wv.getURL === 'function' ? this._wv.getURL() : '';
        this._urlInput.value = url || '';
      } catch (_) { /* webview not attached */ }
    }
    try {
      if (this._backBtn) this._backBtn.disabled = !(this._wv.canGoBack && this._wv.canGoBack());
      if (this._forwardBtn) this._forwardBtn.disabled = !(this._wv.canGoForward && this._wv.canGoForward());
      if (this._homeBtn) this._homeBtn.disabled = !this._getHomeUrl(this.spaceId);
    } catch (_) { /* ignore */ }
  }

  // Public — used by Cmd+L handler so the global focus shortcut focuses the
  // strip belonging to the currently focused tab.
  focus() {
    if (!this._urlInput) return;
    this._sync();
    this._urlInput.focus();
    this._urlInput.select();
  }
}

module.exports = TabChromeStrip;
