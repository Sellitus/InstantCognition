// vllmDiscovery — how far vLLM is from running on this machine.
//
// vLLM needs an NVIDIA GPU with driver R580+ (its PyTorch is a CUDA 13 build).
// On Linux it runs from the app's venv (enginePaths.managedVllmVenv); on
// Windows from the venv inside the app's WSL distro (wsl.js). Besides the usual
// {available, pythonPath, version, reason}, detection reports `setupState`,
// the next thing setup has to do:
//   linux: no-gpu | driver-old | no-python | not-installed | ready
//   win32: no-gpu | driver-old | wsl-missing | reboot-required | distro-missing | not-installed | ready
//
// EXECUTION-TRUTH: PARTIAL — parsing and state order are unit-tested; the
// nvidia-smi and WSL probes need an NVIDIA host.

const fetcher = require('./engineFetch');
const wsl = require('./wsl');
const { managedVllmPython } = require('./enginePaths');

const MIN_DRIVER_MAJOR = 580;
const PROBE_TIMEOUT_MS = 60000;
const LINUX_PACKAGES_HINT = 'sudo apt install python3-venv python3-dev build-essential';
// vLLM 0.31 wheels cover CPython 3.10–3.14.
const PY_MIN = [3, 10];
const PY_MAX = [3, 14];

const VERSION_PROBE = [
  'import json, sys',
  'from importlib.metadata import version, PackageNotFoundError',
  'try: v = version("vllm")',
  'except PackageNotFoundError: v = None',
  'json.dump({"version": v}, sys.stdout)',
].join('\n');

// Everything `python -m venv` and Triton's kernel build need from a system Python.
const PYTHON_PREREQ_PROBE = [
  'import json, os, sys, sysconfig',
  'mods = {}',
  'for m in ("venv", "ensurepip"):',
  '    try: __import__(m); mods[m] = True',
  '    except ImportError: mods[m] = False',
  'h = os.path.join(sysconfig.get_paths()["include"], "Python.h")',
  'json.dump({"version": list(sys.version_info[:2]), "venv": mods["venv"] and mods["ensurepip"], "headers": os.path.exists(h)}, sys.stdout)',
].join('\n');

/** @param {string} stdout `nvidia-smi --query-gpu=name,driver_version --format=csv,noheader` */
function parseNvidiaSmi(stdout) {
  return wsl.cleanOutput(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const i = line.lastIndexOf(',');
    return i < 0 ? { name: line, driver: '' } : { name: line.slice(0, i).trim(), driver: line.slice(i + 1).trim() };
  });
}

/**
 * Pure: the GPU verdict.
 * @param {{name: string, driver: string}[]} gpus
 * @returns {{state: 'no-gpu'|'driver-old'|'ok', reason?: string}}
 */
function gpuVerdict(gpus) {
  if (!gpus.length) {
    return { state: 'no-gpu', reason: 'No NVIDIA GPU was found (nvidia-smi did not answer). vLLM needs an NVIDIA GPU with its driver installed.' };
  }
  const major = parseInt(String(gpus[0].driver).split('.')[0], 10);
  if (!Number.isFinite(major) || major < MIN_DRIVER_MAJOR) {
    return { state: 'driver-old', reason: `vLLM needs NVIDIA driver ${MIN_DRIVER_MAJOR} or newer; this machine has ${gpus[0].driver || 'an unknown version'}. Update it from nvidia.com/drivers.` };
  }
  return { state: 'ok' };
}

/** @returns {Promise<{name: string, driver: string}[]>} */
async function detectGpus() {
  const bin = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi';
  try {
    const { stdout } = await fetcher.run(bin, ['--query-gpu=name,driver_version', '--format=csv,noheader'], { timeoutMs: 30000 });
    return parseNvidiaSmi(stdout);
  } catch (_) {
    // Absent or failing nvidia-smi is exactly the "no usable GPU" signal.
    return [];
  }
}

/** @param {string} stdout */
function parseVersionProbe(stdout) {
  let parsed;
  try { parsed = JSON.parse(wsl.cleanOutput(stdout).trim()); } catch (_) {
    throw new Error(`Unexpected vLLM probe output: ${wsl.cleanOutput(stdout).trim().slice(0, 120)}`);
  }
  return parsed && parsed.version ? String(parsed.version) : null;
}

/**
 * Pure: whether a system Python can host the vLLM venv.
 * @param {{version: number[], venv: boolean, headers: boolean}|null} probe
 * @param {boolean} hasCompiler
 * @returns {string|null} what is missing, or null when ready
 */
