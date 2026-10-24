// sessionStore — persisted assistant sessions. One directory per session under
// {baseDir}/<sessionId>/ holds meta.json (written atomically: tmp + rename)
// and nodes.jsonl, an append-only message tree.
//
// Nodes link through parentId; meta.headId names the leaf of the active
// branch, and the conversation is the root→head path. Editing a user message
// or regenerating an answer adds a sibling node instead of rewriting history,
// so every earlier branch stays reachable. fork() copies a path into a new
// session and never touches the source.
//
// A jsonl line that does not parse into a valid node is counted in
// corruptLines and listed in `corrupt` by get(); it is never silently skipped.
//
// Other modules (artifacts, checkpoints) keep their own files inside a
// session directory, so delete() removes the whole directory and list() only
// considers directories that hold a meta.json.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_ID_RE = /^s_[a-z0-9]{6,32}$/;
const NODE_ID_RE = /^n_[a-z0-9]{6,32}$/;
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const KINDS = new Set(['message', 'tool_calls', 'tool_results', 'compaction', 'error', 'plan']);
const MAX_CONTENT_CHARS = 1_000_000;
const MAX_DATA_CHARS = 1_000_000;
const TITLE_MAX = 120;
const AUTO_TITLE_MAX = 80;
const CORRUPT_DETAIL_MAX = 20;
const SOURCES = new Set(['chat', 'agent', 'routine', 'launcher', 'subagent', 'legacy', 'fork']);

function assertSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new Error('invalid_session_id');
  return id;
}

function assertNodeId(id) {
  if (typeof id !== 'string' || !NODE_ID_RE.test(id)) throw new Error('invalid_node_id');
  return id;
}

const newSessionId = () => `s_${crypto.randomBytes(10).toString('hex')}`;
const newNodeId = () => `n_${crypto.randomBytes(8).toString('hex')}`;

