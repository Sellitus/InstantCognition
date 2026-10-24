// omlxDiscovery — finds an oMLX server runtime and reports its version.
//
// The engine is addressed by its interpreter (settings.llm.omlx.pythonPath),
// which runs `-I -m omlx.cli`; the `omlx` script pip puts beside it marks an
// install. Search order: the managed venv (where updates land), the runtime
// bundled with the app, then an `omlx` on PATH (pip/pipx installs), resolved
// through symlinks to the venv that owns it.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { managedOmlxPython } = require('./enginePaths');

// `omlx --version` imports the package before argparse answers; a cold first
// import after boot takes several seconds.
const OMLX_VERSION_TIMEOUT_MS = 20000;

function isFile(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch (_) { return false; }
}

function bundledOmlxPythonCandidates() {
  const rel = ['bin', 'python3'];
  const archDir = `${process.platform}-${process.arch}`;
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'omlx-python', ...rel));                         // electron-builder
    candidates.push(path.join(process.resourcesPath, 'app', 'vendor', 'omlx-python', archDir, ...rel)); // electron-packager
  }
  candidates.push(path.join(__dirname, '..', '..', '..', 'vendor', 'omlx-python', archDir, ...rel));   // dev
  return candidates;
}

/** @returns {string|null} the interpreter owning an `omlx` found on PATH */
function pathOmlxPython() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const cli = path.join(dir, 'omlx');
    if (!isFile(cli)) continue;
    let real;
    try { real = fs.realpathSync(cli); } catch (_) { continue; }
    const py = path.join(path.dirname(real), 'python3');
    if (isFile(py)) return py;
  }
  return null;
}

/** @returns {string[]} interpreters in discovery order, existing ones only */
function omlxPythonCandidates() {
  const found = [managedOmlxPython(), ...bundledOmlxPythonCandidates().filter(isFile), pathOmlxPython()];
  return found.filter((p, i) => p && found.indexOf(p) === i);
}

function omlxCli(pythonPath) {
  return path.join(path.dirname(pythonPath), 'omlx');
}

function readVersion(pythonPath) {
  return new Promise((resolve) => {
    execFile(pythonPath, ['-I', '-m', 'omlx.cli', '--version'], { timeout: OMLX_VERSION_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        const killed = error.killed || error.signal === 'SIGTERM';
        const detail = String(stderr || '').trim().split('\n').pop();
        resolve({ error: killed ? `omlx --version timed out after ${OMLX_VERSION_TIMEOUT_MS}ms` : (detail || error.message) });
        return;
      }
      const m = String(stdout).trim().match(/\d+\.\d+\.\d+\S*/);
      resolve(m ? { version: m[0] } : { error: `unrecognised omlx --version output: ${String(stdout).trim().slice(0, 80)}` });
    });
  });
}

/**
 * @returns {Promise<{available: boolean, pythonPath?: string|null, version?: string, reason?: string}>}
 */
async function detectOmlx() {
  if (process.platform !== 'darwin') return { available: false, pythonPath: null, reason: 'macOS only' };
  if (process.arch !== 'arm64') return { available: false, pythonPath: null, reason: 'Apple Silicon required' };
  const candidates = omlxPythonCandidates().filter((py) => isFile(omlxCli(py)));
  if (!candidates.length) return { available: false, pythonPath: null, reason: 'oMLX not installed' };
  const pythonPath = candidates[0];
  const r = await readVersion(pythonPath);
  if (r.error) return { available: false, pythonPath, reason: `oMLX at ${pythonPath} did not run: ${r.error}` };
  return { available: true, pythonPath, version: r.version };
}

/** True when `p` is an interpreter discovery itself would return. */
function isDiscoveredOmlxPath(p) {
  if (!p) return false;
  const target = path.resolve(p);
  return [managedOmlxPython(), ...bundledOmlxPythonCandidates(), pathOmlxPython()]
    .some((c) => c && path.resolve(c) === target);
}

module.exports = { detectOmlx, isDiscoveredOmlxPath, bundledOmlxPythonCandidates, OMLX_VERSION_TIMEOUT_MS };
