// omlxDiscovery — where an oMLX install is found and how its version is read.
// Boundaries: child_process.execFile (the `-m omlx.cli --version` probe), the
// filesystem (a virtual file set behind fs.existsSync/statSync), Electron's
// userData path, PATH and the platform/arch.

const fs = require('fs');
const path = require('path');

jest.mock('child_process', () => ({ execFile: jest.fn() }));

const { execFile } = require('child_process');
const { app } = require('electron');
const { detectOmlx, isDiscoveredOmlxPath, bundledOmlxPythonCandidates, OMLX_VERSION_TIMEOUT_MS } = require('../../../../../main/services/llm/omlxDiscovery');

const USER_DATA = '/ud';
const MANAGED_PY = path.join(USER_DATA, 'engines', 'omlx-venv', 'bin', 'python3');
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const realArch = Object.getOwnPropertyDescriptor(process, 'arch');
const realPath = process.env.PATH;

let files;
function addPython(py) { files.add(py); files.add(path.join(path.dirname(py), 'omlx')); }
function setHost(platform, arch) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}
function versionAnswer(error, stdout = '', stderr = '') {
  execFile.mockImplementationOnce((_f, _a, _o, cb) => { cb(error, stdout, stderr); });
}

beforeEach(() => {
  files = new Set();
  setHost('darwin', 'arm64');
  process.env.PATH = '';
  jest.spyOn(app, 'getPath').mockReturnValue(USER_DATA);
  jest.spyOn(fs, 'existsSync').mockImplementation((p) => files.has(p));
  jest.spyOn(fs, 'statSync').mockImplementation((p) => {
    if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isFile: () => true };
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  Object.defineProperty(process, 'arch', realArch);
  process.env.PATH = realPath;
  jest.restoreAllMocks();
  execFile.mockReset();
});

describe('detectOmlx', () => {
  test('macOS only, Apple Silicon only, without probing', async () => {
    setHost('linux', 'arm64');
    await expect(detectOmlx()).resolves.toMatchObject({ available: false, reason: 'macOS only' });
    setHost('darwin', 'x64');
    await expect(detectOmlx()).resolves.toMatchObject({ available: false, reason: 'Apple Silicon required' });
    expect(execFile).not.toHaveBeenCalled();
  });

  test('nothing installed', async () => {
    await expect(detectOmlx()).resolves.toEqual({ available: false, pythonPath: null, reason: 'oMLX not installed' });
  });

  test('the managed venv wins over the bundled runtime and is probed with -I -m omlx.cli', async () => {
    addPython(bundledOmlxPythonCandidates()[0]);
    addPython(MANAGED_PY);
    versionAnswer(null, 'omlx 0.7.1\n');
    await expect(detectOmlx()).resolves.toEqual({ available: true, pythonPath: MANAGED_PY, version: '0.7.1' });
    const [file, args, opts] = execFile.mock.calls[0];
    expect(file).toBe(MANAGED_PY);
    expect(args).toEqual(['-I', '-m', 'omlx.cli', '--version']);
    expect(opts.timeout).toBe(OMLX_VERSION_TIMEOUT_MS);
  });

  test('an interpreter without the omlx script beside it is skipped', async () => {
    files.add(MANAGED_PY);
    const bundled = bundledOmlxPythonCandidates()[0];
    addPython(bundled);
    versionAnswer(null, '0.7.0');
    await expect(detectOmlx()).resolves.toMatchObject({ pythonPath: bundled, version: '0.7.0' });
  });

  test('an omlx on PATH resolves to the interpreter of the venv that owns it', async () => {
    const venvBin = '/opt/venv/bin';
    files.add(path.join('/usr/local/bin', 'omlx'));
    addPython(path.join(venvBin, 'python3'));
    process.env.PATH = '/usr/local/bin';
    jest.spyOn(fs, 'realpathSync').mockReturnValue(path.join(venvBin, 'omlx'));
    versionAnswer(null, '0.6.9');
    await expect(detectOmlx()).resolves.toMatchObject({ available: true, pythonPath: path.join(venvBin, 'python3') });
  });

  test('a timed-out probe is reported as a timeout', async () => {
    addPython(MANAGED_PY);
    versionAnswer(Object.assign(new Error('killed'), { killed: true }));
    const res = await detectOmlx();
    expect(res.available).toBe(false);
    expect(res.reason).toBe(`oMLX at ${MANAGED_PY} did not run: omlx --version timed out after ${OMLX_VERSION_TIMEOUT_MS}ms`);
  });

  test('a failing probe reports the last stderr line', async () => {
    addPython(MANAGED_PY);
    versionAnswer(new Error('exit 1'), '', 'Traceback\nModuleNotFoundError: No module named mlx\n');
    await expect(detectOmlx()).resolves.toMatchObject({ available: false, reason: expect.stringMatching(/No module named mlx$/) });
  });

  test('output without a version is unrecognised', async () => {
    addPython(MANAGED_PY);
    versionAnswer(null, 'usage: omlx');
    await expect(detectOmlx()).resolves.toMatchObject({ available: false, reason: expect.stringContaining('unrecognised omlx --version output: usage: omlx') });
  });
});

describe('isDiscoveredOmlxPath', () => {
  test('true for the managed and bundled interpreters, false otherwise', () => {
    files.add(MANAGED_PY);
    expect(isDiscoveredOmlxPath(MANAGED_PY)).toBe(true);
    expect(isDiscoveredOmlxPath(bundledOmlxPythonCandidates()[0])).toBe(true);
    expect(isDiscoveredOmlxPath('/usr/bin/python3')).toBe(false);
    expect(isDiscoveredOmlxPath(null)).toBe(false);
  });
});
