// skillInstall — fetch a SKILL.md from an https URL and parse it.
//
// The body is read into memory with a hard byte cap: a Content-Length over the
// cap is refused up front and a stream that grows past it is destroyed
// mid-flight, so a hostile server cannot make the app buffer more than the cap.
// Redirects are followed only to https. The fetched text is parsed as data;
// nothing in it is ever executed. GitHub "blob" page URLs are rewritten to
// raw.githubusercontent.com so a link copied from the browser works.

const https = require('https');
const { URL } = require('url');
const { parseSkill, MAX_SKILL_BYTES } = require('./skillFormat');

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/** @returns {{ ok: true, url: string } | { ok: false, error: string }} */
function normalizeInstallUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_URL_LENGTH) return { ok: false, error: 'invalid_url' };
  let u;
  try { u = new URL(raw.trim()); }
  catch (_err) { return { ok: false, error: 'invalid_url' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'https_only' };
  if (u.username || u.password) return { ok: false, error: 'credentials_in_url' };
  const blob = u.hostname === 'github.com' ? /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname) : null;
  if (blob) return { ok: true, url: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}` };
  return { ok: true, url: u.toString() };
}

/**
 * GET `url` as UTF-8 text, refusing anything larger than `maxBytes`.
 * @param {string} url
 * @param {{ get?: typeof https.get, maxBytes?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
function fetchCapped(url, opts = {}) {
  const get = opts.get || https.get;
  const maxBytes = opts.maxBytes || MAX_SKILL_BYTES;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const go = (current, redirectsLeft) => {
      const req = get(current, { headers: { Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5' } }, (res) => {
        const status = res.statusCode || 0;
        if (REDIRECT_CODES.has(status) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return finish(reject, new Error('too_many_redirects'));
          let next;
          try { next = new URL(res.headers.location, current); }
          catch (_err) { return finish(reject, new Error('invalid_redirect')); }
          if (next.protocol !== 'https:') return finish(reject, new Error('https_only'));
          return go(next.toString(), redirectsLeft - 1);
        }
        if (status < 200 || status >= 300) { res.resume(); return finish(reject, new Error(`http_${status}`)); }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); return finish(reject, new Error('too_large')); }
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            req.destroy();
            finish(reject, new Error('too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (err) => finish(reject, err));
        res.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', (err) => finish(reject, err));
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    };
    go(url, MAX_REDIRECTS);
  });
}

/**
 * Download and parse a skill. Writing it to disk is the caller's job.
 * @returns {Promise<{ ok: true, url: string, markdown: string, skill: any, warnings: string[] } | { ok: false, error: string }>}
 */
async function fetchSkillFromUrl(rawUrl, opts = {}) {
  const norm = normalizeInstallUrl(rawUrl);
  if (norm.ok === false) return norm;
  let markdown;
  try { markdown = await fetchCapped(norm.url, opts); }
  catch (err) { return { ok: false, error: (err instanceof Error && err.message) || String(err) }; }
  const parsed = parseSkill(markdown);
  if (parsed.ok === false) return { ok: false, error: parsed.error };
  return { ok: true, url: norm.url, markdown, skill: parsed.skill, warnings: parsed.warnings };
}

module.exports = { normalizeInstallUrl, fetchCapped, fetchSkillFromUrl, MAX_URL_LENGTH };
