// mlxDiscovery — unit tests for the mlx-openai-server probe.
//
// Mock child_process.execFile and exercise the platform guards (darwin +
// arm64) and the dual-package JSON probe. The probe emits a
// { 'mlx-lm': v|null, 'mlx-openai-server': v|null } map; the runtime is
// available only when mlx-openai-server itself is installed, and its version
// is the one reported.

const { execFile } = require('child_process');
const { detectMlx } = require('../../../../../main/services/llm/mlxDiscovery');

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

function withPlatformArch(platform, arch, fn) {
  const realP = Object.getOwnPropertyDescriptor(process, 'platform');
  const realA = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  try { return fn(); } finally {
    if (realP) Object.defineProperty(process, 'platform', realP);
    if (realA) Object.defineProperty(process, 'arch', realA);
  }
}

function mockExecResult(stdout = '', error = null) {
  execFile.mockImplementationOnce((_file, _args, _opts, cb) => {
    cb(error, stdout, '');
    return undefined;
  });
}

const resolver = async () => '/venv/bin/python3';

describe('mlxDiscovery', () => {
  afterEach(() => { jest.clearAllMocks(); });

  test('short-circuits off macOS (no probe spawned)', async () => {
    const res = await withPlatformArch('linux', 'arm64', () => detectMlx(resolver));
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/macOS only/);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('short-circuits on x64 macs (Apple Silicon required)', async () => {
    const res = await withPlatformArch('darwin', 'x64', () => detectMlx(resolver));
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/Apple Silicon/);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('returns unavailable when python3 cannot be resolved', async () => {
    const res = await withPlatformArch('darwin', 'arm64', () => detectMlx(async () => null));
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/python3 not found/);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('reports not-installed when neither package is present', async () => {
    mockExecResult(JSON.stringify({ 'mlx-lm': null, 'mlx-openai-server': null }));
    const res = await withPlatformArch('darwin', 'arm64', () => detectMlx(resolver));
    expect(res.available).toBe(false);
    expect(res.pythonPath).toBe('/venv/bin/python3');
    expect(res.reason).toMatch(/mlx-openai-server not installed \(python at \/venv\/bin\/python3\)/);
  });

  test('available when BOTH packages installed; version is the server\'s, map surfaced', async () => {
    mockExecResult(JSON.stringify({ 'mlx-lm': '0.20.0', 'mlx-openai-server': '0.0.10' }));
    const res = await withPlatformArch('darwin', 'arm64', () => detectMlx(resolver));
    expect(res.available).toBe(true);
    expect(res.version).toBe('0.0.10');
    expect(res.packages).toEqual({ 'mlx-lm': '0.20.0', 'mlx-openai-server': '0.0.10' });
  });

  test('mlx-lm alone is not a runnable server: unavailable', async () => {
    mockExecResult(JSON.stringify({ 'mlx-lm': '0.20.0', 'mlx-openai-server': null }));
    const res = await withPlatformArch('darwin', 'arm64', () => detectMlx(resolver));
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/mlx-openai-server not installed/);
  });

  test('mlx-openai-server without a separately reported mlx-lm is still available', async () => {
    mockExecResult(JSON.stringify({ 'mlx-lm': null, 'mlx-openai-server': '1.4.0' }));
    const res = await withPlatformArch('darwin', 'arm64', () => detectMlx(resolver));
    expect(res.available).toBe(true);
    expect(res.version).toBe('1.4.0');
    expect(res.packages['mlx-lm']).toBeNull();
  });

  test('reports a timeout reason when the probe is killed (cold python start)', async () => {
    mockExecResult('', { killed: true, signal: 'SIGTERM' });
    const res = await withPlatformArch('darwin', 'arm64', () => detectMlx(resolver));
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/timed out/);
    expect(res.pythonPath).toBe('/venv/bin/python3');
  });
});
