// mcpHandlers -- IPC surface for MCP server status + lifecycle. Tool browsing/call channels were removed along with their handler registration; sibling to engineHandlers.test.js: mock electron.ipcMain so each remaining handler is invoked directly with a controlled mcpService (the boundary here, per its own suite).
const mockInvokeHandlers = new Map();

jest.mock('electron', () => ({
  ipcMain: { on: jest.fn(), handle: jest.fn((channel, fn) => { mockInvokeHandlers.set(channel, fn); }) },
}));

function loadHandlers(services) {
  mockInvokeHandlers.clear();
  jest.isolateModules(() => { require('../../../../main/ipc/mcpHandlers').register({ isDestroyed: () => false }, services); });
}

describe('mcpHandlers', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('no-op (registers nothing) when mcpService is missing', () => { expect(() => loadHandlers({})).not.toThrow(); expect(mockInvokeHandlers.size).toBe(0); });

  describe('read channels', () => {
    test('mcp:available reports SDK availability + enabled flag', async () => {
      loadHandlers({ mcpService: { isAvailable: () => true, _config: { enabled: true } } });
      expect(await mockInvokeHandlers.get('mcp:available')()).toEqual({ ok: true, available: true, enabled: true });
    });

    test('mcp:status forwards getStatus()', async () => {
      const servers = [{ id: 's1', status: 'connected', toolCount: 2 }];
      loadHandlers({ mcpService: { isAvailable: () => true, _config: {}, getStatus: () => servers } });
      expect(await mockInvokeHandlers.get('mcp:status')()).toEqual({ ok: true, servers });
    });
  });

  describe('lifecycle channels', () => {
    test('mcp:reload awaits _reload and reports ok', async () => {
      let called = false; loadHandlers({ mcpService: { isAvailable: () => true, _config: {}, _reload: async () => { called = true; } } });
      expect(await mockInvokeHandlers.get('mcp:reload')()).toEqual({ ok: true }); expect(called).toBe(true);
    });


    test('mcp:reload normalizes a thrown error into { ok:false, error }', async () => {
      loadHandlers({ mcpService: { isAvailable: () => true, _config: {}, _reload: async () => { throw new Error('nope'); } } });
      expect(await mockInvokeHandlers.get('mcp:reload')()).toEqual({ ok: false, error: 'nope' });
    });
  });
});
