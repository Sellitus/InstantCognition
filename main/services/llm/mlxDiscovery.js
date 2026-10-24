// mlxDiscovery — mlx-openai-server availability probe.
//
// Returns the {available, pythonPath, reason} shape
// the engine discovery service expects, plus a `packages` map so the UI can
// report the server and the mlx-lm library it runs on. Probes both packages in
// a single python invocation via importlib.metadata.
//
// EXECUTION-TRUTH: N/A — this module is only invoked on darwin/arm64 (the
// platform guard in EngineDiscoveryService.detectMlx short-circuits earlier);
// the probe path itself is unit-tested.

const { execFile } = require('child_process');

const MLX_PROBE_TIMEOUT_MS = 6000;
// Cold python3 + importlib.metadata startup can take 2-3s on macOS the first
// time after boot — a 1.5s budget caused first-click "mlx_lm not found" errors
// that disappeared on retry once the interpreter was warm.

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: MLX_PROBE_TIMEOUT_MS, ...options }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// detectMlx accepts an injected python resolver (the EngineDiscoveryService's
// _findPython: bundled MLX python -> PATH -> platform fallbacks).
async function detectMlx(resolvePython) {
  if (process.platform !== 'darwin') return { available: false, reason: 'macOS only' };
  if (process.arch !== 'arm64') return { available: false, reason: 'Apple Silicon required' };
  const python = await resolvePython();
  if (!python) return { available: false, reason: 'python3 not found' };

  const probe = [
    'from importlib.metadata import version, PackageNotFoundError',
    'import json, sys',
    'out = {}',
    'for pkg in ("mlx-lm", "mlx-openai-server"):',
    '    try: out[pkg] = version(pkg)',
    '    except PackageNotFoundError: out[pkg] = None',
    'json.dump(out, sys.stdout)',
  ].join('\n');
  const { error, stdout } = await execFileAsync(python, ['-c', probe]);
  if (error) {
    const killed = error.killed || error.signal === 'SIGTERM';
    const reason = killed
      ? `python probe timed out after ${MLX_PROBE_TIMEOUT_MS}ms (cold start at ${python})`
      : `python probe failed (${python})`;
    return { available: false, pythonPath: python, reason };
  }
  let pkgs;
  try { pkgs = JSON.parse(stdout.trim()); } catch (_) { pkgs = {}; }
  const mlxLm = pkgs['mlx-lm'];
  const mlxOai = pkgs['mlx-openai-server'];
  if (!mlxOai) {
    return { available: false, pythonPath: python, reason: `mlx-openai-server not installed (python at ${python})` };
  }
  return {
    available: true,
    pythonPath: python,
    version: mlxOai,
    packages: { 'mlx-lm': mlxLm, 'mlx-openai-server': mlxOai },
  };
}

module.exports = { detectMlx, MLX_PROBE_TIMEOUT_MS };
