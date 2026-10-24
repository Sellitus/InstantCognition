const fs = require('fs');
const path = require('path');
const os = require('os');

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 16 * 1024;

function tryReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function safeParse(line) {
  try { return JSON.parse(line); } catch (_) { return null; }
}

function readHeadTail(file, headBytes, tailBytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const head = Buffer.alloc(Math.min(headBytes, size));
    fs.readSync(fd, head, 0, head.length, 0);
    let tail = Buffer.alloc(0);
    if (size > head.length) {
      const tailLen = Math.min(tailBytes, size - head.length);
      tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, Math.max(0, size - tailLen));
    }
    return { head: head.toString('utf8'), tail: tail.toString('utf8'), size };
  } catch (_) {
    return { head: '', tail: '', size: 0 };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

function summarizeRun(file) {
  const id = path.basename(file, '.jsonl');
  const { head, tail, size } = readHeadTail(file, HEAD_BYTES, TAIL_BYTES);
  /** @type {any} */ let start = null;
  /** @type {any} */ let end = null;
  let steps = 0;
  const seen = new Set();
  const scan = (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line || seen.has(line)) continue;
      seen.add(line);
      const e = safeParse(line);
      if (!e) continue;
      if (e.kind === 'task-start' && !start) start = e;
      if (e.kind === 'task-end') end = e;
      if (e.kind === 'step') steps += 1;
    }
  };
  scan(head);
  if (size > head.length) scan(tail);

  const description = (start && start.description) || '';
  const autoTitle = (start && start.title) || description.slice(0, 80) || id;
  const status = end ? (end.ok ? 'ok' : (end.reason ? 'failed' : 'stopped')) : 'running';
  return {
    id,
    description,
    autoTitle,
    startedAt: (start && start.ts) || null,
    endedAt: (end && end.ts) || null,
    status,
    mode: (start && start.mode) || null,
    stepCount: (end && end.steps) || steps,
    tokensUsed: (end && end.tokensUsed) || 0,
    durationMs: (end && end.elapsedMs) || null,
    summary: (end && end.summary) || '', persona: (start && start.persona) || null, routerSource: (start && start.routerSource) || null,
  };
}

function readMeta(baseDir, id) {
  const m = tryReadJson(path.join(baseDir, `${id}.meta.json`));
  if (!m || typeof m !== 'object') return { title: null, pinned: false };
  return { title: m.title || null, pinned: !!m.pinned };
}

function writeMeta(baseDir, id, patch) {
  const file = path.join(baseDir, `${id}.meta.json`);
  const current = tryReadJson(file) || {};
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next));
  return next;
}

class AgentHistoryService {
  constructor() {
    this._baseDir = null;
  }

  initialize({ baseDir, skipOrphanSweep } = /** @type {{ baseDir?: string, skipOrphanSweep?: boolean }} */ ({})) {
    this._baseDir = baseDir || this._defaultBaseDir();
    try { fs.mkdirSync(this._baseDir, { recursive: true }); } catch (_) { /* best effort */ }
    // Sweep orphans from previous sessions so a force-quit / crash / reload
    // mid-run doesn't leave a row stuck on "processing" forever. Skip is a
    // test-only escape hatch.
    if (!skipOrphanSweep) {
      try { this.sweepOrphans(); } catch (_) { /* best effort */ }
    }
  }

  // Append a synthetic task-end to any .jsonl that has a task-start but no
  // task-end (idempotent — files with task-end are left alone). Called from
  // initialize() at app startup so a previous-session crash doesn't leave a
  // row stuck on "processing" forever.
  sweepOrphans({ activeFilePaths } = /** @type {{ activeFilePaths?: string[] }} */ ({})) {
    const dir = this.getBaseDir();
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
    catch (_) { return 0; }
    const skip = new Set(Array.isArray(activeFilePaths) ? activeFilePaths : []);
    let swept = 0;
    for (const f of files) {
      const file = path.join(dir, f);
      if (skip.has(file)) continue;
      try {
        const { head, tail, size } = readHeadTail(file, HEAD_BYTES, TAIL_BYTES);
        let hasStart = false; let hasEnd = false; let lastTs = 0;
        const seen = new Set();
        const scan = (chunk) => {
          for (const line of chunk.split('\n')) {
            if (!line || seen.has(line)) continue;
            seen.add(line);
            const e = safeParse(line); if (!e) continue;
            if (e.kind === 'task-start') hasStart = true;
            if (e.kind === 'task-end') hasEnd = true;
            if (Number.isFinite(e.ts) && e.ts > lastTs) lastTs = e.ts;
          }
        };
        scan(head); if (size > head.length) scan(tail);
        if (hasStart && !hasEnd) {
          const synthEnd = { ts: Date.now(), kind: 'task-end', ok: false, summary: '', summary_markdown: '', reason: 'orphaned', tokensUsed: 0, elapsedMs: lastTs ? Math.max(0, Date.now() - lastTs) : 0, steps: 0, navigations: 0 };
          fs.appendFileSync(file, JSON.stringify(synthEnd) + '\n');
          swept += 1;
        }
      } catch (_) { /* per-file best effort */ }
    }
    return swept;
  }

  _defaultBaseDir() {
    try {
      const { app } = require('electron');
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'agent-runs');
      }
    } catch (_) { /* fall through */ }
    return path.join(os.tmpdir(), 'instantcognition-agent-runs');
  }

  getBaseDir() { return this._baseDir || this._defaultBaseDir(); }

  open(id) {
    const dir = this.getBaseDir();
    const file = path.join(dir, `${id}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`run not found: ${id}`);
    const text = fs.readFileSync(file, 'utf8');
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      const e = safeParse(line);
      if (e) events.push(e);
    }
    const meta = readMeta(dir, id);
    const row = summarizeRun(file);
    return {
      id,
      title: meta.title || row.autoTitle,
      pinned: !!meta.pinned,
      description: row.description,
      status: row.status,
      mode: row.mode,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: row.durationMs,
      tokensUsed: row.tokensUsed,
      summary: row.summary,
      events,
    };
  }

  // Generic meta read/write for arbitrary sidecar fields (used by
  // AgentWorkspaceService for per-conversation tab snapshots, etc.).
  writeMeta(id, patch) {
    return writeMeta(this.getBaseDir(), id, patch || {});
  }

  readMeta(id) {
    const file = path.join(this.getBaseDir(), `${id}.meta.json`);
    return tryReadJson(file);
  }
}

module.exports = new AgentHistoryService();
module.exports.AgentHistoryService = AgentHistoryService;
