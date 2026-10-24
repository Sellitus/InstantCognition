// SessionService — manages a separate Electron session for private browsing.
//
// A webview opts in with partition="private". The name has no "persist:"
// prefix, so Electron keeps that session's cookies, storage and cache in
// memory only and drops them when the app quits. This service applies the
// default session's permission policy, privacy headers, ad blocker and
// download tracking (kept out of the saved history) to it. The renderer opens
// one through SpaceManager.openPrivateTab.
//
// clear() wipes the partition (and the permission answers remembered in it)
// when the renderer closes the last private tab, so the next one starts clean.
// The wipe is async, so a new private tab loads only after whenClean(): one
// opened mid-wipe could otherwise read the old session's cache or auth entries.

const PRIVATE_PARTITION = 'private';

class SessionService {
  constructor() {
    this._sessionModule = null;
    this._installed = false;
    this._privateSession = null;
    this._adblocker = null;
    this._permission = null;
    this._privacy = null;
    this._downloads = null;
    this._clearing = null;
    this._wipeOwed = false;
  }

  // Test injection
  _setSessionModule(mod) { this._sessionModule = mod; }

  /**
   * @param {{ adblockerService?: typeof import('./AdblockerService'),
   *   permissionService?: typeof import('./PermissionService'),
   *   browsingPrivacy?: typeof import('./BrowsingPrivacyService'),
   *   downloadService?: typeof import('./DownloadService') }} [deps]
   */
  initialize({ adblockerService, permissionService, browsingPrivacy, downloadService } = {}) {
    if (this._installed) return;
    this._adblocker = adblockerService || null;
    this._permission = permissionService || null;
    this._privacy = browsingPrivacy || null;
    this._downloads = downloadService || null;
    const sessionMod = this._resolveSessionModule();
    if (!sessionMod) return;
    this._privateSession = sessionMod.fromPartition(PRIVATE_PARTITION, { cache: false });
    this._configurePrivateSession();
    this._installed = true;
  }

  _resolveSessionModule() {
    if (this._sessionModule) return this._sessionModule;
    try {
      return require('electron').session;
    } catch (_) { return null; }
  }

  _configurePrivateSession() {
    const sess = this._privateSession;
    if (!sess) return;

    // Same policy + prompt flow as the default session.
    if (this._permission) this._permission.attachToSession(sess, { ephemeral: true });
    if (this._privacy) this._privacy.attachToSession(sess);
    if (this._downloads) this._downloads.attachToSession(sess, { ephemeral: true });

    // Registered even before blocking starts, so it follows every enable and swap.
    if (this._adblocker && typeof this._adblocker.enableForSession === 'function') {
      try { this._adblocker.enableForSession(sess); } catch (err) { console.error('[SessionService] adblocker could not attach to the private session:', err); }
    }
  }

  getPartitionName() { return PRIVATE_PARTITION; }

  getSession() { return this._privateSession; }

  // A popup a private tab opens inherits its session, so this covers it too.
  isPrivateContents(contents) {
    return !!this._privateSession && !!contents && contents.session === this._privateSession;
  }

  isInstalled() { return this._installed; }

  clear() {
    const run = this._wipe();
    this._clearing = run;
    run.then(() => { this._wipeOwed = false; }, () => { this._wipeOwed = true; })
      .finally(() => { if (this._clearing === run) this._clearing = null; });
    return run;
  }

  /** Resolves once no wipe is running or owed; rejects if an owed wipe fails again. */
  async whenClean() {
    // clear() records a failed wipe as owed, so only its settling matters here.
    if (this._clearing) await Promise.allSettled([this._clearing]);
    if (this._wipeOwed) await this.clear();
  }

  async _wipe() {
    if (this._permission) this._permission.clearSessionOverrides();
    const sess = this._privateSession;
    if (!sess) return;
    await sess.clearStorageData();
    await sess.clearCache();
    // Basic/Digest credentials typed in a private tab live outside storage data.
    await sess.clearAuthCache();
  }
}

module.exports = new SessionService();
module.exports.PRIVATE_PARTITION = PRIVATE_PARTITION;
