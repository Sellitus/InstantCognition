// traceStore — saved recordings at {userData}/recordings/<id>.json.
// Ids are validated before any path is built, so a renderer-supplied id can
// never escape the directory. Writes go to a temp file and are renamed into
// place, so a crash never leaves a half-written trace.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RX = /^rec_[a-z0-9]{6,32}$/;
const FILE_RX = /^(rec_[a-z0-9]{6,32})\.json$/;
const MAX_TRACE_BYTES = 1024 * 1024;

const isTraceId = (id) => typeof id === 'string' && ID_RX.test(id);
const errMsg = (err) => (err instanceof Error && err.message) || String(err);

function summarize(trace) {
  return {
    id: trace.id,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    startUrl: trace.startUrl,
    title: trace.title,
    eventCount: Array.isArray(trace.events) ? trace.events.length : 0,
    truncated: trace.truncated === true,
  };
}

class TraceStore {
  /** @param {{ baseDir: string }} opts */
  constructor(opts) {
    if (!opts || typeof opts.baseDir !== 'string' || !opts.baseDir) throw new TypeError('TraceStore requires baseDir');
    this.baseDir = opts.baseDir;
  }

  _file(id) {
    if (!isTraceId(id)) throw new Error('invalid_id');
    return path.join(this.baseDir, `${id}.json`);
  }

  /** @param {{ id: string, events: any[] }} trace */
  save(trace) {
    if (!trace || typeof trace !== 'object' || !Array.isArray(trace.events)) throw new Error('invalid_trace');
    const file = this._file(trace.id);
    const json = JSON.stringify(trace);
    if (Buffer.byteLength(json, 'utf8') > MAX_TRACE_BYTES) throw new Error('trace_too_large');
    fs.mkdirSync(this.baseDir, { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    return summarize(trace);
  }

  /** @param {string} id */
  get(id) {
    const file = this._file(id);
    if (!fs.existsSync(file)) throw new Error('not_found');
    if (fs.statSync(file).size > MAX_TRACE_BYTES) throw new Error('trace_too_large');
    const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!trace || trace.id !== id || !Array.isArray(trace.events)) throw new Error('corrupt_trace');
    return trace;
  }

  /**
   * Newest first. A file that cannot be read is reported in `errors`, not dropped.
   * @returns {{ recordings: object[], errors: Array<{ id: string, error: string }> }}
   */
  list() {
    if (!fs.existsSync(this.baseDir)) return { recordings: [], errors: [] };
    const recordings = [];
    const errors = [];
    for (const name of fs.readdirSync(this.baseDir)) {
      const m = FILE_RX.exec(name);
      if (!m) continue;
      try { recordings.push(summarize(this.get(m[1]))); } catch (err) { errors.push({ id: m[1], error: errMsg(err) }); }
    }
    recordings.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return { recordings, errors };
  }

  /** @param {string} id */
  delete(id) {
    const file = this._file(id);
    if (!fs.existsSync(file)) throw new Error('not_found');
    fs.unlinkSync(file);
    return true;
  }
}

let defaultStore = null;
function getDefaultTraceStore() {
  if (!defaultStore) {
    const { app } = require('electron');
    defaultStore = new TraceStore({ baseDir: path.join(app.getPath('userData'), 'recordings') });
  }
  return defaultStore;
}

module.exports = { TraceStore, getDefaultTraceStore, isTraceId, summarize, MAX_TRACE_BYTES };
