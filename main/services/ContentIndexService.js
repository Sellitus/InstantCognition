// ContentIndexService — sidecar store for the readable body text of pages the
// user visits, feeding SemanticIndexService so "Ask your browsing" can match
// terms that appear only in a page's body (not its title/URL).
//
// Capture happens in the renderer (renderer.js wireWebviewEvents) right after
// a page finishes loading — the readable extractor already runs in-page there.
// This service only persists and serves the text; it never spawns webviews.
//
// Storage: <configDir>/semantic_content.json — { url: { hash, text } }. The
// hash mirrors the djb2 used by SemanticIndexService so a changed page body
// re-indexes. Text is capped per doc to keep the corpus + embeddings batches
// bounded. Opt-in via settings.askBrowsing.indexContent (default off).

const path = require('path');
const fs = require('fs');
const { getConfigDir } = require('../../shared/configPaths');
const configService = require('./ConfigService');

const MAX_BODY_CHARS = 8000;

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

class ContentIndexService {
  constructor() {
    this._fs = fs;
    this._filePath = null;
    this._config = configService;
    this._store = null; // { url: { hash, text } }
  }

  // Test injection
  _setFs(f) { this._fs = f; }
  _setFilePath(p) { this._filePath = p; }
  _setConfig(c) { this._config = c; }

  enabled() {
    const c = this._config && typeof this._config.get === 'function'
      ? this._config.get('settings.askBrowsing.indexContent', false) : false;
    return c === true;
  }

  _resolvePath() { return this._filePath || path.join(getConfigDir(), 'semantic_content.json'); }

  load() {
    if (this._store) return;
    this._store = {};
    try {
      const file = this._resolvePath();
      if (this._fs.existsSync(file)) {
        const parsed = JSON.parse(this._fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object') this._store = parsed;
      }
    } catch (_) { this._store = {}; }
  }

  _save() {
    try {
      const file = this._resolvePath();
      const dir = path.dirname(file);
      if (!this._fs.existsSync(dir)) this._fs.mkdirSync(dir, { recursive: true });
      this._fs.writeFileSync(file, JSON.stringify(this._store));
    } catch (err) {
      console.error('[ContentIndex] save failed:', (err instanceof Error && err.message) || err);
    }
  }

  // Store (or refresh) the readable text for a URL. Returns true if the store
  // changed (caller may trigger a reindex). No-op when indexContent is off.
  capture(url, text) {
    if (!this.enabled()) return false;
    const u = String(url || '').trim();
    if (!u || !/^https?:/i.test(u)) return false;
    const body = String(text == null ? '' : text).slice(0, MAX_BODY_CHARS);
    if (!body) return false;
    this.load();
    const hash = djb2(body);
    const existing = this._store[u];
    if (existing && existing.hash === hash) return false; // unchanged
    this._store[u] = { hash, text: body };
    this._save();
    return true;
  }

  // Read the stored body text for a doc (by url). Empty string when absent or
  // the feature is off — callers merge it into the lexical text only when on.
  getText(url) {
    if (!this.enabled()) return '';
    this.load();
    const e = this._store && this._store[String(url || '')];
    return e && e.text ? e.text : '';
  }

  // Drop entries for URLs no longer in the supplied live set (history + bookmarks).
  // No-op when indexContent is off, matching capture/getText (the store is frozen
  // while the feature is disabled, so there is nothing to prune).
  prune(liveUrls) {
    if (!this.enabled()) return 0;
    this.load();
    const live = new Set((liveUrls || []).filter(Boolean));
    let removed = 0;
    for (const u of Object.keys(this._store)) {
      if (!live.has(u)) { delete this._store[u]; removed++; }
    }
    if (removed) this._save();
    return removed;
  }

  // Test hook
  _reset() { this._store = null; }
}

const instance = new ContentIndexService();
module.exports = instance;
module.exports.ContentIndexService = ContentIndexService;
module.exports.djb2 = djb2;
