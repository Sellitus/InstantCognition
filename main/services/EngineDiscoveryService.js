const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const {
  LLAMA_SERVER_BINARY_NAMES,
  LLAMA_SERVER_SEARCH_PATHS,
} = require('../../shared/llmDefaults');
const { detectVllm, isDiscoveredVllmPath } = require('./llm/vllmDiscovery');
const { detectMlx: detectMlxImpl } = require('./llm/mlxDiscovery');
const { detectOmlx, isDiscoveredOmlxPath } = require('./llm/omlxDiscovery');
const { managedLlamaDirs, managedLlamaRoot, managedMlxPython } = require('./llm/enginePaths');

const pythonNames = () => (process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']);

function resolveBundledLlamaServerDirs() {
  // Newest managed install first: EngineUpdateService writes there, and it must
  // win over the copy frozen into the bundle at build time.
  const dirs = managedLlamaDirs();
  try {
    const electron = require('electron');
    const app = electron && electron.app;
    if (app && typeof app.isPackaged === 'boolean' && app.isPackaged) {
      if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'llama-server'));
    }
  } catch (_) { /* electron not available (test env) */ }
  if (process.resourcesPath) {
    const candidate = path.join(process.resourcesPath, 'llama-server');
    if (!dirs.includes(candidate)) dirs.push(candidate);
  }
  const devDir = path.join(__dirname, '..', '..', 'vendor', 'llama-server', `${process.platform}-${process.arch}`);
  dirs.push(devDir);
  return dirs;
}

function bundledMlxPythonCandidates() {
  const rel = process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3'];
  const archDir = `${process.platform}-${process.arch}`;
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'mlx-python', ...rel));               // electron-builder
    candidates.push(path.join(process.resourcesPath, 'app', 'vendor', 'mlx-python', archDir, ...rel)); // electron-packager
  }
  candidates.push(path.join(__dirname, '..', '..', 'vendor', 'mlx-python', archDir, ...rel)); // dev fallback
  return candidates;
}

function resolveBundledMlxPython() {
  const managed = managedMlxPython();
  if (managed) return managed;
  for (const c of bundledMlxPythonCandidates()) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (_) { /* ignore */ }
  }
  return null;
}

const PYTHON_FALLBACK_PATHS = {
  darwin: [
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
  ],
  linux: [
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ],
  win32: [],
};

// Backend detection lives in ./llm/{vllmDiscovery,mlxDiscovery}.js — kept
// out-of-file so this service stays under the 265-line architecture cap.

const EXEC_TIMEOUT_MS = 1500;
const VERSION_TIMEOUT_MS = 20000;

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, ...options }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

class EngineDiscoveryService {
  constructor() {
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTtlMs = 30000;
  }

  async detectEngines({ force = false } = {}) {
    if (!force && this._cache && Date.now() - this._cacheTime < this._cacheTtlMs) {
      return this._cache;
    }

    const [llamaCpp, mlx, omlx, vllm] = await Promise.all([
      this.detectLlamaCpp(),
      this.detectMlx(),
      this.detectOmlx(),
      this.detectVllm(),
    ]);
    const mlxOpenAi = mlx.available
      ? { available: true, pythonPath: mlx.pythonPath, version: mlx.version }
      : { available: false, pythonPath: mlx.pythonPath || null, reason: mlx.reason };
    const result = { llamaCpp, mlx, mlxOpenAi, omlx, vllm, capabilities: this.getPlatformCapabilities() };
    this._cache = result;
    this._cacheTime = Date.now();
    return result;
  }

  async detectLlamaCpp() {
    const binaryPath = await this.findLlamaServerBinary();
    if (!binaryPath) {
      return { available: false, path: null, version: null };
    }
    const version = await this._getBinaryVersion(binaryPath);
    return { available: true, path: binaryPath, version };
  }

