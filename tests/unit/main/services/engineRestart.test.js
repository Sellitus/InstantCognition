// engineRestart — releasing a cached runtime path and restarting the running
// engine on a freshly installed runtime. The engine and busy predicate are plain
// fakes at the service boundary; timers are faked for the idle wait.

const { releasePinnedPath, repointStartOpts, canRestart, waitForIdle, restartOnNewRuntime } = require('../../../../main/services/llm/engineRestart');

function makeConfig(values) {
  const store = { ...values };
  return { store, get: (k, d) => (k in store ? store[k] : d), set: jest.fn((k, v) => { store[k] = v; }) };
}

function makeLlm(status, opts) {
  return {
    _lastStartOpts: opts,
    getStatus: jest.fn(() => status),
    reload: jest.fn(async () => ({ status: 'running' })),
  };
}

const running = (backend) => ({ status: 'running', backend, isRemote: false });

function makeDiscovery(resolved) {
  return { clearCache: jest.fn(), resolveBackendPath: jest.fn(async () => resolved), isDiscoveredPath: jest.fn(() => true) };
}

describe('releasePinnedPath', () => {
  test('clears a llama.cpp binary path detection produced', () => {
    const cfg = makeConfig({ 'settings.llm.llamaCpp.binaryPath': '/app/llama-server/llama-server' });

    releasePinnedPath(cfg, makeDiscovery(null), 'llamaCpp');

    expect(cfg.store['settings.llm.llamaCpp.binaryPath']).toBeNull();
  });

  test('keeps a path set by hand', () => {
    const cfg = makeConfig({ 'settings.llm.llamaCpp.binaryPath': '/opt/custom/llama-server' });
    const discovery = { isDiscoveredPath: jest.fn(() => false) };

    releasePinnedPath(cfg, discovery, 'llamaCpp');

    expect(cfg.set).not.toHaveBeenCalled();
    expect(discovery.isDiscoveredPath).toHaveBeenCalledWith('llamaCpp', '/opt/custom/llama-server');
  });

  // oMLX runs in its own interpreter, so an mlx-openai-server update must not
  // release oMLX's cached path, and vice versa.
  test('an mlx update clears only the mlx-openai-server cache', () => {
    const cfg = makeConfig({ 'settings.llm.mlxOpenAi.pythonPath': '/b/py', 'settings.llm.omlx.pythonPath': '/o/py' });

    releasePinnedPath(cfg, makeDiscovery(null), 'mlx');

    expect(cfg.store['settings.llm.mlxOpenAi.pythonPath']).toBeNull();
    expect(cfg.store['settings.llm.omlx.pythonPath']).toBe('/o/py');
  });

  test('an omlx update clears only the oMLX cache', () => {
    const cfg = makeConfig({ 'settings.llm.mlxOpenAi.pythonPath': '/b/py', 'settings.llm.omlx.pythonPath': '/o/py' });

    releasePinnedPath(cfg, makeDiscovery(null), 'omlx');

    expect(cfg.store['settings.llm.omlx.pythonPath']).toBeNull();
    expect(cfg.store['settings.llm.mlxOpenAi.pythonPath']).toBe('/b/py');
  });

  test('a vllm update clears the vLLM interpreter cache', () => {
    const cfg = makeConfig({ 'settings.llm.vllm.pythonPath': '/opt/instantcognition/vllm-venv/bin/python' });

    releasePinnedPath(cfg, makeDiscovery(null), 'vllm');

    expect(cfg.store['settings.llm.vllm.pythonPath']).toBeNull();
  });
});

describe('waitForIdle', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('resolves once the engine stops being busy', async () => {
    let busy = true;
    let done = false;
    const p = waitForIdle(() => busy, { pollMs: 1000, timeoutMs: 60000 }).then(() => { done = true; });

    await jest.advanceTimersByTimeAsync(3000);
    expect(done).toBe(false);
    busy = false;
    await jest.advanceTimersByTimeAsync(1000);
    await p;
    expect(done).toBe(true);
  });

  test('gives up with an error when the engine never goes idle', async () => {
    const p = waitForIdle(() => true, { pollMs: 1000, timeoutMs: 5000 });
    const assertion = expect(p).rejects.toThrow(/stayed busy/);

    await jest.advanceTimersByTimeAsync(6000);
    await assertion;
  });
});

