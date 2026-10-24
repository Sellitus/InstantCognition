#!/usr/bin/env node
// fetch-omlx-runtime.js
//
// Installs a standalone Python build plus the pinned oMLX release wheel into
// vendor/omlx-python/<platform>-<arch>/ so electron-builder can bundle it via
// mac.extraResources. oMLX gets its own interpreter because it pins mlx to an
// exact version that conflicts with the mlx-openai-server runtime. Apple
// Silicon only; other targets are a no-op.
//
// Usage:
//   node scripts/fetch-omlx-runtime.js                                    # host
//   OMLX_PLATFORM=darwin OMLX_ARCH=arm64 node scripts/fetch-omlx-runtime.js
//   FORCE=1 node scripts/fetch-omlx-runtime.js                            # re-install
//
// On failure (offline, no git, pip error), exits 0 with a warning: the app then
// reports oMLX as not installed and Settings → LLM offers to install it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { errMsg } = require('../shared/errMsg');
const { PYTHON_MARKER, ensurePython, downloadVerified, pipShowVersion } = require('./lib/pythonRuntime');

const ROOT = path.join(__dirname, '..');
const targetPlatform = process.env.OMLX_PLATFORM || process.platform;
const targetArch = process.env.OMLX_ARCH || process.arch;
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const DEST_DIR = path.join(ROOT, 'vendor', 'omlx-python', `${targetPlatform}-${targetArch}`);

// Pinned to a stable release; the in-app updater moves installs forward from
// here. The wheel matches the bundled CPython 3.11 interpreter.
const OMLX_VERSION = '0.7.0';
const OMLX_WHEEL = `omlx-${OMLX_VERSION}-cp311-cp311-macosx_15_0_universal2.whl`;
const OMLX_WHEEL_URL = `https://github.com/jundot/omlx/releases/download/v${OMLX_VERSION}/${OMLX_WHEEL}`;
const OMLX_WHEEL_SHA256 = 'a25b0fbf86579512ced2a45b9aba420a51e6e8f3ee9ea3832ea1b9111d2cc4a7';

function log(msg) { process.stdout.write(`[fetch-omlx-runtime] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[fetch-omlx-runtime] WARN: ${msg}\n`); }

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  log(`Target: ${targetPlatform}-${targetArch}`);
  log(`Destination: ${DEST_DIR}`);

  const markerPath = path.join(DEST_DIR, '.omlx-runtime-version');
  const wantMarker = `${PYTHON_MARKER} omlx==${OMLX_VERSION}`;
  const cli = path.join(DEST_DIR, 'bin', 'omlx');
  if (!FORCE && fs.existsSync(cli) && fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8').trim() === wantMarker) {
    log(`oMLX ${OMLX_VERSION} already installed; nothing to do.`);
    return;
  }

  const pythonBin = await ensurePython({ destDir: DEST_DIR, markerPath, platform: targetPlatform, arch: targetArch, force: FORCE, log, warn });
  if (!pythonBin) {
    log(`oMLX bundling is Apple Silicon (darwin-arm64) only; skipping ${targetPlatform}-${targetArch}.`);
    return;
  }
  // Written before pip so an interrupted install keeps the interpreter cached.
  fs.writeFileSync(markerPath, PYTHON_MARKER);

  // oMLX pins its mlx-lm / mlx-vlm dependencies to git commits.
  if (!hasGit()) {
    warn('git is not available, and oMLX installs its dependencies from git. Install the Xcode Command Line Tools (xcode-select --install) and re-run.');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-omlx-fetch-'));
  try {
    // pip reads the version and platform tags from the wheel's file name.
    const wheel = path.join(tmpDir, OMLX_WHEEL);
    log(`Downloading ${OMLX_WHEEL}…`);
    await downloadVerified(OMLX_WHEEL_URL, wheel, OMLX_WHEEL_SHA256, 'instant-cognition-fetch-omlx-runtime');
    log('Installing oMLX and its dependencies via pip…');
    execFileSync(pythonBin, ['-m', 'pip', 'install', '--no-cache-dir', wheel], { stdio: 'inherit' });
  } catch (err) {
    warn(`oMLX install failed: ${errMsg(err)}`);
    return;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const installed = pipShowVersion(pythonBin, 'omlx');
  if (installed !== OMLX_VERSION || !fs.existsSync(cli)) {
    warn(`pip finished but oMLX ${OMLX_VERSION} is not runnable (pip reports ${installed}).`);
    return;
  }
  const version = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 60000 }).trim();
  fs.writeFileSync(markerPath, wantMarker);
  log(`Installed ${version}`);
  log('Done.');
}

main().catch((err) => {
  warn(errMsg(err));
  warn('The app will report oMLX as not installed.');
  process.exit(0);
});
