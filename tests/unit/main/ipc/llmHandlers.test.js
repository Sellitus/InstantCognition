jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    dialog: { showOpenDialog: jest.fn() },
    shell: { openPath: jest.fn().mockResolvedValue('') },
  };
});

// LLMClientService.listModels performs an HTTP fetch (network boundary) — mock it.
jest.mock('../../../../main/services/LLMClientService', () => ({
  listModels: jest.fn(),
}));

const { ipcMain, dialog, shell } = require('electron');
const llmClient = require('../../../../main/services/LLMClientService');
const { register } = require('../../../../main/ipc/llmHandlers');

function makeLlmService() {
  const listeners = {};
  return {
    _listeners: listeners,
    on: jest.fn((evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); }),
    emit: (evt, payload) => { (listeners[evt] || []).forEach((fn) => fn(payload)); },
    getStatus: jest.fn(() => ({ running: true, backend: 'llamaCpp' })),
    getEndpoint: jest.fn(() => 'http://127.0.0.1:8080'),
    getLogs: jest.fn(() => ['log1']),
    start: jest.fn(async () => ({ running: true })),
    stop: jest.fn(async () => {}),
    setRemoteEndpoint: jest.fn(),
    clearRemoteEndpoint: jest.fn(),
  };
}

describe('llmHandlers', () => {
  let llmService;
  let modelManagerService;
  let engineDiscoveryService;
  let configService;
  let mainWindow;

  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });

    llmService = makeLlmService();
    modelManagerService = {
      _listeners: {},
      on: jest.fn(function (evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); }),
      emit(evt) { (this._listeners[evt] || []).forEach((fn) => fn()); },
      getModelsDir: jest.fn(() => '/models'),
      setModelsDir: jest.fn(),
      listModels: jest.fn(() => [{ name: 'm1' }]),
      ensureModelsDir: jest.fn(() => '/models'),
      importModel: jest.fn(() => ({ name: 'imported' })),
      deleteModel: jest.fn(() => true),
      resolveModelInfo: jest.fn(() => ({})),
    };
    engineDiscoveryService = {
      getPlatformCapabilities: jest.fn(() => ({ mlx: false })),
      detectEngines: jest.fn(() => ({ llamaCpp: true })),
      resolveBackendPath: jest.fn(async (_b, p) => p || '/resolved/path'),
    };
    const store = {};
    configService = {
      get: jest.fn((k, d) => (k in store ? store[k] : d)),
      set: jest.fn((k, v) => { store[k] = v; }),
      _store: store,
    };
    mainWindow = { isDestroyed: jest.fn(() => false), webContents: { send: jest.fn() } };

    register(mainWindow, { llmService, modelManagerService, engineDiscoveryService, configService });
  });

  test('no-ops when llmService missing', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow, { modelManagerService, engineDiscoveryService });
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('no-ops when modelManagerService missing', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow, { llmService, engineDiscoveryService });
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('no-ops when engineDiscoveryService missing', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow, { llmService, modelManagerService });
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  describe('event relay → renderer', () => {
    test('status-change relays as llm:status-changed', () => {
      llmService.emit('status-change', { running: true });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('llm:status-changed', { running: true });
    });

    test('log relays as llm:log', () => {
      llmService.emit('log', { line: 'x' });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('llm:log', { line: 'x' });
    });

    test('error relays with message string from Error', () => {
      llmService.emit('error', new Error('explode'));
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('llm:error', { message: 'explode' });
    });

    test('error relays with String() fallback when no message', () => {
      llmService.emit('error', 'rawstr');
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('llm:error', { message: 'rawstr' });
    });

    test('model-loaded / endpoint-changed / fallback relay', () => {
      llmService.emit('model-loaded', { m: 1 });
      llmService.emit('endpoint-changed', { e: 2 });
      llmService.emit('fallback', { f: 3 });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('llm:model-loaded', { m: 1 });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('llm:endpoint-changed', { e: 2 });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('llm:fallback', { f: 3 });
    });

    test('models-changed relays null', () => {
      modelManagerService.emit('models-changed');
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('llm:models-changed', null);
    });

    test('send guards against destroyed window', () => {
      mainWindow.isDestroyed.mockReturnValue(true);
      llmService.emit('status-change', { x: 1 });
      expect(mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    test('send guards when mainWindow is falsy', () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      const ls = makeLlmService();
      register(null, { llmService: ls, modelManagerService, engineDiscoveryService, configService });
      expect(() => ls.emit('status-change', {})).not.toThrow();
    });
  });

  describe('simple passthrough handlers', () => {
    test('llm:get-status', async () => {
      expect(await ipcMain._handlers['llm:get-status']()).toEqual({ running: true, backend: 'llamaCpp' });
    });
    test('llm:get-endpoint', async () => {
      expect(await ipcMain._handlers['llm:get-endpoint']()).toBe('http://127.0.0.1:8080');
    });
    test('llm:get-logs', async () => {
      expect(await ipcMain._handlers['llm:get-logs']()).toEqual(['log1']);
    });
    test('llm:get-capabilities', async () => {
      expect(await ipcMain._handlers['llm:get-capabilities']()).toEqual({ mlx: false });
    });
    test('llm:detect-engines passes force flag', async () => {
      await ipcMain._handlers['llm:detect-engines']({}, { force: true });
      expect(engineDiscoveryService.detectEngines).toHaveBeenCalledWith({ force: true });
    });
    test('llm:detect-engines defaults force false when opts omitted', async () => {
      await ipcMain._handlers['llm:detect-engines']({});
      expect(engineDiscoveryService.detectEngines).toHaveBeenCalledWith({ force: false });
    });
    test('llm:delete-model forwards path', async () => {
      expect(await ipcMain._handlers['llm:delete-model']({}, '/m.gguf')).toBe(true);
      expect(modelManagerService.deleteModel).toHaveBeenCalledWith('/m.gguf');
    });
  });

  describe('llm:list-models', () => {
    test('uses default models dir when no custom dir', async () => {
      const r = await ipcMain._handlers['llm:list-models']();
      expect(modelManagerService.setModelsDir).not.toHaveBeenCalled();
      expect(r).toEqual([{ name: 'm1' }]);
    });

    test('switches to custom dir when different', async () => {
      configService.get.mockImplementation((k) => (k === 'settings.llm.modelsDir' ? '/custom' : null));
      await ipcMain._handlers['llm:list-models']();
      expect(modelManagerService.setModelsDir).toHaveBeenCalledWith('/custom');
    });

    test('does not switch when custom dir equals current', async () => {
      configService.get.mockImplementation((k) => (k === 'settings.llm.modelsDir' ? '/models' : null));
      await ipcMain._handlers['llm:list-models']();
      expect(modelManagerService.setModelsDir).not.toHaveBeenCalled();
    });

    test('works without configService', async () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { llmService, modelManagerService, engineDiscoveryService });
      const r = await ipcMain._handlers['llm:list-models']();
      expect(r).toEqual([{ name: 'm1' }]);
    });
  });

  describe('llm:open-models-dir', () => {
    test('opens dir via shell', async () => {
      const r = await ipcMain._handlers['llm:open-models-dir']();
      expect(modelManagerService.ensureModelsDir).toHaveBeenCalled();
      expect(shell.openPath).toHaveBeenCalledWith('/models');
      expect(r).toBe('/models');
    });

    test('rejects with the reason when shell.openPath reports a failure string', async () => {
      shell.openPath.mockResolvedValue('No application is associated with the folder');
      await expect(ipcMain._handlers['llm:open-models-dir']())
        .rejects.toThrow('Could not open /models: No application is associated with the folder');
    });

    test('a rejecting shell.openPath reaches the caller', async () => {
      shell.openPath.mockRejectedValue(new Error('no opener'));
      await expect(ipcMain._handlers['llm:open-models-dir']()).rejects.toThrow('no opener');
    });
  });

  describe('llm:import-model', () => {
    test('GGUF dialog for non-mlx backend, imports first file', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a.gguf'] });
      const r = await ipcMain._handlers['llm:import-model']({}, { backend: 'llamaCpp' });
      expect(dialog.showOpenDialog).toHaveBeenCalledWith(mainWindow, expect.objectContaining({
        properties: ['openFile', 'multiSelections'],
      }));
      expect(modelManagerService.importModel).toHaveBeenCalledWith('/a.gguf');
      expect(r).toEqual({ name: 'imported' });
    });

    test.each(['mlxOpenAi', 'omlx'])('directory dialog for the %s backend', async (backend) => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/mlxdir'] });
      await ipcMain._handlers['llm:import-model']({}, { backend });
      expect(dialog.showOpenDialog).toHaveBeenCalledWith(mainWindow, {
        title: 'Import MLX model folder', properties: ['openDirectory'],
      });
      expect(modelManagerService.importModel).toHaveBeenCalledWith('/mlxdir');
    });

    test('vllm imports a model folder, not a .gguf file', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/hfdir'] });
      await ipcMain._handlers['llm:import-model']({}, { backend: 'vllm' });
      expect(dialog.showOpenDialog).toHaveBeenCalledWith(mainWindow, {
        title: 'Import model folder', properties: ['openDirectory'],
      });
    });

    test('directory dialog for backend === "mlx"', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/mlxdir'] });
      await ipcMain._handlers['llm:import-model']({}, { backend: 'mlx' });
      expect(dialog.showOpenDialog).toHaveBeenCalledWith(mainWindow, expect.objectContaining({
        properties: ['openDirectory'],
      }));
    });

    test('returns null on cancel', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
      const r = await ipcMain._handlers['llm:import-model']({}, {});
      expect(r).toBeNull();
      expect(modelManagerService.importModel).not.toHaveBeenCalled();
    });

    test('returns null when no file paths', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
      const r = await ipcMain._handlers['llm:import-model']({});
      expect(r).toBeNull();
    });
  });

  describe('llm:start', () => {
    test('starts llamaCpp backend with resolved binary path', async () => {
      const r = await ipcMain._handlers['llm:start']({}, { backend: 'llamaCpp', modelPath: '/m.gguf' });
      expect(engineDiscoveryService.resolveBackendPath).toHaveBeenCalledWith('llamaCpp', undefined);
      expect(llmService.start).toHaveBeenCalled();
      expect(r).toEqual({ running: true });
    });

    test('throws when llama.cpp binary not found', async () => {
      engineDiscoveryService.resolveBackendPath.mockResolvedValue(null);
      await expect(ipcMain._handlers['llm:start']({}, { backend: 'llamaCpp', modelPath: '/m.gguf' }))
        .rejects.toThrow(/llama\.cpp server binary not found/);
    });

    test('throws when mlx-openai-server is not detected', async () => {
      engineDiscoveryService.resolveBackendPath.mockResolvedValue(null);
      await expect(ipcMain._handlers['llm:start']({}, { backend: 'mlxOpenAi', modelPath: '/m' }))
        .rejects.toThrow(/mlx-openai-server not detected/);
      expect(llmService.start).not.toHaveBeenCalled();
    });

    test('throws an oMLX-specific message when omlx is not detected', async () => {
      engineDiscoveryService.resolveBackendPath.mockResolvedValue(null);
      await expect(ipcMain._handlers['llm:start']({}, { backend: 'omlx', modelPath: '/m' }))
        .rejects.toThrow(/^oMLX not detected/);
    });

    test.each(['mlxOpenAi', 'omlx'])('%s resolves its python path then starts', async (backend) => {
      engineDiscoveryService.resolveBackendPath.mockResolvedValue('/py');
      const r = await ipcMain._handlers['llm:start']({}, { backend, modelPath: '/m' });
      expect(engineDiscoveryService.resolveBackendPath).toHaveBeenCalledWith(backend, undefined);
      expect(llmService.start.mock.calls[0][0].pythonPath).toBe('/py');
      expect(r).toEqual({ running: true });
    });

    // Regression: vLLM is a python backend (isPythonBackend) and must go through
    // pythonPath resolution — NOT the llamaCpp binaryPath branch. Before the fix,
    // vLLM fell into the else and tried to resolve a llama-server binary, then
    // LLMManager.start threw 'pythonPath required'. This locks the python branch.
    test('vllm backend resolves python path then starts (not llamaCpp binary)', async () => {
      engineDiscoveryService.resolveBackendPath.mockResolvedValue('/usr/bin/python3');
      const r = await ipcMain._handlers['llm:start']({}, { backend: 'vllm', modelPath: '/m' });
      expect(engineDiscoveryService.resolveBackendPath).toHaveBeenCalledWith('vllm', undefined);
      expect(llmService.start).toHaveBeenCalled();
      const passed = llmService.start.mock.calls[0][0];
      expect(passed.pythonPath).toBe('/usr/bin/python3');
      expect(r).toEqual({ running: true });
    });

    test('throws a vLLM-specific message when vllm is not detected', async () => {
      engineDiscoveryService.resolveBackendPath.mockResolvedValue(null);
      await expect(ipcMain._handlers['llm:start']({}, { backend: 'vllm', modelPath: '/m' }))
        .rejects.toThrow(/vLLM is not set up\. .*"Set up vLLM"/);
    });

    test('throws when no model selected', async () => {
      await expect(ipcMain._handlers['llm:start']({}, { backend: 'llamaCpp' }))
        .rejects.toThrow(/No model selected/);
    });

    test('applies mmproj path from model info for llamaCpp', async () => {
      modelManagerService.resolveModelInfo.mockReturnValue({ mmprojPath: '/mm.gguf' });
      await ipcMain._handlers['llm:start']({}, { backend: 'llamaCpp', modelPath: '/m.gguf' });
      const passed = llmService.start.mock.calls[0][0];
      expect(passed.mmprojPath).toBe('/mm.gguf');
    });

    test('works without configService (cfg defaults to {})', async () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { llmService, modelManagerService, engineDiscoveryService });
      const r = await ipcMain._handlers['llm:start']({}, { backend: 'llamaCpp', modelPath: '/m.gguf' });
      expect(r).toEqual({ running: true });
    });
  });

  describe('llm:stop', () => {
    test('stops and returns status', async () => {
      const r = await ipcMain._handlers['llm:stop']();
      expect(llmService.stop).toHaveBeenCalled();
      expect(r).toEqual({ running: true, backend: 'llamaCpp' });
    });
  });

  describe('llm:set-remote', () => {
    test('sets endpoint and persists normalized values', async () => {
      const r = await ipcMain._handlers['llm:set-remote']({}, { endpoint: 'https://api.test/v1/', apiKey: 'k', model: 'gpt' });
      // visionCapable (4th arg) is undefined when the payload omits it, and persisted as false.
      expect(llmService.setRemoteEndpoint).toHaveBeenCalledWith('https://api.test/v1/', 'k', 'gpt', undefined);
      expect(configService.set).toHaveBeenCalledWith('settings.llm.remote', { endpoint: 'https://api.test', apiKey: 'k', model: 'gpt', visionCapable: false });
      expect(configService.set).toHaveBeenCalledWith('settings.llm.activeBackend', 'remote');
      // mode is what App.js's startup restore reads; activeBackend gets overwritten by any later local-engine pick.
      expect(configService.set).toHaveBeenCalledWith('settings.llm.mode', 'remote');
      expect(r).toEqual({ running: true, backend: 'llamaCpp' });
    });

    test('clears activeBackend and mode when endpoint empty', async () => {
      await ipcMain._handlers['llm:set-remote']({}, { endpoint: '' });
      expect(configService.set).toHaveBeenCalledWith('settings.llm.remote', { endpoint: '', apiKey: '', model: '', visionCapable: false });
      expect(configService.set).toHaveBeenCalledWith('settings.llm.activeBackend', null);
      expect(configService.set).toHaveBeenCalledWith('settings.llm.mode', 'local');
    });

    test('defaults arg to {} when omitted', async () => {
      await ipcMain._handlers['llm:set-remote']({});
      expect(llmService.setRemoteEndpoint).toHaveBeenCalledWith(undefined, undefined, undefined, undefined);
    });

    test('works without configService', async () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { llmService, modelManagerService, engineDiscoveryService });
      const r = await ipcMain._handlers['llm:set-remote']({}, { endpoint: 'https://a' });
      expect(r).toEqual({ running: true, backend: 'llamaCpp' });
    });
  });

  describe('llm:clear-remote', () => {
    test('clears endpoint and config', async () => {
      const r = await ipcMain._handlers['llm:clear-remote']();
      expect(llmService.clearRemoteEndpoint).toHaveBeenCalled();
      expect(configService.set).toHaveBeenCalledWith('settings.llm.activeBackend', null);
      // Without this the saved URL/key would be restored on the next launch, silently re-enabling a paid endpoint.
      expect(configService.set).toHaveBeenCalledWith('settings.llm.mode', 'local');
      expect(r).toEqual({ running: true, backend: 'llamaCpp' });
    });

    test('works without configService', async () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { llmService, modelManagerService, engineDiscoveryService });
      const r = await ipcMain._handlers['llm:clear-remote']();
      expect(r).toEqual({ running: true, backend: 'llamaCpp' });
    });
  });

  describe('llm:verify-remote', () => {
    test('returns error when endpoint missing', async () => {
      const r = await ipcMain._handlers['llm:verify-remote']({}, {});
      expect(r).toEqual({ ok: false, error: 'Endpoint is required.' });
    });

    test('returns error when endpoint not a string', async () => {
      const r = await ipcMain._handlers['llm:verify-remote']({}, { endpoint: 123 });
      expect(r).toEqual({ ok: false, error: 'Endpoint is required.' });
    });

    test('returns sorted normalized model list on success', async () => {
      llmClient.listModels.mockResolvedValue([{ id: 'zeta' }, 'alpha', { name: 'beta' }, {}, null]);
      const r = await ipcMain._handlers['llm:verify-remote']({}, { endpoint: ' http://x ', apiKey: ' key ' });
      expect(llmClient.listModels).toHaveBeenCalledWith({ endpoint: 'http://x', apiKey: 'key' });
      expect(r).toEqual({ ok: true, models: ['alpha', 'beta', 'zeta'] });
    });

    test('returns ok:false with message when listModels rejects', async () => {
      llmClient.listModels.mockRejectedValue(new Error('bad key'));
      const r = await ipcMain._handlers['llm:verify-remote']({}, { endpoint: 'http://x' });
      expect(r).toEqual({ ok: false, error: 'bad key' });
    });

    test('generic message when rejection has no message', async () => {
      llmClient.listModels.mockRejectedValue({});
      const r = await ipcMain._handlers['llm:verify-remote']({}, { endpoint: 'http://x' });
      expect(r).toEqual({ ok: false, error: 'Verify failed' });
    });

    test('handles missing apiKey (defaults to empty)', async () => {
      llmClient.listModels.mockResolvedValue([]);
      await ipcMain._handlers['llm:verify-remote']({}, { endpoint: 'http://x' });
      expect(llmClient.listModels).toHaveBeenCalledWith({ endpoint: 'http://x', apiKey: '' });
    });
  });
});
