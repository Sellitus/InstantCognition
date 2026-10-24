// agentWorkspaceHandlers — IPC contract for the agent workspace.

const mockHandlers = new Map();
const mockInvokeHandlers = new Map();

jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn((ch, fn) => { mockHandlers.set(ch, fn); }),
    handle: jest.fn((ch, fn) => { mockInvokeHandlers.set(ch, fn); }),
  },
}));

function fakeService(overrides = {}) {
  return {
    applyStateFromRenderer: jest.fn(),
    getState: jest.fn(() => ({ tabs: [{ id: 't1', url: 'x' }], currentTabId: 't1' })),
    setActiveConversation: jest.fn(),
    bindConversationId: jest.fn(),
    ...overrides,
  };
}

function loadHandlers(svc) {
  mockHandlers.clear();
  mockInvokeHandlers.clear();
  jest.isolateModules(() => {
    const mod = require('../../../../main/ipc/agentWorkspaceHandlers');
    mod.register({ isDestroyed: () => false }, { agentWorkspaceService: svc });
  });
}

describe('agentWorkspaceHandlers', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('no-op when service is missing', () => {
    expect(() => loadHandlers(null)).not.toThrow();
    expect(mockHandlers.size).toBe(0);
    expect(mockInvokeHandlers.size).toBe(0);
  });

  test('agent-workspace:state-update forwards to applyStateFromRenderer', () => {
    const svc = fakeService();
    loadHandlers(svc);
    const payload = { tabs: [{ id: 'a', url: 'x' }], currentTabId: 'a' };
    mockHandlers.get('agent-workspace:state-update')({}, payload);
    expect(svc.applyStateFromRenderer).toHaveBeenCalledWith(payload);
  });

  test('agent-workspace:state-update swallows service errors', () => {
    const svc = fakeService({ applyStateFromRenderer: jest.fn(() => { throw new Error('boom'); }) });
    loadHandlers(svc);
    expect(() => mockHandlers.get('agent-workspace:state-update')({}, {})).not.toThrow();
  });

  test('agent-workspace:get-state returns the service state', async () => {
    const svc = fakeService();
    loadHandlers(svc);
    const r = await mockInvokeHandlers.get('agent-workspace:get-state')({});
    expect(svc.getState).toHaveBeenCalled();
    expect(r.currentTabId).toBe('t1');
  });

  test('agent-workspace:set-active-conversation routes to setActiveConversation', async () => {
    const svc = fakeService();
    loadHandlers(svc);
    const r = await mockInvokeHandlers.get('agent-workspace:set-active-conversation')({}, { taskId: 't', isNew: true });
    expect(svc.setActiveConversation).toHaveBeenCalledWith({ taskId: 't', isNew: true });
    expect(r).toEqual({ ok: true });
  });

  test('agent-workspace:set-active-conversation returns error envelope on throw', async () => {
    const svc = fakeService({ setActiveConversation: jest.fn(() => { throw new Error('nope'); }) });
    loadHandlers(svc);
    const r = await mockInvokeHandlers.get('agent-workspace:set-active-conversation')({}, {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nope/);
  });

  test('agent-workspace:bind-conversation-id passes taskId through', () => {
    const svc = fakeService();
    loadHandlers(svc);
    mockHandlers.get('agent-workspace:bind-conversation-id')({}, { taskId: 'task_42' });
    expect(svc.bindConversationId).toHaveBeenCalledWith('task_42');
  });
});
