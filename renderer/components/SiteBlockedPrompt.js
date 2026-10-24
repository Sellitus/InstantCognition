// SiteBlockedPrompt.js — Singleton modal queue that shows the user when a
// main-frame load was blocked or failed. Lets them retry the navigation or
// add the host to the per-app site allowlist (which exempts the host from
// adblocker filters). When HTTPS-only mode's upgrade is what failed, it also
// offers loading the page over HTTP. Listens on 'site-blocked:show' (sent by main/index.js
// `did-fail-load` handler) and replies via IPC.

const { ipcRenderer } = require('electron');
const { iconHTML } = require('./Icon');
const { trap } = require('../utils/focusTrap');
const modalStack = require('../utils/modalStack');
const { escapeHtml } = require('../utils/html');

function hostnameFromUrl(url) {
  if (!url) return '';
  try { return new URL(url).hostname || url; }
  catch (_) { return url; }
}

// Chromium error codes we want to phrase nicely for the user. Anything not
// listed falls back to the raw errorDescription string from Electron.
const ERROR_COPY = {
  '-20': 'The site was blocked by the in-app ad/tracker filter.',
  '-21': 'A network change interrupted the request.',
  '-22': 'The connection was reset before the page could load.',
  '-27': 'The server\'s response was blocked.',
  '-100': 'The server unexpectedly closed the connection.',
  '-101': 'The connection was reset.',
  '-102': 'The connection was refused.',
  '-104': 'The connection failed to be established.',
  '-105': 'The site\'s address could not be resolved (DNS).',
  '-106': 'No internet connection.',
  '-107': 'The site\'s SSL handshake failed.',
  '-108': 'The site\'s address is invalid.',
  '-109': 'The site\'s address is unreachable.',
  '-118': 'The connection timed out before any data was received.',
  '-137': 'A name resolution failure occurred.',
  '-200': 'The site\'s certificate is not valid for this address.',
  '-201': 'The certificate authority is not trusted.',
  '-202': 'The certificate has expired.',
  '-310': 'Too many redirects.',
  '-379': 'The site is in HTTPS-only mode and HTTPS is not available.',
};

function copyFor(errorCode, errorDescription) {
  const key = String(errorCode);
  if (ERROR_COPY[key]) return ERROR_COPY[key];
  if (errorDescription) return 'This site couldn\'t be loaded (' + errorDescription + ').';
  return 'This site couldn\'t be loaded.';
}

// Errors that look like the in-app filter or response blocked the request —
// adding the host to the allowlist is genuinely useful. Other errors (DNS,
// connection refused) get the dialog without the allowlist offer to avoid
// suggesting an action that won't help.
function isBlockedByApp(errorCode) {
  return errorCode === -20 || errorCode === -27;
}

class SiteBlockedPrompt {
  constructor() {
    this._queue = [];
    this._active = null;
    this._overlay = null;
    // Coalesce repeated failures for the same (webContents, host) so a noisy
    // reload-loop doesn't stack 5 modals. Cleared on resolve.
    this._inflightKeys = new Set();
    this._onKeyDown = this._onKeyDown.bind(this);
    this._layer = null;
    this._wired = false;
  }

  initialize() {
    if (this._wired) return;
    this._wired = true;
    ipcRenderer.on('site-blocked:show', (_e, request) => {
      if (!request || !request.url) return;
      const host = hostnameFromUrl(request.url);
      const key = (request.webContentsId || 0) + '|' + host;
      if (this._inflightKeys.has(key)) return;
      this._inflightKeys.add(key);
      const enriched = { ...request, host, _key: key };
      this._queue.push(enriched);
      this._pump();
    });
  }

  _pump() {
    if (this._active) return;
    const next = this._queue.shift();
    if (!next) return;
    this._active = next;
    this._render(next);
  }

  _resolve(action) {
    const active = this._active;
    if (!active) return;
    try {
      if (action === 'allowlist') {
        ipcRenderer.invoke('site-allowlist:add', active.host)
          .then((res) => {
            if (res && res.ok) {
              ipcRenderer.send('site-blocked:retry', { webContentsId: active.webContentsId });
              return;
            }
            require('./Toast').error((res && res.error) || 'The site could not be allowlisted.', { title: 'Allowlist failed' });
          })
          .catch((err) => {
            console.error('[SiteBlockedPrompt] site-allowlist:add failed:', err);
            require('./Toast').error('The site could not be allowlisted.', { title: 'Allowlist failed' });
          });
      } else if (action === 'retry') {
        ipcRenderer.send('site-blocked:retry', { webContentsId: active.webContentsId });
      } else if (action === 'http') {
        ipcRenderer.send('site-blocked:continue-http', { webContentsId: active.webContentsId });
      }
    } catch (_) { /* ignore */ }
    this._teardown();
    if (active._key) this._inflightKeys.delete(active._key);
    this._active = null;
    this._pump();
  }

