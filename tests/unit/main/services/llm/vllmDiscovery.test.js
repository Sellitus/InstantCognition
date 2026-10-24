// vllmDiscovery — how far vLLM is from running on this machine.
//
// Boundaries mocked: child_process.execFile (nvidia-smi, the venv's python,
// the system python3 and gcc, all reached through engineFetch.run), fs for the
// managed venv's interpreter, electron for the userData root, and the WSL
// process wrappers wsl.wslState / wsl.execInDistro. The parsers, the GPU and
// prerequisite verdicts and the state order run for real.

const path = require('path');

jest.mock('electron', () => ({ app: { getPath: jest.fn(() => '/ud') } }));

jest.mock('child_process', () => ({ execFile: jest.fn() }));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, existsSync: jest.fn(() => false), statSync: jest.fn(() => ({ isFile: () => true })) };
});

const fs = require('fs');
const { execFile } = require('child_process');
const wsl = require('../../../../../main/services/llm/wsl');
const {
  detectVllm, isDiscoveredVllmPath, parseNvidiaSmi, gpuVerdict, parseVersionProbe,
  linuxPrereqProblem, MIN_DRIVER_MAJOR, LINUX_PACKAGES_HINT, VERSION_PROBE,
} = require('../../../../../main/services/llm/vllmDiscovery');

