// SemanticIndexService — "Ask your browsing": relevance search over the
// user's history + bookmarks, fully local.
//
// Reality check: the bundled chat llama-server does NOT serve /v1/embeddings
// (started without --embeddings, chat model loaded), and the MLX backends
// don't expose it either. So a strong LEXICAL ranker is the always-available
// primary path. Embeddings are an OPT-IN overlay that activates only when the
// user points settings.askBrowsing.embeddingsEndpoint at a real embeddings
// server (a dedicated llama-server --embeddings, or a remote /v1/embeddings).
// When unavailable we degrade to pure lexical and say so (mode:'lexical') —
// the limitation is surfaced, never hidden.

const path = require('path');
const fs = require('fs');
const { getConfigDir } = require('../../shared/configPaths');
const configService = require('./ConfigService');
const historyService = require('./HistoryService');
const bookmarkService = require('./BookmarkService');
const contentIndex = require('./ContentIndexService');
const { buildDfMap, idf } = require('./semanticIdf');
const { ReindexScheduler } = require('./semanticReindexScheduler');

const MAX_CORPUS = 5000;
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'was', 'about', 'that', 'this', 'it', 'i', 'my']);

function tokenize(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

class SemanticIndexService {
  constructor() {
    this._fs = fs;
    this._filePath = null;
    this._config = configService;
    this._fetch = (typeof fetch === 'function') ? fetch.bind(globalThis) : null;
    this._index = null; // { model, vecs: { id: { h, v } } }
    this._dfCache = null; // { signature, map } — document-frequency for IDF
    this._scheduler = new ReindexScheduler(() => this.reindex(), 30000);
  }

  // Test injection
  _setFs(f) { this._fs = f; }
  _setFilePath(p) { this._filePath = p; }
  _setConfig(c) { this._config = c; }
  _setFetch(fn) { this._fetch = fn; }

  _cfg() {
    const c = this._config && typeof this._config.get === 'function' ? this._config.get('settings.askBrowsing', {}) : {};
    const o = c && typeof c === 'object' ? c : {};
    return {
      enabled: o.enabled !== false,
      embeddingsEndpoint: String(o.embeddingsEndpoint || '').trim().replace(/\/+$/, ''),
      embeddingsModel: String(o.embeddingsModel || '').trim(),
      blend: Number.isFinite(o.blend) ? Math.max(0, Math.min(1, o.blend)) : 0.5,
      maxResults: Number(o.maxResults) > 0 ? Math.floor(o.maxResults) : 8,
    };
  }

  _resolvePath() { return this._filePath || path.join(getConfigDir(), 'semantic_index.json'); }

  load() {
    if (this._index) return;
    this._index = { model: '', vecs: {} };
    try {
      const file = this._resolvePath();
      if (this._fs.existsSync(file)) {
        const parsed = JSON.parse(this._fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.vecs) this._index = { model: parsed.model || '', vecs: parsed.vecs };
      }
    } catch (_) { this._index = { model: '', vecs: {} }; }
  }

  _save() {
    try {
      const file = this._resolvePath();
      const dir = path.dirname(file);
      if (!this._fs.existsSync(dir)) this._fs.mkdirSync(dir, { recursive: true });
      this._fs.writeFileSync(file, JSON.stringify(this._index));
    } catch (err) { console.error('[SemanticIndex] save failed:', (err instanceof Error && err.message) || err); }
  }

  // Flatten history + bookmarks into a single doc list.
  _corpus() {
    const docs = [];
    const doc = (id, url, title, ts, source) => docs.push({ id, url, title: title || '', ts: ts || 0, source });
    try {
      for (const e of historyService.getRecent(MAX_CORPUS) || []) if (e && e.url) doc(`h:${e.id}`, e.url, e.title, e.timestamp, 'history');
    } catch (_) { /* history unavailable */ }
    try {
      const walk = (n) => { if (!n) return; if (n.type === 'bookmark' && n.url) doc(`b:${n.id}`, n.url, n.name, n.createdAt, 'bookmark'); (n.children || []).forEach(walk); };
      walk(bookmarkService.getTree());
    } catch (_) { /* bookmarks unavailable */ }
    return docs;
  }

  _docText(d) {
    const urlWords = String(d.url || '').replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, ' ');
    const body = contentIndex.getText(d.url); // '' when indexContent is off
    return { title: String(d.title || '').toLowerCase(), text: `${d.title || ''} ${urlWords} ${body}`.toLowerCase() };
  }

  // IDF document-frequency map. Cached against a signature of the doc-id set
  // so it's rebuilt only when the corpus changes.
  _dfMap(docs) {
    const sig = docs.map((d) => d.id).sort().join('|');
    if (this._dfCache && this._dfCache.signature === sig) return this._dfCache.map;
    const map = buildDfMap(docs.map((d) => new Set(tokenize(this._docText(d).text))));
    this._dfCache = { signature: sig, map };
    return map;
  }

  // Lexical relevance: IDF-weighted term hits (title-weighted) + all-terms
  // + phrase + recency tiebreak. Always available, no deps.
  _lexicalRank(query, docs) {
    const terms = tokenize(query).filter((t) => !STOPWORDS.has(t));
    const phrase = String(query || '').toLowerCase().trim();
    const now = Date.now();
    const dfMap = this._dfMap(docs);
    const scored = [];
    for (const d of docs) {
      const { title, text } = this._docText(d);
      if (!terms.length) { scored.push({ d, score: 0 }); continue; }
      let score = 0;
      let present = 0;
      for (const t of terms) {
        const w = idf(t, dfMap, docs.length);
        if (title.includes(t)) { score += 3 * w; present++; } else if (text.includes(t)) { score += 1 * w; present++; }
      }
      if (!present) continue;
      if (present === terms.length) score += 2;
      if (phrase.length > 2 && title.includes(phrase)) score += 4;
      else if (phrase.length > 2 && text.includes(phrase)) score += 2;
      if (d.ts) score += Math.max(0, 1 - (now - d.ts) / (1000 * 60 * 60 * 24 * 30)) * 0.5;
      scored.push({ d, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  async _embed(texts, cfg) {
    if (!this._fetch) throw new Error('fetch_unavailable');
    if (!cfg.embeddingsEndpoint) throw new Error('embeddings_not_configured');
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    try {
      const res = await this._fetch(`${cfg.embeddingsEndpoint}/v1/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.embeddingsModel || 'local', input: texts }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res || !res.ok) throw new Error(`embeddings_http_${res ? res.status : 'error'}`);
      const json = await res.json();
      return (json && Array.isArray(json.data) ? json.data : []).map((x) => x && x.embedding).filter(Array.isArray);
    } finally { if (timer) clearTimeout(timer); }
  }

  // Auto-reindex debounce: a burst of corpus changes coalesces into one reindex.
  // No-op in pure-lexical mode (no embeddings endpoint). Called by HistoryService.
  _scheduleReindex() {
    const cfg = this._cfg();
    if (!cfg.embeddingsEndpoint) return;
    this._scheduler.schedule();
  }

  // Refresh cached doc vectors for changed/new docs. Preempts a pending debounce.
  async reindex() {
    this._scheduler.cancel();
    this.load();
    this._dfCache = null; // corpus text may have changed; rebuild IDF on next search
    const cfg = this._cfg();
    if (!cfg.embeddingsEndpoint) return { ok: false, error: 'embeddings_not_configured', hint: 'Set settings.askBrowsing.embeddingsEndpoint to a /v1/embeddings server to enable semantic ranking.' };
    const docs = this._corpus();
    if (cfg.embeddingsModel && this._index.model && this._index.model !== cfg.embeddingsModel) this._index.vecs = {};
    const stale = [];
    for (const d of docs) {
      const { text } = this._docText(d);
      const h = djb2(text);
      const cached = this._index.vecs[d.id];
      if (!cached || cached.h !== h) stale.push({ id: d.id, h, text });
    }
    let embedded = 0;
    for (let i = 0; i < stale.length; i += 64) {
      const batch = stale.slice(i, i + 64);
      const vecs = await this._embed(batch.map((s) => s.text), cfg);
      batch.forEach((s, j) => { if (vecs[j]) { this._index.vecs[s.id] = { h: s.h, v: vecs[j] }; embedded++; } });
    }
    const live = new Set(docs.map((d) => d.id));
    for (const id of Object.keys(this._index.vecs)) if (!live.has(id)) delete this._index.vecs[id];
    this._index.model = cfg.embeddingsModel || this._index.model;
    this._save();
    return { ok: true, embedded, total: docs.length };
  }

  // Primary entry: lexical first, blend embeddings when an endpoint is set and vectors exist. Degrades to lexical.
  async search(query, opts = {}) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return { ok: false, error: 'empty_query' };
    this.load();
    const cfg = this._cfg();
    const limit = Math.max(1, Math.min(50, Number(opts.limit) || cfg.maxResults));
    const ranked = this._lexicalRank(q, this._corpus());
    let mode = 'lexical';
    let note;
    let top = ranked;

    if (cfg.enabled && cfg.embeddingsEndpoint) {
      const candidates = ranked.slice(0, Math.max(limit * 4, 24));
      const haveVecs = candidates.filter((c) => this._index.vecs[c.d.id]);
      if (haveVecs.length) {
        try {
          const [qv] = await this._embed([q], cfg);
          if (qv) {
            const maxLex = candidates.reduce((m, c) => Math.max(m, c.score), 0) || 1;
            candidates.forEach((c) => {
              const cv = this._index.vecs[c.d.id];
              const cos = cv ? cosine(qv, cv.v) : 0;
              c.score = (1 - cfg.blend) * (c.score / maxLex) + cfg.blend * cos;
            });
            candidates.sort((a, b) => b.score - a.score);
            top = candidates; mode = 'hybrid';
          }
        } catch (err) {
          note = `semantic ranking unavailable (${(err instanceof Error && err.message) || 'error'}); showing keyword matches`;
        }
      } else {
        note = 'no cached vectors yet — run reindex to enable semantic ranking';
      }
    }

    const results = top.slice(0, limit).map(({ d, score }) => ({
      url: d.url, title: d.title, timestamp: d.ts || null, source: d.source, score: Math.round(score * 1000) / 1000,
    }));
    return {
      ok: true, mode, count: results.length, results,
      ...(note ? { note } : {}),
      hint: results.length === 0
        ? 'Nothing in history or bookmarks matched. The user may not have visited that page in this app.'
        : 'Top match is the first result. Open its URL to read it.',
    };
  }
}

const instance = new SemanticIndexService();
module.exports = instance;
module.exports.SemanticIndexService = SemanticIndexService;
module.exports.tokenize = tokenize;
module.exports.cosine = cosine;
