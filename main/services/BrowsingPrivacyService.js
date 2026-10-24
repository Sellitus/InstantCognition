// BrowsingPrivacyService — applies the Privacy & Security toggles to web traffic:
// Do Not Track + Global Privacy Control headers, third-party Cookie stripping,
// HTTPS-only upgrades of webview page loads, and clearing cookies at quit.
// Settings are read on every request, so a toggle applies without a restart.
//
// Electron keeps only the last listener per webRequest event per session. The
// ad blocker owns onBeforeRequest; this service owns onBeforeSendHeaders and
// one composed onHeadersReceived per session that runs the ad blocker's
// response handler first, then strips third-party Set-Cookie. Ghostery's
// enable/disable overwrite that listener, so AdblockerService calls
// setResponseBlocker after each one to put the composed listener back.
//
// Third-party = a subresource whose site differs from the page's. A request
// with no webview (a service worker's) is judged by the site of the origin
// that issued it (initiatorOrigin); one with no initiator (main-process
// fetches) is left alone.

const { getDomain } = require('tldts-experimental');
const { isLocalHost } = require('../../shared/privateIp');
// The module exports an instance; the origin parser is a static on its class.
const { computeHttpOrigins } = /** @type {any} */ (require('./HttpAllowlistService')).constructor;

const CLEAR_ON_QUIT_TIMEOUT_MS = 3000;
const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
const ALL_URLS = { urls: ['<all_urls>'] };

// Registrable domain ("site"); IP addresses and single-label hosts are their own site.
function siteOf(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (!WEB_SCHEMES.has(parsed.protocol)) return null;
  return getDomain(parsed.hostname, { allowPrivateDomains: true }) || parsed.hostname;
}

class BrowsingPrivacyService {
  constructor() {
    this._config = null;
    this._app = null;
    this._session = null;
    this._httpAllowed = new Set(); // hosts the user chose to load over HTTP this run
    this._upgrades = new WeakMap(); // webContents -> { http, https } for the upgrade in flight
    this._responseBlockers = new WeakMap(); // session -> ad blocker engine filtering its responses
    this._cookiesCleared = false;
    this._clearing = false;
  }

  /**
   * @param {{ get: (path: string, fallback?: any) => any }} configService
   * @param {{ app?: any, session?: any }} [deps] Electron modules (injected by tests)
   */
  initialize(configService, deps = {}) {
    const electron = deps.app && deps.session ? deps : require('electron');
    this._config = configService;
    this._app = electron.app;
    this._session = electron.session;
    this.attachToSession(this._session.defaultSession);
    // will-quit fires once every window has closed, so no page is left to set
    // a cookie after the clear.
    this._app.on('will-quit', (event) => this._onWillQuit(event));
  }

  attachToSession(ses) {
    ses.webRequest.onBeforeSendHeaders((details, callback) => callback(this.handleRequest(details)));
    this.setResponseBlocker(ses, this._responseBlockers.get(ses) || null);
  }

  /**
   * (Re)install the session's composed onHeadersReceived listener.
   * @param {any} ses Electron session
   * @param {{ onHeadersReceived: (details: any, callback: (result: any) => void) => void } | null} blocker
   *   the ad blocker engine blocking in this session, or null when it is not
   */
  setResponseBlocker(ses, blocker) {
    if (blocker) this._responseBlockers.set(ses, blocker);
    else this._responseBlockers.delete(ses);
    ses.webRequest.onHeadersReceived(ALL_URLS, (details, callback) => {
      if (!blocker) { callback(this._stripSetCookie(details, {})); return; }
      blocker.onHeadersReceived(details, (result) => callback(this._stripSetCookie(details, result || {})));
    });
  }

  // A cancel or redirect from the ad blocker wins as is; otherwise the headers
  // it rewrote (or, when it left them alone, the response's own) lose
  // Set-Cookie for a third-party response.
  _stripSetCookie(details, result) {
    if (result.cancel || result.redirectURL || !this._isThirdPartyCookieRequest(details)) return result;
    const headers = result.responseHeaders || details.responseHeaders;
    if (!headers) return result;
    const names = Object.keys(headers).filter((name) => name.toLowerCase() === 'set-cookie');
    if (names.length === 0) return result;
    const responseHeaders = { ...headers };
    for (const name of names) delete responseHeaders[name];
    return { ...result, responseHeaders };
  }

  _isThirdPartyCookieRequest(details) {
    if (details.resourceType === 'mainFrame' || !this._setting('blockThirdPartyCookies')) return false;
    const wc = details.webContents;
    if (wc && !wc.isDestroyed() && wc.getType() === 'webview') {
      const top = siteOf(wc.getURL());
      return !!top && siteOf(details.url) !== top;
    }
    // A service worker forwards its page's navigations: the document is the
    // top of its own frame, so it is first-party to itself.
    if (details.resourceType === 'subFrame') return false;
    // Never the referrer: it is often empty and can name another site's page.
    // initiatorOrigin is "null" for an opaque origin.
    const initiator = details.initiatorOrigin && details.initiatorOrigin !== 'null' ? siteOf(details.initiatorOrigin) : null;
    return !!initiator && siteOf(details.url) !== initiator;
  }

  _setting(name) {
    return !!(this._config && this._config.get(`settings.${name}`, false));
  }