  async findLlamaServerBinary() {
    const platform = process.platform;
    const names = LLAMA_SERVER_BINARY_NAMES[platform] || ['llama-server'];
    const searchPaths = LLAMA_SERVER_SEARCH_PATHS[platform] || [];

    const bundledDirs = resolveBundledLlamaServerDirs();
    const pathEnv = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const allPaths = [...bundledDirs, ...pathEnv, ...searchPaths];

    for (const dir of allPaths) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          if (fs.existsSync(candidate)) {
            const stat = fs.statSync(candidate);
            if (stat.isFile()) return candidate;
          }
        } catch (_) { /* ignore */ }
      }
    }
    return null;
  }

  getBundledBinarySearchDirs() {
    return resolveBundledLlamaServerDirs();
  }

  async _getBinaryVersion(binaryPath) {
    // llama-server initializes Metal before it prints anything, which takes
    // ~11s on a cold GPU library cache. The generic probe timeout cuts the
    // output off mid-banner and leaves the version line unread, so this one
    // waits long enough for it.
    const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], { timeout: VERSION_TIMEOUT_MS });
    const out = (stdout + stderr).trim();
    if (!out) return 'unknown';
    const lines = out.split('\n');
    const versionLine = lines.find((l) => /^\s*version:/i.test(l)) || lines.find((l) => /version/i.test(l) && /\d/.test(l));
    return (versionLine || lines[0]).slice(0, 80);
  }

  // vLLM detection lives in ./llm/vllmDiscovery. A probe fault becomes the
  // row's reason (setupState 'error') so it cannot sink the other engines' rows.
  async detectVllm() {
    try { return await detectVllm(); } catch (err) {
      return { available: false, pythonPath: null, setupState: 'error', reason: `vLLM check failed: ${(/** @type {any} */ (err)).message || err}` };
    }
  }

  // MLX detection lives in ./llm/mlxDiscovery (darwin/arm64 guard + dual
  // importlib probe). Injects this._findPython so MLX picks up the same
  // bundled-MLX-python + fallback-path resolution vLLM uses.
  async detectMlx() {
    return detectMlxImpl(() => this._findPython());
  }

  // oMLX runs from its own runtime, never the MLX interpreter (llm/omlxDiscovery).
  async detectOmlx() {
    return detectOmlx();
  }

  async _findPython() {
    const bundled = resolveBundledMlxPython();
    if (bundled) return bundled;

    const names = pythonNames();
    const pathEnv = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathEnv) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        } catch (_) { /* ignore */ }
      }
    }

    const fallbacks = PYTHON_FALLBACK_PATHS[process.platform] || [];
    for (const candidate of fallbacks) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  getBundledMlxPython() {
    return resolveBundledMlxPython();
  }

  // Same resolution the MLX/vLLM probes use. EngineUpdateService needs an
  // interpreter to build its managed venv from.
  findPythonInterpreter() {
    return this._findPython();
  }

  getPlatformCapabilities() {
    const totalMem = os.totalmem();
    const cpus = os.cpus() || [];
    return {
      platform: process.platform,
      arch: process.arch,
      ramGB: Math.round(totalMem / (1024 * 1024 * 1024)),
      cpuCores: cpus.length,
      cpuModel: cpus[0] ? cpus[0].model : 'unknown',
      hasMetalSupport: process.platform === 'darwin' && process.arch === 'arm64',
    };
  }

  // Used by llm:start to fill in pythonPath / binaryPath. Honors a previously
  // resolved path from config (skips detection entirely once we've succeeded
  // once), and drops it as stale if the file no longer exists.
  async resolveBackendPath(backend, cachedPath) {
    // On Windows vLLM's interpreter is a path inside WSL, which fs cannot see.
    if (cachedPath && !(backend === 'vllm' && process.platform === 'win32')) {
      try { if (fs.existsSync(cachedPath)) return cachedPath; } catch (_) { /* fall through to detect */ }
    }
    if (backend === 'mlxOpenAi' || backend === 'mlx') {
      const d = await this.detectMlx();
      return d.available ? d.pythonPath : null;
    }
    if (backend === 'omlx') {
      const d = await this.detectOmlx();
      return d.available ? d.pythonPath : null;
    }
    if (backend === 'vllm') {
      const d = await this.detectVllm();
      return d.available ? d.pythonPath : null;
    }
    const d = await this.detectLlamaCpp();
    return d.available ? d.path : null;
  }

  // True when `p` sits where detection itself looks, i.e. a config path cached
  // from an earlier detection rather than one set by hand. EngineUpdateService
  // releases these after an install so the next start re-detects and finds the
  // newer runtime.
  isDiscoveredPath(engine, p) {
    if (!p) return false;
    const same = (a, b) => path.resolve(a) === path.resolve(b);
    const dir = path.dirname(p);
    const pathEnv = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (engine === 'llamaCpp') {
      // Any build under the managed root counts, including one an install has since pruned.
      const root = managedLlamaRoot();
      // Detection only ever finds these names; any other file was chosen by hand.
      if (!(LLAMA_SERVER_BINARY_NAMES[process.platform] || ['llama-server']).includes(path.basename(p))) return false;
      if (root && same(path.dirname(dir), root)) return true;
      const dirs = [...resolveBundledLlamaServerDirs(), ...pathEnv, ...(LLAMA_SERVER_SEARCH_PATHS[process.platform] || [])];
      return dirs.some((d) => same(d, dir));
    }
    if (engine === 'omlx') return isDiscoveredOmlxPath(p);
    if (engine === 'vllm') return isDiscoveredVllmPath(p);
    const files = [managedMlxPython(), ...bundledMlxPythonCandidates(), ...(PYTHON_FALLBACK_PATHS[process.platform] || [])].filter(Boolean);
    return files.some((f) => same(f, p)) || (pythonNames().includes(path.basename(p)) && pathEnv.some((d) => same(d, dir)));
  }

  clearCache() {
    this._cache = null;
    this._cacheTime = 0;
  }
}

module.exports = new EngineDiscoveryService();
