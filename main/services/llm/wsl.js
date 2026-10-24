// wsl — the Windows side of the vLLM engine.
//
// vLLM ships Linux wheels only, so on Windows it runs inside a WSL2 distro the
// app owns (DISTRO, imported from the official Ubuntu image by vllmSetup.js).
// A dedicated distro keeps the user's own distros untouched and makes root the
// default user, so no first-run account prompt ever appears. Commands go in
// through `wsl.exe -d DISTRO -u root --exec`, which passes argv straight to
// the Linux binary with no shell in between.
//
// wsl.exe prints its own messages as UTF-16LE unless WSL_UTF8=1, and inbox
// builds ignore that variable, so output is also NUL-stripped.
//
// EXECUTION-TRUTH: PARTIAL — the parsing and state derivation are unit-tested;
// the wsl.exe / sc.exe / reg.exe calls need a Windows host.

const fetcher = require('./engineFetch');

const DISTRO = 'InstantCognition';
const VENV_DIR = '/opt/instantcognition/vllm-venv';
const VENV_PYTHON = `${VENV_DIR}/bin/python3`;
// Present in every WSL2 distro once the Windows NVIDIA driver is installed;
// root's PATH does not include /usr/lib/wsl/lib.
const WSL_NVIDIA_SMI = '/usr/lib/wsl/lib/nvidia-smi';
// Set by `wsl --install` and cleared by the reboot that finishes it.
const INSTALL_STATUS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';
// sc.exe's exit code for "the specified service does not exist".
const SC_SERVICE_MISSING = 1060;

/**
 * Translate a Windows path into the path the distro sees it under.
 * @param {string} winPath
 * @returns {string}
 */
function toWslPath(winPath) {
  const p = String(winPath || '');
  if (!p) throw new Error('No path to translate.');
  if (p.startsWith('/')) return p;
  const drive = p.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
  if (drive) {
    const rest = (drive[2] || '').split(/[\\/]+/).filter(Boolean).join('/');
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  const unc = p.match(/^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i);
  if (unc) {
    if (unc[1].toLowerCase() !== DISTRO.toLowerCase()) {
      throw new Error(`${p} is inside the WSL distro "${unc[1]}", which vLLM cannot read. Move the model to a Windows folder.`);
    }
    return `/${(unc[2] || '').split(/[\\/]+/).filter(Boolean).join('/')}`;
  }
  throw new Error(`${p} is a network path, which vLLM inside WSL cannot read. Move the model to a local drive.`);
}

/** @param {string} text */
function cleanOutput(text) {
  return String(text || '').replace(/\u0000/g, '').replace(/^\uFEFF/, '');
}

/** @param {string} text `wsl -l -q` output */
function parseDistroList(text) {
  return cleanOutput(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Pure: which setup step WSL still needs.
 * @param {{wslRuns: boolean, installPending: boolean, vmcomputeMissing: boolean, distros: string[]}} probe
 * @returns {'wsl-missing'|'reboot-required'|'distro-missing'|'ready'}
 */
function deriveWslState({ wslRuns, installPending, vmcomputeMissing, distros }) {
  if (installPending) return 'reboot-required';
  if (!wslRuns) return 'wsl-missing';
  // The WSL package installs without a reboot, but the virtual machine
  // platform it needs only starts after one.
  if (vmcomputeMissing) return 'reboot-required';
  return distros.some((d) => d.toLowerCase() === DISTRO.toLowerCase()) ? 'ready' : 'distro-missing';
}

const WSL_ENV = () => ({ ...process.env, WSL_UTF8: '1' });

/**
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [opts]
 */
async function runWsl(args, { timeoutMs = 120000 } = {}) {
  try {
    const { stdout, stderr } = await fetcher.run('wsl.exe', args, { timeoutMs, env: WSL_ENV() });
    return { stdout: cleanOutput(stdout), stderr: cleanOutput(stderr) };
  } catch (err) {
    throw new Error(cleanOutput((/** @type {any} */ (err)).message));
  }
}

/**
 * Run argv as root inside the app's distro.
 * @param {string[]} argv
 * @param {{timeoutMs?: number}} [opts]
 */
function execInDistro(argv, opts) {
  return runWsl(['-d', DISTRO, '-u', 'root', '--exec', ...argv], opts);
}

/** @returns {Promise<boolean>} */
async function succeeds(file, args) {
  try { await fetcher.run(file, args, { timeoutMs: 30000 }); return true; } catch (_) { return false; }
}

async function listDistros() {
  try {
    return parseDistroList((await runWsl(['-l', '-q'], { timeoutMs: 60000 })).stdout);
  } catch (err) {
    // With no distro registered wsl.exe exits non-zero and says so.
    if (/no installed distributions/i.test((/** @type {any} */ (err)).message)) return [];
    throw err;
  }
}

/** @returns {Promise<boolean>} whether the vmcompute service is absent */
async function vmcomputeMissing() {
  try {
    await fetcher.run('sc.exe', ['query', 'vmcompute'], { timeoutMs: 30000 });
    return false;
  } catch (err) {
    return new RegExp(`\\b${SC_SERVICE_MISSING}\\b`).test((/** @type {any} */ (err)).message);
  }
}

/** @returns {Promise<'wsl-missing'|'reboot-required'|'distro-missing'|'ready'>} */
async function wslState() {
  const installPending = await succeeds('reg.exe', ['query', INSTALL_STATUS_KEY, '/v', 'InstallStatus']);
  // Every Windows 10/11 machine ships an inbox wsl.exe launcher; only an
  // installed WSL package answers --version.
  const wslRuns = await succeeds('wsl.exe', ['--version']);
  const missingVm = wslRuns && !installPending ? await vmcomputeMissing() : false;
  const distros = wslRuns && !installPending && !missingVm ? await listDistros() : [];
  return deriveWslState({ wslRuns, installPending, vmcomputeMissing: missingVm, distros });
}

/** Stop every process in the distro by shutting the distro down. */
function terminateDistro() {
  return runWsl(['--terminate', DISTRO], { timeoutMs: 60000 });
}

module.exports = {
  DISTRO, VENV_DIR, VENV_PYTHON, WSL_NVIDIA_SMI,
  toWslPath, parseDistroList, deriveWslState, cleanOutput,
  runWsl, execInDistro, listDistros, wslState, terminateDistro, WSL_ENV,
};
