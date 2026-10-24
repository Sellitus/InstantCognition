// DownloadService — tracks downloads via session.on('will-download').
//
// Each download gets a tracker entry with progress events forwarded to listeners.
// History is JSON-persisted; in-flight downloads are kept in memory. Downloads
// from an ephemeral session (private browsing) never enter the saved history.

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { getConfigDir } = require('../../shared/configPaths');
const { errMsg } = require('../../shared/errMsg');
const { writeFileAtomic, readJsonOrQuarantine } = require('../../shared/atomicWrite');

const DEFAULT_MAX_HISTORY = 500;

class DownloadService extends EventEmitter {
  constructor() {
    super();
    this._active = new Map();      // id -> { item, info }
    this._history = [];
    this._loaded = false;
    this._fs = fs;
    this._filePath = null;
    this._sessions = new WeakSet();
    this._configService = null;
    this._saveBlocked = false;
    // Every path a download finished at this run, private ones included, so
    // the shell can open a file it just showed even when history never kept it.
    this._finishedPaths = new Set();
  }

  _setFs(f) { this._fs = f; }
  _setFilePath(p) { this._filePath = p; }

  bindConfig(cs) { this._configService = cs; }

  _maxHistory() {
    if (!this._configService || typeof this._configService.get !== 'function') return DEFAULT_MAX_HISTORY;
    const v = this._configService.get('settings.downloadHistoryCap', DEFAULT_MAX_HISTORY);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_HISTORY;
  }

  _resolvePath() {
    if (this._filePath) return this._filePath;
    return path.join(getConfigDir(), 'downloads.json');
  }

  load() {
    if (this._loaded) return;
    const { value, blocked } = readJsonOrQuarantine(this._fs, this._resolvePath(), 'DownloadService');
    this._saveBlocked = Boolean(blocked);
    if (Array.isArray(value)) this._history = value.slice(-this._maxHistory());
    this._loaded = true;
  }

  attachToSession(electronSession, { ephemeral = false } = {}) {
    if (!electronSession || typeof electronSession.on !== 'function' || this._sessions.has(electronSession)) return;
    electronSession.on('will-download', (_event, item, _webContents) => this._handleWillDownload(item, ephemeral));
    this._sessions.add(electronSession);
  }

  _handleWillDownload(item, ephemeral = false) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const info = {
      id,
      url: typeof item.getURL === 'function' ? item.getURL() : '',
      filename: typeof item.getFilename === 'function' ? item.getFilename() : '',
      totalBytes: typeof item.getTotalBytes === 'function' ? item.getTotalBytes() : 0,
      receivedBytes: 0,
      state: 'progressing',
      startedAt: Date.now(),
    };
    this._active.set(id, { item, info });
    this.emit('download-started', { ...info });

    item.on('updated', (_e, state) => {
      info.state = state;
      info.receivedBytes = typeof item.getReceivedBytes === 'function' ? item.getReceivedBytes() : info.receivedBytes;
      this.emit('download-updated', { ...info });
    });
    item.once('done', (_e, state) => {
      info.state = state;
      info.completedAt = Date.now();
      info.savePath = typeof item.getSavePath === 'function' ? item.getSavePath() : '';
      if (info.savePath) this._finishedPaths.add(info.savePath);
      this._active.delete(id);
      if (!ephemeral) {
        this._history.push({ ...info });
        if (this._history.length > this._maxHistory()) this._history.shift();
        this._save();
      }
      this.emit('download-done', { ...info });
    });
  }

  getActive() {
    return [...this._active.values()].map((entry) => ({ ...entry.info }));
  }

  getHistory() {
    this.load();
    return [...this._history].reverse();
  }

  /** True only for a file a download wrote; the shell may open nothing else. */
  isKnownSavePath(filePath) {
    if (typeof filePath !== 'string' || !filePath) return false;
    if (this._finishedPaths.has(filePath)) return true;
    this.load();
    return this._history.some((h) => h.savePath === filePath);
  }

  cancel(id) {
    const entry = this._active.get(id);
    if (!entry || !entry.item || typeof entry.item.cancel !== 'function') return false;
    entry.item.cancel();
    return true;
  }

  pause(id) {
    const entry = this._active.get(id);
    if (!entry || !entry.item || typeof entry.item.pause !== 'function') return false;
    entry.item.pause();
    return true;
  }

  resume(id) {
    const entry = this._active.get(id);
    if (!entry || !entry.item || typeof entry.item.resume !== 'function') return false;
    entry.item.resume();
    return true;
  }

  clearHistory() {
    this._history = [];
    this._save();
  }

  _save() {
    if (this._saveBlocked) {
      console.error('[DownloadService] save skipped: downloads.json could not be loaded or moved aside');
      return;
    }
    try {
      writeFileAtomic(this._fs, this._resolvePath(), JSON.stringify(this._history));
    } catch (err) {
      console.error('[DownloadService] failed to save:', errMsg(err));
    }
  }
}

module.exports = new DownloadService();
