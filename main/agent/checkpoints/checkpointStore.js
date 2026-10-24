// checkpointStore — per-turn snapshots of agent file mutations, and rewind.
//
// Layout under rootDir ({userData}/checkpoints):
//   <sessionId>/<turnId>/manifest.json   every file first touched in that turn
//   <sessionId>/blobs/<sha256>           original bytes, content-addressed
// beforeMutate records a path's original bytes (or `absent`) the first time a
// turn touches it; afterMutate records the hash of what the agent wrote. A
// rewind compares the disk against that hash, so an edit made outside the
// agent is reported as a conflict and left alone unless forced. Every restored
// path is re-resolved through pathGuard against the root in the manifest.
// Shell commands are not observed: results carry `untracked: ['shell']`.
// A turn dir without manifest.json is abandoned (a crash or ENOSPC between
// the dir's mkdir and the manifest rename): readers skip it and pruning,
// which runs under the session lock, deletes it.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { resolveInside, isInside, errCode } = require('../workspace/pathGuard');
const { normalize: normalizeAgentSettings } = require('../workspace/agentSettings');
const { DEFAULT_LLM_SETTINGS } = require('../../../shared/llmDefaults');
const files = require('./checkpointFiles');

const { ABSENT, IRREGULAR } = files;
const SESSION_RE = /^s_[a-z0-9]{6,32}$/;
const TURN_RE = /^n_[a-z0-9]{6,32}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const UNTRACKED = Object.freeze(['shell']);
const DAY_MS = 86400000;
const MANIFEST = 'manifest.json';
const BLOBS = 'blobs';
const D = DEFAULT_LLM_SETTINGS.agent.checkpoints;

const isSessionId = (v) => typeof v === 'string' && SESSION_RE.test(v);
const isTurnId = (v) => typeof v === 'string' && TURN_RE.test(v);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const posNum = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);

function assertSession(sessionId) { if (!isSessionId(sessionId)) throw new Error('invalid_session_id'); }
function assertTurn(turnId) { if (!isTurnId(turnId)) throw new Error('invalid_turn_id'); }

/** settings.llm.agent.checkpoints layered over the shipped defaults. */
function checkpointSettings(agentRaw) {
  const c = obj(obj(agentRaw).checkpoints);
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : D.enabled,
    retentionDays: posNum(c.retentionDays, D.retentionDays),
    maxBytesPerSession: Math.floor(posNum(c.maxBytesPerSession, D.maxBytesPerSession)),
  };
}

const tokenOf = (original) => (original.state === ABSENT ? ABSENT : original.hash);

function validOriginal(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.state === ABSENT) return true;
  return o.state === 'file' && HASH_RE.test(o.hash) && Number.isInteger(o.mode) && o.mode >= 0 && o.mode <= 0o777;
}

function validManifest(m, sessionId, turnId) {
  if (!m || typeof m !== 'object' || m.version !== 1 || m.sessionId !== sessionId || m.turnId !== turnId) return false;
  if (!Number.isInteger(m.seq) || !Number.isFinite(m.createdAt) || !m.files || typeof m.files !== 'object' || Array.isArray(m.files)) return false;
  return Object.entries(m.files).every(([abs, e]) => path.isAbsolute(abs) && e && typeof e === 'object'
    && typeof e.root === 'string' && typeof e.rel === 'string' && validOriginal(e.original)
    && (e.post === null || (typeof e.post === 'string' && HASH_RE.test(e.post))));
}

