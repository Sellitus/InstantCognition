// ExtensionService.js — Loads unpacked Chrome extensions via session.loadExtension.
// Persists known extension paths to config so they reload on next launch.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { session } = require('electron');
const { unpackArchive } = require('../utils/crxUnpack');
const { downloadToFile } = require('../utils/httpDownload');

const WEBSTORE_ID_RE = /[a-p]{32}/;

class ExtensionService extends EventEmitter {
  constructor() {
    super();
    this._sessionMod = { fromPartition: (p) => session.fromPartition(p), defaultSession: null };
    this._configService = null;
    this._loaded = new Map();
    // Configured paths that failed to load this launch (drive not mounted,
    // extension mid-update). Kept in config so one bad start never forgets them.
    this._unavailable = new Set();
    // Floor listener: prevents a process crash if 'error' is emitted before
    // any consumer attaches (e.g. during window reload).
    this.on('error', () => {});
  }

  _setSessionModule(mod) { this._sessionMod = mod; }

  initialize(configService) {
    this._configService = configService || null;
    if (!this._configService) return;
    const paths = this._configService.get('settings.extensions.paths', []) || [];
    for (const p of paths) {
      this.load(p, { persist: false }).catch((err) => {
        this._unavailable.add(path.resolve(p));
        this.emit('error', { path: p, message: err.message });
      });
    }
  }

  _getSession() {
    try { return session.defaultSession; } catch (_) { return null; }
  }

  async load(extPath, { persist = true } = {}) {
    if (!extPath) throw new Error('extension path required');
    const resolved = path.resolve(extPath);
    if (!fs.existsSync(resolved)) throw new Error(`Path not found: ${resolved}`);
    const manifest = path.join(resolved, 'manifest.json');
    if (!fs.existsSync(manifest)) throw new Error(`No manifest.json at ${resolved}`);

    const sess = this._getSession();
    if (!sess || typeof sess.loadExtension !== 'function') {
      throw new Error('session.loadExtension unavailable');
    }
    const ext = await sess.loadExtension(resolved, { allowFileAccess: true });
    const info = {
      id: ext.id,
      name: ext.name,
      version: ext.version,
      path: resolved,
    };
    this._loaded.set(ext.id, { ...info, _ext: ext });
    this._unavailable.delete(resolved);
    if (persist) this._persistPaths();
    this.emit('loaded', info);
    return info;
  }

  remove(id) {
    const entry = this._loaded.get(id);
    if (!entry) return false;
    const sess = this._getSession();
    if (sess && typeof sess.removeExtension === 'function') {
      try { sess.removeExtension(id); } catch (_) {}
    }
    this._loaded.delete(id);
    this._persistPaths();
    this.emit('removed', { id });
    return true;
  }

  list() {
    return Array.from(this._loaded.values()).map((e) => ({
      id: e.id, name: e.name, version: e.version, path: e.path,
    }));
  }

  _persistPaths() {
    if (!this._configService) return;
    const paths = new Set(Array.from(this._loaded.values()).map((e) => e.path));
    for (const p of this._unavailable) paths.add(p);
    this._configService.set('settings.extensions.paths', Array.from(paths));
  }

  _extensionsDir() {
    try {
      const { app } = require('electron');
      return path.join(app.getPath('userData'), 'extensions');
    } catch (_) {
      return path.join(process.cwd(), 'extensions');
    }
  }