function linuxPrereqProblem(probe, hasCompiler) {
  if (!probe) return `Python 3 was not found. Install it with: sudo apt install python3 ${LINUX_PACKAGES_HINT.replace('sudo apt install ', '')}`;
  const [maj, min] = probe.version;
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
  if (cmp([maj, min], PY_MIN) < 0 || cmp([maj, min], PY_MAX) > 0) {
    return `vLLM needs Python ${PY_MIN.join('.')}–${PY_MAX.join('.')}; python3 here is ${maj}.${min}.`;
  }
  if (!probe.venv || !probe.headers || !hasCompiler) {
    return `vLLM needs Python's venv module, its headers and a C compiler. Install them with: ${LINUX_PACKAGES_HINT}`;
  }
  return null;
}

/** @returns {Promise<{python: string|null, problem: string|null}>} */
async function linuxPrereqs() {
  let probe = null;
  try {
    const { stdout } = await fetcher.run('python3', ['-c', PYTHON_PREREQ_PROBE], { timeoutMs: PROBE_TIMEOUT_MS });
    probe = JSON.parse(stdout.trim());
  } catch (_) {
    probe = null; // python3 missing or unusable: reported as missing below
  }
  let hasCompiler = true;
  try { await fetcher.run('gcc', ['--version'], { timeoutMs: 15000 }); } catch (_) { hasCompiler = false; }
  const problem = linuxPrereqProblem(probe, hasCompiler);
  return { python: probe ? 'python3' : null, problem };
}

async function detectLinux(gpu) {
  const python = managedVllmPython();
  if (python) {
    const { stdout } = await fetcher.run(python, ['-c', VERSION_PROBE], { timeoutMs: PROBE_TIMEOUT_MS });
    const version = parseVersionProbe(stdout);
    if (version) return { available: true, pythonPath: python, version, setupState: 'ready', gpu };
    return { available: false, pythonPath: null, setupState: 'not-installed', reason: 'vLLM is not installed yet.', gpu };
  }
  const { problem } = await linuxPrereqs();
  if (problem) return { available: false, pythonPath: null, setupState: 'no-python', reason: problem, gpu };
  return { available: false, pythonPath: null, setupState: 'not-installed', reason: 'vLLM is not installed yet.', gpu };
}

const WSL_REASONS = {
  'wsl-missing': 'Windows Subsystem for Linux is not installed. "Set up vLLM" installs it (one administrator prompt, then a restart).',
  'reboot-required': 'Restart Windows to finish installing the Windows Subsystem for Linux, then continue setup.',
  'distro-missing': 'The Linux environment vLLM runs in has not been created yet.',
};

async function detectWindows(gpu) {
  const state = await wsl.wslState();
  if (state !== 'ready') return { available: false, pythonPath: null, setupState: state, reason: WSL_REASONS[state], gpu };
  let version = null;
  try {
    version = parseVersionProbe((await wsl.execInDistro([wsl.VENV_PYTHON, '-c', VERSION_PROBE], { timeoutMs: PROBE_TIMEOUT_MS })).stdout);
  } catch (err) {
    // A missing venv makes the exec fail; anything else is a real fault.
    if (!/no such file|not found|ENOENT/i.test((/** @type {any} */ (err)).message)) throw err;
  }
  if (!version) return { available: false, pythonPath: null, setupState: 'not-installed', reason: 'vLLM is not installed yet.', gpu };
  return { available: true, pythonPath: wsl.VENV_PYTHON, version, setupState: 'ready', gpu };
}

/**
 * @returns {Promise<{available: boolean, pythonPath: string|null, version?: string, setupState: string, reason?: string, gpu?: {name: string, driver: string}}>}
 */
async function detectVllm() {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    return { available: false, pythonPath: null, setupState: 'unsupported', reason: 'vLLM needs an NVIDIA GPU on Linux or Windows.' };
  }
  const gpus = await detectGpus();
  const verdict = gpuVerdict(gpus);
  if (verdict.state !== 'ok') return { available: false, pythonPath: null, setupState: verdict.state, reason: verdict.reason };
  return process.platform === 'win32' ? detectWindows(gpus[0]) : detectLinux(gpus[0]);
}

/** True when `p` is an interpreter detection itself would return. */
function isDiscoveredVllmPath(p) {
  if (!p) return false;
  return process.platform === 'win32' ? p === wsl.VENV_PYTHON : p === managedVllmPython();
}

module.exports = {
  detectVllm, isDiscoveredVllmPath, linuxPrereqs, parseNvidiaSmi, gpuVerdict, parseVersionProbe,
  linuxPrereqProblem, VERSION_PROBE, MIN_DRIVER_MAJOR, LINUX_PACKAGES_HINT,
};
