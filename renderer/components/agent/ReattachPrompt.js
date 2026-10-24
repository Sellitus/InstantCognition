// ReattachPrompt — shown when the tab the agent was controlling closes
// mid-run. Lets the user re-attach to the active tab, pick a different tab,
// or abort the run entirely.

const { ipcRenderer } = require('electron');
const { escapeHtml } = require('./format');
const { errMsg } = require('../../../shared/errMsg');

class ReattachPrompt {
  constructor({ root, getContext }) {
    this._root = root;
    this._getContext = getContext;
    this._el = this._build();
    root.appendChild(this._el);
    this.hide();
  }

  _build() {
    const div = document.createElement('div');
    div.className = 'agent-reattach';
    div.setAttribute('aria-live', 'assertive');
    div.innerHTML = ''
      + '<div class="agent-reattach-title">The tab the agent was using closed.</div>'
      + '<div class="agent-reattach-body">Re-attach to another tab so the agent can keep going.</div>'
      + '<div class="agent-reattach-actions">'
      + '  <button type="button" data-action="active">Re-attach to active tab</button>'
      + '  <button type="button" data-action="abort">Abort run</button>'
      + '</div>';
    div.querySelector('[data-action="active"]').addEventListener('click', () => this._reattachActive());
    div.querySelector('[data-action="abort"]').addEventListener('click', () => this._abort());
    return div;
  }

  show() { this._el.classList.add('is-open'); this._el.hidden = false; }
  hide() { this._el.classList.remove('is-open'); this._el.hidden = true; }

  async _reattachActive() {
    const ctx = this._getContext ? this._getContext() : null;
    const wv = ctx && ctx.navigationManager && typeof ctx.navigationManager.getActiveWebview === 'function'
      ? ctx.navigationManager.getActiveWebview() : null;
    if (!wv || typeof wv.getWebContentsId !== 'function') {
      this._showError('No active webview to re-attach to. Open a tab first.');
      return;
    }
    let id;
    try { id = wv.getWebContentsId(); }
    catch (e) { this._showError(`Cannot resolve webview id: ${errMsg(e)}`); return; }
    try {
      const result = await ipcRenderer.invoke('agent:reattach', { webContentsId: id });
      if (result && result.ok) this.hide();
      else this._showError(result && result.error ? result.error : 'Re-attach failed.');
    } catch (err) {
      this._showError(errMsg(err) || 'Re-attach failed.');
    }
  }

  _abort() {
    ipcRenderer.send('agent:stop');
    this.hide();
  }

  _showError(msg) {
    let err = this._el.querySelector('.agent-reattach-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'agent-reattach-error';
      this._el.appendChild(err);
    }
    err.textContent = msg;
    err.innerHTML = escapeHtml(msg);
  }
}

module.exports = ReattachPrompt;
