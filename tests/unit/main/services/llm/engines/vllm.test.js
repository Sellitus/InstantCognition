// engines/vllm — the vLLM updater adapter. Boundaries: PyPI (engineFetch
// getJson) and the discovery probe; install delegates to the guided setup
// (vllmSetup.runSetup, covered by its own suite), mocked here to its result.

jest.mock('../../../../../../main/services/llm/engineFetch', () => ({ getJson: jest.fn() }));
jest.mock('../../../../../../main/services/llm/vllmSetup', () => ({ runSetup: jest.fn() }));

const fetcher = require('../../../../../../main/services/llm/engineFetch');
const { runSetup } = require('../../../../../../main/services/llm/vllmSetup');
const discovery = require('../../../../../../main/services/EngineDiscoveryService');
const vllm = require('../../../../../../main/services/llm/engines/vllm');

beforeEach(() => { jest.spyOn(discovery, 'clearCache').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); jest.resetAllMocks(); });

describe('check', () => {
  test('a machine still needing guided setup is reported, PyPI is not asked', async () => {
    jest.spyOn(discovery, 'detectVllm').mockResolvedValue({ available: false, setupState: 'wsl-missing', reason: 'Install WSL' });
    const row = await vllm.check({ latest: {} });
    expect(row).toEqual({ engine: 'vllm', ok: true, name: 'vLLM', current: 'not set up', latest: null, updateAvailable: false, setupState: 'wsl-missing', reason: 'Install WSL' });
    expect(fetcher.getJson).not.toHaveBeenCalled();
  });

  test('not installed: the PyPI version is offered', async () => {
    jest.spyOn(discovery, 'detectVllm').mockResolvedValue({ available: false, setupState: 'not-installed' });
    fetcher.getJson.mockResolvedValue({ info: { version: '0.31.0' } });
    const ctx = { latest: {} };
    expect(await vllm.check(ctx)).toMatchObject({ current: 'not installed', latest: '0.31.0', updateAvailable: true });
    expect(fetcher.getJson).toHaveBeenCalledWith('https://pypi.org/pypi/vllm/json');
    expect(ctx.latest.vllm).toBe('0.31.0');
  });

  test('installed: update only when PyPI is newer', async () => {
    const detect = jest.spyOn(discovery, 'detectVllm').mockResolvedValue({ available: true, setupState: 'ready', version: '0.31.0' });
    fetcher.getJson.mockResolvedValue({ info: { version: '0.31.0' } });
    expect((await vllm.check({ latest: {} })).updateAvailable).toBe(false);
    detect.mockResolvedValue({ available: true, setupState: 'ready', version: '0.30.2' });
    expect((await vllm.check({ latest: {} })).updateAvailable).toBe(true);
  });

  test('PyPI without a version is an error', async () => {
    jest.spyOn(discovery, 'detectVllm').mockResolvedValue({ available: true, setupState: 'ready', version: '1.0.0' });
    fetcher.getJson.mockResolvedValue({ info: {} });
    await expect(vllm.check({ latest: {} })).rejects.toThrow('PyPI did not report a version for vllm.');
  });
});

describe('install', () => {
  test('runs setup with upgrade and relays progress as installing events', async () => {
    runSetup.mockImplementation(async ({ send }) => { send({ step: 'Installing vLLM' }); return { state: 'ready', version: '0.31.0' }; });
    const sent = [];
    await expect(vllm.install({ send: (p) => sent.push(p) })).resolves.toBe('0.31.0');
    expect(runSetup.mock.calls[0][0].upgrade).toBe(true);
    expect(sent).toEqual([{ ok: true, status: 'installing', engine: 'vllm', step: 'Installing vLLM' }]);
    expect(discovery.clearCache).toHaveBeenCalled();
  });

  test('setup that stops short of ready fails with its reason', async () => {
    runSetup.mockResolvedValue({ state: 'reboot-required', reason: 'Restart Windows' });
    await expect(vllm.install({ send: () => {} })).rejects.toThrow('Restart Windows');
    runSetup.mockResolvedValue({ state: 'reboot-required' });
    await expect(vllm.install({ send: () => {} })).rejects.toThrow('vLLM setup stopped at "reboot-required".');
    expect(discovery.clearCache).not.toHaveBeenCalled();
  });
});

test('supported on Linux and Windows only', () => {
  expect(vllm.supported('linux')).toBe(true);
  expect(vllm.supported('win32')).toBe(true);
  expect(vllm.supported('darwin')).toBe(false);
});
