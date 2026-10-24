// Shared by the fetch-*-runtime build scripts: installs a pinned
// python-build-standalone interpreter into a vendor directory (cached by a
// marker file) and downloads release files, optionally sha256-verified.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { errMsg } = require('../../shared/errMsg');

const PYTHON_STANDALONE_TAG = '20240415';
const PYTHON_VERSION = '3.11.9';
const PYTHON_MARKER = `${PYTHON_VERSION}+${PYTHON_STANDALONE_TAG}`;

/** @returns {string|null} the interpreter tarball URL, or null off darwin-arm64 */
function standaloneUrl(platform, arch) {
  if (platform !== 'darwin' || arch !== 'arm64') return null;
  const name = `cpython-${PYTHON_VERSION}+${PYTHON_STANDALONE_TAG}-aarch64-apple-darwin-install_only.tar.gz`;
  return `https://github.com/indygreg/python-build-standalone/releases/download/${PYTHON_STANDALONE_TAG}/${name}`;
}

function removeQuietly(p) {
  try { fs.rmSync(p, { force: true }); } catch (err) { process.stderr.write(`could not remove ${p}: ${errMsg(err)}\n`); }
}

/** Follows redirects; a non-200 final answer rejects and leaves no file. */
function download(url, dest, userAgent = 'instant-cognition-fetch-runtime') {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': userAgent } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        removeQuietly(dest);
        download(res.headers.location, dest, userAgent).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        removeQuietly(dest);
        reject(new Error(`GET ${url} -> ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      removeQuietly(dest);
      reject(err);
    });
  });
}

/** @param {string} file @returns {string} hex sha256 */
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Download, then reject (and delete the file) unless it hashes to `sha256`. */
async function downloadVerified(url, dest, sha256, userAgent) {
  await download(url, dest, userAgent);
  const actual = sha256File(dest);
  if (actual !== sha256.toLowerCase()) {
    removeQuietly(dest);
    throw new Error(`Checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
  }
}

function copyDirContents(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const stack = [['', srcDir]];
  while (stack.length) {
    const [rel, dir] = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '__pycache__') continue;
      const srcPath = path.join(dir, ent.name);
      const relPath = path.join(rel, ent.name);
      const destPath = path.join(destDir, relPath);
      if (ent.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
      } else if (ent.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        stack.push([relPath, srcPath]);
      } else {
        fs.copyFileSync(srcPath, destPath);
        fs.chmodSync(destPath, fs.statSync(srcPath).mode);
      }
    }
  }
}

/**
 * Make sure destDir holds the pinned interpreter. Skips the download when the
 * marker file already names this interpreter build (unless `force`);
 * otherwise empties destDir (keeping .gitkeep) and installs it fresh.
 * @param {{destDir: string, markerPath: string, platform: string, arch: string,
 *   force?: boolean, log: (m: string) => void, warn: (m: string) => void}} opts
 * @returns {Promise<string|null>} bin/python3, or null when the target has no build
 */
async function ensurePython({ destDir, markerPath, platform, arch, force = false, log, warn }) {
  const url = standaloneUrl(platform, arch);
  if (!url) return null;
  const pythonBin = path.join(destDir, 'bin', 'python3');
  const existingMarker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';
  if (!force && fs.existsSync(pythonBin) && existingMarker.startsWith(PYTHON_MARKER)) {
    log(`Python ${PYTHON_VERSION} already installed; skipping download.`);
    return pythonBin;
  }

  if (fs.existsSync(destDir)) {
    log(`Cleaning stale contents at ${destDir}`);
    for (const entry of fs.readdirSync(destDir)) {
      if (entry === '.gitkeep') continue;
      fs.rmSync(path.join(destDir, entry), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(destDir, { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-python-fetch-'));
  try {
    const tarPath = path.join(tmpDir, 'python.tar.gz');
    log(`Downloading Python ${PYTHON_VERSION} standalone…`);
    log(`  ${url}`);
    await download(url, tarPath);
    log('Extracting…');
    const extractDir = path.join(tmpDir, 'ext');
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', tarPath, '-C', extractDir], { stdio: 'inherit' });
    const pythonRoot = path.join(extractDir, 'python');
    if (!fs.existsSync(pythonRoot)) throw new Error(`Expected ${pythonRoot} inside the Python tarball.`);
    log(`Copying interpreter into ${destDir}`);
    copyDirContents(pythonRoot, destDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (!fs.existsSync(pythonBin)) throw new Error(`Missing ${pythonBin} after copying the interpreter.`);

  log('Upgrading pip…');
  try {
    execFileSync(pythonBin, ['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', 'pip'], { stdio: 'inherit' });
  } catch (err) {
    warn(`pip self-upgrade failed, continuing with the bundled pip: ${errMsg(err)}`);
  }
  return pythonBin;
}

/** @returns {string} `pip show` version of pkg, or 'missing' */
function pipShowVersion(pythonBin, pkg) {
  let out;
  try {
    out = execFileSync(pythonBin, ['-m', 'pip', 'show', pkg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) {
    return 'missing';
  }
  const m = out.match(/^Version:\s*(\S+)/m);
  return m ? m[1] : 'unknown';
}

module.exports = {
  PYTHON_MARKER, PYTHON_VERSION,
  standaloneUrl, download, downloadVerified, sha256File, copyDirContents, ensurePython, pipShowVersion,
};
