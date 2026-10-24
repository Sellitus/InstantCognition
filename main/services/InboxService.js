// InboxService — results of background work (background sessions, scheduled
// routines) waiting for the user, in {userData}/inbox.json.
//
// Item: { id, sessionId, title, summary, ok, source, createdAt, read }.
// Every mutation rewrites the file atomically (temp file + rename), newest
// item first, capped at MAX_ITEMS (the oldest drop off). A file that cannot
// be parsed is reported as inbox_corrupt on every read and write instead of
// being overwritten; clear() is the explicit recovery and starts it empty.
// Emits 'changed' { reason, unread } after each successful mutation.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const MAX_ITEMS = 500;
const TITLE_MAX = 200;
const SUMMARY_MAX = 8000;
const ID_RE = /^ib_[a-f0-9]{16}$/;
const SESSION_ID_RE = /^s_[a-z0-9]{6,32}$/;
const SOURCES = new Set(['agent', 'chat', 'routine', 'launcher', 'subagent']);

function assertItemId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid_inbox_id');
  return id;
}

class InboxService extends EventEmitter {
  /** @param {{ filePath?: string, now?: () => number }} [opts] */
  constructor(opts = {}) {
    super();
    this._file = null;
    this._items = null;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    if (opts.filePath) this.configure({ filePath: opts.filePath });
  }

  /** @param {{ filePath: string }} opts absolute path of inbox.json */
  configure({ filePath }) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('absolute filePath required');
    this._file = filePath;
    this._items = null;
  }

  _load() {
    if (!this._file) throw new Error('inbox_not_configured');
    if (this._items) return this._items;
    let text;
    try { text = fs.readFileSync(this._file, 'utf8'); } catch (err) {
      if (/** @type {any} */ (err).code === 'ENOENT') { this._items = []; return this._items; }
      throw err;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (err) {
      throw new Error(`inbox_corrupt: ${(err instanceof Error && err.message) || String(err)}`);
    }
    if (!parsed || !Array.isArray(parsed.items)) throw new Error('inbox_corrupt: items array missing');
    const bad = parsed.items.findIndex((it) => !it || typeof it !== 'object' || !ID_RE.test(it.id));
    if (bad >= 0) throw new Error(`inbox_corrupt: item ${bad} is malformed`);
    this._items = parsed.items;
    return this._items;
  }

  _save(items, reason) {
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    const tmp = `${this._file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }));
    try { fs.renameSync(tmp, this._file); } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    this._items = items;
    this.emit('changed', { reason, unread: this.unreadCount() });
  }

  list() { return this._load().map((it) => ({ ...it })); }

  unreadCount() { return this._load().filter((it) => !it.read).length; }

  /** @param {{ sessionId?: string|null, title: string, summary?: string, ok: boolean, source?: string }} input */
  add(input) {
    const r = input && typeof input === 'object' ? input : /** @type {any} */ ({});
    const sessionId = r.sessionId == null ? null : r.sessionId;
    if (sessionId !== null && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) throw new Error('invalid_session_id');
    if (typeof r.title !== 'string' || !r.title.trim()) throw new Error('title required');
    if (r.summary !== undefined && typeof r.summary !== 'string') throw new Error('invalid_summary');
    if (typeof r.ok !== 'boolean') throw new Error('ok must be a boolean');
    const item = {
      id: `ib_${crypto.randomBytes(8).toString('hex')}`,
      sessionId,
      title: r.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX),
      summary: (r.summary || '').slice(0, SUMMARY_MAX),
      ok: r.ok,
      source: SOURCES.has(r.source) ? r.source : 'agent',
      createdAt: this._now(),
      read: false,
    };
    this._save([item, ...this._load()].slice(0, MAX_ITEMS), 'added');
    return { ...item };
  }

  /** Marks one item read (or unread with read=false). */
  markRead(id, read = true) {
    assertItemId(id);
    const items = this._load();
    if (!items.some((it) => it.id === id)) throw new Error('not_found');
    this._save(items.map((it) => (it.id === id ? { ...it, read: !!read } : it)), 'read');
    return { ok: true };
  }

  markAllRead() {
    this._save(this._load().map((it) => (it.read ? it : { ...it, read: true })), 'read');
    return { ok: true };
  }

  delete(id) {
    assertItemId(id);
    const items = this._load();
    const next = items.filter((it) => it.id !== id);
    if (next.length === items.length) throw new Error('not_found');
    this._save(next, 'deleted');
    return { ok: true };
  }

  /** Empties the inbox; also the recovery path for a corrupt file. */
  clear() {
    if (!this._file) throw new Error('inbox_not_configured');
    this._save([], 'cleared');
    return { ok: true };
  }
}

const instance = new InboxService();
module.exports = instance;
module.exports.InboxService = InboxService;
module.exports.assertItemId = assertItemId;
