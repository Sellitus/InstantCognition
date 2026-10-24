// PermissionService.js — Centralizes permission decisions for all sessions.
// Hooks into session.setPermissionRequestHandler to apply a default policy
// table, with per-origin overrides loaded from config. A 'prompt' entry asks
// the user through PermissionPromptService. Decisions are recorded to a ring
// buffer for diagnostics.

const { EventEmitter } = require('events');
const { session } = require('electron');

const DEFAULT_POLICY = {
  // Granted by default (low-risk, expected for normal browsing)
  'clipboard-sanitized-write': 'allow',
  'fullscreen': 'allow',
  'pointerLock': 'allow',
  'idle-detection': 'allow',
  'background-sync': 'allow',
  // Prompt the user on first request (answer is persisted per origin)
  'clipboard-read': 'prompt',
  // A link into another app; decided per origin and scheme ('openExternal:mailto').
  'openExternal': 'prompt',
  'notifications': 'prompt',
  'geolocation': 'prompt',
  'media': 'prompt',
  'midi': 'prompt',
  'midiSysex': 'prompt',
  'display-capture': 'prompt',
  // Denied by default (privacy / hardware sensitive — needs a dedicated UI)
  'mediaKeySystem': 'deny',
  'hid': 'deny',
  'serial': 'deny',
  'usb': 'deny',
  'window-management': 'deny',
  'persistent-storage': 'deny',
  'storage-access': 'deny',
  'top-level-storage-access': 'deny',
  'speaker-selection': 'deny',
};

const HISTORY_MAX = 100;
// Schemes that hand a page-chosen path or command line to the OS (file shares,
// the ms-msdt/search-ms launchers); never offered to the user.
const REFUSED_EXTERNAL = /^(file|smb|javascript|vbscript|data|search-ms|search|ms-[a-z0-9.+-]*):$/i;

class PermissionService extends EventEmitter {
  constructor() {
    super();
    this._configService = null;
    this._overrides = new Map(); // key: origin|permission -> 'allow' | 'deny'
    // Answers remembered in the private session: memory only, dropped when it is cleared.
    this._sessionOverrides = new Map();
    this._history = [];
    this._installed = false;
    this._prompter = null;
  }

  /**
   * @param {typeof import('./ConfigService')|null} configService
   * @param {{ promptService?: typeof import('./PermissionPromptService') }} [deps]
   */
  initialize(configService, { promptService } = {}) {
    this._configService = configService || null;
    this._prompter = promptService || null;
    if (configService) {
      const persisted = configService.get('settings.permissions.overrides', null);
      if (persisted && typeof persisted === 'object') {
        for (const k of Object.keys(persisted)) {
          if (persisted[k] === 'allow' || persisted[k] === 'deny') {
            this._overrides.set(k, persisted[k]);
          }
        }
      }
    }
    this._install();
  }

  setPromptService(promptService) {
    this._prompter = promptService || null;
  }

  _install() {
    if (this._installed) return;
    try {
      const ses = session.defaultSession;
      if (!ses) return;
      this.attachToSession(ses);
      this._installed = true;
    } catch (err) {
      console.error('PermissionService install failed:', err);
    }
  }