const MANAGED_PY = path.join('/ud', 'engines', 'vllm-venv', 'bin', 'python3');
const RTX = { name: 'NVIDIA GeForce RTX 5090', driver: '580.65.06' };

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
function setPlatform(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

// Answers execFile by program: each entry is stdout, an Error to fail with, or
// absent (ENOENT, as when the program is not installed).
function programs(table) {
  execFile.mockImplementation((file, args, opts, cb) => {
    const key = file === 'python3' || file === MANAGED_PY ? `${file} ${args[0]}` : file;
    const out = table[key];
    if (out instanceof Error) cb(out, '', '');
    else if (out === undefined) cb(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', '');
    else cb(null, out, '');
  });
}

function managedVenvInstalled(installed) {
  fs.existsSync.mockImplementation((p) => installed && p === MANAGED_PY);
}

const PREREQS_OK = JSON.stringify({ version: [3, 12], venv: true, headers: true });

beforeEach(() => {
  execFile.mockReset();
  fs.existsSync.mockReset();
  fs.existsSync.mockImplementation(() => false);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  jest.restoreAllMocks();
});

describe('parseNvidiaSmi', () => {
  test('splits each line at its last comma, so GPU names may contain commas', () => {
    expect(parseNvidiaSmi('NVIDIA RTX 6000 Ada, 48GB, 580.65.06\nNVIDIA GeForce RTX 4090, 575.51\n')).toEqual([
      { name: 'NVIDIA RTX 6000 Ada, 48GB', driver: '580.65.06' },
      { name: 'NVIDIA GeForce RTX 4090', driver: '575.51' },
    ]);
  });

  test('strips the NUL bytes of UTF-16 output and skips blank lines', () => {
    const utf16ish = 'N\u0000V\u0000I\u0000D\u0000I\u0000A\u0000 T4, 581.15\r\n\r\n';
    expect(parseNvidiaSmi(utf16ish)).toEqual([{ name: 'NVIDIA T4', driver: '581.15' }]);
  });

  test('a line without a comma keeps the name and reports no driver', () => {
    expect(parseNvidiaSmi('NVIDIA-SMI has failed')).toEqual([{ name: 'NVIDIA-SMI has failed', driver: '' }]);
  });

  test('empty output means no GPUs', () => {
    expect(parseNvidiaSmi('')).toEqual([]);
  });
});

describe('gpuVerdict', () => {
  test('the minimum driver is R580', () => {
    expect(MIN_DRIVER_MAJOR).toBe(580);
  });

  test('no GPUs is no-gpu', () => {
    const v = gpuVerdict([]);
    expect(v.state).toBe('no-gpu');
    expect(v.reason).toMatch(/^No NVIDIA GPU was found/);
  });

  test.each(['575.64.03', '579.99'])('driver %s is too old', (driver) => {
    const v = gpuVerdict([{ name: 'GPU', driver }]);
    expect(v.state).toBe('driver-old');
    expect(v.reason).toBe(`vLLM needs NVIDIA driver 580 or newer; this machine has ${driver}. Update it from nvidia.com/drivers.`);
  });

  test('an unreadable driver version counts as too old', () => {
    const v = gpuVerdict([{ name: 'GPU', driver: '' }]);
    expect(v.state).toBe('driver-old');
    expect(v.reason).toMatch(/this machine has an unknown version/);
  });

  test.each(['580.65.06', '590.1'])('driver %s is ok', (driver) => {
    expect(gpuVerdict([{ name: 'GPU', driver }])).toEqual({ state: 'ok' });
  });

  test('only the first GPU decides', () => {
    expect(gpuVerdict([{ name: 'A', driver: '570.1' }, { name: 'B', driver: '590.1' }]).state).toBe('driver-old');
  });
});

describe('parseVersionProbe', () => {
  test('returns the installed version', () => {
    expect(parseVersionProbe('{"version": "0.31.0"}\n')).toBe('0.31.0');
  });

  test('returns null when vllm is not installed', () => {
    expect(parseVersionProbe('{"version": null}')).toBeNull();
  });

  test('throws on output that is not the probe JSON', () => {
    expect(() => parseVersionProbe('Traceback (most recent call last):')).toThrow(/^Unexpected vLLM probe output: Traceback/);
  });
});

describe('linuxPrereqProblem', () => {
  test('a missing python3 names the apt packages to install, python3 included', () => {
    expect(linuxPrereqProblem(null, true)).toBe('Python 3 was not found. Install it with: sudo apt install python3 python3-venv python3-dev build-essential');
  });

  test.each([[[3, 9]], [[3, 15]], [[2, 7]]])('python %j is outside 3.10–3.14', (version) => {
    expect(linuxPrereqProblem({ version, venv: true, headers: true }, true))
      .toBe(`vLLM needs Python 3.10–3.14; python3 here is ${version[0]}.${version[1]}.`);
  });

  test.each([
    ['venv', { version: [3, 12], venv: false, headers: true }, true],
    ['headers', { version: [3, 12], venv: true, headers: false }, true],
    ['compiler', { version: [3, 12], venv: true, headers: true }, false],
  ])('missing %s points at the packages hint', (_what, probe, hasCompiler) => {
    expect(linuxPrereqProblem(probe, hasCompiler)).toBe(`vLLM needs Python's venv module, its headers and a C compiler. Install them with: ${LINUX_PACKAGES_HINT}`);
  });

  test.each([[[3, 10]], [[3, 14]]])('python %j with venv, headers and gcc is ready', (version) => {
    expect(linuxPrereqProblem({ version, venv: true, headers: true }, true)).toBeNull();
  });
});

describe('detectVllm', () => {
  test.each(['darwin', 'freebsd'])('%s is unsupported and probes nothing', async (platform) => {
    setPlatform(platform);
    expect(await detectVllm()).toEqual({
      available: false, pythonPath: null, setupState: 'unsupported', reason: 'vLLM needs an NVIDIA GPU on Linux or Windows.',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  describe('linux', () => {
    beforeEach(() => setPlatform('linux'));

    test('no nvidia-smi is no-gpu', async () => {
      programs({});
      const r = await detectVllm();
      expect(r).toEqual({ available: false, pythonPath: null, setupState: 'no-gpu', reason: expect.stringMatching(/^No NVIDIA GPU was found/) });
    });

    test('an old driver is driver-old and stops before any python probe', async () => {
      programs({ 'nvidia-smi': 'NVIDIA GeForce RTX 4090, 570.124.04\n' });
      managedVenvInstalled(true);
      const r = await detectVllm();
      expect(r.setupState).toBe('driver-old');
      expect(r.reason).toMatch(/has 570\.124\.04/);
      expect(execFile).toHaveBeenCalledTimes(1);
    });

    test('nvidia-smi is queried for name and driver only', async () => {
      programs({});
      await detectVllm();
      expect(execFile.mock.calls[0][0]).toBe('nvidia-smi');
      expect(execFile.mock.calls[0][1]).toEqual(['--query-gpu=name,driver_version', '--format=csv,noheader']);
    });

    test('the managed venv with vllm installed is ready', async () => {
      programs({ 'nvidia-smi': `${RTX.name}, ${RTX.driver}\n`, [`${MANAGED_PY} -c`]: '{"version": "0.31.0"}' });
      managedVenvInstalled(true);
      expect(await detectVllm()).toEqual({ available: true, pythonPath: MANAGED_PY, version: '0.31.0', setupState: 'ready', gpu: RTX });
      const probeCall = execFile.mock.calls.find((c) => c[0] === MANAGED_PY);
      expect(probeCall[1]).toEqual(['-c', VERSION_PROBE]);
    });

    test('the managed venv without vllm is not-installed', async () => {
      programs({ 'nvidia-smi': `${RTX.name}, ${RTX.driver}\n`, [`${MANAGED_PY} -c`]: '{"version": null}' });
      managedVenvInstalled(true);
      expect(await detectVllm()).toEqual({ available: false, pythonPath: null, setupState: 'not-installed', reason: 'vLLM is not installed yet.', gpu: RTX });
    });

    test('a managed venv probe that fails reaches the caller', async () => {
      programs({ 'nvidia-smi': `${RTX.name}, ${RTX.driver}\n`, [`${MANAGED_PY} -c`]: new Error('Segmentation fault') });
      managedVenvInstalled(true);
      await expect(detectVllm()).rejects.toThrow(/Segmentation fault/);
    });

    test('no venv and no system python3 is no-python with the install hint', async () => {
      programs({ 'nvidia-smi': `${RTX.name}, ${RTX.driver}\n`, gcc: 'gcc 13' });
      const r = await detectVllm();
      expect(r.setupState).toBe('no-python');
      expect(r.available).toBe(false);
      expect(r.reason).toContain('sudo apt install python3 python3-venv python3-dev build-essential');
      expect(r.gpu).toEqual(RTX);
    });

    test('no venv and no compiler is no-python with the packages hint', async () => {
      programs({ 'nvidia-smi': `${RTX.name}, ${RTX.driver}\n`, 'python3 -c': PREREQS_OK });
      const r = await detectVllm();
      expect(r.setupState).toBe('no-python');
      expect(r.reason).toContain(LINUX_PACKAGES_HINT);
    });

    test('no venv but a usable system python is not-installed', async () => {
      programs({ 'nvidia-smi': `${RTX.name}, ${RTX.driver}\n`, 'python3 -c': PREREQS_OK, gcc: 'gcc 13' });
      expect(await detectVllm()).toEqual({ available: false, pythonPath: null, setupState: 'not-installed', reason: 'vLLM is not installed yet.', gpu: RTX });
    });
  });

  describe('win32', () => {
    beforeEach(() => setPlatform('win32'));

    test('nvidia-smi.exe is the GPU probe; no GPU stops before WSL', async () => {
      programs({});
      const state = jest.spyOn(wsl, 'wslState');
      const r = await detectVllm();
      expect(execFile.mock.calls[0][0]).toBe('nvidia-smi.exe');
      expect(r.setupState).toBe('no-gpu');
      expect(state).not.toHaveBeenCalled();
    });

    test.each([
      ['wsl-missing', /Windows Subsystem for Linux is not installed/],
      ['reboot-required', /^Restart Windows/],
      ['distro-missing', /has not been created yet/],
    ])('WSL state %s passes through with its reason', async (state, reason) => {
      programs({ 'nvidia-smi.exe': `${RTX.name}, ${RTX.driver}\r\n` });
      jest.spyOn(wsl, 'wslState').mockResolvedValue(state);
      const exec = jest.spyOn(wsl, 'execInDistro');
      const r = await detectVllm();
      expect(r).toEqual({ available: false, pythonPath: null, setupState: state, reason: expect.stringMatching(reason), gpu: RTX });
      expect(exec).not.toHaveBeenCalled();
    });

    test('a ready distro with vllm in its venv is ready', async () => {
      programs({ 'nvidia-smi.exe': `${RTX.name}, ${RTX.driver}\r\n` });
      jest.spyOn(wsl, 'wslState').mockResolvedValue('ready');
      const exec = jest.spyOn(wsl, 'execInDistro').mockResolvedValue({ stdout: '{"version": "0.31.0"}\n', stderr: '' });
      expect(await detectVllm()).toEqual({ available: true, pythonPath: wsl.VENV_PYTHON, version: '0.31.0', setupState: 'ready', gpu: RTX });
      expect(exec).toHaveBeenCalledWith([wsl.VENV_PYTHON, '-c', VERSION_PROBE], expect.objectContaining({ timeoutMs: expect.any(Number) }));
    });

    test('a ready distro whose venv lacks vllm is not-installed', async () => {
      programs({ 'nvidia-smi.exe': `${RTX.name}, ${RTX.driver}\r\n` });
      jest.spyOn(wsl, 'wslState').mockResolvedValue('ready');
      jest.spyOn(wsl, 'execInDistro').mockResolvedValue({ stdout: '{"version": null}', stderr: '' });
      expect((await detectVllm()).setupState).toBe('not-installed');
    });

    test.each([
      'Command failed: /opt/instantcognition/vllm-venv/bin/python3: No such file or directory',
      'exec: python3: not found',
      'spawn ENOENT',
    ])('a missing venv (%s) is not-installed', async (message) => {
      programs({ 'nvidia-smi.exe': `${RTX.name}, ${RTX.driver}\r\n` });
      jest.spyOn(wsl, 'wslState').mockResolvedValue('ready');
      jest.spyOn(wsl, 'execInDistro').mockRejectedValue(new Error(message));
      expect(await detectVllm()).toEqual({ available: false, pythonPath: null, setupState: 'not-installed', reason: 'vLLM is not installed yet.', gpu: RTX });
    });

    test('any other WSL failure is rethrown, not reported as not-installed', async () => {
      programs({ 'nvidia-smi.exe': `${RTX.name}, ${RTX.driver}\r\n` });
      jest.spyOn(wsl, 'wslState').mockResolvedValue('ready');
      jest.spyOn(wsl, 'execInDistro').mockRejectedValue(new Error('The virtual machine could not be started (0x80370102)'));
      await expect(detectVllm()).rejects.toThrow('The virtual machine could not be started (0x80370102)');
    });
  });
});

describe('isDiscoveredVllmPath', () => {
  test('linux: only the managed venv interpreter is a detected path', () => {
    setPlatform('linux');
    managedVenvInstalled(true);
    expect(isDiscoveredVllmPath(MANAGED_PY)).toBe(true);
    expect(isDiscoveredVllmPath('/usr/bin/python3')).toBe(false);
  });

  test('linux: nothing is detected when the managed venv is absent', () => {
    setPlatform('linux');
    expect(isDiscoveredVllmPath(MANAGED_PY)).toBe(false);
  });

  test('win32: only the WSL venv interpreter is a detected path', () => {
    setPlatform('win32');
    expect(isDiscoveredVllmPath(wsl.VENV_PYTHON)).toBe(true);
    expect(isDiscoveredVllmPath('C:\\Python312\\python.exe')).toBe(false);
  });

  test('no path is never a detected one', () => {
    expect(isDiscoveredVllmPath(null)).toBe(false);
    expect(isDiscoveredVllmPath('')).toBe(false);
  });
});
