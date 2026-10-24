// engineHandlers — IPC for the chat-popover engine switcher (backend catalog,
// select-backend, model list). Electron's ipcMain is mocked so each handler
// can be invoked directly with a controlled service bag.

const mockInvokeHandlers = new Map();

jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn(),
    handle: jest.fn((channel, fn) => { mockInvokeHandlers.set(channel, fn); }),
  },
}));

function loadHandlers(services) {
  mockInvokeHandlers.clear();
  jest.isolateModules(() => {
    const mod = require('../../../../main/ipc/engineHandlers');
    mod.register({ isDestroyed: () => false }, services);
  });
}

function fakeCs(data = {}) {
  return {
    get: (p, fb) => { const ks = p.split('.'); let c = data; for (const k of ks) c = (c && typeof c === 'object') ? c[k] : undefined; return c === undefined ? fb : c; },
    set: jest.fn((p, v) => { const ks = p.split('.'); let c = data; for (let i = 0; i < ks.length - 1; i++) { if (typeof c[ks[i]] !== 'object' || c[ks[i]] === null) c[ks[i]] = {}; c = c[ks[i]]; } c[ks[ks.length - 1]] = v; }),
  };
}

describe('engineHandlers', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('no-op when required services are missing', () => {
    expect(() => loadHandlers({})).not.toThrow();
    expect(mockInvokeHandlers.size).toBe(0);
  });

  describe('llm:backends', () => {
    test('composes catalog from detection + active backend + status', async () => {
      const llmService = { getStatus: () => ({ status: 'stopped', backend: 'llamaCpp' }) };
      const engineDiscoveryService = { detectEngines: async () => ({ llamaCpp: { available: true }, mlxOpenAi: { available: false }, mlxLm: { available: false } }) };
      const configService = fakeCs({ settings: { llm: { activeBackend: 'llamaCpp' } } });
      loadHandlers({ llmService, engineDiscoveryService, configService });
      const res = await mockInvokeHandlers.get('llm:backends')();
      expect(res.active).toBe('llamaCpp');
      const byId = Object.fromEntries(res.backends.map((b) => [b.id, b]));
      expect(byId.llamaCpp.installed).toBe(true);
      expect(byId.llamaCpp.active).toBe(true);
      expect(byId.remote).toBeDefined();
      expect(res.status.backend).toBe('llamaCpp');
    });

    test('surfaces a configured remote endpoint as installed', async () => {
      const llmService = { getStatus: () => ({}) };
      const engineDiscoveryService = { detectEngines: async () => ({}) };
      const configService = fakeCs({ settings: { llm: { remote: { endpoint: 'http://me:1234' } } } });
      loadHandlers({ llmService, engineDiscoveryService, configService });
      const res = await mockInvokeHandlers.get('llm:backends')();
      expect(res.backends.find((b) => b.id === 'remote').installed).toBe(true);
    });
  });

  describe('llm:select-backend', () => {
    test('persists the active backend and returns status', async () => {
      const llmService = { getStatus: () => ({ status: 'stopped' }) };
      const engineDiscoveryService = { detectEngines: async () => ({}) };
      const configService = fakeCs({ settings: { llm: {} } });
      loadHandlers({ llmService, engineDiscoveryService, configService });
      const res = await mockInvokeHandlers.get('llm:select-backend')({}, 'mlxOpenAi');
      expect(res).toEqual({ ok: true, active: 'mlxOpenAi', status: { status: 'stopped' } });
      expect(configService.set).toHaveBeenCalledWith('settings.llm.activeBackend', 'mlxOpenAi');
    });

    test('rejects a missing/invalid backend id at the boundary', async () => {
      loadHandlers({ llmService: { getStatus: () => ({}) }, engineDiscoveryService: { detectEngines: async () => ({}) }, configService: fakeCs({}) });
      expect(mockInvokeHandlers.get('llm:select-backend')({}, '')).toEqual({ ok: false, error: 'invalid_backend' });
      expect(mockInvokeHandlers.get('llm:select-backend')({}, null)).toEqual({ ok: false, error: 'invalid_backend' });
    });
  });

  describe('llm:list-models-popover', () => {
    test('returns the scanned model list', async () => {
      const llmService = { getStatus: () => ({}) };
      const engineDiscoveryService = { detectEngines: async () => ({}) };
      const modelManagerService = { getModelsDir: () => '/m', setModelsDir: jest.fn(), listModels: () => [{ name: 'qwen.gguf' }] };
      const configService = fakeCs({ settings: { llm: {} } });
      loadHandlers({ llmService, engineDiscoveryService, modelManagerService, configService });
      const res = await mockInvokeHandlers.get('llm:list-models-popover')();
      expect(res.ok).toBe(true);
      expect(res.models).toEqual([{ name: 'qwen.gguf' }]);
    });

    test('degrades gracefully when modelManagerService is absent', async () => {
      loadHandlers({ llmService: { getStatus: () => ({}) }, engineDiscoveryService: { detectEngines: async () => ({}) }, configService: fakeCs({}) });
      const res = await mockInvokeHandlers.get('llm:list-models-popover')();
      expect(res).toEqual({ ok: false, error: 'model_manager_unavailable' });
    });
  });
});
