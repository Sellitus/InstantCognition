// PasswordService — saved logins: save offers after a login submit, autofill
// on an explicit context-menu choice, and the Settings → Passwords actions.
//
// A captured password stays in main, keyed by an opaque offer id with a short
// TTL; the shell's save bar only sees origin, host and username. Plaintext
// leaves main only to the guest's top frame on a fill the user chose, and to
// the shell for one entry on an explicit, main-confirmed reveal.

const store = require('./passwords/passwordStore');
const { decideCapture } = require('./passwords/capturePolicy');
const { authMode, confirmAccess } = require('./passwords/userConsent');
const { errMsg } = require('../../shared/errMsg');

const OFFER_TTL_MS = 2 * 60 * 1000;
// A page firing login submits faster than this is not a person signing in.
const CAPTURE_INTERVAL_MS = 1000;

const FILL_FAILURES = {
  'no-form': 'No login form was found on this page to fill.',
  'origin-mismatch': 'The page changed before the saved password could be filled. Try again.',
  'certificate-error': 'Saved passwords are not filled on a site whose security certificate was not valid.',
};

const isGuest = (sender) => !!sender && typeof sender.getType === 'function' && sender.getType() === 'webview';

class PasswordService {
  constructor() {
    this.OFFER_TTL_MS = OFFER_TTL_MS;
    this._store = store;
    this._tabs = require('./tabRegistry');
    this._mainWindow = null;
    this._config = null;
    this._certs = null;
    /** @type {Map<string, { tabId: number, origin: string, username: string, password: string, existingId: string|null, expiresAt: number, timer: any }>} */
    this._pending = new Map();
    /** @type {Map<number, number>} webContents id -> time of its last capture */
    this._lastCapture = new Map();
    /** @type {Map<number, { id: string, origin: string, persistent: boolean }>} fills awaiting the page's result */
    this._fills = new Map();
    this._now = Date.now;
    this._setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; };
    this._clearTimer = (t) => clearTimeout(t);
    this._platform = process.platform;
    this._warnedUnavailable = false;
  }

  _setNow(fn) { this._now = fn; }
  _setTimers(set, clear) { this._setTimer = set; this._clearTimer = clear; }
  _setPlatform(p) { this._platform = p; }

  /** @param {{ mainWindow?: any, configService?: any, certificateService?: { hasCertificateException(host: string): boolean } }} deps */
  bind(deps) {
    this._mainWindow = deps.mainWindow || null;
    this._config = deps.configService || null;
    this._certs = deps.certificateService || null;
  }

  _toShell(channel, payload) {
    const mw = this._mainWindow;
    if (mw && !mw.isDestroyed()) mw.webContents.send(channel, payload);
  }

  _notice(kind, message) { this._toShell('passwords:notice', { kind, message }); }

  _offerEnabled() {
    return !this._config || this._config.get('settings.passwords.offerToSave', true) !== false;
  }

  // Chrome turns autofill off on a page with a certificate error; a host this
  // run let through an invalid certificate gets the same treatment. With no
  // certificate service bound nothing can be verified, so nothing qualifies.
  _certificateError(origin) {
    if (!this._certs) return true;
    let host;
    try {
      host = new URL(origin).hostname;
    } catch (_) {
      return true; // Not an origin with a host: nothing to fill or save there.
    }
    return this._certs.hasCertificateException(host);
  }

  _isAgentTab(sender) {
    const spaceId = this._tabs.findBySpaceId(sender.id);
    const entry = spaceId ? this._tabs.get(spaceId) : null;
    return !!entry && entry.kind === 'agent';
  }

  _rateLimited(senderId) {
    const now = this._now();
    const last = this._lastCapture.get(senderId);
    for (const [id, at] of this._lastCapture) if (now - at >= CAPTURE_INTERVAL_MS) this._lastCapture.delete(id);
    this._lastCapture.set(senderId, now);
    return last !== undefined && now - last < CAPTURE_INTERVAL_MS;
  }

  // -- Capture ----------------------------------------------------------------

  /** A guest page's preload reported a login submit. */
  handleCaptured(event, payload) {
    const sender = event && event.sender;
    if (!isGuest(sender)) return { action: 'skip', reason: 'not-a-guest' };
    // senderFrame is null once the frame has navigated or gone; its origin
    // can then no longer be trusted to be the one that sent the credential.
    const frame = event.senderFrame;
    if (!frame) return { action: 'skip', reason: 'frame-gone' };
    if (frame.parent) return { action: 'skip', reason: 'not-top-frame' };
    if (this._rateLimited(sender.id)) return { action: 'skip', reason: 'rate-limited' };
    // What the agent types into its own tabs is not the user's login.
    if (this._isAgentTab(sender)) return { action: 'skip', reason: 'agent-tab' };
    const p = payload || {};
    let decision;
    try {
      decision = decideCapture({
        origin: frame.origin,
        persistent: !!(sender.session && sender.session.isPersistent()),
        offerEnabled: this._offerEnabled(),
        certificateError: this._certificateError(frame.origin),
        username: p.username,
        password: p.password,
      }, this._store);
    } catch (err) {
      console.error('[PasswordService] could not check the saved passwords:', errMsg(err));
      this._notice('error', `Could not check saved passwords: ${errMsg(err)}`);
      return { action: 'skip', reason: 'error' };
    }
    if (decision.action === 'unavailable') {
      if (!this._warnedUnavailable) {
        this._warnedUnavailable = true;
        this._notice('warn', decision.reason);
      }
      return decision;
    }
    if (decision.action === 'save' || decision.action === 'update') {
      const existingId = decision.action === 'update' ? decision.existingId : null;
      this._offer(sender.id, { origin: frame.origin, username: p.username, password: p.password, existingId }, decision.action);
    }
    return decision;
  }

  _dropPending(id) {
    const entry = this._pending.get(id);
    if (!entry) return null;
    this._clearTimer(entry.timer);
    this._pending.delete(id);
    return entry;
  }

  // One offer per tab: a newer login there replaces that tab's offer, while
  // offers from other tabs stay pending until answered or expired.
  _offer(tabId, login, kind) {
    for (const [id, entry] of this._pending) if (entry.tabId === tabId) this._expire(id);
    const id = require('crypto').randomUUID();
    const timer = this._setTimer(() => this._expire(id), OFFER_TTL_MS);
    this._pending.set(id, { tabId, ...login, expiresAt: this._now() + OFFER_TTL_MS, timer });
    this._toShell('passwords:offer', { id, origin: login.origin, host: new URL(login.origin).host, username: login.username, kind });
  }

  _expire(id) {
    if (this._dropPending(id)) this._toShell('passwords:offer-expired', { id });
  }

  /**
   * The user answered the save bar: 'save' | 'never' | 'dismiss'. A failed
   * save or never keeps the offer pending, so the bar can offer a retry.
   * @returns {{ ok: true } | { ok: false, error: string, retryable?: true }}
   */
  resolveOffer(id, action) {
    if (action !== 'save' && action !== 'never' && action !== 'dismiss') return { ok: false, error: `Unknown save-offer action: ${String(action)}` };
    const entry = this._pending.get(id);
    if (!entry) return { ok: false, error: 'This save offer is no longer available.' };
    if (this._now() > entry.expiresAt) {
      this._dropPending(id);
      return { ok: false, error: 'This save offer expired. Sign in again to be offered again.' };
    }
    try {
      if (action === 'save') this._store.save({ origin: entry.origin, username: entry.username, password: entry.password, id: entry.existingId });
      else if (action === 'never') this._store.addNeverSave(entry.origin);
    } catch (err) {
      console.error(`[PasswordService] ${action} failed:`, errMsg(err));
      return { ok: false, error: errMsg(err), retryable: true };
    }
    this._dropPending(id);
    return { ok: true };
  }

  // -- Autofill ---------------------------------------------------------------

  _guestOrigin(contents) {
    if (!contents || typeof contents.isDestroyed !== 'function' || contents.isDestroyed()) return null;
    return contents.mainFrame ? contents.mainFrame.origin : null;
  }

  /**
   * Page context-menu entries for a guest whose top-frame origin has saved
   * logins: one item for a single login, a submenu per username otherwise.
   * @returns {Electron.MenuItemConstructorOptions[]}
   */
  contextMenuItems(contents) {
    const origin = this._guestOrigin(contents);
    if (!origin || this._certificateError(origin)) return [];
    const logins = this._store.forOrigin(origin);
    if (!logins.length) return [];
    const name = (l) => l.username || '(no username)';
    /** @type {Electron.MenuItemConstructorOptions} */
    const item = logins.length === 1
      ? { label: `Fill saved password (${name(logins[0])})`, click: () => this.fill(contents, origin, logins[0].id) }
      : { label: 'Fill saved password', submenu: logins.map((l) => ({ label: name(l), click: () => this.fill(contents, origin, l.id) })) };
    return [item];
  }

  /** Fill one saved login into the guest's top frame, if it is still on `origin`. */
  fill(contents, origin, id) {
    if (this._guestOrigin(contents) !== origin) {
      this._notice('warn', FILL_FAILURES['origin-mismatch']);
      return false;
    }
    if (this._certificateError(origin)) {
      this._notice('warn', FILL_FAILURES['certificate-error']);
      return false;
    }
    const entry = this._store.get(id);
    if (!entry || entry.origin !== origin) {
      this._notice('warn', 'That saved login no longer exists.');
      return false;
    }
    let password;
    try {
      password = this._store.decrypt(id);
    } catch (err) {
      console.error('[PasswordService] could not decrypt a saved password:', errMsg(err));
      this._notice('error', `The saved password could not be decrypted: ${errMsg(err)}`);
      return false;
    }
    contents.mainFrame.send('passwords:fill', { origin, username: entry.username, password });
    this._fills.set(contents.id, { id, origin, persistent: !!(contents.session && contents.session.isPersistent()) });
    return true;
  }

  handleFillResult(event, result) {
    const sender = event && event.sender;
    if (!isGuest(sender) || !result) return;
    const sent = this._fills.get(sender.id);
    this._fills.delete(sender.id);
    if (!result.ok) {
      this._notice('warn', FILL_FAILURES[result.reason] || 'The saved password could not be filled on this page.');
      return;
    }
    // A private tab leaves no trace, so its fills do not count as a use.
    if (!sent || !sent.persistent) return;
    try {
      this._store.touch(sent.id);
    } catch (err) {
      console.error('[PasswordService] could not record the last use of a saved login:', errMsg(err));
      this._notice('warn', `The password was filled, but its last-used time could not be saved: ${errMsg(err)}`);
    }
  }

  // -- Settings ---------------------------------------------------------------

  listForSettings() {
    return {
      ok: true,
      entries: this._store.list(),
      neverSave: this._store.neverSaveList(),
      status: this._store.status(),
      authMode: authMode(this._platform),
      quarantined: this._store.quarantinedFile(),
    };
  }

  async reveal(id) {
    const entry = this._store.get(id);
    if (!entry) throw new Error('Saved login not found.');
    await confirmAccess({ platform: this._platform, mainWindow: this._mainWindow, verb: 'reveal', entry });
    return { ok: true, password: this._store.decrypt(id) };
  }

  async copy(id) {
    const entry = this._store.get(id);
    if (!entry) throw new Error('Saved login not found.');
    await confirmAccess({ platform: this._platform, mainWindow: this._mainWindow, verb: 'copy', entry });
    await require('electron').clipboard.writeText(this._store.decrypt(id));
    return { ok: true };
  }

  remove(id) {
    return this._store.remove(id) ? { ok: true } : { ok: false, error: 'Saved login not found.' };
  }

  removeNeverSave(origin) {
    this._store.removeNeverSave(origin);
    return { ok: true, neverSave: this._store.neverSaveList() };
  }
}

module.exports = new PasswordService();
module.exports.PasswordService = PasswordService;
