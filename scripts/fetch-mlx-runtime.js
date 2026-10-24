#!/usr/bin/env node
// fetch-mlx-runtime.js
//
// Downloads a standalone Python build (python-build-standalone) and pip-installs
// mlx + mlx-lm into vendor/mlx-python/<platform>-<arch>/ so electron-builder can
// bundle it via mac.extraResources. MLX is Apple-Silicon-only — this script
// only does real work for darwin-arm64; other targets get a no-op.
//
// Usage:
//   node scripts/fetch-mlx-runtime.js                                   # host
//   MLX_PLATFORM=darwin MLX_ARCH=arm64 node scripts/fetch-mlx-runtime.js
//   FORCE=1 node scripts/fetch-mlx-runtime.js                           # re-install
//
// On failure (offline, pip error, unsupported target), exits 0 with a warning.
// The runtime falls back to system python when the bundled dir is empty.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { errMsg } = require('../shared/errMsg');
const { PYTHON_MARKER, ensurePython, pipShowVersion } = require('./lib/pythonRuntime');

const ROOT = path.join(__dirname, '..');
const targetPlatform = process.env.MLX_PLATFORM || process.platform;
const targetArch = process.env.MLX_ARCH || process.arch;
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const DEST_DIR = path.join(ROOT, 'vendor', 'mlx-python', `${targetPlatform}-${targetArch}`);

// mlx-lm and mlx-openai-server are installed with --upgrade on every build so
// the latest releases are always bundled. Override with MLX_LM_SPEC / MLX_OAI_SPEC
// to pin explicitly (e.g. MLX_LM_SPEC=mlx-lm==0.31.2).
const MLX_LM_SPEC = process.env.MLX_LM_SPEC || 'mlx-lm';
const MLX_OAI_SPEC = process.env.MLX_OAI_SPEC || 'mlx-openai-server';

function log(msg) { process.stdout.write(`[fetch-mlx-runtime] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[fetch-mlx-runtime] WARN: ${msg}\n`); }

async function main() {
  log(`Target: ${targetPlatform}-${targetArch}`);
  log(`Destination: ${DEST_DIR}`);

  // Phase A: the pinned interpreter, cached via the marker (~30MB download).
  // FORCE=1 reinstalls everything.
  const markerPath = path.join(DEST_DIR, '.mlx-runtime-version');
  const pythonBin = await ensurePython({ destDir: DEST_DIR, markerPath, platform: targetPlatform, arch: targetArch, force: FORCE, log, warn });
  if (!pythonBin) {
    log(`MLX bundling is Apple Silicon (darwin-arm64) only; skipping ${targetPlatform}-${targetArch}.`);
    return;
  }

  // Phase B: always install/upgrade mlx-lm and mlx-openai-server on every run
  // so each build picks up upstream fixes. mlx-openai-server serves the models
  // (subprocess-per-model, avoids Metal/threading bugs) on top of mlx-lm.
  // oMLX ships in its own runtime (fetch-omlx-runtime.js).
  log(`Installing/upgrading ${MLX_LM_SPEC} and ${MLX_OAI_SPEC} via pip…`);
  try {
    execFileSync(pythonBin, ['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', MLX_LM_SPEC, MLX_OAI_SPEC], { stdio: 'inherit' });
  } catch (err) {
    warn(`pip install failed: ${errMsg(err)}`);
    warn('Build will fall back to system python detection.');
    return;
  }

  // Record resolved versions in the marker for visibility.
  const versionTag = ['mlx-lm', 'mlx-openai-server'].map((pkg) => `${pkg}==${pipShowVersion(pythonBin, pkg)}`).join(' ');
  fs.writeFileSync(markerPath, `${PYTHON_MARKER} ${versionTag}`);
  log(`Installed ${versionTag}`);
  log('Done.');
}

main().catch((err) => {
  warn(err && err.message ? err.message : String(err));
  warn('Build will fall back to system python detection.');
  process.exit(0);
});
