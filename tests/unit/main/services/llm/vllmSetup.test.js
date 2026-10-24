// vllmSetup — the guided vLLM install. Detection (vllmDiscovery) is scripted
// per test; the boundaries are engineFetch (downloads, native processes) and
// the wsl.exe calls (wsl.execInDistro / wsl.runWsl).

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../../../../main/services/llm/engineFetch', () => ({
  run: jest.fn(), fetchText: jest.fn(), downloadVerified: jest.fn(),
}));
jest.mock('../../../../../main/services/llm/vllmDiscovery', () => ({ detectVllm: jest.fn() }));
jest.mock('../../../../../main/services/llm/enginePaths', () => ({
  managedWslDir: jest.fn(), managedVllmPython: jest.fn(), managedVllmVenv: jest.fn(),
  venvPython: (v) => `${v}/bin/python3`,
}));
jest.mock('../../../../../main/services/llm/wsl', () => {
  const actual = jest.requireActual('../../../../../main/services/llm/wsl');
  return { ...actual, execInDistro: jest.fn(), runWsl: jest.fn() };
});

const fetcher = require('../../../../../main/services/llm/engineFetch');
const { detectVllm } = require('../../../../../main/services/llm/vllmDiscovery');
const enginePaths = require('../../../../../main/services/llm/enginePaths');
const wsl = require('../../../../../main/services/llm/wsl');
const { runSetup, restartWindows, parseSha256Sums, UBUNTU_FILE, APT_PACKAGES } = require('../../../../../main/services/llm/vllmSetup');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const realArch = Object.getOwnPropertyDescriptor(process, 'arch');
function setPlatform(platform, arch = 'x64') {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

const DIGEST = 'a'.repeat(64);
const CUDA_OK = JSON.stringify({ cuda: true, torch: '2.9.0' });

/** Each detectVllm call returns the next state; the last one repeats. */
function detectSequence(...dets) {
  let i = 0;
  detectVllm.mockImplementation(async () => dets[Math.min(i++, dets.length - 1)]);
}

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vllm-setup-test-'));
  enginePaths.managedWslDir.mockReturnValue(path.join(tmpRoot, 'wsl'));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  Object.defineProperty(process, 'arch', realArch);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  jest.resetAllMocks();
});

describe('parseSha256Sums', () => {
  const sums = `${'b'.repeat(64)}  other.iso\n${DIGEST.toUpperCase()} *${UBUNTU_FILE}\r\n`;
  test('returns the lower-cased digest for the file, binary marker allowed', () => {
    expect(parseSha256Sums(sums, UBUNTU_FILE)).toBe(DIGEST);
  });
  test('returns null when the file is not listed or the input is empty', () => {
    expect(parseSha256Sums(sums, 'missing.wsl')).toBeNull();
    expect(parseSha256Sums('', UBUNTU_FILE)).toBeNull();
  });
});

