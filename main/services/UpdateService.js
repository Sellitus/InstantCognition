// UpdateService — in-app updates on top of electron-updater.
//
// electron-updater can only replace a build that ships an update feed and can
// rewrite itself in place: a packaged app, not a Windows portable .exe or an
// electron-packager build, on Linux only an AppImage, and on macOS only a
// signed app (Squirrel.Mac rejects an update it cannot verify, which marks
// this run as unable to self-update). Everywhere else, and after any
// electron-updater failure, this falls back to the GitHub Releases query in
// updater.js, which finds the newer version and its download page.
//
// Updates are passive, like Chrome's: the app re-checks every few hours,
// downloads in the background and installs on the next quit, telling the user
// nothing. The toolbar Update pill (updater:nudge) asks for a restart once a
// downloaded update has waited NUDGE_DAYS, more insistently after
// ELEVATED_DAYS, since an app that is never quit never gets the security
// fixes. A release only reachable as a download page is held the same way: on a build that cannot
// self-update the pill links it at once, and on one whose feed failed it appears only if the feed
// is still failing NUDGE_DAYS later, so a transient failure never surfaces. A manual check from Settings reports every step.

const { app } = require('electron');
const { errMsg } = require('../../shared/errMsg');
const { compareVersions } = require('../../updater');

const FIRST_CHECK_MS = 15000; // let the window mount before touching the network
const TICK_MS = 60 * 60 * 1000;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NUDGE_DAYS = 3;
const ELEVATED_DAYS = 7;
// Squirrel.Mac's verdict on an unsigned or re-signed app; no retry changes it.
const SIGNATURE_ERROR = /code signature/i;

/**
 * How hard to ask for the update, from how long it has waited.
 * @param {{version: string, since: number}|null} pending
 * @param {number} now
 * @param {number} [nudgeDays] wait before the first ask
 * @returns {'none'|'recommended'|'elevated'}
 */
function nudgeLevel(pending, now, nudgeDays = NUDGE_DAYS) {
  if (!pending || !Number.isFinite(pending.since)) return 'none';
  const days = (now - pending.since) / DAY_MS;
  if (days >= ELEVATED_DAYS) return 'elevated';
  if (days >= nudgeDays) return 'recommended';
  return 'none';
}

class UpdateService {
  constructor() {
    this._configService = null;
    this._window = null;
    this._timer = null;
    this._tick = null;
    this._updater = null;
    this._manual = false;
    this._lastCheckAt = 0;
    this._checking = 0;
    this._downloaded = false;      // installNow can only apply what this run downloaded
    this._nudge = 'none null null';  // last posted level, version and url
    this._signatureRejected = false;
    this._loadUpdater = () => /** @type {any} */ (require('electron-updater')).autoUpdater;
    this._env = process.env;
    this._isPackaged = () => app.isPackaged;
    this._version = () => app.getVersion();
    this._platform = () => process.platform;
    this._now = () => Date.now();
  }

