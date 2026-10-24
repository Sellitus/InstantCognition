// artifactStore — versioned, per-session artifacts the assistant produces
// (HTML pages, diagrams, documents, code, SVG).
//
// Layout: <baseDir>/<sessionId>/artifacts/<artifactId>/v<n>.json, where
// baseDir is {userData}/sessions (shared with the session store). Every
// create/update writes a new immutable version file; nothing is overwritten.
// Each record is { id, version, type, title, language?, content, createdAt }.
//
// The store emits 'upserted' { sessionId, artifact } after every successful
// write so the IPC layer can push the change to the renderer.
//
// All fs work is synchronous: version numbers come from the directory
// listing, and sync calls cannot interleave inside the main process, so two
// updates can never claim the same version.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const ARTIFACT_TYPES = Object.freeze(['html', 'markdown', 'mermaid', 'code', 'svg']);
const SESSION_ID_RX = /^s_[a-z0-9]{6,32}$/;
const ARTIFACT_ID_RX = /^a_[a-z0-9]{6,32}$/;
const LANGUAGE_RX = /^[\w+#.-]{1,32}$/;
const VERSION_FILE_RX = /^v([1-9]\d{0,5})\.json$/;
const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_BYTES = 512 * 1024;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 12;

class ArtifactError extends Error {
  /** @param {string} code @param {object} [extra] */
  constructor(code, extra) { super(code); this.code = code; this.extra = extra || {}; }
}

function newArtifactId() {
  const bytes = crypto.randomBytes(ID_LENGTH);
  let out = 'a_';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

function assertSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID_RX.test(id)) throw new ArtifactError('invalid_session_id');
}

function assertArtifactId(id) {
  if (typeof id !== 'string' || !ARTIFACT_ID_RX.test(id)) throw new ArtifactError('invalid_artifact_id');
}

function normalizeVersion(version) {
  if (version === undefined || version === null) return null;
  if (!Number.isInteger(version) || version < 1) throw new ArtifactError('invalid_version');
  return version;
}

// Validates the user-visible fields; `base` supplies inherited values on update.
function normalizeFields(input, base) {
  const src = input && typeof input === 'object' ? input : {};
  const type = src.type !== undefined ? src.type : base && base.type;
  if (!ARTIFACT_TYPES.includes(type)) throw new ArtifactError('invalid_type', { allowed: ARTIFACT_TYPES });
  const rawTitle = src.title !== undefined ? src.title : base && base.title;
  if (typeof rawTitle !== 'string' || !rawTitle.trim()) throw new ArtifactError('invalid_title');
  const title = rawTitle.trim();
  if (title.length > MAX_TITLE_CHARS) throw new ArtifactError('title_too_long', { maxChars: MAX_TITLE_CHARS });
  const language = src.language !== undefined ? src.language : base && base.language;
  if (language !== undefined && language !== null && (typeof language !== 'string' || !LANGUAGE_RX.test(language))) {
    throw new ArtifactError('invalid_language');
  }
  const content = src.content;
  if (typeof content !== 'string' || !content.length) throw new ArtifactError('invalid_content');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_CONTENT_BYTES) throw new ArtifactError('content_too_large', { bytes, maxBytes: MAX_CONTENT_BYTES });
  const fields = { type, title, content };
  if (typeof language === 'string') fields.language = language;
  return fields;
}

function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(tmp, file); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
}

/**
 * @param {{ baseDir: string }} opts baseDir is the sessions root ({userData}/sessions).
 */
