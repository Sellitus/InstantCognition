// projectUtils — pure helpers for ProjectService, shared with its IPC layer
// and tests. No I/O, no service state: everything here is a pure function so
// the service stays under its line budget and the helpers are exhaustively
// testable without mocks.

const MAX_TEXT_BYTES = 1024 * 1024;        // 1 MB
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // 8 MB per image
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'sql', 'ini',
  'toml', 'env', 'gitignore', 'tex', 'swift', 'kt', 'scala', 'vue', 'svelte',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function extOf(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

function truncate(s, max) {
  const t = String(s == null ? '' : s);
  return t.length > max ? t.slice(0, max) + '\n…[truncated]' : t;
}

function parseDataUrl(dataUrl) {
  const m = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const mime = m[1];
  const ext = mime.split('/')[1] ? mime.split('/')[1].split('+')[0] : 'png';
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); }
  catch (_) { return null; }
  return { mime, ext, buf, bytes: buf.length };
}

// Lexical score: how many query terms appear in the haystack (name + body +
// summary). Pure — the service supplies the haystack; this just ranks it.
function scoreMatch(terms, haystack) {
  const hay = String(haystack || '').toLowerCase();
  let score = 0;
  for (const t of terms) if (t && hay.includes(t)) score += 1;
  return score;
}

module.exports = {
  MAX_TEXT_BYTES, MAX_IMAGE_BYTES, TEXT_EXTS, IMAGE_EXTS,
  genId, extOf, truncate, parseDataUrl, scoreMatch,
};