describe('restartOnNewRuntime', () => {
  const idle = { pollMs: 1000, timeoutMs: 60000 };

  test('restarts the same model on the newly resolved runtime and persists it', async () => {
    const llm = makeLlm(running('llamaCpp'), { backend: 'llamaCpp', binaryPath: '/old/llama-server', modelPath: '/m.gguf', port: 8421 });
    const discovery = makeDiscovery('/engines/llama-server/b10831/llama-server');
    const cfg = makeConfig({});

    const r = await restartOnNewRuntime({ engine: 'llamaCpp', llmService: llm, isBusy: () => false, discovery, configService: cfg, idle });

    expect(r).toEqual({ restarted: true, model: '/m.gguf' });
    expect(discovery.clearCache).toHaveBeenCalled();
    expect(discovery.resolveBackendPath).toHaveBeenCalledWith('llamaCpp', null);
    expect(llm.reload).toHaveBeenCalledWith({ backend: 'llamaCpp', binaryPath: '/engines/llama-server/b10831/llama-server', modelPath: '/m.gguf', port: 8421 });
    expect(cfg.store['settings.llm.llamaCpp.binaryPath']).toBe('/engines/llama-server/b10831/llama-server');
    expect(cfg.store['settings.llm.lastModel']).toBe('/m.gguf');
  });

  test('leaves a fallback on the other MLX runtime on its own interpreter', async () => {
    const llm = makeLlm(running('mlxOpenAi'), {
      backend: 'mlxOpenAi', pythonPath: '/old/py', modelPath: '/m', port: 8421,
      fallbackChain: [{ backend: 'omlx', opts: { backend: 'omlx', pythonPath: '/omlx/py', modelPath: '/m' } }],
    });

    await restartOnNewRuntime({ engine: 'mlx', llmService: llm, isBusy: () => false, discovery: makeDiscovery('/new/py'), configService: makeConfig({}), idle });

    const opts = llm.reload.mock.calls[0][0];
    expect(opts.pythonPath).toBe('/new/py');
    expect(opts.fallbackChain[0].opts.pythonPath).toBe('/omlx/py');
  });

  test('restarts a running oMLX on its new interpreter', async () => {
    const llm = makeLlm(running('omlx'), { backend: 'omlx', pythonPath: '/old/omlx/py', modelPath: '/m', port: 8421 });
    const discovery = makeDiscovery('/engines/omlx-venv/bin/python3');
    const cfg = makeConfig({});

    const r = await restartOnNewRuntime({ engine: 'omlx', llmService: llm, isBusy: () => false, discovery, configService: cfg, idle });

    expect(r).toEqual({ restarted: true, model: '/m' });
    expect(discovery.resolveBackendPath).toHaveBeenCalledWith('omlx', null);
    expect(llm.reload.mock.calls[0][0].pythonPath).toBe('/engines/omlx-venv/bin/python3');
    expect(cfg.store['settings.llm.omlx.pythonPath']).toBe('/engines/omlx-venv/bin/python3');
  });

  test('waits for the in-flight reply before restarting', async () => {
    jest.useFakeTimers();
    let busy = true;
    const llm = makeLlm(running('llamaCpp'), { backend: 'llamaCpp', binaryPath: '/old', modelPath: '/m', port: 1 });
    const p = restartOnNewRuntime({ engine: 'llamaCpp', llmService: llm, isBusy: () => busy, discovery: makeDiscovery('/new'), configService: makeConfig({}), idle });

    await jest.advanceTimersByTimeAsync(2000);
    expect(llm.reload).not.toHaveBeenCalled();
    busy = false;
    await jest.advanceTimersByTimeAsync(1000);
    await p;
    jest.useRealTimers();
    expect(llm.reload).toHaveBeenCalled();
  });

  test('leaves an engine on a hand-set runtime path alone, config included', async () => {
    const llm = makeLlm(running('llamaCpp'), { backend: 'llamaCpp', binaryPath: '/Users/me/llama/llama-server', modelPath: '/m', port: 1 });
    const discovery = makeDiscovery('/engines/llama-server/b10831/llama-server');
    discovery.isDiscoveredPath.mockReturnValue(false);
    const cfg = makeConfig({ 'settings.llm.llamaCpp.binaryPath': '/Users/me/llama/llama-server' });

    const r = await restartOnNewRuntime({ engine: 'llamaCpp', llmService: llm, isBusy: () => false, discovery, configService: cfg, idle });

    expect(r).toEqual({ restarted: false });
    expect(llm.reload).not.toHaveBeenCalled();
    expect(cfg.set).not.toHaveBeenCalled();
  });

  test('does not restart an old model the user switched away from while waiting', async () => {
    jest.useFakeTimers();
    let busy = true;
    const llm = makeLlm(running('llamaCpp'), { backend: 'llamaCpp', binaryPath: '/old', modelPath: '/a.gguf', port: 1 });
    const p = restartOnNewRuntime({ engine: 'llamaCpp', llmService: llm, isBusy: () => busy, discovery: makeDiscovery('/new'), configService: makeConfig({}), idle });

    await jest.advanceTimersByTimeAsync(1000);
    llm._lastStartOpts = { backend: 'llamaCpp', binaryPath: '/old', modelPath: '/b.gguf', port: 1 };
    busy = false;
    await jest.advanceTimersByTimeAsync(1000);
    const r = await p;
    jest.useRealTimers();

    expect(r).toEqual({ restarted: false });
    expect(llm.reload).not.toHaveBeenCalled();
  });

  test('resolves the new runtime before waiting, so nothing slips between idle and stop', async () => {
    jest.useFakeTimers();
    let busy = true;
    const llm = makeLlm(running('llamaCpp'), { backend: 'llamaCpp', binaryPath: '/old', modelPath: '/m', port: 1 });
    const discovery = makeDiscovery('/new');
    const p = restartOnNewRuntime({ engine: 'llamaCpp', llmService: llm, isBusy: () => busy, discovery, configService: makeConfig({}), idle });

    await jest.advanceTimersByTimeAsync(0);
    expect(discovery.resolveBackendPath).toHaveBeenCalled();
    busy = false;
    await jest.advanceTimersByTimeAsync(1000);
    await p;
    jest.useRealTimers();
    expect(llm.reload).toHaveBeenCalled();
  });

  test('does nothing when a different runtime is running', async () => {
    const llm = makeLlm(running('mlxOpenAi'), { backend: 'mlxOpenAi', pythonPath: '/py', modelPath: '/m', port: 1 });

    const r = await restartOnNewRuntime({ engine: 'llamaCpp', llmService: llm, isBusy: () => false, discovery: makeDiscovery('/new'), configService: makeConfig({}), idle });

    expect(r).toEqual({ restarted: false });
    expect(llm.reload).not.toHaveBeenCalled();
  });

  test('does nothing when the user stopped the engine while waiting', async () => {
    jest.useFakeTimers();
    let busy = true;
    const status = running('llamaCpp');
    const llm = makeLlm(status, { backend: 'llamaCpp', binaryPath: '/old', modelPath: '/m', port: 1 });
    const p = restartOnNewRuntime({ engine: 'llamaCpp', llmService: llm, isBusy: () => busy, discovery: makeDiscovery('/new'), configService: makeConfig({}), idle });

    await jest.advanceTimersByTimeAsync(1000);
    status.status = 'stopped';
    busy = false;
    await jest.advanceTimersByTimeAsync(1000);
    const r = await p;
    jest.useRealTimers();
    expect(r).toEqual({ restarted: false });
    expect(llm.reload).not.toHaveBeenCalled();
  });

  test('refuses to stop the engine when the new runtime cannot be found', async () => {
    const llm = makeLlm(running('llamaCpp'), { backend: 'llamaCpp', binaryPath: '/old', modelPath: '/m', port: 1 });

    await expect(restartOnNewRuntime({ engine: 'llamaCpp', llmService: llm, isBusy: () => false, discovery: makeDiscovery(null), configService: makeConfig({}), idle }))
      .rejects.toThrow(/could not be found/);
    expect(llm.reload).not.toHaveBeenCalled();
  });
});

