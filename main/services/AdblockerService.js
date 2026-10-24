const { BrowserWindow } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const fs = require('fs');
const configService = require('./ConfigService');
const browsingPrivacy = require('./BrowsingPrivacyService');
const { loadAllowlistFromConfig, diffAllowlist } = require('./adblockerAllowlist');
const { setupAutoUpdate, teardownAutoUpdate } = require('./adblockerAutoUpdate');
const { errMsg } = require('../../shared/errMsg');
const { getAdblockerCachePath, getLegacyPathCandidates, migrateLegacyFile } = require('../utils/configStorage');

// Electron 36 / Node 20+ ship a global fetch; cross-fetch is no longer needed.
// Tests replace 'cross-fetch' but production stopped importing it.
const fetch = globalThis.fetch;

// Catalog of built-in blocklists. The id is what gets stored in
// `settings.adblocker.builtinEnabled`. defaultOn entries are seeded in
// configDefaults so existing users see no behavior change on upgrade.
const BUILTIN_LIST_CATALOG = [
  { id: 'hagezi-pro-plus', label: 'Hagezi Pro+ (recommended)', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.plus.txt', defaultOn: true },
  { id: 'oisd-big', label: 'OISD Big', url: 'https://big.oisd.nl/', defaultOn: true },
  { id: 'hagezi-tif', label: 'Hagezi Threat Intelligence Feed', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/tif.txt', defaultOn: true },
  { id: 'hagezi-hoster', label: 'Hagezi Bad Hosters', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/hoster.txt', defaultOn: true },
  { id: 'hagezi-fake', label: 'Hagezi Fake / scam', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/fake.txt', defaultOn: true },
  { id: 'hagezi-spam-tlds', label: 'Hagezi Spam TLDs', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/spam-tlds-adblock.txt', defaultOn: true },
];

const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const VALIDATE_TIMEOUT_MS = 8000;
const VALIDATE_MAX_BYTES = 5 * 1024 * 1024; // 5MB

class AdblockerService {
  constructor() {
    this.blocker = null; this.blockerCache = null; this.intervalId = null;
    this._activeListCount = 0; this._filterCount = 0; this._lastReloadAt = 0;
    this._appliedAllowlist = [];
    this._attached = new Set(); // sessions the live engine (this.blocker) is bound to
    this._extraSessions = new Set(); // non-window sessions (private browsing) that block whenever windows do
  }

  // Re-apply the site allowlist as exception filters; idempotent (delta-only).
  // Throws when the engine rejects the diff; the applied list is then unchanged.
  async applyAllowlist(hosts) {
    const desired = Array.isArray(hosts) ? hosts.filter((h) => typeof h === 'string' && h) : [];
    if (!this.blockerCache || typeof this.blockerCache.updateFromDiff !== 'function') {
      this._appliedAllowlist = desired.slice(); return;
    }
    const { added, removed } = diffAllowlist(this._appliedAllowlist, desired);
    if (added.length === 0 && removed.length === 0) return;
    this.blockerCache.updateFromDiff({ added, removed });
    this._appliedAllowlist = desired.slice();
    this._captureStats();
  }

  getCatalog() {
    return BUILTIN_LIST_CATALOG.slice();
  }

  _resolveActiveLists() {
    const cfg = configService.get('settings.adblocker', null) || {};
    const enabled = Array.isArray(cfg.builtinEnabled)
      ? cfg.builtinEnabled
      : BUILTIN_LIST_CATALOG.filter((e) => e.defaultOn).map((e) => e.id);
    const builtinUrls = BUILTIN_LIST_CATALOG.filter((e) => enabled.includes(e.id)).map((e) => e.url);
    const customUrls = Array.isArray(cfg.customLists) ? cfg.customLists.map((c) => c && c.url).filter(Boolean) : [];
    return [...builtinUrls, ...customUrls];
  }

  _cachePath() {
    const cachePath = getAdblockerCachePath();
    migrateLegacyFile(cachePath, getLegacyPathCandidates('adblocker_cache.bin'));
    return cachePath;
  }

  _cacheIsFresh(cachePath) {
    return fs.existsSync(cachePath) && Date.now() - fs.statSync(cachePath).mtimeMs <= CACHE_MAX_AGE;
  }

  async _readCache(cachePath) {
    if (!fs.existsSync(cachePath)) return null;
    try { return await ElectronBlocker.deserialize(await fs.promises.readFile(cachePath)); }
    catch (error) { console.error('Adblocker: cached engine is unreadable:', errMsg(error)); return null; }
  }

  async _fetchEngine(lists, cachePath) {
    console.log('Adblocker: Updating filters from', lists.length, 'list(s)...');
    const engine = await ElectronBlocker.fromLists(fetch, lists, {
      enableCompression: true,
      loadNetworkFilters: true,
      loadCosmeticFilters: false,
      loadExtendedSelectors: false,
    });
    const tmp = cachePath + '.tmp';
    await fs.promises.writeFile(tmp, await engine.serialize());
    await fs.promises.rename(tmp, cachePath);
    console.log('Adblocker: Cache updated');
    return engine;
  }

  _activeLists() {
    const lists = this._resolveActiveLists();
    this._activeListCount = lists.length;
    if (!lists.length) console.warn('Adblocker: no lists active — skipping engine creation.');
    return lists;
  }

  // Start blocking: a fresh disk cache, else freshly fetched lists, else the
  // stale cache (offline start), so blocking never silently turns off.
  async enable() {
    if (this.blockerCache) return this.blockerCache;
    const lists = this._activeLists();
    if (!lists.length) return this._swapIn(null);
    const cachePath = this._cachePath();
    const cached = await this._readCache(cachePath);
    if (cached && this._cacheIsFresh(cachePath)) {
      console.log('Adblocker: Loaded from cache');
      return this._swapIn(cached);
    }
    try {
      return await this._swapIn(await this._fetchEngine(lists, cachePath));
    } catch (error) {
      if (!cached) {
        console.error('Adblocker: Critical error:', error);
        throw error;
      }
      console.warn(`Adblocker: filter update failed; blocking with the stale cached lists: ${errMsg(error)}`);
      return this._swapIn(cached);
    }
  }

  // Hourly: refetch once the cache ages out. A failed fetch keeps the running engine.
  async refresh() {
    if (!this.blocker) return null;
    const cachePath = this._cachePath();
    if (this._cacheIsFresh(cachePath)) return this.blocker;
    const lists = this._activeLists();
    if (!lists.length) return this._swapIn(null);
    return this._swapIn(await this._fetchEngine(lists, cachePath));
  }

  disable() {
    if (this.blocker) {
      this._detach();
      console.log('Adblocker: disabled');
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.blockerCache = null;
    this._activeListCount = 0;
    this._filterCount = 0;
    this._appliedAllowlist = [];
  }

  // Refetch every list now (settings changed or the user asked). On failure
  // the running engine keeps blocking and the error reaches the caller.
  async reload() {
    const lists = this._activeLists();
    if (!lists.length) return this._swapIn(null);
    return this._swapIn(await this._fetchEngine(lists, this._cachePath()));
  }

  // Ghostery binds webRequest listeners and process-wide ipcMain handlers per
  // engine, so the running engine must detach before another can attach.
  async _swapIn(engine) {
    this.blockerCache = engine;
    this._appliedAllowlist = [];
    if (engine) {
      // A bad allowlist must not leave the browser unprotected; blocking still starts.
      try { await this.applyAllowlist(loadAllowlistFromConfig()); }
      catch (err) { console.error('Adblocker: allowlist apply failed:', errMsg(err)); }
    }
    this._detach();
    this.blocker = engine;
    if (engine) this._enableInAllSessions();
    this._captureStats();
    this._lastReloadAt = Date.now();
    return engine;
  }

  _detach() {
    if (!this.blocker) return;
    for (const session of this._attached) {
      try { this.blocker.disableBlockingInSession(session); }
      catch (err) { console.error('Adblocker: could not detach from a session:', errMsg(err)); }
      // Ghostery's disable cleared the session's onHeadersReceived slot.
      browsingPrivacy.setResponseBlocker(session, null);
    }
    this._attached.clear();
    this.blocker = null;
  }

  setupAutoUpdate() { setupAutoUpdate(this); }

  _teardownAutoUpdate() { teardownAutoUpdate(this); }

  get isEnabled() { return this.blocker !== null; }

  getStats() {
    return {
      enabled: this.isEnabled,
      activeListCount: this._activeListCount,
      filterCount: this._filterCount,
      lastReloadAt: this._lastReloadAt,
    };
  }

  // Registers a session outside any window (the private partition) so every
  // later enable and engine swap covers it too.
  enableForSession(session) {
    if (!session) return;
    this._extraSessions.add(session);
    this._attach(session);
  }

  _attach(session) {
    if (!this.blocker || this._attached.has(session)) return;
    try {
      this.blocker.enableBlockingInSession(session);
      this._attached.add(session);
    } catch (err) { console.error('Adblocker: could not attach to a session:', errMsg(err)); }
    // Ghostery's enable replaced the session's onHeadersReceived listener.
    browsingPrivacy.setResponseBlocker(session, this._attached.has(session) ? this.blocker : null);
  }

  // Validate a remote filter list URL: fetch with timeout + size cap, parse,
  // and report network filter count. A "valid" list parses to ≥1 filter.
  async validateBlocklistUrl(url) {
    const trimmed = (url || '').trim();
    if (!trimmed) return { ok: false, error: 'URL is empty.' };
    let parsed;
    try { parsed = new URL(trimmed); }
    catch (_) { return { ok: false, error: 'Not a valid URL.' }; }
    if (!/^https?:$/.test(parsed.protocol)) {
      return { ok: false, error: 'URL must be http:// or https://.' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
    try {
      // Use globalThis.fetch at call-time so tests can swap it in.
      const fetchFn = (typeof globalThis.fetch === 'function') ? globalThis.fetch : fetch;
      const res = await fetchFn(trimmed, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText || ''}`.trim() };
      const len = Number(res.headers.get('content-length') || '0');
      if (len > VALIDATE_MAX_BYTES) return { ok: false, error: `File too large (${len} bytes; max ${VALIDATE_MAX_BYTES}).` };
      const text = await res.text();
      if (text.length > VALIDATE_MAX_BYTES) return { ok: false, error: 'File too large.' };
      const lower = text.slice(0, 200).toLowerCase();
      if (lower.includes('<!doctype html') || lower.includes('<html')) {
        return { ok: false, error: 'Server returned an HTML page, not a filter list.' };
      }
      let engine;
      try { engine = ElectronBlocker.parse(text, { loadNetworkFilters: true, loadCosmeticFilters: false }); }
      catch (err) { return { ok: false, error: `Parse error: ${errMsg(err)}` }; }
      const filters = (engine && typeof engine.getFilters === 'function') ? engine.getFilters() : { networkFilters: [], cosmeticFilters: [] };
      const filterCount = (filters.networkFilters || []).length + (filters.cosmeticFilters || []).length;
      if (filterCount < 1) return { ok: false, error: 'Not a recognized filter list (parsed 0 filters).' };
      return { ok: true, filterCount };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { ok: false, error: 'Timed out.' };
      return { ok: false, error: (err instanceof Error && err.message) || 'Network error.' };
    } finally {
      clearTimeout(timer);
    }
  }

  _captureStats() {
    if (!this.blockerCache || typeof this.blockerCache.getFilters !== 'function') {
      this._filterCount = 0;
      return;
    }
    try {
      const f = this.blockerCache.getFilters();
      this._filterCount = ((f.networkFilters || []).length) + ((f.cosmeticFilters || []).length);
    } catch (_) { this._filterCount = 0; }
  }

  _enableInAllSessions() {
    const windowSessions = BrowserWindow.getAllWindows().map((w) => w.webContents.session).filter(Boolean);
    for (const session of new Set([...windowSessions, ...this._extraSessions])) this._attach(session);
  }
}

const instance = new AdblockerService();
module.exports = instance;
module.exports.BUILTIN_LIST_CATALOG = BUILTIN_LIST_CATALOG;
