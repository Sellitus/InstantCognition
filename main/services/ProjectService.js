// ProjectService — persistent file/image collections the LLM can reach.
// Reach paths: (1) on-demand tools project.search / project.read_file (see
// tools/projectTools), (2) buildPromptBlock(projectId) injects a project's
// always-in-context text files into the system prompt. INDEX (metadata) lives
// in settings.projects.items so it migrates with config; BLOBS live on disk
// under userData/projects/<projectId>/<fileId> so config.json stays small.
// Mirrors UserMemoryService/RoutineService singletons; fs/path/time injectable.

const path = require('path');
const {
  MAX_TEXT_BYTES, MAX_IMAGE_BYTES, TEXT_EXTS, IMAGE_EXTS,
  genId, extOf, truncate, parseDataUrl, scoreMatch,
} = require('../../shared/projectUtils');

const SUMMARY_MAX_INPUT = 12000;     // chars of the file fed to the summarizer
const PROMPT_FILE_MAX = 6000;        // per-file cap in the always-in-context block
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

class ProjectService {
  constructor() {
    this._cs = null; this._fs = null; this._path = path;
    this._now = () => Date.now();
    this._screenshotService = null; this._tabRegistry = null; this._llm = null;
  }

  bindConfig(cs) { this._cs = cs; }
  _setFs(m) { this._fs = m; }
  _setPath(p) { this._path = p; }
  _setNow(fn) { if (typeof fn === 'function') this._now = fn; }
  setScreenshotService(s) { this._screenshotService = s; }
  setTabRegistry(t) { this._tabRegistry = t; }
  setLLMClient(c) { this._llm = c; }
  _getLLM() {
    if (this._llm) return this._llm;
    try { this._llm = require('./LLMClientService'); } catch (_) { return null; }
    return this._llm;
  }

  _fsMod() { return this._fs || require('fs'); }
  _cfg() {
    const cfg = (this._cs && this._cs.get('settings.projects', {})) || {};
    return {
      enabled: cfg.enabled !== false,
      items: Array.isArray(cfg.items) ? cfg.items : [],
      defaultAlwaysInContext: !!cfg.defaultAlwaysInContext,
      autoSummarize: cfg.autoSummarize !== false,
    };
  }
  _setItems(next) {
    if (!this._cs) return;
    const cfg = this._cs.get('settings.projects', {}) || {};
    this._cs.set('settings.projects', { ...cfg, items: next });
  }
  _projectsDir() { return this._path.join(require('../../shared/configPaths').getConfigDir(), 'projects'); }
  _projectDir(id) { return this._path.join(this._projectsDir(), id); }
  _ensureDir(dir) {
    try { this._fsMod().mkdirSync(dir, { recursive: true }); return true; }
    catch (err) { console.error('[ProjectService] mkdir failed', dir, err); return false; }
  }

  list() {
    return this._cfg().items.map((p) => ({
      id: p.id, name: p.name, alwaysInContext: !!p.alwaysInContext,
      createdAt: p.createdAt, fileCount: Array.isArray(p.files) ? p.files.length : 0,
    }));
  }
  _find(id) { return this._cfg().items.find((p) => p && p.id === id) || null; }
  create(arg = {}) {
    const { name } = /** @type {any} */ (arg);
    const cleaned = String(name || '').trim().slice(0, 120);
    if (!cleaned) return { ok: false, error: 'empty_name' };
    const cfg = this._cfg();
    if (!cfg.enabled) return { ok: false, error: 'disabled' };
    const project = { id: genId('proj'), name: cleaned, alwaysInContext: cfg.defaultAlwaysInContext, createdAt: this._now(), files: [] };
    this._setItems([...cfg.items, project]);
    this._ensureDir(this._projectDir(project.id));
    return { ok: true, project };
  }
  rename(arg = {}) {
    const { id, name } = /** @type {any} */ (arg);
    const cleaned = String(name || '').trim().slice(0, 120);
    if (!cleaned) return { ok: false, error: 'empty_name' };
    return this._patch(id, (p) => ({ ...p, name: cleaned }));
  }
  setContext(arg = {}) {
    const { id, on } = /** @type {any} */ (arg);
    return this._patch(id, (p) => ({ ...p, alwaysInContext: !!on }));
  }
  _patch(id, fn) {
    const items = this._cfg().items;
    const idx = items.findIndex((p) => p && p.id === id);
    if (idx < 0) return { ok: false, error: 'not_found' };
    items[idx] = fn(items[idx]);
    this._setItems(items);
    return { ok: true };
  }
  async delete(arg = {}) {
    const { id } = /** @type {any} */ (arg);
    const items = this._cfg().items;
    const next = items.filter((p) => p && p.id !== id);
    if (next.length === items.length) return { ok: false, error: 'not_found' };
    this._setItems(next);
    try { await this._fsMod().promises.rm(this._projectDir(id), { recursive: true, force: true }); }
    catch (err) { console.error('[ProjectService] delete dir failed', id, err); }
    return { ok: true };
  }

