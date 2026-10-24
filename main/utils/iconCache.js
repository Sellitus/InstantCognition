// iconCache.js — persists notification icon images to disk so they survive
// across restarts without bloating config.json. Preloads resolve remote/blob
// icons into small data URLs before IPC; this module decodes + hashes +
// writes them to `<userData>/notification-icons/<sha1>.<ext>` and returns the
// on-disk path for storage in the inbox record.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let _app = null;
function getApp() {
  if (_app) return _app;
  try { _app = require('electron').app; } catch (_) { _app = null; }
  return _app;
}

const MAX_BYTES = 256 * 1024;

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
};

function getCacheDir() {
  const app = getApp();
  if (!app || typeof app.getPath !== 'function') return null;
  const dir = path.join(app.getPath('userData'), 'notification-icons');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) { return null; }
  return dir;
}

function storeDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const isB64 = !!m[2];
  let raw;
  try {
    raw = isB64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  } catch (_) { return null; }
  if (!raw || raw.length === 0 || raw.length > MAX_BYTES) return null;
  const dir = getCacheDir();
  if (!dir) return null;
  const ext = EXT_BY_MIME[mime] || '.bin';
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const filename = hash + ext;
  const full = path.join(dir, filename);
  try {
    if (!fs.existsSync(full)) fs.writeFileSync(full, raw);
  } catch (_) { return null; }
  return full;
}

function collectActiveFiles(records) {
  const keep = new Set();
  for (const r of records || []) {
    if (r && typeof r.iconPath === 'string' && r.iconPath) {
      keep.add(path.basename(r.iconPath));
    }
  }
  return keep;
}

function gc(records) {
  const dir = getCacheDir();
  if (!dir) return;
  try {
    const keep = collectActiveFiles(records);
    for (const f of fs.readdirSync(dir)) {
      if (!keep.has(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ }
      }
    }
  } catch (_) { /* ignore */ }
}

function clearAll() {
  const dir = getCacheDir();
  if (!dir) return;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}

module.exports = { storeDataUrl, getCacheDir, gc, clearAll, MAX_BYTES };
