// passwordStore — saved logins in {userData}/passwords.json.
//
// File shape: { version, entries: [{ id, origin, username, passwordEnc,
// createdAt, updatedAt, lastUsedAt }], neverSave: [origin] }. passwordEnc is
// base64 of safeStorage.encryptString, so the file alone never yields a
// password. Linux's 'basic_text' backend encrypts with a fixed key, which is
// no protection, so it counts as unavailable. An unparseable or malformed file
// is moved aside to `.corrupt-<ms>`, never overwritten; one from a newer format
// version, or one that exists but cannot be read, stays in place and saving is
// refused.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getConfigDir } = require('../../../shared/configPaths');
const { errMsg } = require('../../../shared/errMsg');
const { writeFileAtomic, readJsonOrQuarantine } = require('../../../shared/atomicWrite');

const LABEL = 'PasswordService';
const UNAVAILABLE = 'Passwords cannot be saved because this system\'s secure storage (keychain) is not available.';
const BASIC_TEXT = 'Passwords cannot be saved because no system keyring was found; Linux would store them with a fixed key, which is no protection.';
const BLOCKED = 'Passwords cannot be saved: the saved-passwords file could not be read or moved aside, so writing would destroy it.';
const NEWER = 'Passwords cannot be saved: the saved-passwords file was written by a newer version of InstantCognition, so writing would destroy it.';
const VERSION = 1;

const publicEntry = (e) => ({
  id: e.id, origin: e.origin, username: e.username, createdAt: e.createdAt, updatedAt: e.updatedAt, lastUsedAt: e.lastUsedAt,
});

const isEntry = (e) => !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.origin === 'string'
  && typeof e.username === 'string' && typeof e.passwordEnc === 'string';

class PasswordStore {
  constructor() {
    this._fs = fs;
    this._filePath = null;
    this._safeStorage = null;
    this._platform = process.platform;
    this._now = Date.now;
    this._entries = [];
    this._neverSave = [];
    this._loaded = false;
    this._saveBlocked = false;
    this._blockedReason = BLOCKED;
    this._quarantined = null;
  }

  _setFs(f) { this._fs = f; }
  _setFilePath(p) { this._filePath = p; }
  _setSafeStorage(s) { this._safeStorage = s; }
  _setPlatform(p) { this._platform = p; }
  _setNow(fn) { this._now = fn; }

  _path() { return this._filePath || path.join(getConfigDir(), 'passwords.json'); }

  _storage() { return this._safeStorage || require('electron').safeStorage; }

  /** @returns {{ available: boolean, reason: string }} */
  status() {
    this.load();
    if (this._saveBlocked) return { available: false, reason: this._blockedReason };
    const ss = this._storage();
    if (!ss || !ss.isEncryptionAvailable()) return { available: false, reason: UNAVAILABLE };
    if (this._platform === 'linux' && ss.getSelectedStorageBackend() === 'basic_text') return { available: false, reason: BASIC_TEXT };
    return { available: true, reason: '' };
  }

  load() {
    if (this._loaded) return;
    const file = this._path();
    const { value, blocked, quarantined } = readJsonOrQuarantine(this._fs, file, LABEL);
    this._saveBlocked = Boolean(blocked);
    this._quarantined = quarantined || null;
    if (value !== undefined) this._adopt(file, value);
    this._loaded = true;
  }

  // Every entry must validate or the whole file is set aside: dropping the bad
  // ones in memory would let the next save erase them from disk.
  _adopt(file, value) {
    const doc = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (doc && typeof doc.version === 'number' && doc.version > VERSION) {
      console.error(`[${LABEL}] ${file} has format version ${doc.version}; saving is disabled to protect it`);
      this._saveBlocked = true;
      this._blockedReason = NEWER;
      return;
    }
    const valid = !!doc && doc.version === VERSION
      && Array.isArray(doc.entries) && doc.entries.every(isEntry)
      && Array.isArray(doc.neverSave) && doc.neverSave.every((o) => typeof o === 'string');
    if (!valid) {
      this._quarantineMalformed(file);
      return;
    }
    this._entries = doc.entries;
    this._neverSave = doc.neverSave;
  }