  _stageDir() {
    const d = path.join(os.tmpdir(),
      `ic-ext-stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  _rmDir(d) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* already gone */ }
  }

  // Accepts a 32-char store id or a Chrome Web Store URL; null otherwise.
  parseWebStoreId(input) {
    const s = String(input || '').trim();
    if (/^[a-p]{32}$/.test(s)) return s;
    if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com)\//i.test(s)) {
      const m = s.match(WEBSTORE_ID_RE);
      return m ? m[0] : null;
    }
    return null;
  }

  // Google's unofficial CRX endpoint. prodversion is keyed off the real
  // bundled Chromium so it stays accurate as Electron updates.
  webStoreCrxUrl(id) {
    const pv = (process.versions && process.versions.chrome) || '120.0.0.0';
    const x = `id%3D${id}%26installsource%3Dondemand%26uc`;
    return 'https://clients2.google.com/service/update2/crx'
      + `?response=redirect&acceptformat=crx2,crx3&prodversion=${pv}&x=${x}`;
  }

  _readManifest(dir) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    let name = typeof m.name === 'string' ? m.name : '';
    if (name.startsWith('__MSG_') && m.default_locale) {
      try {
        const key = name.replace(/^__MSG_/, '').replace(/__$/, '');
        const msgs = JSON.parse(fs.readFileSync(
          path.join(dir, '_locales', m.default_locale, 'messages.json'), 'utf8'));
        if (msgs[key] && msgs[key].message) name = msgs[key].message;
        else name = '';
      } catch (_) { name = ''; }
    }
    const perms = Array.isArray(m.permissions) ? m.permissions.map(String) : [];
    const hostPerms = Array.isArray(m.host_permissions) ? m.host_permissions.map(String) : [];
    // MV2 mixes host match patterns into `permissions`; split them out so the
    // preview reads sensibly regardless of manifest version.
    const isHost = (p) => p.includes('://') || p === '<all_urls>';
    return {
      name: name || path.basename(dir),
      version: typeof m.version === 'string' ? m.version : '',
      permissions: perms.filter((p) => !isHost(p)),
      hostPermissions: hostPerms.concat(perms.filter(isHost)),
    };
  }

  async _loadSafely(dir) {
    try {
      const info = await this.load(dir);
      return { ok: true, ...info };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Stage an extension from a store id/URL, a .crx/.zip URL, a local
  // .crx/.zip, or an unpacked directory. Returns its manifest preview WITHOUT
  // loading it — commitInstall finalizes after the user reviews permissions.
  async prepareInstall(source) {
    const s = String(source || '').trim();
    if (!s) return { ok: false, error: 'No source provided' };
    try {
      const storeId = this.parseWebStoreId(s);
      const downloadUrl = storeId ? this.webStoreCrxUrl(storeId)
        : (/^https?:\/\//i.test(s) ? s : null);
      let isDirectory = false;
      let dir;
      if (downloadUrl) {
        const crx = path.join(os.tmpdir(),
          `ic-ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.crx`);
        try {
          await downloadToFile(downloadUrl, crx);
          dir = this._stageDir();
          await unpackArchive(crx, dir);
        } finally {
          try { fs.unlinkSync(crx); } catch (_) { /* temp already gone */ }
        }
      } else {
        const resolved = path.resolve(s);
        if (!fs.existsSync(resolved)) return { ok: false, error: `Path not found: ${resolved}` };
        if (fs.statSync(resolved).isDirectory()) {
          isDirectory = true;
          dir = resolved;
        } else {
          dir = this._stageDir();
          await unpackArchive(resolved, dir);
        }
      }
      if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
        if (!isDirectory) this._rmDir(dir);
        return { ok: false, error: 'No manifest.json found in the extension' };
      }
      return { ok: true, staging: dir, isDirectory, ...this._readManifest(dir) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Finalize a staged install. accept=false discards the staging copy.
  async commitInstall(opts = {}) {
    const { staging, isDirectory, accept } = /** @type {any} */ (opts);
    if (!staging) return { ok: false, error: 'Nothing to install' };
    if (!accept) {
      if (!isDirectory) this._rmDir(staging);
      return { ok: false, cancelled: true };
    }
    if (isDirectory) return this._loadSafely(staging);
    let finalDir;
    try {
      const meta = this._readManifest(staging);
      const slug = (meta.name || 'extension').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'extension';
      finalDir = path.join(this._extensionsDir(),
        `${slug}-${Math.random().toString(36).slice(2, 8)}`);
      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      fs.cpSync(staging, finalDir, { recursive: true });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this._rmDir(staging);
    }
    return this._loadSafely(finalDir);
  }
}

module.exports = new ExtensionService();