function cleanTitle(v) {
  if (typeof v !== 'string') throw new Error('invalid_title');
  return v.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

function autoTitle(text) {
  const line = String(text || '').split('\n').find((l) => l.trim()) || '';
  return line.trim().slice(0, AUTO_TITLE_MAX);
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function appendLine(file, line) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function validNode(n) {
  return !!n && typeof n === 'object' && NODE_ID_RE.test(n.id)
    && (n.parentId === null || NODE_ID_RE.test(n.parentId))
    && ROLES.has(n.role) && KINDS.has(n.kind) && typeof n.content === 'string';
}

class SessionStore extends EventEmitter {
  /** @param {{ baseDir: string, now?: () => number }} opts */
  constructor({ baseDir, now }) {
    super();
    if (typeof baseDir !== 'string' || !baseDir) throw new Error('baseDir required');
    this._baseDir = baseDir;
    this._now = typeof now === 'function' ? now : Date.now;
    this._cache = new Map();
  }

  getBaseDir() { return this._baseDir; }

  _dir(id) { return path.join(this._baseDir, assertSessionId(id)); }

  exists(id) {
    return SESSION_ID_RE.test(String(id)) && fs.existsSync(path.join(this._dir(id), 'meta.json'));
  }

  /** @param {{ id?: string, title?: string, projectId?: string|null, workspaceRoot?: string|null, source?: string, forkedFrom?: any, legacyRunId?: string|null, createdAt?: number, pinned?: boolean }} [opts] */
  create(opts = {}) {
    const id = opts.id === undefined ? newSessionId() : assertSessionId(opts.id);
    const dir = this._dir(id);
    if (fs.existsSync(path.join(dir, 'meta.json'))) throw new Error('session_exists');
    fs.mkdirSync(dir, { recursive: true });
    const t = Number.isFinite(opts.createdAt) ? opts.createdAt : this._now();
    const meta = {
      id, title: opts.title === undefined ? '' : cleanTitle(opts.title), createdAt: t, updatedAt: t,
      pinned: !!opts.pinned, projectId: opts.projectId || null, workspaceRoot: opts.workspaceRoot || null,
      headId: null, nodeCount: 0, source: SOURCES.has(opts.source) ? opts.source : 'chat',
      forkedFrom: opts.forkedFrom || null, legacyRunId: opts.legacyRunId || null,
    };
    fs.writeFileSync(path.join(dir, 'nodes.jsonl'), '', { flag: 'a' });
    writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta));
    this._cache.set(id, { meta, nodes: new Map(), order: [], corrupt: [], corruptLines: 0, endsClean: true });
    this.emit('changed', { sessionId: id, reason: 'created' });
    return { ...meta };
  }

  _load(id) {
    const cached = this._cache.get(id);
    if (cached) return cached;
    const dir = this._dir(id);
    const metaFile = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaFile)) throw new Error('session_not_found');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const nodesFile = path.join(dir, 'nodes.jsonl');
    const text = fs.existsSync(nodesFile) ? fs.readFileSync(nodesFile, 'utf8') : '';
    const nodes = new Map();
    const order = [];
    const corrupt = [];
    let corruptLines = 0;
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      let node = null;
      let reason = 'invalid_node';
      try { node = JSON.parse(line); } catch (err) { reason = `parse_error: ${(err instanceof Error && err.message) || err}`; }
      if (validNode(node) && nodes.has(node.id)) reason = 'duplicate_id';
      if (!validNode(node) || nodes.has(node.id)) {
        corruptLines++;
        if (corrupt.length < CORRUPT_DETAIL_MAX) corrupt.push({ line: i + 1, reason, preview: line.slice(0, 120) });
        return;
      }
      nodes.set(node.id, node);
      order.push(node.id);
    });
    if (corruptLines) console.error(`[sessionStore] ${id}: ${corruptLines} corrupt line(s) in nodes.jsonl`);
    if (meta.headId && !nodes.has(meta.headId)) meta.headId = order.length ? order[order.length - 1] : null;
    const entry = { meta, nodes, order, corrupt, corruptLines, endsClean: text === '' || text.endsWith('\n') };
    this._cache.set(id, entry);
    return entry;
  }

  _saveMeta(entry, reason) {
    entry.meta.updatedAt = this._now();
    writeFileAtomic(path.join(this._dir(entry.meta.id), 'meta.json'), JSON.stringify(entry.meta));
    this.emit('changed', { sessionId: entry.meta.id, reason });
  }

  list() {
    let names = [];
    try { names = fs.readdirSync(this._baseDir); } catch (err) {
      if (/** @type {any} */ (err).code === 'ENOENT') return [];
      throw err;
    }
    const rows = [];
    for (const name of names) {
      if (!SESSION_ID_RE.test(name) || !fs.existsSync(path.join(this._baseDir, name, 'meta.json'))) continue;
      // One unreadable session must not hide the rest; it is listed with its error.
      try {
        const entry = this._load(name);
        rows.push({ ...entry.meta, corruptLines: entry.corruptLines });
      } catch (err) {
        rows.push({ id: name, title: '', pinned: false, updatedAt: 0, error: (err instanceof Error && err.message) || String(err) });
      }
    }
    rows.sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || (b.updatedAt - a.updatedAt));
    return rows;
  }

  _pathIds(entry, nodeId) {
    const ids = [];
    const seen = new Set();
    let cur = nodeId;
    while (cur) {
      if (seen.has(cur)) throw new Error('node_cycle');
      seen.add(cur);
      const node = entry.nodes.get(cur);
      if (!node) break;
      ids.push(cur);
      cur = node.parentId;
    }
    return ids.reverse();
  }

  _children(entry, parentId) {
    return entry.order.filter((nid) => entry.nodes.get(nid).parentId === parentId);
  }

  /** Nodes root→nodeId (default: head). */
  getPath(id, nodeId) {
    const entry = this._load(assertSessionId(id));
    const target = nodeId === undefined ? entry.meta.headId : assertNodeId(nodeId);
    if (target && !entry.nodes.has(target)) throw new Error('node_not_found');
    return this._pathIds(entry, target).map((nid) => ({ ...entry.nodes.get(nid) }));
  }

  get(id) {
    const entry = this._load(assertSessionId(id));
    const pathIds = this._pathIds(entry, entry.meta.headId);
    /** @type {Record<string, { index: number, count: number, siblingIds: string[] }>} */
    const branches = {};
    for (const nid of pathIds) {
      const sibs = this._children(entry, entry.nodes.get(nid).parentId);
      if (sibs.length > 1) branches[nid] = { index: sibs.indexOf(nid), count: sibs.length, siblingIds: sibs };
    }
    return {
      meta: { ...entry.meta }, nodes: entry.order.map((nid) => ({ ...entry.nodes.get(nid) })),
      path: pathIds, branches, corruptLines: entry.corruptLines, corrupt: entry.corrupt.slice(),
    };
  }

  /** @param {{ parentId?: string|null, role: string, kind?: string, content?: string, data?: any }} input */
  append(id, input) {
    const entry = this._load(assertSessionId(id));
    const i = input || /** @type {any} */ ({});
    if (!ROLES.has(i.role)) throw new Error('invalid_role');
    const kind = i.kind === undefined ? 'message' : i.kind;
    if (!KINDS.has(kind)) throw new Error('invalid_kind');
    const content = i.content === undefined ? '' : i.content;
    if (typeof content !== 'string') throw new Error('invalid_content');
    if (content.length > MAX_CONTENT_CHARS) throw new Error('content_too_large');
    const parentId = i.parentId === undefined ? entry.meta.headId : (i.parentId === null ? null : assertNodeId(i.parentId));
    if (parentId && !entry.nodes.has(parentId)) throw new Error('parent_not_found');
    /** @type {any} */
    const node = { id: newNodeId(), parentId, role: i.role, kind, content, createdAt: this._now() };
    if (i.data !== undefined) {
      const json = JSON.stringify(i.data);
      if (json === undefined || json.length > MAX_DATA_CHARS) throw new Error('data_too_large');
      node.data = JSON.parse(json);
    }
    const file = path.join(this._dir(id), 'nodes.jsonl');
    // A crash mid-append can leave a partial last line; start a fresh line so
    // the new node is not glued onto it.
    appendLine(file, `${entry.endsClean ? '' : '\n'}${JSON.stringify(node)}\n`);
    entry.endsClean = true;
    entry.nodes.set(node.id, node);
    entry.order.push(node.id);
    entry.meta.headId = node.id;
    entry.meta.nodeCount = entry.order.length;
    if (!entry.meta.title && node.role === 'user' && kind === 'message') entry.meta.title = autoTitle(content);
    this._saveMeta(entry, 'node');
    this.emit('node', { sessionId: id, node: { ...node } });
    return { ...node };
  }

  setHead(id, nodeId) {
    const entry = this._load(assertSessionId(id));
    if (nodeId !== null && !entry.nodes.has(assertNodeId(nodeId))) throw new Error('node_not_found');
    entry.meta.headId = nodeId;
    this._saveMeta(entry, 'head');
    return { ...entry.meta };
  }

  /** Make the branch through nodeId active: head = its newest descendant leaf. */
  branch(id, nodeId) {
    const entry = this._load(assertSessionId(id));
    if (!entry.nodes.has(assertNodeId(nodeId))) throw new Error('node_not_found');
    let leaf = nodeId;
    for (let kids = this._children(entry, leaf); kids.length; kids = this._children(entry, leaf)) leaf = kids[kids.length - 1];
    this.setHead(id, leaf);
    return this.get(id);
  }

  /** New sibling of a user message carrying the edited text; becomes head. */
  edit(id, nodeId, content) {
    const entry = this._load(assertSessionId(id));
    const target = entry.nodes.get(assertNodeId(nodeId));
    if (!target) throw new Error('node_not_found');
    if (target.role !== 'user' || target.kind !== 'message') throw new Error('not_a_user_message');
    if (typeof content !== 'string' || !content.trim()) throw new Error('empty_content');
    const lane = target.data && target.data.lane;
    return this.append(id, { parentId: target.parentId, role: 'user', content, data: lane ? { lane, editedFrom: nodeId } : { editedFrom: nodeId } });
  }

  /**
   * Point head at the user message an answer replied to, so the next appended
   * answer becomes a sibling of the old one. Accepts the answer or the user node;
   * an agent answer sits below its turn's tool calls and results.
   */
  regenerate(id, nodeId) {
    const entry = this._load(assertSessionId(id));
    const target = entry.nodes.get(assertNodeId(nodeId));
    if (!target) throw new Error('node_not_found');
    let user = target;
    while (user && user.role !== 'user' && (user === target || user.kind === 'tool_calls' || user.kind === 'tool_results')) {
      user = user.parentId ? entry.nodes.get(user.parentId) : null;
    }
    if (!user || user.role !== 'user') throw new Error('no_user_message_to_regenerate');
    this.setHead(id, user.id);
    return { ...user };
  }

  /** Copy root→nodeId (default head) into a new session; the source is untouched. */
  fork(id, nodeId) {
    const nodes = this.getPath(id, nodeId);
    const src = this._load(id).meta;
    const meta = this.create({
      title: src.title ? cleanTitle(`${src.title} (fork)`) : '', projectId: src.projectId,
      workspaceRoot: src.workspaceRoot, source: 'fork', forkedFrom: { sessionId: id, nodeId: nodes.length ? nodes[nodes.length - 1].id : null },
    });
    let parentId = null;
    for (const n of nodes) {
      const copy = this.append(meta.id, { parentId, role: n.role, kind: n.kind, content: n.content, data: n.data });
      parentId = copy.id;
    }
    return { ...this._load(meta.id).meta };
  }

  _patchMeta(id, patch, reason) {
    const entry = this._load(assertSessionId(id));
    Object.assign(entry.meta, patch);
    this._saveMeta(entry, reason);
    return { ...entry.meta };
  }

  rename(id, title) { return this._patchMeta(id, { title: cleanTitle(title) }, 'renamed'); }

  pin(id, pinned) {
    if (typeof pinned !== 'boolean') throw new Error('invalid_pinned');
    return this._patchMeta(id, { pinned }, 'pinned');
  }

  setProject(id, projectId) {
    if (projectId !== null && (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId))) throw new Error('invalid_project_id');
    return this._patchMeta(id, { projectId }, 'project');
  }

  /** The caller validates `root` against the configured workspace roots. */
  setWorkspace(id, root) {
    if (root !== null && (typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('invalid_workspace_root');
    return this._patchMeta(id, { workspaceRoot: root }, 'workspace');
  }

  delete(id) {
    const dir = this._dir(id);
    if (!fs.existsSync(path.join(dir, 'meta.json'))) throw new Error('session_not_found');
    fs.rmSync(dir, { recursive: true, force: true });
    this._cache.delete(id);
    this.emit('changed', { sessionId: id, reason: 'deleted' });
    return true;
  }
}

function createSessionStore(opts) { return new SessionStore(opts); }

module.exports = { createSessionStore, SessionStore, assertSessionId, assertNodeId, SESSION_ID_RE, NODE_ID_RE, newSessionId };