describe('setup on Windows', () => {
  beforeEach(() => setPlatform('win32'));

  test('wsl-missing: enables WSL, then stops at reboot-required', async () => {
    detectSequence({ setupState: 'wsl-missing' }, { setupState: 'reboot-required', reason: 'Restart Windows' });
    fetcher.run.mockResolvedValue({ stdout: '', stderr: '' });
    const res = await runSetup();
    expect(res).toEqual({ state: 'reboot-required', reason: 'Restart Windows' });
    expect(fetcher.run).toHaveBeenCalledWith('wsl.exe', ['--install', '--no-distribution'], expect.objectContaining({ timeoutMs: 1800000 }));
  });

  test('a declined administrator prompt surfaces as a clear error', async () => {
    detectSequence({ setupState: 'wsl-missing' });
    fetcher.run.mockRejectedValue(new Error('exit 1'));
    await expect(runSetup()).rejects.toThrow(/administrator prompt declined\?\): exit 1/);
  });

  test('distro-missing → not-installed → ready imports, installs and checks CUDA in order', async () => {
    detectSequence(
      { setupState: 'distro-missing' },
      { setupState: 'not-installed' },
      { setupState: 'ready', pythonPath: wsl.VENV_PYTHON, version: '0.31.0' },
    );
    fetcher.fetchText.mockResolvedValue(`${DIGEST}  ${UBUNTU_FILE}\n`);
    fetcher.downloadVerified.mockResolvedValue(undefined);
    wsl.runWsl.mockResolvedValue({ stdout: '', stderr: '' });
    const steps = [];
    wsl.execInDistro.mockImplementation(async (argv) => {
      steps.push(argv.join(' '));
      if (argv.includes('-c') && argv.some((a) => a.includes('os.access'))) return { stdout: 'False\n', stderr: '' };
      if (argv.includes('-c') && argv.some((a) => a.includes('torch'))) return { stdout: `noise\n${CUDA_OK}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const sent = [];
    const res = await runSetup({ send: (p) => sent.push(p.step) });

    expect(res).toEqual({ state: 'ready', version: '0.31.0' });
    expect(fetcher.downloadVerified).toHaveBeenCalledWith(
      expect.stringContaining(UBUNTU_FILE), expect.stringContaining(UBUNTU_FILE), expect.objectContaining({ digest: DIGEST }),
    );
    const importArgs = wsl.runWsl.mock.calls[0][0];
    expect(importArgs.slice(0, 3)).toEqual(['--import', 'InstantCognition', path.join(tmpRoot, 'wsl')]);
    expect(importArgs.slice(-2)).toEqual(['--version', '2']);

    const idx = (re) => steps.findIndex((s) => re.test(s));
    expect(idx(/apt-get update/)).toBeGreaterThan(-1);
    expect(steps[idx(/apt-get install/)]).toContain(APT_PACKAGES.join(' '));
    expect(idx(/-m venv/)).toBeGreaterThan(idx(/apt-get install/));
    expect(idx(/pip install --no-cache-dir --upgrade vllm/)).toBeGreaterThan(idx(/-m venv/));
    expect(idx(/torch/)).toBeGreaterThan(idx(/pip install/));
    expect(sent).toContain('Checking the GPU');
  });

  test('no checksum for the image stops before downloading', async () => {
    detectSequence({ setupState: 'distro-missing' });
    fetcher.fetchText.mockResolvedValue(`${DIGEST}  other.wsl\n`);
    await expect(runSetup()).rejects.toThrow(/no entry for/);
    expect(fetcher.downloadVerified).not.toHaveBeenCalled();
  });

  test('distro import refuses non-x64 Windows', async () => {
    setPlatform('win32', 'arm64');
    detectSequence({ setupState: 'distro-missing' });
    await expect(runSetup()).rejects.toThrow(/x64 PC/);
  });

  test('an existing venv skips apt and venv creation', async () => {
    detectSequence({ setupState: 'not-installed' }, { setupState: 'ready', pythonPath: wsl.VENV_PYTHON, version: '1.0.0' });
    wsl.execInDistro.mockImplementation(async (argv) => {
      if (argv.some((a) => a.includes('os.access'))) return { stdout: 'True', stderr: '' };
      if (argv.some((a) => a.includes('torch'))) return { stdout: CUDA_OK, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    await runSetup();
    const lines = wsl.execInDistro.mock.calls.map(([a]) => a.join(' '));
    expect(lines.some((l) => /apt-get|-m venv/.test(l))).toBe(false);
    expect(lines.some((l) => /pip install/.test(l))).toBe(true);
  });
});

describe('setup loop guards (Linux)', () => {
  beforeEach(() => setPlatform('linux'));

  test('the same state twice means setup is stuck', async () => {
    enginePaths.managedVllmPython.mockReturnValue('/e/vllm-venv/bin/python3');
    detectSequence({ setupState: 'not-installed', reason: 'vllm import failed' });
    fetcher.run.mockResolvedValue({ stdout: '', stderr: '' });
    await expect(runSetup()).rejects.toThrow('vLLM setup is stuck: vllm import failed');
    expect(fetcher.run.mock.calls.filter(([, a]) => a.includes('pip')).length).toBe(1);
  });

  test('ready + upgrade reinstalls exactly once, then verifies', async () => {
    detectSequence({ setupState: 'ready', pythonPath: '/e/py', version: '0.31.0' });
    fetcher.run.mockImplementation(async (_f, args) => (args[0] === '-c' ? { stdout: CUDA_OK, stderr: '' } : { stdout: '', stderr: '' }));
    const res = await runSetup({ upgrade: true });
    expect(res.state).toBe('ready');
    const pipCalls = fetcher.run.mock.calls.filter(([, a]) => a.includes('pip'));
    expect(pipCalls).toHaveLength(1);
    expect(pipCalls[0]).toEqual(['/e/py', ['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', 'vllm'], expect.any(Object)]);
  });

  test('ready without upgrade does not touch pip', async () => {
    detectSequence({ setupState: 'ready', pythonPath: '/e/py', version: '0.31.0' });
    fetcher.run.mockResolvedValue({ stdout: CUDA_OK, stderr: '' });
    await runSetup();
    expect(fetcher.run.mock.calls.some(([, a]) => a.includes('pip'))).toBe(false);
  });

  test('not-installed creates the native venv from system python3', async () => {
    enginePaths.managedVllmPython.mockReturnValue(null);
    enginePaths.managedVllmVenv.mockReturnValue('/e/vllm-venv');
    detectSequence({ setupState: 'not-installed' }, { setupState: 'ready', pythonPath: '/e/vllm-venv/bin/python3', version: '1' });
    fetcher.run.mockImplementation(async (_f, args) => (args[0] === '-c' ? { stdout: CUDA_OK, stderr: '' } : { stdout: '', stderr: '' }));
    await runSetup();
    expect(fetcher.run.mock.calls[0]).toEqual(['python3', ['-m', 'venv', '/e/vllm-venv'], expect.any(Object)]);
    expect(fetcher.run.mock.calls[1][0]).toBe('/e/vllm-venv/bin/python3');
  });

  test('CUDA unreachable from PyTorch fails with the driver message', async () => {
    detectSequence({ setupState: 'ready', pythonPath: '/e/py', version: '1' });
    fetcher.run.mockResolvedValue({ stdout: JSON.stringify({ cuda: false, torch: '2.9.0' }), stderr: '' });
    await expect(runSetup()).rejects.toThrow(/PyTorch 2.9.0 cannot reach the GPU.*580/);
  });

  test('unparseable CUDA probe output is reported, not ignored', async () => {
    detectSequence({ setupState: 'ready', pythonPath: '/e/py', version: '1' });
    fetcher.run.mockResolvedValue({ stdout: 'Traceback', stderr: '' });
    await expect(runSetup()).rejects.toThrow(/Unexpected CUDA check output: Traceback/);
  });

  test('a state setup cannot fix throws its reason', async () => {
    detectSequence({ setupState: 'no-gpu', reason: 'vLLM needs an NVIDIA GPU' });
    await expect(runSetup()).rejects.toThrow('vLLM needs an NVIDIA GPU');
    expect(fetcher.run).not.toHaveBeenCalled();
  });

  test('concurrent callers share one run; a later call starts fresh', async () => {
    let release;
    detectVllm.mockImplementation(() => new Promise((r) => { release = r; }));
    fetcher.run.mockResolvedValue({ stdout: CUDA_OK, stderr: '' });
    const a = runSetup();
    const b = runSetup();
    expect(b).toBe(a);
    release({ setupState: 'ready', pythonPath: '/e/py', version: '1' });
    await a;
    expect(detectVllm).toHaveBeenCalledTimes(1);
    detectSequence({ setupState: 'ready', pythonPath: '/e/py', version: '1' });
    const c = runSetup();
    expect(c).not.toBe(a);
    await c;
    expect(detectVllm).toHaveBeenCalledTimes(2);
  });
});

describe('restartWindows', () => {
  test('refuses off Windows', () => {
    setPlatform('linux');
    expect(() => restartWindows()).toThrow(/Only Windows/);
    expect(fetcher.run).not.toHaveBeenCalled();
  });
  test('schedules a 10 s restart on Windows', async () => {
    setPlatform('win32');
    fetcher.run.mockResolvedValue({ stdout: '', stderr: '' });
    await restartWindows();
    expect(fetcher.run.mock.calls[0][0]).toBe('shutdown.exe');
    expect(fetcher.run.mock.calls[0][1].slice(0, 3)).toEqual(['/r', '/t', '10']);
  });
});