  files(arg = {}) {
    const { id } = /** @type {any} */ (arg);
    const p = this._find(id);
    if (!p) return { ok: false, error: 'not_found' };
    return { ok: true, files: (p.files || []).map((f) => ({ id: f.id, name: f.name, ext: f.ext, size: f.size, isImage: !!f.isImage, addedAt: f.addedAt })) };
  }
  async addFile(arg = {}) {
    const { id, name, text } = /** @type {any} */ (arg);
    const p = this._find(id);
    if (!p) return { ok: false, error: 'not_found' };
    const body = String(text == null ? '' : text);
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MAX_TEXT_BYTES) return { ok: false, error: 'file_too_large' };
    const ext = extOf(name);
    const file = { id: genId('file'), name: String(name || 'untitled').slice(0, 200), ext, size: bytes, isImage: false, addedAt: this._now() };
    if (!this._writeText(id, file.id, body)) return { ok: false, error: 'write_failed' };
    this._appendFile(id, file);
    if (this._cfg().autoSummarize && TEXT_EXTS.has(ext) && bytes > 0) {
      summarizeFile(this, id, file.id, name, body).catch((e) => console.error('[ProjectService] summarize failed', e));
    }
    return { ok: true, file };
  }
  async addImage(arg = {}) {
    const { id, name, dataUrl } = /** @type {any} */ (arg);
    const p = this._find(id);
    if (!p) return { ok: false, error: 'not_found' };
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return { ok: false, error: 'invalid_image' };
    if (parsed.bytes > MAX_IMAGE_BYTES) return { ok: false, error: 'image_too_large' };
    const ext = IMAGE_EXTS.has(extOf(name)) ? extOf(name) : (parsed.ext || 'png');
    const file = { id: genId('file'), name: String(name || 'image').slice(0, 200), ext, size: parsed.bytes, isImage: true, addedAt: this._now() };
    if (!this._writeBuf(id, file.id, parsed.buf)) return { ok: false, error: 'write_failed' };
    this._appendFile(id, file);
    return { ok: true, file };
  }
  async removeFile(arg = {}) {
    const { id, fileId } = /** @type {any} */ (arg);
    const p = this._find(id);
    if (!p) return { ok: false, error: 'not_found' };
    const before = (p.files || []).length;
    const next = (p.files || []).filter((f) => f.id !== fileId);
    if (next.length === before) return { ok: false, error: 'file_not_found' };
    this._patch(id, (proj) => ({ ...proj, files: next }));
    try { await this._fsMod().promises.rm(this._path.join(this._projectDir(id), fileId), { force: true }); }
    catch (err) { console.error('[ProjectService] removeFile blob failed', id, fileId, err); }
    return { ok: true };
  }
  _appendFile(id, file) { this._patch(id, (p) => ({ ...p, files: [...(p.files || []), file] })); }
  _writeText(id, fileId, body) { return this._writeBuf(id, fileId, body, true); }
  _writeBuf(id, fileId, data, asText = false) {
    if (!this._ensureDir(this._projectDir(id))) return false;
    try { this._fsMod().writeFileSync(this._path.join(this._projectDir(id), fileId), data, asText ? 'utf8' : undefined); return true; }
    catch (err) { console.error('[ProjectService] write failed', id, fileId, err); return false; }
  }
  async read(projectId, fileId) {
    const p = this._find(projectId);
    if (!p) return null;
    const f = (p.files || []).find((x) => x.id === fileId);
    if (!f) return null;
    try {
      const fp = this._path.join(this._projectDir(projectId), fileId);
      if (f.isImage) { const buf = await this._fsMod().promises.readFile(fp); const mime = IMAGE_MIME[f.ext] || 'image/png'; return { file: f, imagePath: fp, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }; }
      return { file: f, text: await this._fsMod().promises.readFile(fp, 'utf8') };
    } catch (err) { console.error('[ProjectService] read failed', projectId, fileId, err); return null; }
  }
  _readSync(projectId, fileId) {
    try { return this._fsMod().readFileSync(this._path.join(this._projectDir(projectId), fileId), 'utf8'); }
    catch (_) { return ''; }
  }

  buildPromptBlock(projectId) {
    if (!projectId) return '';
    const p = this._find(projectId);
    if (!p || !p.alwaysInContext) return '';
    const parts = [];
    (p.files || []).forEach((f) => { if (f.isImage) return; const body = this._readSync(projectId, f.id); if (body) parts.push(`### ${f.name}\n${truncate(body, PROMPT_FILE_MAX)}`); });
    return parts.length ? `Project "${p.name}" files (always-in-context):\n\n${parts.join('\n\n')}` : '';
  }
  // Agent system-prompt convenience: block for the user's selected (lastActiveId) project. No-op when none or alwaysInContext off.
  buildActiveBlock() {
    try { const pid = this._cs ? this._cs.get('settings.projects.lastActiveId', null) : null; return pid ? this.buildPromptBlock(pid) : ''; }
    catch (err) { console.error('[ProjectService] buildActiveBlock failed', err); return ''; }
  }
  search(projectId, query, opts = {}) {
    const { limit = 8 } = /** @type {any} */ (opts);
    const p = this._find(projectId);
    if (!p) return [];
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const terms = q.split(/\s+/);
    const results = [];
    for (const f of (p.files || [])) {
      if (f.isImage) {
        if (terms.every((t) => f.name.toLowerCase().includes(t))) results.push({ fileId: f.id, name: f.name, isImage: true, score: 1 });
      } else {
        const hay = `${this._readSync(projectId, f.id)} ${f.name} ${f.summary || ''}`;
        const score = scoreMatch(terms, hay);
        if (score > 0) results.push({ fileId: f.id, name: f.name, isImage: false, score });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(25, limit)));
  }
  activeContextProject() { return this._cfg().items.find((p) => p && p.alwaysInContext) || null; }
  async screenshotActive(arg = {}) {
    const { id } = /** @type {any} */ (arg);
    return screenshotActive(this, id);
  }
}