  _quarantineMalformed(file) {
    const target = `${file}.corrupt-${this._now()}`;
    console.error(`[${LABEL}] ${file} is not a valid saved-passwords file`);
    try {
      this._fs.renameSync(file, target);
      this._quarantined = target;
    } catch (err) {
      console.error(`[${LABEL}] could not move ${file} aside; saving is disabled to protect it:`, errMsg(err));
      this._saveBlocked = true;
    }
  }

  /** Path the unreadable file was moved to on this run, or null. */
  quarantinedFile() { this.load(); return this._quarantined; }

  // Writes first and adopts the new lists only once the write succeeded, so a
  // failed save never leaves memory claiming something the file lacks.
  _commit(entries, neverSave) {
    if (this._saveBlocked) throw new Error(this._blockedReason);
    writeFileAtomic(this._fs, this._path(), JSON.stringify({ version: VERSION, entries, neverSave }, null, 2));
    this._entries = entries;
    this._neverSave = neverSave;
  }

  _find(id) { this.load(); return this._entries.find((e) => e.id === id) || null; }

  list() { this.load(); return this._entries.map(publicEntry); }

  /** Logins saved for exactly this origin (scheme + host + port). */
  forOrigin(origin) { this.load(); return this._entries.filter((e) => e.origin === origin).map(publicEntry); }

  findLogin(origin, username) {
    this.load();
    const e = this._entries.find((x) => x.origin === origin && x.username === username);
    return e ? publicEntry(e) : null;
  }

  get(id) { const e = this._find(id); return e ? publicEntry(e) : null; }

  decrypt(id) {
    const e = this._find(id);
    if (!e) throw new Error('Saved login not found.');
    return this._storage().decryptString(Buffer.from(e.passwordEnc, 'base64'));
  }

  matches(id, password) { return this.decrypt(id) === password; }

  /**
   * Save a login. With `id` (an update offer) that entry gets the new
   * password; otherwise a named login replaces the same origin+username, and a
   * login with no username is always a new entry, since several accounts can
   * reach a site's password step without a visible username.
   * @param {{ origin: string, username: string, password: string, id?: string|null }} login
   */
  save(login) {
    const { available, reason } = this.status();
    if (!available) throw new Error(reason);
    const passwordEnc = this._storage().encryptString(login.password).toString('base64');
    const ts = this._now();
    const prev = (login.id && this._entries.find((x) => x.id === login.id && x.origin === login.origin))
      || (login.username ? this._entries.find((x) => x.origin === login.origin && x.username === login.username) : null);
    const entry = prev
      ? { ...prev, passwordEnc, updatedAt: ts }
      : { id: crypto.randomUUID(), origin: login.origin, username: login.username, passwordEnc, createdAt: ts, updatedAt: ts, lastUsedAt: null };
    const entries = prev ? this._entries.map((x) => (x === prev ? entry : x)) : [...this._entries, entry];
    this._commit(entries, this._neverSave);
    return publicEntry(entry);
  }

  remove(id) {
    if (!this._find(id)) return false;
    this._commit(this._entries.filter((e) => e.id !== id), this._neverSave);
    return true;
  }

  touch(id) {
    const ts = this._now();
    this.load();
    this._commit(this._entries.map((e) => (e.id === id ? { ...e, lastUsedAt: ts } : e)), this._neverSave);
  }

  neverSaveList() { this.load(); return this._neverSave.slice(); }

  isNeverSave(origin) { this.load(); return this._neverSave.includes(origin); }

  addNeverSave(origin) {
    this.load();
    if (this._neverSave.includes(origin)) return;
    this._commit(this._entries, [...this._neverSave, origin]);
  }

  removeNeverSave(origin) {
    this.load();
    if (!this._neverSave.includes(origin)) return false;
    this._commit(this._entries, this._neverSave.filter((o) => o !== origin));
    return true;
  }
}

module.exports = new PasswordStore();
module.exports.PasswordStore = PasswordStore;