  _render(request) {
    if (typeof document === 'undefined' || !document.body) {
      if (request._key) this._inflightKeys.delete(request._key);
      this._active = null;
      return;
    }
    // A downgrade is cancelled by HTTPS-only with the ad blocker's error code;
    // allowlisting or retrying cannot get past the redirect.
    const downgrade = !!request.httpsDowngrade;
    const detail = downgrade
      ? 'The secure version of this page redirected back to HTTP.'
      : copyFor(request.errorCode, request.errorDescription);
    const allowable = !downgrade && isBlockedByApp(request.errorCode);
    const retryBtnHtml = downgrade ? '' : '<button type="button" class="site-blocked-retry">Retry</button>';
    const allowBtn = allowable
      ? '<button type="button" class="permission-prompt-allow site-blocked-allowlist">Add to allowlist & retry</button>'
      : '';
    // Set by main only when an HTTPS-only upgrade is what failed.
    const httpBtn = request.httpFallback
      ? '<button type="button" class="site-blocked-http">Continue over HTTP</button>'
      : '';

    const overlay = document.createElement('div');
    overlay.className = 'permission-prompt-overlay site-blocked-overlay';
    overlay.innerHTML = ''
      + '<div class="permission-prompt site-blocked-prompt" role="alertdialog" aria-modal="true" aria-labelledby="site-blocked-title">'
      + '  <div class="permission-prompt-header">'
      + '    <span class="permission-prompt-icon">' + iconHTML('warn') + '</span>'
      + '    <span class="permission-prompt-title" id="site-blocked-title">Site couldn\'t load</span>'
      + '  </div>'
      + '  <div class="permission-prompt-origin">' + escapeHtml(request.host || request.url) + '</div>'
      + '  <div class="permission-prompt-detail">' + escapeHtml(detail) + '</div>'
      + (allowable
        ? '  <div class="permission-prompt-detail site-blocked-allowlist-hint">Allowlisting exempts the host from the ad/tracker filter for future visits. You can remove it from Settings → Privacy & Security.</div>'
        : '')
      + (request.httpFallback
        ? '  <div class="permission-prompt-detail site-blocked-http-hint">HTTPS-only mode is on and this site did not load securely. Continuing sends this visit unencrypted; the site stays allowed over HTTP until the app restarts.</div>'
        : '')
      + '  <div class="permission-prompt-actions">'
      + '    <button type="button" class="permission-prompt-deny site-blocked-close">Close</button>'
      + '    ' + retryBtnHtml
      + '    ' + httpBtn
      + '    ' + allowBtn
      + '  </div>'
      + '</div>';
    document.body.appendChild(overlay);
    this._overlay = overlay;

    const closeBtn = overlay.querySelector('.site-blocked-close');
    const retryBtn = overlay.querySelector('.site-blocked-retry');
    const allowEl = overlay.querySelector('.site-blocked-allowlist');
    closeBtn.addEventListener('click', () => this._resolve('close'));
    if (retryBtn) retryBtn.addEventListener('click', () => this._resolve('retry'));
    if (allowEl) allowEl.addEventListener('click', () => this._resolve('allowlist'));
    const httpEl = overlay.querySelector('.site-blocked-http');
    if (httpEl) httpEl.addEventListener('click', () => this._resolve('http'));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this._resolve('close');
    });
    document.addEventListener('keydown', this._onKeyDown, true);
    this._layer = modalStack.push();
    // The teardown check is load-bearing: a prompt dismissed before this tick
    // would otherwise install a trap nobody can release, leaving every body
    // child inert and the window unclickable.
    setTimeout(() => {
      if (this._overlay !== overlay) return;
      const initial = allowEl || retryBtn || httpEl;
      this._releaseTrap = trap(overlay.querySelector('.site-blocked-prompt'), { initialFocus: initial });
    }, 0);
  }

  _teardown() {
    if (this._layer) { modalStack.pop(this._layer); this._layer = null; }
    if (this._releaseTrap) {
      // Clear the handle first: a throwing release must not leave a trap that
      // teardown will try to release again on the next prompt.
      const release = this._releaseTrap;
      this._releaseTrap = null;
      try { release(); }
      catch (err) { console.error('[SiteBlockedPrompt] focus trap release failed:', (err instanceof Error && err.message) || err); }
    }
    document.removeEventListener('keydown', this._onKeyDown, true);
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
    this._overlay = null;
  }

  _onKeyDown(e) {
    if (!this._active) return;
    if (this._layer && !modalStack.isTop(this._layer)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this._resolve('close');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const primary = /** @type {HTMLElement|null} */ (this._overlay && (
        this._overlay.querySelector('.site-blocked-allowlist')
        || this._overlay.querySelector('.site-blocked-retry')
        || this._overlay.querySelector('.site-blocked-http')
      ));
      if (primary) primary.click();
    }
  }
}

module.exports = new SiteBlockedPrompt();
