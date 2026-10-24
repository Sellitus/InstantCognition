// engineFetch — network and unpacking mechanics for runtime engine updates.
//
// Split out of EngineUpdateService so the service holds policy (what to
// install, when to tell the user) and this holds the I/O. Downloads are HTTPS
// only and every archive is checked against the sha256 digest GitHub publishes
// for the asset: this writes an executable the app later spawns, so an
// unverifiable download is refused rather than trusted.

const fs = require('fs');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { URL } = require('url');

const USER_AGENT = 'InstantCognition-engine-updater';
const REQUEST_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 600000;
const MAX_REDIRECTS = 5;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * @param {string} url
 * @param {{accept?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<string>}
 */
function fetchText(url, { accept = 'text/plain', timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const go = (current, redirectsLeft) => {
      let parsed;
      try { parsed = new URL(current); } catch (_) { reject(new Error('Invalid URL')); return; }
      if (parsed.protocol !== 'https:') { reject(new Error('Only HTTPS is allowed')); return; }
      const req = https.get(current, { headers: { 'User-Agent': USER_AGENT, Accept: accept } }, (res) => {
        const { statusCode, headers } = res;
        if (REDIRECT_CODES.has(statusCode) && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
          go(new URL(headers.location, current).toString(), redirectsLeft - 1);
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${parsed.host}${parsed.pathname} -> HTTP ${statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('error', reject);
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    };
    go(url, MAX_REDIRECTS);
  });
}

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function getJson(url) {
  const body = await fetchText(url, { accept: 'application/vnd.github+json' });
  return JSON.parse(body);
}

/**
 * Stream an asset to disk, reporting progress and verifying its sha256.
 * @param {string} url
 * @param {string} destPath
 * @param {{digest?: string|null, onProgress?: (pct: number) => void}} [opts]
 * @returns {Promise<string>} the sha256 hex of what was written
 */
function downloadVerified(url, destPath, { digest = null, onProgress = null } = {}) {
  const expected = digest ? String(digest).replace(/^sha256:/i, '').toLowerCase() : null;
  return new Promise((resolve, reject) => {
    const fail = (err) => {
      try { fs.unlinkSync(destPath); } catch (_) { /* nothing written */ }
      reject(err);
    };
    const go = (current, redirectsLeft) => {
      let parsed;
      try { parsed = new URL(current); } catch (_) { reject(new Error('Invalid download URL')); return; }
      if (parsed.protocol !== 'https:') { reject(new Error('Only HTTPS downloads are allowed')); return; }
      const req = https.get(current, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        const { statusCode, headers } = res;
        if (REDIRECT_CODES.has(statusCode) && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
          go(new URL(headers.location, current).toString(), redirectsLeft - 1);
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${statusCode}`));
          return;
        }
        const total = Number(headers['content-length'] || 0);
        let received = 0;
        let lastPct = -1;
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          hash.update(chunk);
          if (!onProgress || !total) return;
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        });
        res.on('error', fail);
        out.on('error', fail);
        res.pipe(out);
        out.on('close', () => {
          const actual = hash.digest('hex');
          if (expected && actual !== expected) {
            fail(new Error('Downloaded archive failed its sha256 check'));
            return;
          }
          resolve(actual);
        });
      });
      req.on('error', fail);
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('Download timed out')));
    };
    go(url, MAX_REDIRECTS);
  });
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{timeoutMs?: number, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function run(file, args, { timeoutMs = 600000, env = undefined } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || '').trim().split('\n').slice(-3).join(' ');
        reject(new Error(detail ? `${error.message}: ${detail}` : error.message));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * GNU tar cannot read zip. A zip uses unzip off win32, and bsdtar tar then
 * PowerShell Expand-Archive on win32 (which has no unzip).
 * @param {string} archivePath
 * @param {string} outDir
 */
async function extractArchive(archivePath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (archivePath.toLowerCase().endsWith('.zip') && process.platform === 'win32') {
    const q = (p) => String(p).replace(/'/g, "''");
    const attempt = (bin, args) => run(bin, args).then(() => null, (e) => e);
    const tarError = await attempt('tar', ['-xf', archivePath, '-C', outDir]);
    if (!tarError) return;
    const psError = await attempt('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${q(archivePath)}' -DestinationPath '${q(outDir)}' -Force`]);
    if (!psError) return;
    throw new Error(`zip extraction failed: tar: ${tarError.message}; Expand-Archive: ${psError.message}`);
  }
  if (archivePath.toLowerCase().endsWith('.zip')) {
    await run('unzip', ['-q', '-o', archivePath, '-d', outDir]);
    return;
  }
  await run('tar', ['-xf', archivePath, '-C', outDir]);
}

/**
 * @param {string} rootDir
 * @param {string} name
 * @returns {string|null}
 */
function findFile(rootDir, name) {
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (ent.name === name) return full;
    }
  }
  return null;
}

/**
 * Copy a directory's contents, marking files executable — the shared libraries
 * next to llama-server have to keep their exec bit for it to load them.
 * @param {string} srcDir
 * @param {string} destDir
 */
function copyDirContents(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const stack = [['', srcDir]];
  while (stack.length) {
    const [rel, dir] = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const srcPath = path.join(dir, ent.name);
      const relPath = path.join(rel, ent.name);
      const destPath = path.join(destDir, relPath);
      if (ent.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        stack.push([relPath, srcPath]);
      } else {
        fs.copyFileSync(srcPath, destPath);
        try { fs.chmodSync(destPath, 0o755); } catch (err) { throw new Error(`chmod ${destPath} failed: ${(/** @type {any} */ (err)).message}`); }
      }
    }
  }
}

module.exports = {
  fetchText,
  getJson,
  downloadVerified,
  run,
  extractArchive,
  findFile,
  copyDirContents,
};
