// HistoryService — JSON-backed browsing history.
//
// Records URL+title+timestamp+spaceId. Provides search, recent, deleteEntry,
// and clearAll. Storage is a single JSON file in the userData directory,
// debounced to disk on writes. In-memory ring buffer caps total entries.

const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../../shared/configPaths');
const { errMsg } = require('../../shared/errMsg');
const { writeFileAtomic, readJsonOrQuarantine } = require('../../shared/atomicWrite');

const DEFAULT_MAX_ENTRIES = 5000;
const SAVE_DEBOUNCE_MS = 500;

class HistoryService {
  constructor() {
    this._entries = [];
    this._loaded = false;
    this._filePath = null;
    this._saveTimer = null;
    this._fs = fs;
    this._configService = null;
    this._saveBlocked = false;
  }

  // Test injection
  _setFs(fsOverride) { this._fs = fsOverride; }
  _setFilePath(p) { this._filePath = p; }

  bindConfig(cs) { this._configService = cs; }

  _maxEntries() {
    if (!this._configService || typeof this._configService.get !== 'function') return DEFAULT_MAX_ENTRIES;
    const v = this._configService.get('settings.historyCap', DEFAULT_MAX_ENTRIES);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_ENTRIES;
  }

  _resolvePath() {
    if (this._filePath) return this._filePath;
    return path.join(getConfigDir(), 'history.json');
  }

  load() {
    if (this._loaded) return;
    const { value, blocked } = readJsonOrQuarantine(this._fs, this._resolvePath(), 'HistoryService');
    this._saveBlocked = Boolean(blocked);
    if (Array.isArray(value)) this._entries = value.slice(-this._maxEntries());
    this._loaded = true;
  }

  /** @param {{ url?: string, title?: string, spaceId?: string, visitDuration?: number }} entry */
  addEntry({ url, title, spaceId, visitDuration }) {
    if (!url || typeof url !== 'string') return null;
    this.load();
    // A repeat of the newest visit (reload, relaunch, or a late title update
    // from the renderer) refreshes that entry instead of adding a duplicate.
    const last = this._entries[this._entries.length - 1];
    if (last && last.url === url && last.spaceId === (spaceId || null)) {
      if (title) last.title = title;
      last.timestamp = Date.now();
      this._scheduleSave();
      return last;
    }
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title: title || '',
      spaceId: spaceId || null,
      timestamp: Date.now(),
      visitDuration: visitDuration || 0,
    };
    this._entries.push(entry);
    const cap = this._maxEntries();
    if (this._entries.length > cap) {
      this._entries.splice(0, this._entries.length - cap);
    }
    this._scheduleSave();
    // Notify the semantic index so it can debounce a reindex. Lazy require
    // avoids a circular dependency (SemanticIndexService requires this module).
    try { require('./SemanticIndexService')._scheduleReindex(); } catch (err) { console.error('[HistoryService] reindex notify failed:', (err instanceof Error && err.message) || err); }
    return entry;
  }

  /**
   * @param {string} query
   * @param {{ limit?: number, dateRange?: { from: number, to: number } }} [opts]
   */
  search(query, { limit = 50, dateRange } = {}) {
    this.load();
    const q = (query || '').toLowerCase();
    const results = [];
    for (let i = this._entries.length - 1; i >= 0 && results.length < limit; i--) {
      const e = this._entries[i];
      if (dateRange && (e.timestamp < dateRange.from || e.timestamp > dateRange.to)) continue;
      if (q && !(e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))) continue;
      results.push(e);
    }
    return results;
  }

  getRecent(limit = 50) {
    this.load();
    return this._entries.slice(-limit).reverse();
  }

  deleteEntry(id) {
    this.load();
    const idx = this._entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this._entries.splice(idx, 1);
    this._scheduleSave();
    return true;
  }

  clearAll() {
    this._entries = [];
    this._loaded = true;
    this._scheduleSave();
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._writeNow(), SAVE_DEBOUNCE_MS);
    if (this._saveTimer && typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  flushSync() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._writeNow();
  }

  _writeNow() {
    if (this._saveBlocked) {
      console.error('[HistoryService] save skipped: history.json could not be loaded or moved aside');
      return;
    }
    try {
      writeFileAtomic(this._fs, this._resolvePath(), JSON.stringify(this._entries));
    } catch (err) {
      console.error('[HistoryService] failed to save:', errMsg(err));
    }
  }
}

module.exports = new HistoryService();