  handleRequest(details) {
    const wc = details.webContents && !details.webContents.isDestroyed() && details.webContents.getType() === 'webview'
      ? details.webContents : null;
    if (wc && details.resourceType === 'mainFrame') {
      const pending = this._upgrades.get(wc);
      if (pending && pending.requestId !== undefined && pending.requestId === details.id) {
        // A redirect hop of the upgraded request (it keeps its id across
        // redirects). HTTPS hops (an SSO bounce) keep the watch; a hop back to
        // HTTP would loop if upgraded again, so stop and offer HTTP instead.
        if (/^http:/i.test(details.url)) {
          pending.http = details.url;
          pending.downgraded = true;
          return { cancel: true };
        }
      } else if (pending && details.url === pending.https) {
        pending.requestId = details.id;
      } else if (pending) {
        this._upgrades.delete(wc);
      }
      if (this._upgrade(wc, details)) return { cancel: true };
    }
    const requestHeaders = { ...details.requestHeaders };
    if (this._setting('doNotTrack')) {
      requestHeaders.DNT = '1';
      requestHeaders['Sec-GPC'] = '1';
    }
    if (this._isThirdPartyCookieRequest(details)) {
      for (const name of Object.keys(requestHeaders)) {
        if (name.toLowerCase() === 'cookie') delete requestHeaders[name];
      }
    }
    return { requestHeaders };
  }

  // Cancels a plain-HTTP page load and reloads it over HTTPS, so the HTTP
  // request never leaves the machine. Only GET: a reload cannot replay a body.
  _upgrade(wc, details) {
    if (details.method !== 'GET') return false;
    const https = this.upgradeTarget(details.url);
    if (https === details.url) return false;
    this._upgrades.set(wc, { http: details.url, https });
    setImmediate(() => {
      if (wc.isDestroyed()) return;
      this._dropHistoryEntry(wc, details.url);
      wc.loadURL(https).catch((err) => {
        // A failed load also raises did-fail-load, where the user is offered HTTP.
        console.warn('[privacy] HTTPS upgrade did not load:', (err instanceof Error && err.message) || err);
      });
    });
    return true;
  }

  // The HTTPS form of an http URL when HTTPS-only applies to it, else the URL
  // unchanged. For callers that load a URL themselves (the agent's navigate),
  // whose load the in-flight cancel would otherwise reject.
  upgradeTarget(rawUrl) {
    if (!this._setting('httpsOnly')) return rawUrl;
    let url;
    try { url = new URL(rawUrl); } catch (_) { return rawUrl; }
    if (url.protocol !== 'http:' || this._isExempt(url)) return rawUrl;
    url.protocol = 'https:';
    return url.href;
  }

  // A cancelled Back/Forward leaves the http entry in history, and the HTTPS
  // load lands after the current page, so Back would hit the entry again.
  _dropHistoryEntry(wc, httpUrl) {
    const history = wc.navigationHistory;
    if (!history) return;
    const active = history.getActiveIndex();
    const index = history.getAllEntries().findIndex((entry, i) => i !== active && entry.url === httpUrl);
    if (index !== -1) history.removeEntryAtIndex(index);
  }

  _isExempt(url) {
    if (isLocalHost(url.hostname) || this._httpAllowed.has(url.hostname)) return true;
    // Spaces the user configured with an http:// URL keep working.
    return computeHttpOrigins(this._config.get('spaces', {})).has(url.origin);
  }

  // The did-fail-load for the cancelled HTTP request is ours, not a site failure.
  isUpgradeCancel(wc, url) {
    const pending = this._upgrades.get(wc);
    return !!pending && !pending.downgraded && pending.http === url;
  }

  // The HTTPS page redirected back to HTTP and was stopped here: the failure
  // is not the ad blocker's, so the prompt must not offer the allowlist.
  isDowngradeCancel(wc, url) {
    const pending = this._upgrades.get(wc);
    return !!pending && !!pending.downgraded && pending.http === url;
  }

  // The HTTP URL to offer when the HTTPS upgrade failed to load or redirected
  // back to HTTP.
  httpFallbackFor(wc, url) {
    const pending = this._upgrades.get(wc);
    if (!pending) return null;
    if (pending.https === url || (pending.downgraded && pending.http === url)) return pending.http;
    return null;
  }

  // "Continue over HTTP": exempts the host for the rest of this run.
  continueOverHttp(wc) {
    const pending = this._upgrades.get(wc);
    if (!pending) return false;
    this._upgrades.delete(wc);
    this._httpAllowed.add(new URL(pending.http).hostname);
    wc.loadURL(pending.http).catch((err) => {
      console.error('[privacy] HTTP fallback did not load:', (err instanceof Error && err.message) || err);
    });
    return true;
  }

  _onWillQuit(event) {
    if (this._cookiesCleared || !this._setting('clearCookiesOnQuit')) return;
    event.preventDefault();
    if (this._clearing) return;
    this._clearing = true;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${CLEAR_ON_QUIT_TIMEOUT_MS} ms`)), CLEAR_ON_QUIT_TIMEOUT_MS);
    });
    const finish = () => {
      clearTimeout(timer);
      this._cookiesCleared = true;
      this._app.quit();
    };
    Promise.race([this._session.defaultSession.clearStorageData({ storages: ['cookies'] }), timeout])
      .then(finish, (err) => {
        console.error('[privacy] could not clear cookies before quitting:', err);
        finish();
      });
  }
}

module.exports = new BrowsingPrivacyService();
module.exports.isLocalHost = isLocalHost;
module.exports.siteOf = siteOf;
module.exports.CLEAR_ON_QUIT_TIMEOUT_MS = CLEAR_ON_QUIT_TIMEOUT_MS;
