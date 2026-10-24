jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
}));

jest.mock('child_process', () => ({
  execFile: jest.fn((file, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (file && file.endsWith('llama-server') && args && args[0] === '--version') {
      cb(null, 'llama-server v0.0.1234\n', '');
      return;
    }
    if (args && args[0] === '-c' && /importlib\.metadata/.test(args[1] || '')) {
      // Simulate "no MLX server packages installed" — valid JSON with both null.
      cb(null, '{"mlx-lm": null, "mlx-openai-server": null}', '');
      return;
    }
    cb(new Error('unknown'), '', '');
  }),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn((p) => {
      if (typeof p !== 'string') return false;
      if (p.includes('llama-server') && !p.includes('.exe')) return true;
      if (p.endsWith('python3') || p.endsWith('python')) return true;
      return false;
    }),
    statSync: jest.fn(() => ({ isFile: () => true })),
  };
});

let svc;
beforeEach(() => {
  jest.resetModules();
  jest.mock('electron', () => ({ app: { getPath: jest.fn(() => '/mock'), isPackaged: false } }));
  svc = require('../../../../main/services/EngineDiscoveryService');
  svc.clearCache();
});

describe('EngineDiscoveryService', () => {
  test('detectEngines returns shape', async () => {
    const result = await svc.detectEngines({ force: true });
    expect(result).toHaveProperty('llamaCpp');
    expect(result).toHaveProperty('mlx');         // legacy umbrella, kept for compat
    expect(result).toHaveProperty('mlxOpenAi');   // per-runtime entries
    expect(result).toHaveProperty('omlx');
    expect(result).not.toHaveProperty('mlxLm');
    // vLLM is advertised by detectEngines. Only its presence, unavailability
    // and a setupState are host-independent here — the reason differs per
    // platform and is pinned in the platform-guard describe below.
    expect(result).toHaveProperty('vllm');
    expect(result.vllm.available).toBe(false);
    expect(typeof result.vllm.setupState).toBe('string');
    expect(result).toHaveProperty('capabilities');
  });

  test('detectEngines reports mlxOpenAi unavailable when only the mlx-lm library is installed', async () => {
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      if (file && file.endsWith('llama-server') && args && args[0] === '--version') { cb(null, 'llama-server v0.0.1234\n', ''); return; }
      if (args && args[0] === '-c' && /importlib\.metadata/.test(args[1] || '')) {
        // mlx-lm installed, mlx-openai-server NOT installed.
        cb(null, '{"mlx-lm": "0.20.0", "mlx-openai-server": null}', '');
        return;
      }
      cb(new Error('unknown'), '', '');
    });
    svc.clearCache();
    const result = await svc.detectEngines({ force: true });
    expect(result.mlxOpenAi.available).toBe(false);
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(result.mlxOpenAi.reason).toMatch(/mlx-openai-server not installed/);
    }
  });

  test('detectEngines copies an available mlx-openai-server into the mlxOpenAi row', async () => {
    if (!(process.platform === 'darwin' && process.arch === 'arm64')) return; // only darwin/arm64 runs the probe
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      if (args && args[0] === '-c' && /importlib\.metadata/.test(args[1] || '')) {
        cb(null, '{"mlx-lm": "0.20.0", "mlx-openai-server": "1.4.0"}', '');
        return;
      }
      cb(new Error('unknown'), '', '');
    });
    svc.clearCache();
    const result = await svc.detectEngines({ force: true });
    expect(result.mlxOpenAi).toEqual({ available: true, pythonPath: result.mlx.pythonPath, version: '1.4.0' });
    expect(result.mlxOpenAi.pythonPath).toMatch(/python3?$/);
  });

  test('getPlatformCapabilities returns RAM, cores, platform', () => {
    const caps = svc.getPlatformCapabilities();
    expect(typeof caps.ramGB).toBe('number');
    expect(typeof caps.cpuCores).toBe('number');
    expect(caps.platform).toBe(process.platform);
  });

  test('detectLlamaCpp finds binary in mocked PATH', async () => {
    const result = await svc.detectLlamaCpp();
    expect(result.available).toBe(true);
    expect(result.path).toContain('llama-server');
    expect(result.version).toMatch(/llama-server/);
  });

  test('getBundledBinarySearchDirs includes vendor and resourcesPath', () => {
    const dirs = svc.getBundledBinarySearchDirs();
    expect(Array.isArray(dirs)).toBe(true);
    expect(dirs.length).toBeGreaterThan(0);
    const joined = dirs.join('|');
    expect(joined).toMatch(/vendor[\\/]llama-server[\\/]/);
    expect(joined).toContain(`${process.platform}-${process.arch}`);
  });

  test('findLlamaServerBinary prefers bundled vendor dir over PATH', async () => {
    const fs = require('fs');
    const path = require('path');
    const platform = process.platform;
    const expectedName = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const vendorDir = path.join(__dirname, '..', '..', '..', '..', 'vendor', 'llama-server', `${platform}-${process.arch}`);
    const vendorBin = path.join(vendorDir, expectedName);
    fs.existsSync.mockImplementation((p) => {
      if (typeof p !== 'string') return false;
      if (p === vendorBin) return true;
      if (p.includes('llama-server') && !p.includes('.exe')) return true;
      if (p.endsWith('python3') || p.endsWith('python')) return true;
      return false;
    });
    const found = await svc.findLlamaServerBinary();
    expect(found).toBe(vendorBin);
  });

  test('detectMlx returns unavailable when not installed', async () => {
    const result = await svc.detectMlx();
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(result.available).toBe(false);
      expect(result.reason).toMatch(/^mlx-openai-server not installed \(python at .+\)$/);
    } else if (process.platform === 'darwin') {
      expect(result.available).toBe(false);
      expect(result.reason).toMatch(/Apple Silicon/);
    } else {
      expect(result.available).toBe(false);
      expect(result.reason).toMatch(/macOS only/);
    }
  });

  // Locks in the friendly-reason path for the cold-python-startup timeout case.
  // This is the failure mode the recent 1.5s→6s probe-timeout bump was fixing;
  // without this test, we can regress back to a useless "python probe failed"
  // message that doesn't tell the user it was a timeout.
  test('detectMlx surfaces "timed out" reason when the python probe is killed by SIGTERM', async () => {
    if (!(process.platform === 'darwin' && process.arch === 'arm64')) return; // only the macOS arm64 branch invokes the probe
    const cp = require('child_process');
    cp.execFile.mockImplementationOnce((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      const err = new Error('Command timed out');
      err.killed = true;
      err.signal = 'SIGTERM';
      cb(err, '', '');
    });
    const result = await svc.detectMlx();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/timed out/);
  });

  test('cache returns same result without re-detecting', async () => {
    const a = await svc.detectEngines();
    const b = await svc.detectEngines();
    expect(a).toBe(b);
  });

  test('force=true bypasses cache', async () => {
    const a = await svc.detectEngines();
    const b = await svc.detectEngines({ force: true });
    expect(a).not.toBe(b);
  });

  // Locks in the cached-path / stale-path / detect-fallback behavior the
  // llm:start handler relies on. Without this, every Start click re-runs the
  // python probe — which could time out cold and surface as "mlx_lm not found".
  describe('resolveBackendPath', () => {
    test('returns the cached path verbatim when the file still exists (mlxOpenAi)', async () => {
      const result = await svc.resolveBackendPath('mlxOpenAi', '/some/cached/python3');
      expect(result).toBe('/some/cached/python3');
    });

    test('returns the cached path verbatim when the file still exists (omlx)', async () => {
      const result = await svc.resolveBackendPath('omlx', '/some/cached/python3');
      expect(result).toBe('/some/cached/python3');
    });

    test('omlx resolves null when detection finds no oMLX runtime', async () => {
      expect(await svc.resolveBackendPath('omlx', '/no/longer/here')).toBeNull();
    });

    test('falls back to detection when the cached path no longer exists (mlxOpenAi)', async () => {
      const result = await svc.resolveBackendPath('mlxOpenAi', '/no/longer/here');
      expect(result).toBeNull();
    });

    test('llamaCpp branch resolves to the bundled or PATH binary when no cache', async () => {
      const result = await svc.resolveBackendPath('llamaCpp', null);
      expect(typeof result).toBe('string');
      expect(result).toMatch(/llama-server/);
    });

    test('legacy "mlx" backend id is still resolvable (back-compat)', async () => {
      const result = await svc.resolveBackendPath('mlx', '/some/cached/python3');
      expect(result).toBe('/some/cached/python3');
    });

    test('cached path that no longer exists is dropped and detection runs (llamaCpp)', async () => {
      // existsSync('/stale') -> false, so the cached path is rejected and we
      // detect; llama-server binary IS found by the default fs mock.
      const result = await svc.resolveBackendPath('llamaCpp', '/stale/never/exists');
      expect(result).toMatch(/llama-server/);
    });

    test('a fs.existsSync that throws on the cached path falls through to detect', async () => {
      const fs = require('fs');
      fs.existsSync.mockImplementationOnce(() => { throw new Error('EACCES'); });
      const result = await svc.resolveBackendPath('llamaCpp', '/protected/python3');
      // Threw on the cached check -> caught -> detection still resolves the binary.
      expect(result).toMatch(/llama-server/);
    });
  });

  describe('isDiscoveredPath', () => {
    const path = require('path');
    const ORIGINAL_PATH = process.env.PATH;
    afterEach(() => { process.env.PATH = ORIGINAL_PATH; });

    test('a llama-server in a bundled search dir is one detection produced', () => {
      const dir = svc.getBundledBinarySearchDirs()[0];
      expect(svc.isDiscoveredPath('llamaCpp', path.join(dir, 'llama-server'))).toBe(true);
    });

    test('a llama-server found on PATH counts as detected', () => {
      process.env.PATH = ['/opt/tools/bin', '/usr/bin'].join(path.delimiter);
      expect(svc.isDiscoveredPath('llamaCpp', '/opt/tools/bin/llama-server')).toBe(true);
    });

    test('a managed build counts as detected even after an install pruned it', () => {
      expect(svc.isDiscoveredPath('llamaCpp', '/mock/engines/llama-server/b4000/llama-server')).toBe(true);
      expect(svc.isDiscoveredPath('llamaCpp', '/mock/engines/other/b4000/llama-server')).toBe(false);
    });

    test('a llama-server somewhere detection never looks was set by hand', () => {
      process.env.PATH = '/usr/bin';
      expect(svc.isDiscoveredPath('llamaCpp', '/Users/me/builds/llama.cpp/llama-server')).toBe(false);
    });

    test('a differently named binary in a searched dir was chosen by hand', () => {
      process.env.PATH = ['/usr/local/bin', '/opt/py/bin'].join(path.delimiter);
      expect(svc.isDiscoveredPath('llamaCpp', '/usr/local/bin/llama-server-cuda')).toBe(false);
      expect(svc.isDiscoveredPath('mlx', '/opt/py/bin/python3.12')).toBe(false);
    });

    test('a python on PATH counts as detected, a custom venv does not', () => {
      process.env.PATH = '/opt/py/bin';
      expect(svc.isDiscoveredPath('mlx', '/opt/py/bin/python3')).toBe(true);
      expect(svc.isDiscoveredPath('mlx', '/Users/me/venvs/mlx/bin/python3')).toBe(false);
    });

    test('no path is never a detected one', () => {
      expect(svc.isDiscoveredPath('llamaCpp', null)).toBe(false);
    });
  });
});