describe('canRestart', () => {
  test('only a running engine of that runtime on a detected path can be restarted', () => {
    const discovery = makeDiscovery('/new');
    const opts = { backend: 'llamaCpp', binaryPath: '/bundled/llama-server', modelPath: '/m' };
    expect(canRestart({ engine: 'llamaCpp', llmService: makeLlm(running('llamaCpp'), opts), discovery })).toBe(true);
    expect(canRestart({ engine: 'mlx', llmService: makeLlm(running('llamaCpp'), opts), discovery })).toBe(false);
    expect(canRestart({ engine: 'llamaCpp', llmService: makeLlm({ status: 'stopped', backend: 'llamaCpp' }, opts), discovery })).toBe(false);
    expect(canRestart({ engine: 'llamaCpp', llmService: makeLlm({ ...running('llamaCpp'), isRemote: true }, opts), discovery })).toBe(false);
    discovery.isDiscoveredPath.mockReturnValue(false);
    expect(canRestart({ engine: 'llamaCpp', llmService: makeLlm(running('llamaCpp'), opts), discovery })).toBe(false);
  });
});

describe('repointStartOpts', () => {
  test('points the last start and a parked hide snapshot at the new runtime', async () => {
    const opts = { backend: 'llamaCpp', binaryPath: '/bundled/llama-server', modelPath: '/m', port: 1 };
    const llm = /** @type {any} */ (makeLlm({ status: 'stopped', backend: 'llamaCpp' }, { ...opts }));
    llm._pauseSnapshot = { opts: { ...opts } };

    await repointStartOpts({ engine: 'llamaCpp', llmService: llm, discovery: makeDiscovery('/engines/b2/llama-server') });

    expect(llm._lastStartOpts).toEqual({ ...opts, binaryPath: '/engines/b2/llama-server' });
    expect(llm._pauseSnapshot.opts).toEqual({ ...opts, binaryPath: '/engines/b2/llama-server' });
  });

  test('keeps a hand-set path and another runtime\'s options untouched', async () => {
    const custom = { backend: 'llamaCpp', binaryPath: '/Users/me/llama-server', modelPath: '/m' };
    const llm = /** @type {any} */ (makeLlm(running('llamaCpp'), { ...custom }));
    llm._pauseSnapshot = { opts: { backend: 'mlxOpenAi', pythonPath: '/py', modelPath: '/m' } };
    const discovery = makeDiscovery('/engines/b2/llama-server');
    discovery.isDiscoveredPath.mockImplementation((_e, p) => p !== '/Users/me/llama-server');

    await repointStartOpts({ engine: 'llamaCpp', llmService: llm, discovery });

    expect(llm._lastStartOpts).toEqual(custom);
    expect(llm._pauseSnapshot.opts.pythonPath).toBe('/py');
  });
});