// -- Free functions (out of class for line-budget + reuse) ---

// Auto-summarize a fresh text file so search matches by meaning, not just
// literal keywords. Best-effort; failures only log.
async function summarizeFile(service, projectId, fileId, name, body) {
  const llm = service._getLLM();
  if (!llm || typeof llm.chatCompletionJson !== 'function') return;
  const messages = [
    { role: 'system', content: 'Summarize the following file for semantic search. Capture what the file is about, its main topics, entities, and key terms so a keyword search can find it later. Reply with ONLY a JSON object: {"summary":"<3-6 sentence summary>"}.' },
    { role: 'user', content: `File: ${name}\n\n${truncate(body, SUMMARY_MAX_INPUT)}` },
  ];
  let res;
  try { res = await llm.chatCompletionJson(messages, { summary: 'string' }, { temperature: 0, maxTokens: 400 }); }
  catch (err) { console.error('[ProjectService] summarize request failed', err); return; }
  if (!res || !res.ok || !res.value || typeof res.value.summary !== 'string') return;
  service._patch(projectId, (p) => ({
    ...p,
    files: (p.files || []).map((f) => f.id === fileId ? { ...f, summary: res.value.summary.slice(0, 2000) } : f),
  }));
}

// Capture the active user tab and store it as a project image.
async function screenshotActive(service, projectId) {
  if (!service._find(projectId)) return { ok: false, error: 'not_found' };
  if (!service._screenshotService || !service._tabRegistry) return { ok: false, error: 'no_capture_service' };
  const tabs = service._tabRegistry.list ? service._tabRegistry.list() : [];
  // A private tab never lands in a project: project files are saved to disk.
  const capturable = tabs.filter((t) => t && t.webContentsId != null && !t.private);
  const active = capturable.find((t) => (t.kind || 'user') === 'user') || capturable[0];
  if (!active) return { ok: false, error: 'no_active_tab' };
  try {
    const image = await service._screenshotService.captureById(active.webContentsId);
    const buf = image && typeof image.toPNG === 'function' ? image.toPNG() : null;
    if (!buf) return { ok: false, error: 'capture_empty' };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = { id: genId('file'), name: `screenshot-${stamp}.png`, ext: 'png', size: buf.length, isImage: true, addedAt: service._now() };
    if (!service._writeBuf(projectId, file.id, buf)) return { ok: false, error: 'write_failed' };
    service._appendFile(projectId, file);
    return { ok: true, file };
  } catch (err) {
    console.error('[ProjectService] screenshotActive failed', err);
    return { ok: false, error: (err instanceof Error && err.message) || 'capture_failed' };
  }
}

const instance = new ProjectService();
module.exports = instance;
module.exports.ProjectService = ProjectService;
module.exports.summarizeFile = summarizeFile;
module.exports.screenshotActive = screenshotActive;