// process.platform / process.arch are an environment boundary; overriding them
// is the only way to exercise the non-darwin / non-arm64 guard branches that
// the host machine (darwin/arm64) never takes.
describe('EngineDiscoveryService platform-guard branches', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realArch = Object.getOwnPropertyDescriptor(process, 'arch');

  function setPlatform(platform, arch) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  }
  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    Object.defineProperty(process, 'arch', realArch);
  });

  test('detectMlx short-circuits with "macOS only" on a non-darwin platform', async () => {
    setPlatform('linux', 'x64');
    const result = await svc.detectMlx();
    expect(result).toEqual({ available: false, reason: 'macOS only' });
  });

  // vLLM needs an NVIDIA GPU, so it short-circuits everywhere except
  // Linux/Windows. Both branches are pinned here because the host platform
  // decides which one detectEngines takes — asserting either one unpinned only
  // passes on the matching developer machine.
  test('detectVllm short-circuits as unsupported off Linux/Windows', async () => {
    setPlatform('darwin', 'arm64');
    const result = await svc.detectVllm();
    expect(result).toEqual({
      available: false, pythonPath: null, setupState: 'unsupported',
      reason: 'vLLM needs an NVIDIA GPU on Linux or Windows.',
    });
  });

  test('detectVllm on Linux without nvidia-smi reports no-gpu rather than unsupported', async () => {
    setPlatform('linux', 'x64');
    const result = await svc.detectVllm();
    expect(result.available).toBe(false);
    expect(result.setupState).toBe('no-gpu');
    expect(result.reason).toMatch(/No NVIDIA GPU was found/);
  });

  // A probe fault must become this row's reason: detectEngines runs every
  // engine's probe together, and a throw would sink the llama.cpp and MLX rows.
  test('detectVllm turns a probe fault into an error row', async () => {
    setPlatform('linux', 'x64');
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      if (file === 'nvidia-smi') { cb(null, 'NVIDIA GeForce RTX 5090, 580.65.06\n', ''); return; }
      if (args && args[0] === '-c') { cb(null, 'Traceback (most recent call last)', ''); return; }
      cb(new Error('unknown'), '', '');
    });
    const result = await svc.detectVllm();
    expect(result.available).toBe(false);
    expect(result.setupState).toBe('error');
    expect(result.reason).toMatch(/^vLLM check failed: Unexpected vLLM probe output: Traceback/);
    const all = await svc.detectEngines({ force: true });
    expect(all.vllm.setupState).toBe('error');
    expect(all.llamaCpp).toBeDefined();
  });

  test('detectMlx short-circuits with "Apple Silicon required" on darwin/x64', async () => {
    setPlatform('darwin', 'x64');
    const result = await svc.detectMlx();
    expect(result).toEqual({ available: false, reason: 'Apple Silicon required' });
  });

  test('detectMlx on darwin/arm64 returns unavailable when python is not found', async () => {
    setPlatform('darwin', 'arm64');
    const fs = require('fs');
    fs.existsSync.mockImplementation(() => false); // no python anywhere
    const result = await svc.detectMlx();
    expect(result).toEqual({ available: false, reason: 'python3 not found' });
  });

  test('detectMlx on darwin/arm64 reports both MLX packages installed', async () => {
    setPlatform('darwin', 'arm64');
    const fs = require('fs');
    fs.existsSync.mockImplementation((p) => typeof p === 'string' && (p.endsWith('python3') || p.endsWith('python')));
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      if (args && args[0] === '-c') { cb(null, '{"mlx-lm": "0.21.0", "mlx-openai-server": "1.2.3"}', ''); return; }
      cb(new Error('unknown'), '', '');
    });
    const result = await svc.detectMlx();
    expect(result.available).toBe(true);
    expect(result.packages).toEqual({ 'mlx-lm': '0.21.0', 'mlx-openai-server': '1.2.3' });
    expect(result.version).toBe('1.2.3'); // the server's version, not the library's
  });

  test('detectMlx surfaces a non-timeout "probe failed" reason', async () => {
    setPlatform('darwin', 'arm64');
    const fs = require('fs');
    fs.existsSync.mockImplementation((p) => typeof p === 'string' && (p.endsWith('python3') || p.endsWith('python')));
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      cb(new Error('boom'), '', ''); // not killed / not SIGTERM
    });
    const result = await svc.detectMlx();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/python probe failed/);
    expect(result.reason).not.toMatch(/timed out/);
  });

  test('detectMlx tolerates non-JSON probe stdout (treats as no packages)', async () => {
    setPlatform('darwin', 'arm64');
    const fs = require('fs');
    fs.existsSync.mockImplementation((p) => typeof p === 'string' && (p.endsWith('python3') || p.endsWith('python')));
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      cb(null, 'not json at all', '');
    });
    const result = await svc.detectMlx();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/mlx-openai-server not installed/);
  });

  test('resolveBackendPath(mlxOpenAi) returns null when only mlx-lm is present', async () => {
    setPlatform('darwin', 'arm64');
    const fs = require('fs');
    fs.existsSync.mockImplementation((p) => typeof p === 'string' && (p.endsWith('python3') || p.endsWith('python')));
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      cb(null, '{"mlx-lm": "0.21.0", "mlx-openai-server": null}', '');
    });
    expect(await svc.resolveBackendPath('mlxOpenAi', null)).toBeNull();
  });

  test('resolveBackendPath(mlxOpenAi) returns the python path once mlx-openai-server is present', async () => {
    setPlatform('darwin', 'arm64');
    const fs = require('fs');
    fs.existsSync.mockImplementation((p) => typeof p === 'string' && (p.endsWith('python3') || p.endsWith('python')));
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      cb(null, '{"mlx-lm": null, "mlx-openai-server": "1.0.0"}', '');
    });
    expect(await svc.resolveBackendPath('mlxOpenAi', null)).toMatch(/python3?$/);
  });

  test('_findPython falls back to a well-known absolute path when PATH yields nothing', async () => {
    setPlatform('darwin', 'arm64');
    const fs = require('fs');
    // Nothing on PATH; only the homebrew fallback exists.
    fs.existsSync.mockImplementation((p) => p === '/opt/homebrew/bin/python3');
    const found = await svc._findPython();
    expect(found).toBe('/opt/homebrew/bin/python3');
  });

  test('_findPython returns null when no python exists anywhere', async () => {
    setPlatform('linux', 'x64');
    const fs = require('fs');
    fs.existsSync.mockImplementation(() => false);
    expect(await svc._findPython()).toBeNull();
  });

  test('getPlatformCapabilities reports Metal support only on darwin/arm64', () => {
    setPlatform('darwin', 'arm64');
    expect(svc.getPlatformCapabilities().hasMetalSupport).toBe(true);
    setPlatform('win32', 'x64');
    expect(svc.getPlatformCapabilities().hasMetalSupport).toBe(false);
  });

  test('findLlamaServerBinary returns null when no binary exists on any path', async () => {
    setPlatform('linux', 'x64');
    const fs = require('fs');
    fs.existsSync.mockImplementation(() => false);
    expect(await svc.findLlamaServerBinary()).toBeNull();
  });

  test('detectLlamaCpp returns unavailable when the binary is missing', async () => {
    setPlatform('linux', 'x64');
    const fs = require('fs');
    fs.existsSync.mockImplementation(() => false);
    const r = await svc.detectLlamaCpp();
    expect(r).toEqual({ available: false, path: null, version: null });
  });

  test('_getBinaryVersion returns "unknown" when --version prints nothing', async () => {
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      cb(null, '', ''); // empty stdout+stderr
    });
    const v = await svc._getBinaryVersion('/x/llama-server');
    expect(v).toBe('unknown');
  });

  test('_getBinaryVersion picks the version line out of the Metal init banner', async () => {
    // llama-server prints ~19 lines of ggml_metal_* init before the version.
    // Taking the first line reports GPU noise as the engine version.
    const banner = [
      'ggml_metal_device_init: testing tensor API for f16 support',
      'ggml_metal_library_init: using embedded metal library',
      'version: 0.4.0-dev (build 10809, commit 5266f24da)',
      'built with AppleClang 21.0.0.21000101 for Darwin arm64',
    ].join('\n');
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      cb(null, `${banner}\n`, '');
    });
    const v = await svc._getBinaryVersion('/x/llama-server');
    expect(v).toBe('version: 0.4.0-dev (build 10809, commit 5266f24da)');
  });

  test('_getBinaryVersion allows the Metal init far longer than the detection probe', async () => {
    // Metal library compilation takes ~11s on a cold cache; the 1.5s probe
    // timeout truncates the output before the version line is printed.
    const cp = require('child_process');
    let seenTimeout = null;
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      seenTimeout = opts.timeout;
      cb(null, 'version: 0.4.0-dev (build 10809, commit 5266f24da)\n', '');
    });
    await svc._getBinaryVersion('/x/llama-server');
    expect(seenTimeout).toBeGreaterThanOrEqual(15000);
  });

  test('_getBinaryVersion falls back to the first line when no version line matches', async () => {
    const cp = require('child_process');
    cp.execFile.mockImplementation((file, args, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      cb(null, 'first banner line\nsecond line\n', '');
    });
    const v = await svc._getBinaryVersion('/x/llama-server');
    expect(v).toBe('first banner line');
  });
});
