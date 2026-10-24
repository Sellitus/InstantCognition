// enginePaths — where user-updated inference runtimes live.
//
// Updated engines are installed under userData, never into the app bundle:
// writing inside the bundle invalidates the macOS code signature, and
// electron-updater replaces the whole bundle on the next app update, which
// would silently wipe anything added to it. Discovery searches these paths
// first, so a managed install shadows the bundled one and the bundled copy
// stays the always-working floor.

const fs = require('fs');
const path = require('path');
const { parseBuildNumber } = require('../../../shared/engineRelease');

/** @returns {string|null} the engines root, or null outside an Electron process */
function managedRoot() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const userData = app.getPath('userData');
      if (userData) return path.join(userData, 'engines');
    }
  } catch (_) { /* build scripts and unit tests run outside Electron */ }
  return null;
}

/** @returns {string|null} */
function managedLlamaRoot() {
  const root = managedRoot();
  return root ? path.join(root, 'llama-server') : null;
}

/**
 * Installed llama.cpp builds, newest first. Each install is its own `b<build>`
 * directory, so an install never overwrites the binary a running server holds
 * open — the Windows failure mode.
 * @returns {string[]}
 */
function managedLlamaDirs() {
  const root = managedLlamaRoot();
  if (!root) return [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  return entries
    .filter((e) => e.isDirectory() && /^b\d{3,}$/.test(e.name))
    .map((e) => ({ dir: path.join(root, e.name), build: parseBuildNumber(e.name) || 0 }))
    .sort((a, b) => b.build - a.build)
    .map((e) => e.dir);
}

/** @returns {string|null} */
function managedMlxVenv() {
  const root = managedRoot();
  return root ? path.join(root, 'mlx-venv') : null;
}

/** @param {string} venvDir */
function venvPython(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python3');
}

/** @param {string|null} venv @returns {string|null} the venv's interpreter, if it exists */
function existingVenvPython(venv) {
  if (!venv) return null;
  const py = venvPython(venv);
  try { return fs.existsSync(py) && fs.statSync(py).isFile() ? py : null; } catch (_) { return null; }
}

/** @returns {string|null} the managed MLX interpreter, if one is installed */
function managedMlxPython() {
  return existingVenvPython(managedMlxVenv());
}

// oMLX pins its own mlx build, which conflicts with mlx-openai-server's, so it
// gets a venv of its own rather than sharing mlx-venv.
/** @returns {string|null} */
function managedOmlxVenv() {
  const root = managedRoot();
  return root ? path.join(root, 'omlx-venv') : null;
}

/** @returns {string|null} the managed oMLX interpreter, if one is installed */
function managedOmlxPython() {
  return existingVenvPython(managedOmlxVenv());
}

// oMLX keeps its settings and caches under --base-path; a private one keeps the
// app's server from reading or rewriting a DMG/Homebrew install's ~/.omlx.
/** @returns {string|null} */
function managedOmlxHome() {
  const root = managedRoot();
  return root ? path.join(root, 'omlx-home') : null;
}

/** @returns {string|null} the native (Linux) vLLM venv */
function managedVllmVenv() {
  const root = managedRoot();
  return root ? path.join(root, 'vllm-venv') : null;
}

/** @returns {string|null} the managed native vLLM interpreter, if one is installed */
function managedVllmPython() {
  return existingVenvPython(managedVllmVenv());
}

/** @returns {string|null} where the app's dedicated WSL distro keeps its disk */
function managedWslDir() {
  const root = managedRoot();
  return root ? path.join(root, 'wsl') : null;
}

module.exports = {
  managedRoot, managedLlamaRoot, managedLlamaDirs, managedMlxVenv, venvPython, managedMlxPython,
  managedOmlxVenv, managedOmlxPython, managedOmlxHome, managedVllmVenv, managedVllmPython, managedWslDir,
};