  // Applies this policy to a session: defaultSession here, the private session
  // from SessionService. An ephemeral session's remembered answers stay in memory.
  attachToSession(ses, { ephemeral = false } = {}) {
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      this.handleRequest(this._originFromDetails(webContents, details), permission, callback, details, { ephemeral });
    });
    // Check handler must return synchronously — 'prompt' means the user has
    // not granted yet, so deny. The site can then call requestPermission(),
    // which goes through the async request flow.
    ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
      this.handleCheck(requestingOrigin || this._originFromDetails(webContents, details), permission, { ephemeral })
    ));
  }

  _originFromDetails(webContents, details) {
    if (details && details.requestingUrl) {
      try { return new URL(details.requestingUrl).origin; } catch (err) { console.warn('[permissions] unparseable requestingUrl, falling back:', (err instanceof Error && err.message) || err); }
    }
    if (webContents && typeof webContents.getURL === 'function') {
      // A view that has not navigated yet reports '', which is a normal state
      // and not worth a warning on every startup permission check.
      const url = webContents.getURL();
      if (url) {
        try { return new URL(url).origin; } catch (err) { console.warn('[permissions] unparseable webContents URL, falling back:', (err instanceof Error && err.message) || err); }
      }
    }
    return '*';
  }

  decide(origin, permission, { ephemeral = false } = {}) {
    const key = origin + '|' + permission;
    if (ephemeral && this._sessionOverrides.has(key)) return this._sessionOverrides.get(key);
    if (ephemeral && this._sessionOverrides.has('*|' + permission)) return this._sessionOverrides.get('*|' + permission);
    if (this._overrides.has(key)) return this._overrides.get(key);
    if (this._overrides.has('*|' + permission)) return this._overrides.get('*|' + permission);
    const base = permission.startsWith('openExternal:') ? 'openExternal' : permission;
    if (Object.prototype.hasOwnProperty.call(DEFAULT_POLICY, base)) return DEFAULT_POLICY[base];
    return 'deny';
  }

  // Resolve a 'prompt' decision via the prompt service if available;
  // falls back to 'deny' if no prompter is wired.
  _resolveViaPrompt(origin, permission, detail, ephemeral) {
    if (this._prompter && typeof this._prompter.requestDecision === 'function') {
      return Promise.resolve().then(() => this._prompter.requestDecision(origin, permission, detail, { ephemeral }));
    }
    return Promise.resolve('deny');
  }

  // Shared by defaultSession and the other sessions (e.g., private).
  handleRequest(origin, permission, callback, details, { ephemeral = false } = {}) {
    let detail;
    if (permission === 'openExternal') {
      const target = details && typeof details.externalURL === 'string' ? details.externalURL : '';
      let scheme = '';
      try { scheme = new URL(target).protocol; } catch (err) { console.warn('[permissions] unparseable external URL:', (err instanceof Error && err.message) || err); }
      if (!scheme || REFUSED_EXTERNAL.test(scheme)) {
        this._record(origin, permission, 'deny', 'request');
        callback(false);
        return;
      }
      permission = 'openExternal:' + scheme.slice(0, -1).toLowerCase();
      detail = target.slice(0, 500);
    }
    const decision = this.decide(origin, permission, { ephemeral });
    if (decision === 'prompt') {
      this._record(origin, permission, 'prompt', 'request');
      this._resolveViaPrompt(origin, permission, detail, ephemeral).then((resolved) => {
        this._record(origin, permission, resolved, 'request-resolved');
        callback(resolved === 'allow');
      }, (err) => {
        console.error('[permissions] prompt failed, denying:', err);
        this._record(origin, permission, 'deny', 'request-resolved');
        callback(false);
      });
      return;
    }
    this._record(origin, permission, decision, 'request');
    callback(decision === 'allow');
  }

  handleCheck(origin, permission, { ephemeral = false } = {}) {
    const decision = this.decide(origin, permission, { ephemeral });
    this._record(origin, permission, decision, 'check');
    return decision === 'allow';
  }

  // An ephemeral override is neither saved nor announced: the settings list
  // and every page's preload listen for 'override-changed'.
  setOverride(origin, permission, decision, { ephemeral = false } = {}) {
    if (decision !== 'allow' && decision !== 'deny') throw new Error('decision must be allow or deny');
    const key = (origin || '*') + '|' + permission;
    if (ephemeral) {
      this._sessionOverrides.set(key, decision);
      return;
    }
    const prev = this._overrides.get(key);
    this._overrides.set(key, decision);
    if (prev !== decision) this._persist();
    this.emit('override-changed', { origin, permission, decision });
  }

  clearOverride(origin, permission) {
    const key = (origin || '*') + '|' + permission;
    const had = this._overrides.delete(key);
    if (had) this._persist();
    return had;
  }

  clearSessionOverrides() {
    this._sessionOverrides.clear();
  }

  getOverrides() {
    const out = {};
    for (const [k, v] of this._overrides.entries()) out[k] = v;
    return out;
  }

  _persist() {
    if (!this._configService) return;
    try { this._configService.set('settings.permissions.overrides', this.getOverrides()); }
    catch (err) { console.error('PermissionService persist failed:', err); }
  }

  _record(origin, permission, decision, kind) {
    this._history.push({ origin, permission, decision, kind, at: Date.now() });
    if (this._history.length > HISTORY_MAX) this._history.shift();
    this.emit('decision', { origin, permission, decision, kind });
  }

  getHistory() {
    return this._history.slice();
  }

  clearHistory() {
    this._history = [];
  }
}

module.exports = new PermissionService();
module.exports.DEFAULT_POLICY = DEFAULT_POLICY;