function createArtifactStore(opts) {
  const baseDir = opts && opts.baseDir;
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) throw new TypeError('createArtifactStore: absolute baseDir required');
  const events = new EventEmitter();

  const sessionDir = (sessionId) => path.join(baseDir, sessionId, 'artifacts');
  const artifactDir = (sessionId, artifactId) => path.join(sessionDir(sessionId), artifactId);

  function versionsOf(sessionId, artifactId) {
    const dir = artifactDir(sessionId, artifactId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .map((name) => VERSION_FILE_RX.exec(name))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }

  function readVersion(sessionId, artifactId, version) {
    const file = path.join(artifactDir(sessionId, artifactId), `v${version}.json`);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
      if (err && /** @type {any} */ (err).code === 'ENOENT') throw new ArtifactError('version_not_found', { version });
      throw new ArtifactError('artifact_corrupt', { artifactId, version, reason: (err instanceof Error && err.message) || String(err) });
    }
    if (!record || record.id !== artifactId || record.version !== version || typeof record.content !== 'string') {
      throw new ArtifactError('artifact_corrupt', { artifactId, version });
    }
    return record;
  }

  function writeVersion(sessionId, artifactId, version, fields) {
    const dir = artifactDir(sessionId, artifactId);
    fs.mkdirSync(dir, { recursive: true });
    const artifact = { id: artifactId, version, ...fields, createdAt: new Date().toISOString() };
    writeAtomic(path.join(dir, `v${version}.json`), JSON.stringify(artifact));
    events.emit('upserted', { sessionId, artifact });
    return artifact;
  }

  function create(sessionId, input) {
    assertSessionId(sessionId);
    const fields = normalizeFields(input, null);
    let id = newArtifactId();
    while (fs.existsSync(artifactDir(sessionId, id))) id = newArtifactId();
    return writeVersion(sessionId, id, 1, fields);
  }

  function update(sessionId, artifactId, input) {
    assertSessionId(sessionId);
    assertArtifactId(artifactId);
    const versions = versionsOf(sessionId, artifactId);
    if (!versions.length) throw new ArtifactError('artifact_not_found');
    const latest = versions[versions.length - 1];
    const fields = normalizeFields(input, readVersion(sessionId, artifactId, latest));
    return writeVersion(sessionId, artifactId, latest + 1, fields);
  }

  function get(sessionId, artifactId, version) {
    assertSessionId(sessionId);
    assertArtifactId(artifactId);
    const want = normalizeVersion(version);
    const versions = versionsOf(sessionId, artifactId);
    if (!versions.length) throw new ArtifactError('artifact_not_found');
    return { ...readVersion(sessionId, artifactId, want || versions[versions.length - 1]), versions };
  }

  // Summaries (no content), newest first. An unreadable latest version is
  // listed with its error rather than dropped, so corruption stays visible.
  function list(sessionId) {
    assertSessionId(sessionId);
    const dir = sessionDir(sessionId);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const artifactId of fs.readdirSync(dir)) {
      if (!ARTIFACT_ID_RX.test(artifactId)) continue;
      const versions = versionsOf(sessionId, artifactId);
      if (!versions.length) continue;
      const latest = versions[versions.length - 1];
      try {
        const { id, type, title, language, createdAt } = readVersion(sessionId, artifactId, latest);
        out.push({ id, type, title, language, version: latest, versions, updatedAt: createdAt });
      } catch (err) {
        out.push({ id: artifactId, version: latest, versions, error: err instanceof ArtifactError ? err.code : String(err) });
      }
    }
    return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  return {
    create,
    update,
    get,
    list,
    on: (event, fn) => { events.on(event, fn); return () => events.removeListener(event, fn); },
  };
}

let defaultStore = null;

// Process-wide store under {userData}/sessions, shared by the artifact tools
// and the IPC handlers so a tool write reaches the 'upserted' subscribers.
function getDefaultArtifactStore() {
  if (!defaultStore) {
    const { app } = require('electron');
    defaultStore = createArtifactStore({ baseDir: path.join(app.getPath('userData'), 'sessions') });
  }
  return defaultStore;
}

module.exports = {
  createArtifactStore,
  getDefaultArtifactStore,
  ArtifactError,
  ARTIFACT_TYPES,
  MAX_CONTENT_BYTES,
  MAX_TITLE_CHARS,
  SESSION_ID_RX,
  ARTIFACT_ID_RX,
};
