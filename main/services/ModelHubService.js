const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const EventEmitter = require('events');
const { errMsg } = require('../../shared/errMsg');
const modelManagerService = require('./ModelManagerService');

const HF_API = 'https://huggingface.co/api';
const DEFAULT_LIMIT = 20;
const MAX_REDIRECTS = 5;

class ModelHubService extends EventEmitter {
  constructor() {
    super();
    this._fetch = null;
    this._https = https;
    this._activeDownloads = new Map();
  }

  _setFetch(fn) { this._fetch = fn; }
  _setHttps(mod) { this._https = mod; }

  async search(query, opts = {}) {
    const limit = Math.min(opts.limit || DEFAULT_LIMIT, 100);
    const params = new URLSearchParams({
      search: query || '',
      filter: 'gguf',
      limit: String(limit),
      full: 'true',
    });
    const url = `${HF_API}/models?${params.toString()}`;
    const data = await this._getJson(url);
    if (!Array.isArray(data)) return [];
    return data.map((m) => this._normalizeModel(m)).filter(Boolean);
  }

  async listGgufFiles(repoId) {
    if (!repoId) throw new Error('repoId required');
    const url = `${HF_API}/models/${encodeURIComponent(repoId)}/tree/main?recursive=true`;
    const tree = await this._getJson(url);
    if (!Array.isArray(tree)) return [];
    return tree
      .filter((e) => e.type === 'file' && /\.gguf$/i.test(e.path))
      .map((e) => ({
        path: e.path,
        size: e.size || 0,
        sizeHuman: this._humanSize(e.size || 0),
        downloadUrl: `https://huggingface.co/${repoId}/resolve/main/${e.path}`,
      }));
  }

  async download({ repoId, filePath, downloadUrl }) {
    if (!downloadUrl && (!repoId || !filePath)) {
      throw new Error('downloadUrl or repoId+filePath required');
    }
    const url = downloadUrl || `https://huggingface.co/${repoId}/resolve/main/${filePath}`;
    const dir = modelManagerService.ensureModelsDir();
    const filename = filePath ? path.basename(filePath) : path.basename(new URL(url).pathname);
    const dest = path.join(dir, filename);
    if (fs.existsSync(dest)) throw new Error(`Already exists: ${dest}`);

    const id = `${Date.now()}-${filename}`;
    const tmp = `${dest}.part`;
    const handle = { id, filename, dest, received: 0, total: 0, cancelled: false };
    this._activeDownloads.set(id, handle);
    this.emit('download-started', { id, filename });

    try {
      await this._streamToFile(url, tmp, handle);
      if (handle.cancelled) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        this.emit('download-cancelled', { id, filename });
        return null;
      }
      fs.renameSync(tmp, dest);
      this._activeDownloads.delete(id);
      this.emit('download-done', { id, filename, path: dest });
      // Register the downloaded file in the model registry so the UI sees it
      // without requiring a manual rescan. importModel emits 'models-changed'.
      let info;
      try { info = modelManagerService.importModel(dest); }
      catch (_) { info = modelManagerService.getModelInfo(dest); modelManagerService.emit('models-changed'); }
      return info;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      this._activeDownloads.delete(id);
      this.emit('download-error', { id, filename, message: errMsg(err) });
      throw err;
    }
  }

  cancelDownload(id) {
    const h = this._activeDownloads.get(id);
    if (!h) return false;
    h.cancelled = true;
    if (h.req) try { h.req.destroy(); } catch (_) {}
    return true;
  }

  getActiveDownloads() {
    return Array.from(this._activeDownloads.values()).map((h) => ({
      id: h.id, filename: h.filename, received: h.received, total: h.total,
    }));
  }

  _streamToFile(url, dest, handle, redirects = 0) {
    return new Promise((resolve, reject) => {
      const req = this._https.get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirects >= MAX_REDIRECTS) return reject(new Error('Too many redirects'));
          res.resume();
          return this._streamToFile(res.headers.location, dest, handle, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        handle.total = parseInt(res.headers['content-length'] || '0', 10);
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          if (handle.cancelled) { res.destroy(); out.destroy(); return; }
          handle.received += chunk.length;
          this.emit('download-progress', {
            id: handle.id, filename: handle.filename, received: handle.received, total: handle.total,
          });
        });
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
        res.on('error', reject);
      });
      handle.req = req;
      req.on('error', reject);
    });
  }

  _normalizeModel(m) {
    if (!m || !m.modelId) return null;
    return {
      id: m.modelId,
      author: m.author || (m.modelId.split('/')[0] || ''),
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      tags: m.tags || [],
      lastModified: m.lastModified || null,
    };
  }

  _humanSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes; let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
  }

  _getJson(url) {
    if (this._fetch) {
      return this._fetch(url).then((r) => r.json());
    }
    return new Promise((resolve, reject) => {
      this._https.get(url, { headers: { 'User-Agent': 'InstantCognition' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }
}

module.exports = new ModelHubService();
