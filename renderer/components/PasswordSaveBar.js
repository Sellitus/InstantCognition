// PasswordSaveBar — non-modal "Save password for <host>?" bar shown after a
// login submit. Main keeps the captured password; this bar only receives the
// offer id, host and username, and answers with save / never / dismiss. Main
// keeps one offer per tab, so offers from several tabs can be pending at once:
// the newest is on screen and the others wait behind it until answered or
// expired. A save main reports as retryable comes back on screen. The bar does
// not take focus, so typing in the page carries on; Escape inside it means
// "Not now".
// Also turns main's password notices (fill failures, no secure storage) into
// toasts.

const { ipcRenderer } = require('electron');
const { iconHTML } = require('./Icon');
const { escapeHtml } = require('../utils/html');
const { errMsg } = require('../../shared/errMsg');
const toast = require('./Toast');

class PasswordSaveBar {
  constructor() {
    this._offer = null;
    /** @type {any[]} offers waiting behind the one on screen, oldest first */
    this._queue = [];
    this._el = null;
    this._wired = false;
  }

  initialize() {
    if (this._wired) return;
    this._wired = true;
    ipcRenderer.on('passwords:offer', (_e, offer) => {
      if (offer && offer.id) this._present(offer);
    });
    ipcRenderer.on('passwords:offer-expired', (_e, p) => {
      if (!p) return;
      this._queue = this._queue.filter((o) => o.id !== p.id);
      if (this._offer && p.id === this._offer.id) this._showNext();
    });
    ipcRenderer.on('passwords:notice', (_e, n) => {
      if (!n || !n.message) return;
      if (n.kind === 'error') toast.error(n.message, { title: 'Passwords' });
      else toast.warn(n.message, { title: 'Passwords' });
    });
  }

  _present(offer) {
    if (this._offer) this._queue.push(this._offer);
    this._show(offer);
  }

  _showNext() {
    const next = this._queue.pop();
    if (next) this._show(next);
    else this._hide();
  }

  _show(offer) {
    this._hide();
    const update = offer.kind === 'update';
    const bar = document.createElement('div');
    bar.className = 'password-bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-modal', 'false');
    bar.setAttribute('aria-labelledby', 'password-bar-title');
    bar.setAttribute('aria-describedby', 'password-bar-user');
    bar.innerHTML = ''
      + '<span class="password-bar-icon" aria-hidden="true">' + iconHTML('key') + '</span>'
      + '<div class="password-bar-text">'
      + '  <div class="password-bar-title" id="password-bar-title">'
      +      (update ? 'Update' : 'Save') + ' password for ' + escapeHtml(offer.host || offer.origin || '') + '?</div>'
      + '  <div class="password-bar-user" id="password-bar-user">'
      +      (offer.username ? 'Username: ' + escapeHtml(offer.username) : 'No username') + '</div>'
      + '</div>'
      + '<div class="password-bar-actions">'
      + '  <button type="button" class="password-bar-save">' + (update ? 'Update' : 'Save') + '</button>'
      + '  <button type="button" class="password-bar-never">Never for this site</button>'
      + '  <button type="button" class="password-bar-dismiss">Not now</button>'
      + '</div>';
    bar.querySelector('.password-bar-save').addEventListener('click', () => this._resolve('save'));
    bar.querySelector('.password-bar-never').addEventListener('click', () => this._resolve('never'));
    bar.querySelector('.password-bar-dismiss').addEventListener('click', () => this._resolve('dismiss'));
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this._resolve('dismiss');
    });
    document.body.appendChild(bar);
    this._el = bar;
    this._offer = offer;
  }

  _hide() {
    if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
    this._el = null;
    this._offer = null;
  }

  async _resolve(action) {
    const offer = this._offer;
    if (!offer) return;
    this._showNext();
    let res;
    try {
      res = await ipcRenderer.invoke('passwords:resolve-offer', { id: offer.id, action });
    } catch (err) {
      console.error('[PasswordSaveBar] passwords:resolve-offer failed:', errMsg(err));
      toast.error(`The password choice could not be applied: ${errMsg(err)}`, { title: 'Passwords' });
      return;
    }
    if (!res || !res.ok) {
      toast.error((res && res.error) || 'The password choice could not be applied.', { title: 'Passwords' });
      if (res && res.retryable) this._present(offer);
      return;
    }
    if (action === 'save') toast.success(offer.kind === 'update' ? 'Password updated' : 'Password saved');
  }
}

module.exports = new PasswordSaveBar();