  /**
   * @param {Electron.BrowserWindow|null} mainWindow
   * @param {any} configService
   */
  initialize(mainWindow, configService) {
    this._window = mainWindow || null;
    this._configService = configService || null;
    this.stop();
    this._clearInstalled();
    if (!this._enabled()) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.check();
      this._startTick();
    }, FIRST_CHECK_MS);
    // A pending update check must never be the reason the process stays alive.
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
  }

  // One hourly tick re-evaluates the nudge and, with automatic updates on,
  // re-checks every RECHECK_MS. A manual download starts it too, so the nudge
  // still grows when automatic updates are off.
  _startTick() {
    if (this._tick) return;
    this._tick = setInterval(() => this._onTick(), TICK_MS);
    if (typeof this._tick.unref === 'function') this._tick.unref();
  }

  _onTick() {
    this._emitNudge();
    if (this._enabled() && this._now() - this._lastCheckAt >= RECHECK_MS) this.check();
  }

  _pending() {
    return (this._configService && this._configService.get('settings.pendingUpdate', null)) || null;
  }

  // A recorded update at or below the running version has been installed.
  _clearInstalled() {
    const pending = this._pending();
    if (pending && compareVersions(pending.version, this._version()) <= 0) {
      this._configService.set('settings.pendingUpdate', null);
    }
  }

  // settings.pendingUpdate is {version, since} for a downloaded update and
  // {version, since, url} for one only reachable as a download page. The
  // clock starts when the first update was found and runs until one is
  // installed: a newer release replacing the pending one keeps the original
  // age, so frequent releases cannot keep a never-restarted app quiet.
  _record(version, url) {
    const pending = this._pending();
    if (!this._configService || !version) return;
    if (!pending || pending.version !== version || (pending.url || null) !== url) {
      const since = pending && Number.isFinite(pending.since) ? pending.since : this._now();
      this._configService.set('settings.pendingUpdate', url ? { version, since, url } : { version, since });
    }
    this._startTick();
    this._emitNudge();
  }

  // A download this run already holds still installs on quit, so a release
  // page for the same version adds nothing.
  _recordReleasePage(version, url) {
    const pending = this._pending();
    if (this._downloaded && pending && !pending.url && pending.version === version) return;
    this._record(version, url || null);
  }

  // A conclusive "up to date" withdraws a release-page record, whose release
  // may have been pulled; a downloaded update is left to install.
  _clearReleasePage() {
    const pending = this._pending();
    if (pending && pending.url) this._configService.set('settings.pendingUpdate', null);
    this._emitNudge();
  }

  /** @returns {{level: 'none'|'recommended'|'elevated', version: string|null, url: string|null}} */
  nudge() {
    const pending = this._pending();
    let level = /** @type {'none'|'recommended'|'elevated'} */ ('none');
    if (pending && pending.url) level = nudgeLevel(pending, this._now(), this.supported() ? NUDGE_DAYS : 0);
    else if (this._downloaded) level = nudgeLevel(pending, this._now());
    const shown = level !== 'none' && pending;
    return { level, version: shown ? pending.version : null, url: shown && pending.url ? pending.url : null };
  }

  _emitNudge() {
    const n = this.nudge();
    const key = `${n.level} ${n.version} ${n.url}`;
    if (key === this._nudge) return;
    this._nudge = key;
    this._post('updater:nudge', n);
  }

  _enabled() {
    if (!this._configService) return true;
    return this._configService.get('settings.autoUpdate', true) !== false;
  }

  _channel() {
    return (this._configService && this._configService.get('settings.updateChannel', 'stable')) || 'stable';
  }

  // In-place replacement is only possible for these shapes; see the header.
  supported() {
    if (!this._isPackaged() || this._signatureRejected) return false;
    if (this._env.PORTABLE_EXECUTABLE_FILE) return false;
    if (this._platform() === 'linux' && !this._env.APPIMAGE) return false;
    return true;
  }

  // A manual check stays manual until its cycle ends, even if a background
  // check starts meanwhile and electron-updater folds the two together.
  _send(payload) {
    this._post('updater:result', { ...payload, manual: this._manual });
    if (payload.status !== 'downloading') this._manual = false;
  }

  _post(channel, payload) {
    const w = this._window;
    if (!w || (typeof w.isDestroyed === 'function' && w.isDestroyed()) || !w.webContents) return;
    // A window torn down between the check and the send cannot be told; the
    // next launch re-derives everything it would have shown.
    try { w.webContents.send(channel, payload); } catch (err) {
      console.warn(`[UpdateService] ${channel} not delivered:`, errMsg(err));
    }
  }

  _autoUpdater() {
    if (this._updater) return this._updater;
    const u = this._loadUpdater();
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.allowPrerelease = this._channel() === 'beta';
    u.on('update-available', (info) => this._send({ ok: true, status: 'downloading', version: info && info.version, percent: 0 }));
    u.on('update-not-available', () => {
      this._clearReleasePage();
      this._send({ ok: true, status: 'up-to-date', currentVersion: this._version() });
    });
    u.on('download-progress', (p) => this._send({ ok: true, status: 'downloading', percent: Math.round((p && p.percent) || 0) }));
    u.on('update-downloaded', (info) => {
      this._downloaded = true;
      this._record(info && info.version, null);
      this._send({ ok: true, status: 'downloaded', version: info && info.version });
    });
    // While a check is in flight its catch owns the failure (one electron-updater failure arrives twice); this covers only errors nothing awaits, e.g. a download error.
    u.on('error', (err) => { if (!this._checking) this._fallback(this._updaterError(err, 'Update failed.')); });
    this._updater = u;
    return u;
  }

  /** @param {{manual?: boolean}} [opts] a manual check reports every step to the user */
  async check({ manual = false } = {}) {
    if (manual) this._manual = true;
    this._lastCheckAt = this._now();
    if (!this.supported()) return this._fallback(null);
    this._checking += 1;
    try {
      const u = this._autoUpdater();
      u.allowPrerelease = this._channel() === 'beta';
      await u.checkForUpdates();
    } catch (err) {
      // Awaited so check() resolves only once a result has actually reached the
      // renderer — callers (and the startup timer) otherwise race the send.
      await this._fallback(this._updaterError(err, 'Update check failed.'));
    } finally { this._checking -= 1; }
  }

  /** @returns {string} */
  _updaterError(err, fallbackMessage) {
    const message = errMsg(err) || fallbackMessage;
    if (this._platform() === 'darwin' && SIGNATURE_ERROR.test(message)) this._signatureRejected = true;
    return message;
  }

  // Ask GitHub directly. Used when electron-updater cannot run here, and after
  // any of its failures, so the user still learns a release exists.
  /** @param {string|null} error */
  async _fallback(error) {
    try {
      const u = /** @type {any} */ (require('../../updater'));
      const r = await u.checkForUpdates({ channel: this._channel(), currentVersion: this._version() });
      if (r && r.ok && r.status === 'update-available') {
        if (error) console.warn('[UpdateService] electron-updater failed, release found on GitHub:', error);
        this._recordReleasePage(r.version, r.url);
        // In the background the toolbar pill carries it; see the header.
        if (this._manual) this._send({ ...r, manualDownload: true });
        return;
      }
      // A conclusive answer from GitHub settles the question, so an earlier
      // electron-updater failure stays in the log instead of masking it: a
      // release published without the latest-*.yml feed 404s that path, and
      // the user cannot act on that.
      if (r && r.ok) {
        if (error) console.warn('[UpdateService] electron-updater unavailable, used GitHub check:', error);
        this._clearReleasePage();
        this._send(r);
        return;
      }
      this._send({ ok: false, error: error || (r && r.error) || 'Update check failed.' });
    } catch (err) {
      this._send({ ok: false, error: error || errMsg(err) || 'Update check failed.' });
    }
  }

  // Quit and apply an already-downloaded update.
  installNow() {
    if (!this._updater) return { ok: false, error: 'No update has been downloaded.' };
    try { this._updater.quitAndInstall(); return { ok: true }; }
    catch (err) { return { ok: false, error: errMsg(err) || 'Install failed.' }; }
  }

  // ── Test seams ─────────────────────────────────────────────────────────────
  _setEnv(env) { this._env = env || process.env; }
  _setPackaged(fn) { if (typeof fn === 'function') this._isPackaged = fn; }
  _setPlatform(fn) { if (typeof fn === 'function') this._platform = fn; }
  _setLoader(fn) { if (typeof fn === 'function') { this._loadUpdater = fn; this._updater = null; } }
  _setNow(fn) { if (typeof fn === 'function') this._now = fn; }
}

const instance = new UpdateService();
module.exports = instance;
module.exports.UpdateService = UpdateService;
module.exports.nudgeLevel = nudgeLevel;