class CheckpointStore {
  /**
   * @param {{ rootDir: string, getSettings: () => any, now?: () => number }} opts
   *   getSettings returns settings.llm.agent (checkpoints + workspace roots).
   */
  constructor({ rootDir, getSettings, now }) {
    if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) throw new Error('checkpoint_root_dir_required');
    if (typeof getSettings !== 'function') throw new Error('checkpoint_get_settings_required');
    this._rootDir = rootDir;
    this._getSettings = getSettings;
    this._now = typeof now === 'function' ? now : Date.now;
    /** @type {Map<string, Promise<unknown>>} */
    this._locks = new Map();
  }

  settings() { return checkpointSettings(this._getSettings()); }

  _sessionDir(sessionId) { return path.join(this._rootDir, sessionId); }
  _blobDir(sessionId) { return path.join(this._rootDir, sessionId, BLOBS); }
  _manifestPath(sessionId, turnId) { return path.join(this._rootDir, sessionId, turnId, MANIFEST); }

  /**
   * Mutations of one session's checkpoint tree run one at a time.
   * @template T
   * @param {string} sessionId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  _locked(sessionId, fn) {
    const prev = this._locks.get(sessionId) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this._locks.set(sessionId, tail);
    tail.then(() => { if (this._locks.get(sessionId) === tail) this._locks.delete(sessionId); });
    return run;
  }

  async _loadManifest(sessionId, turnId) {
    let raw;
    try { raw = await fsp.readFile(this._manifestPath(sessionId, turnId), 'utf8'); }
    catch (err) { if (errCode(err) === 'ENOENT') return null; throw err; }
    let m;
    try { m = JSON.parse(raw); } catch { throw new Error(`checkpoint_manifest_invalid: ${turnId}`); }
    if (!validManifest(m, sessionId, turnId)) throw new Error(`checkpoint_manifest_invalid: ${turnId}`);
    return m;
  }

  /**
   * Every turn manifest of a session, oldest first; unreadable ones by id in
   * `corrupt`, manifest-less turn dirs by id in `abandoned`.
   */
  async _readSession(sessionId) {
    let names;
    try { names = await fsp.readdir(this._sessionDir(sessionId)); }
    catch (err) { if (errCode(err) === 'ENOENT') return { turns: [], corrupt: [], abandoned: [] }; throw err; }
    const turns = [];
    const corrupt = [];
    const abandoned = [];
    for (const name of names.filter(isTurnId)) {
      try {
        const m = await this._loadManifest(sessionId, name);
        if (m) turns.push(m);
        else abandoned.push(name);
      } catch (err) {
        if (!(err instanceof Error) || !err.message.startsWith('checkpoint_manifest_invalid')) throw err;
        corrupt.push(name);
      }
    }
    turns.sort((a, b) => a.seq - b.seq);
    return { turns, corrupt, abandoned };
  }

  /**
   * Snapshot `absPath` before the agent writes it in `turnId`. Only the first
   * call per path and turn stores bytes. Returns tracked:false when disabled.
   * @param {{ sessionId: string, turnId: string, absPath: string, root: string }} a
   */
  async beforeMutate({ sessionId, turnId, absPath, root }) {
    const cfg = this.settings();
    if (!cfg.enabled) return { tracked: false };
    assertSession(sessionId);
    assertTurn(turnId);
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) throw new Error('invalid_path');
    const t = resolveInside(root, absPath, { forWrite: true });
    if (t.abs !== absPath) throw new Error('checkpoint_path_mismatch');
    return this._locked(sessionId, async () => {
      let m = await this._loadManifest(sessionId, turnId);
      if (m && m.files[t.abs]) return { tracked: true };
      if (!m) {
        const { turns } = await this._readSession(sessionId);
        const last = turns[turns.length - 1];
        m = { version: 1, sessionId, turnId, seq: last ? last.seq + 1 : 1, createdAt: this._now(), files: {} };
      }
      const st = await files.lstatOrNull(t.abs);
      let original;
      if (!st) original = { state: ABSENT };
      else if (!st.isFile()) throw new Error('checkpoint_not_regular_file');
      else original = { state: 'file', mode: st.mode & 0o777, ...(await files.storeBlob(this._blobDir(sessionId), t.abs)) };
      m.files[t.abs] = { root: t.root, rel: t.rel, original, post: null };
      await files.writeJsonAtomic(this._manifestPath(sessionId, turnId), m);
      await this._pruneSession(sessionId, cfg, turnId);
      return { tracked: true };
    });
  }

  /**
   * Record what the agent wrote to a path snapshotted by beforeMutate.
   * @param {{ sessionId: string, turnId: string, absPath: string, content: string|Buffer }} a
   */
  async afterMutate({ sessionId, turnId, absPath, content }) {
    if (!this.settings().enabled) return { tracked: false };
    assertSession(sessionId);
    assertTurn(turnId);
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new Error('content_must_be_string');
    const post = files.sha256(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
    return this._locked(sessionId, async () => {
      const m = await this._loadManifest(sessionId, turnId);
      const entry = m && m.files[absPath];
      if (!entry) throw new Error('checkpoint_missing_snapshot');
      entry.post = post;
      await files.writeJsonAtomic(this._manifestPath(sessionId, turnId), m);
      return { tracked: true };
    });
  }

  /**
   * The toolCtx.checkpoints object fsTools calls: beforeMutate(absPath) and
   * afterMutate(absPath, content), bound to one session turn. The root is the
   * configured workspace root that contains the path (deepest wins).
   * @param {{ sessionId: string, turnId: string, roots?: string[] }} a
   */
  forTurn({ sessionId, turnId, roots }) {
    assertSession(sessionId);
    assertTurn(turnId);
    const tracked = new Set();
    return {
      beforeMutate: async (absPath) => {
        const res = await this.beforeMutate({ sessionId, turnId, absPath, root: this._rootFor(absPath, roots) });
        if (res.tracked) tracked.add(absPath);
      },
      afterMutate: async (absPath, content) => {
        if (tracked.has(absPath)) await this.afterMutate({ sessionId, turnId, absPath, content });
      },
    };
  }

  _configuredRoots(roots) {
    const list = Array.isArray(roots) ? roots : normalizeAgentSettings(this._getSettings()).workspace.roots;
    const real = [];
    for (const r of list) {
      if (typeof r !== 'string' || !path.isAbsolute(r)) continue;
      try { real.push(fs.realpathSync.native(r)); }
      catch (err) { if (errCode(err) !== 'ENOENT') throw err; }
    }
    return real;
  }

  _rootFor(absPath, roots) {
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) throw new Error('invalid_path');
    const hit = this._configuredRoots(roots).filter((r) => isInside(r, absPath)).sort((a, b) => b.length - a.length)[0];
    if (!hit) throw new Error('checkpoint_root_unknown');
    return hit;
  }

  /** @param {{ sessionId: string }} a */
  async list({ sessionId }) {
    assertSession(sessionId);
    const { turns, corrupt } = await this._readSession(sessionId);
    return {
      sessionId,
      enabled: this.settings().enabled,
      turns: turns.map((m) => ({
        turnId: m.turnId, seq: m.seq, createdAt: m.createdAt,
        files: Object.entries(m.files).map(([abs, e]) => ({ path: abs, rel: e.rel, created: e.original.state === ABSENT })),
      })),
      corrupt,
      untracked: UNTRACKED,
    };
  }

  // What rewinding to `turnId` does per path. Each path's history runs newest
  // turn first: the disk must match the newest post-write hash, each older
  // turn's post must match the next newer turn's original, and the oldest
  // original is what gets restored. Any mismatch is an outside edit.
  async _plan(sessionId, turnId) {
    const { turns, corrupt } = await this._readSession(sessionId);
    if (corrupt.length) throw new Error(`checkpoint_manifest_invalid: ${corrupt.join(',')}`);
    const target = turns.find((m) => m.turnId === turnId);
    if (!target) throw new Error('checkpoint_not_found');
    const affected = turns.filter((m) => m.seq >= target.seq).reverse();
    /** @type {Map<string, any[]>} */
    const chains = new Map();
    for (const m of affected) {
      for (const [abs, e] of Object.entries(m.files)) {
        const chain = chains.get(abs) || [];
        chain.push({ ...e, abs, turnId: m.turnId });
        chains.set(abs, chain);
      }
    }
    const configured = this._configuredRoots(undefined);
    const plan = [];
    for (const [abs, chain] of chains) plan.push(await this._planPath(abs, chain, configured));
    return { turns: affected, files: plan };
  }

  async _planPath(abs, chain, configured) {
    const oldest = chain[chain.length - 1];
    const base = { path: abs, rel: oldest.rel, root: oldest.root, original: oldest.original, turnIds: chain.map((e) => e.turnId) };
    const blocked = (reason) => ({ ...base, status: 'conflict', action: 'none', conflict: { reason, turnId: chain[0].turnId, forceable: false } });
    for (const e of chain) {
      let t;
      try { t = resolveInside(e.root, e.rel, { forWrite: true }); }
      catch (err) {
        const code = err instanceof Error ? err.message : '';
        if (code === 'symlink_target' || code === 'workspace_root_missing') return blocked(code);
        throw err;
      }
      if (t.abs !== abs || t.root !== e.root) throw new Error('checkpoint_path_mismatch');
    }
    if (!configured.includes(oldest.root)) return blocked('root_not_configured');
    const disk = await files.fileState(abs);
    if (disk === IRREGULAR) return blocked('not_a_regular_file');
    let cur = disk;
    let conflict = null;
    for (const e of chain) {
      const before = tokenOf(e.original);
      const expected = e.post === null ? before : e.post;
      if (!conflict && cur !== expected) {
        conflict = { reason: e.post === null ? 'snapshot_incomplete' : 'modified_externally', turnId: e.turnId, forceable: true };
      }
      cur = before;
    }
    const action = cur === disk ? 'none' : cur === ABSENT ? 'delete' : 'restore';
    return { ...base, status: conflict ? 'conflict' : action === 'none' ? 'unchanged' : action, action, conflict };
  }

  /**
   * Files a rewind to `turnId` would touch: status restore | delete |
   * unchanged | conflict.
   * @param {{ sessionId: string, turnId: string }} a
   */
  async preview({ sessionId, turnId }) {
    assertSession(sessionId);
    assertTurn(turnId);
    const plan = await this._plan(sessionId, turnId);
    return {
      sessionId, turnId, conversationNodeId: turnId,
      turns: plan.turns.map((m) => m.turnId),
      files: plan.files.map(({ path: p, rel, status, conflict, turnIds }) => ({
        path: p, rel, status, turnIds,
        ...(conflict ? { reason: conflict.reason, forceable: conflict.forceable } : {}),
      })),
      untracked: UNTRACKED,
    };
  }

  /**
   * Undo the file changes of `turnId` and every later turn. Conflicting files
   * stay as they are unless `force` (a file that is no longer a regular file,
   * or whose root is gone, is never forced). Checkpoints of the rewound turns
   * are dropped only when nothing conflicted, so a forced retry stays possible.
   * conversationNodeId is the turn node the session layer rewinds to.
   * @param {{ sessionId: string, turnId: string, files?: boolean, force?: boolean }} a
   */
  async rewind({ sessionId, turnId, files: doFiles = true, force = false }) {
    assertSession(sessionId);
    assertTurn(turnId);
    if (typeof doFiles !== 'boolean') throw new Error('invalid_files_flag');
    if (typeof force !== 'boolean') throw new Error('invalid_force_flag');
    return this._locked(sessionId, async () => {
      const result = { restored: [], deleted: [], conflicts: [], conversationNodeId: turnId, untracked: UNTRACKED };
      if (!doFiles) return result;
      const plan = await this._plan(sessionId, turnId);
      for (const f of plan.files) {
        if (f.conflict && !(force && f.conflict.forceable)) {
          result.conflicts.push({ path: f.path, rel: f.rel, reason: f.conflict.reason, turnId: f.conflict.turnId });
          continue;
        }
        if (f.action === 'delete') {
          await fsp.unlink(f.path);
          result.deleted.push(f.path);
        } else if (f.action === 'restore') {
          await files.restoreBlob({ blobPath: path.join(this._blobDir(sessionId), f.original.hash), hash: f.original.hash, abs: f.path, root: f.root, mode: f.original.mode });
          result.restored.push(f.path);
        }
      }
      if (!result.conflicts.length) {
        for (const m of plan.turns) await fsp.rm(path.join(this._sessionDir(sessionId), m.turnId), { recursive: true, force: true });
        await this._collectBlobs(sessionId);
      }
      return result;
    });
  }

  // Deletes blobs no manifest references; the session dir goes once empty.
  // Skipped while any manifest is unreadable: its references are unknown.
  async _collectBlobs(sessionId) {
    const { turns, corrupt } = await this._readSession(sessionId);
    if (corrupt.length) return { bytes: null };
    const live = new Set();
    for (const m of turns) for (const e of Object.values(m.files)) if (e.original.state !== ABSENT) live.add(e.original.hash);
    let names = [];
    try { names = await fsp.readdir(this._blobDir(sessionId)); }
    catch (err) { if (errCode(err) !== 'ENOENT') throw err; }
    let bytes = 0;
    for (const name of names) {
      const p = path.join(this._blobDir(sessionId), name);
      if (!live.has(name)) { await fsp.rm(p, { force: true }); continue; }
      bytes += (await fsp.stat(p)).size;
    }
    if (!turns.length) await fsp.rm(this._sessionDir(sessionId), { recursive: true, force: true });
    return { bytes };
  }

  // Drops abandoned turn dirs and turns older than retentionDays, then the
  // oldest turns until the session's blobs fit maxBytesPerSession. `keepTurnId` (the turn being
  // recorded) is never dropped.
  async _pruneSession(sessionId, cfg, keepTurnId) {
    const cutoff = this._now() - cfg.retentionDays * DAY_MS;
    const { turns, abandoned } = await this._readSession(sessionId);
    let removed = 0;
    const dropDir = async (turnId) => { await fsp.rm(path.join(this._sessionDir(sessionId), turnId), { recursive: true, force: true }); removed += 1; };
    for (const turnId of abandoned) if (turnId !== keepTurnId) await dropDir(turnId);
    const kept = [];
    for (const m of turns) {
      if (m.turnId !== keepTurnId && m.createdAt < cutoff) await dropDir(m.turnId);
      else kept.push(m);
    }
    let { bytes } = await this._collectBlobs(sessionId);
    for (const m of kept) {
      if (bytes === null || bytes <= cfg.maxBytesPerSession) break;
      if (m.turnId === keepTurnId) continue;
      await dropDir(m.turnId);
      ({ bytes } = await this._collectBlobs(sessionId));
    }
    return removed;
  }

  /**
   * Delete every checkpoint of a session (its turn manifests and blobs). Runs
   * under the session lock so it never interleaves with a snapshot or rewind.
   * The directory must be a direct child of rootDir; a symlink in its place is
   * unlinked without following it.
   * @param {string} sessionId
   * @returns {Promise<{ removed: boolean }>} removed:false when the session had no checkpoints
   */
  async removeSession(sessionId) {
    assertSession(sessionId);
    const dir = this._sessionDir(sessionId);
    if (path.dirname(dir) !== path.resolve(this._rootDir) || path.basename(dir) !== sessionId) throw new Error('checkpoint_path_outside_root');
    return this._locked(sessionId, async () => {
      try { await fsp.lstat(dir); }
      catch (err) { if (errCode(err) === 'ENOENT') return { removed: false }; throw err; }
      await fsp.rm(dir, { recursive: true, force: true });
      return { removed: true };
    });
  }

  /** Apply retention to every session; returns the number of turns dropped. */
  async prune() {
    const cfg = this.settings();
    let names;
    try { names = await fsp.readdir(this._rootDir); }
    catch (err) { if (errCode(err) === 'ENOENT') return { removedTurns: 0 }; throw err; }
    let removedTurns = 0;
    for (const sessionId of names.filter(isSessionId)) {
      removedTurns += await this._locked(sessionId, () => this._pruneSession(sessionId, cfg, null));
    }
    return { removedTurns };
  }
}

/** @param {{ rootDir: string, getSettings: () => any, now?: () => number }} opts */
function createCheckpointStore(opts) { return new CheckpointStore(opts); }

module.exports = { createCheckpointStore, CheckpointStore, isSessionId, isTurnId, checkpointSettings, UNTRACKED };
