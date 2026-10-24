// vllmSetup — takes a machine with an NVIDIA GPU to a running vLLM install.
//
// Every step is idempotent and setup re-detects before each one, so nothing is
// stored between runs: after the Windows restart that finishes the WSL
// install, running setup again carries on from wherever detection says it is.
//   win32: enable WSL (one administrator prompt, then a restart) → import the
//          app's Ubuntu distro → apt-get the Python build packages → create
//          the venv → pip install vllm → check CUDA from inside the venv
//   linux: create the venv from the system python3 → pip install → check CUDA
// Linux prerequisites need sudo, which the app never runs silently, so a
// missing one stops setup with the exact apt command (vllmDiscovery).
//
// EXECUTION-TRUTH: PARTIAL — step order and failure handling are unit-tested;
// the real WSL, apt and pip runs need a Windows or Linux NVIDIA host.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { errMsg } = require('../../../shared/errMsg');
const { VLLM_PACKAGE } = require('../../../shared/engineRelease');
const fetcher = require('./engineFetch');
const enginePaths = require('./enginePaths');
const wsl = require('./wsl');
const { detectVllm } = require('./vllmDiscovery');

const UBUNTU_DIR = 'https://releases.ubuntu.com/24.04.5';
const UBUNTU_FILE = 'ubuntu-24.04.5-wsl-amd64.wsl';
// The Ubuntu WSL image has python3 but none of what a venv and Triton's
// kernel builds need.
const APT_PACKAGES = ['python3.12-venv', 'python3-pip', 'python3.12-dev', 'build-essential'];
const PIP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const CUDA_PROBE = 'import json, torch; print(json.dumps({"cuda": torch.cuda.is_available(), "torch": torch.__version__}))';

let running = null;

/**
 * @param {string} text a SHA256SUMS file
 * @param {string} fileName
 * @returns {string|null} the hex digest listed for fileName
 */
function parseSha256Sums(text, fileName) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim() === fileName) return m[1].toLowerCase();
  }
  return null;
}

/** Run a command with the vLLM interpreter, natively or inside the distro. */
function runPython(python, args, opts) {
  return process.platform === 'win32'
    ? wsl.execInDistro([python, ...args], opts)
    : fetcher.run(python, args, opts);
}

async function enableWsl() {
  // Self-elevating: Windows shows the administrator prompt. It exits 0 both on
  // success and when a restart is still needed; declining the prompt fails it.
  try {
    await fetcher.run('wsl.exe', ['--install', '--no-distribution'], { timeoutMs: 1800000, env: wsl.WSL_ENV() });
  } catch (err) {
    throw new Error(`Installing the Windows Subsystem for Linux did not finish (was the administrator prompt declined?): ${errMsg(err)}`);
  }
}

/** @param {(payload: object) => void} send */
async function importDistro(send) {
  if (process.arch !== 'x64') throw new Error('vLLM on Windows needs an x64 PC.');
  const dir = enginePaths.managedWslDir();
  if (!dir) throw new Error('No writable engines directory is available.');
  const digest = parseSha256Sums(await fetcher.fetchText(`${UBUNTU_DIR}/SHA256SUMS`), UBUNTU_FILE);
  if (!digest) throw new Error(`Ubuntu's checksum list has no entry for ${UBUNTU_FILE}.`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-wsl-'));
  try {
    const image = path.join(tmpDir, UBUNTU_FILE);
    await fetcher.downloadVerified(`${UBUNTU_DIR}/${UBUNTU_FILE}`, image, {
      digest,
      onProgress: (percent) => send({ step: 'Downloading Ubuntu', percent }),
    });
    send({ step: 'Creating the Linux environment' });
    fs.mkdirSync(dir, { recursive: true });
    await wsl.runWsl(['--import', wsl.DISTRO, dir, image, '--version', '2'], { timeoutMs: 900000 });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) { console.warn('[vllm-setup] temp cleanup failed:', errMsg(err)); }
  }
}

/** @param {(payload: object) => void} send @returns {Promise<string>} the venv interpreter */
async function ensureVenv(send) {
  if (process.platform === 'win32') {
    const probe = `import os; print(os.access(${JSON.stringify(wsl.VENV_PYTHON)}, os.X_OK))`;
    const { stdout } = await wsl.execInDistro(['/usr/bin/python3', '-c', probe], { timeoutMs: 60000 });
    if (wsl.cleanOutput(stdout).trim() === 'True') return wsl.VENV_PYTHON;
    const apt = (args, timeoutMs) => wsl.execInDistro(['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', ...args], { timeoutMs });
    send({ step: 'Installing Python build tools' });
    await apt(['update'], 900000);
    await apt(['install', '-y', '--no-install-recommends', ...APT_PACKAGES], 1800000);
    send({ step: 'Creating the Python environment' });
    await wsl.execInDistro(['/usr/bin/python3', '-m', 'venv', wsl.VENV_DIR], { timeoutMs: 300000 });
    return wsl.VENV_PYTHON;
  }
  const existing = enginePaths.managedVllmPython();
  if (existing) return existing;
  const venv = enginePaths.managedVllmVenv();
  if (!venv) throw new Error('No writable engines directory is available.');
  send({ step: 'Creating the Python environment' });
  await fetcher.run('python3', ['-m', 'venv', venv], { timeoutMs: 300000 });
  return enginePaths.venvPython(venv);
}

/** @param {string} python @param {(payload: object) => void} send */
async function installPackage(python, send) {
  // About 6 GB with PyTorch and CUDA; caching it would double the disk use.
  send({ step: 'Installing vLLM (several GB, this takes a while)' });
  await runPython(python, ['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', VLLM_PACKAGE], { timeoutMs: PIP_TIMEOUT_MS });
}

/** @param {string} python */
async function verifyCuda(python) {
  const { stdout } = await runPython(python, ['-c', CUDA_PROBE], { timeoutMs: 300000 });
  let out;
  try { out = JSON.parse(wsl.cleanOutput(stdout).trim().split(/\r?\n/).pop() || ''); } catch (_) {
    throw new Error(`Unexpected CUDA check output: ${wsl.cleanOutput(stdout).trim().slice(0, 120)}`);
  }
  if (!out.cuda) {
    throw new Error(`vLLM is installed, but PyTorch ${out.torch} cannot reach the GPU. Update the NVIDIA driver to 580 or newer and retry.`);
  }
}

/**
 * @param {{upgrade?: boolean, send?: (payload: object) => void}} [opts] `upgrade`
 *   reinstalls vLLM at its newest release even when it already runs
 * @returns {Promise<{state: string, version?: string, reason?: string}>} 'ready', or
 *   'reboot-required' when Windows must restart before setup can go on
 */
async function setup({ upgrade = false, send = () => {} } = {}) {
  const attempted = new Set();
  for (;;) {
    const det = await detectVllm();
    const state = det.setupState;
    if (state === 'ready') {
      if (upgrade) {
        upgrade = false;
        await installPackage(/** @type {string} */ (det.pythonPath), send);
        continue;
      }
      send({ step: 'Checking the GPU' });
      await verifyCuda(/** @type {string} */ (det.pythonPath));
      return { state, version: det.version };
    }
    if (state === 'reboot-required') return { state, reason: det.reason };
    // A step that leaves detection where it was would otherwise loop forever.
    if (attempted.has(state)) throw new Error(`vLLM setup is stuck: ${det.reason || state}`);
    attempted.add(state);
    if (state === 'wsl-missing') {
      send({ step: 'Installing the Windows Subsystem for Linux' });
      await enableWsl();
    } else if (state === 'distro-missing') {
      await importDistro(send);
    } else if (state === 'not-installed') {
      upgrade = false;
      await installPackage(await ensureVenv(send), send);
    } else {
      throw new Error(det.reason || `vLLM cannot be set up on this machine (${state}).`);
    }
  }
}

/** One setup at a time: a second caller joins the run in progress. */
function runSetup(opts) {
  if (!running) running = setup(opts).finally(() => { running = null; });
  return running;
}

function restartWindows() {
  if (process.platform !== 'win32') throw new Error('Only Windows needs a restart for vLLM setup.');
  return fetcher.run('shutdown.exe', ['/r', '/t', '10', '/c', 'Restarting to finish installing WSL for vLLM.'], { timeoutMs: 30000 });
}

module.exports = { runSetup, restartWindows, parseSha256Sums, APT_PACKAGES, UBUNTU_FILE };
