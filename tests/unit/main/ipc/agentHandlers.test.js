jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      handle: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      _handlers: handlers,
    },
  };
});

// AgentHistoryService is a service singleton the handler delegates to (an
// external boundary to this IPC unit, same as `electron`). Mock it so we can
// assert delegation + argument shaping without touching the filesystem.
jest.mock('../../../../main/services/AgentHistoryService', () => ({
  initialize: jest.fn(),
  open: jest.fn(),
}));

const { ipcMain } = require('electron');
const agentHistoryService = require('../../../../main/services/AgentHistoryService');
const { register } = require('../../../../main/ipc/agentHandlers');

function makeWindow() {
  return { isDestroyed: jest.fn(() => false), webContents: { send: jest.fn() } };
}

function makeAgentService() {
  const listeners = {};
  return {
    _listeners: listeners,
    on: jest.fn((evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); }),
    emit(evt, payload) { (listeners[evt] || []).forEach((fn) => fn(payload)); },
    getStatus: jest.fn(() => ({ state: 'idle' })),
    getSteps: jest.fn(() => [{ step: 0 }]),
    listTools: jest.fn(() => [{ name: 'browser.read_tab' }]),
    startTask: jest.fn(async (o) => ({ ok: true, started: o })),
    reattachTask: jest.fn(async (o) => ({ ok: true, reattached: o })),
    stopTask: jest.fn(),
    pauseTask: jest.fn(),
    resumeTask: jest.fn(),
    resetConversation: jest.fn(),
  };
}

describe('agentHandlers', () => {
  let win;
  let agentService;
  
  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[k];
    ipcMain.on.mockImplementation((ch, fn) => { ipcMain._handlers[ch] = fn; });
    ipcMain.handle.mockImplementation((ch, fn) => { ipcMain._handlers[ch] = fn; });
    win = makeWindow();
    agentService = makeAgentService();
      });

  describe('guard clauses', () => {
    test('no agentService → returns early, registers nothing', () => {
      // {} stands in for any services object — the point is that without an agentService present this must not touch ipcMain at all.
      register(win, {});
      expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
      expect(agentHistoryService.initialize).not.toHaveBeenCalled();
    });

    test('default destructure when services arg is omitted entirely', () => {
      register(win);
      // agentService is undefined → early return, no handlers wired.
      expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
    });

    test('agentHistoryService.initialize failure is swallowed (best effort)', () => {
      agentHistoryService.initialize.mockImplementationOnce(() => { throw new Error('disk full'); });
      expect(() => register(win, { agentService })).not.toThrow();
      // Registration still proceeds after the swallowed init error.
      expect(ipcMain._handlers['agent:start']).toBeInstanceOf(Function);
    });
  });

  describe('event forwarding', () => {
    beforeEach(() => { register(win, { agentService }); });

    test('forwards agentService events to the renderer over the mapped channel', () => {
      agentService.emit('task-started', { id: 't1' });
      expect(win.webContents.send).toHaveBeenCalledWith('agent:task-started', { id: 't1' });

      agentService.emit('step-acted', { step: 3 });
      expect(win.webContents.send).toHaveBeenCalledWith('agent:step-acted', { step: 3 });

      agentService.emit('assistant-chunk', { text: 'hi' });
      expect(win.webContents.send).toHaveBeenCalledWith('agent:assistant-chunk', { text: 'hi' });
    });

    test('forwards runtime token and compaction events as agent:tokens / agent:compacted', () => {
      const tokens = { tokensUsed: 900, contextSize: 8192, contextTokens: 700, step: 2 };
      agentService.emit('agent-tokens', tokens);
      expect(win.webContents.send).toHaveBeenCalledWith('agent:tokens', tokens);
      const compacted = { before: 12, after: 6, tokensUsed: 7000, contextSize: 8192, step: 5 };
      agentService.emit('agent-compacted', compacted);
      expect(win.webContents.send).toHaveBeenCalledWith('agent:compacted', compacted);
      expect(win.webContents.send).not.toHaveBeenCalledWith('agent-tokens', expect.anything());
    });

    test('step-observed is reshaped to { step } before forwarding', () => {
      agentService.emit('step-observed', { step: 7, extra: 'dropped' });
      expect(win.webContents.send).toHaveBeenCalledWith('agent:step-observed', { step: 7 });
    });

    test('does not send when mainWindow is destroyed (send guard arm)', () => {
      win.isDestroyed.mockReturnValue(true);
      agentService.emit('task-completed', { ok: true });
      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('send guard with no/invalid window', () => {
    test('null mainWindow → forwarding is a no-op, no throw', () => {
      register(null, { agentService });
      expect(() => agentService.emit('task-failed', { err: 'x' })).not.toThrow();
    });

    test('window without webContents → no send, no throw', () => {
      const noWc = { isDestroyed: () => false };
      register(noWc, { agentService });
      expect(() => agentService.emit('task-paused', {})).not.toThrow();
    });
  });

  describe('agent:start', () => {
    beforeEach(() => { register(win, { agentService }); });

    test('maps full opts and defaults qualitySkillOverride to null', async () => {
      const res = await ipcMain._handlers['agent:start']({}, {
        description: 'do x', webContentsId: 9, maxSteps: 5, scope: 'tab', tabId: 't2',
      });
      expect(res.ok).toBe(true);
      expect(agentService.startTask).toHaveBeenCalledWith({
        description: 'do x', webContentsId: 9, maxSteps: 5,
        qualitySkillOverride: null, scope: 'tab', tabId: 't2', priorTurns: null,
      });
    });

    test('passes through an explicit qualitySkillOverride (truthy || arm)', async () => {
      await ipcMain._handlers['agent:start']({}, { description: 'd', qualitySkillOverride: 'fast' });
      expect(agentService.startTask).toHaveBeenCalledWith(
        expect.objectContaining({ qualitySkillOverride: 'fast' })
      );
    });

    test('opts defaults to {} when omitted', async () => {
      await ipcMain._handlers['agent:start']({});
      expect(agentService.startTask).toHaveBeenCalledWith({
        description: undefined, webContentsId: undefined, maxSteps: undefined,
        qualitySkillOverride: null, scope: undefined, tabId: undefined, priorTurns: null,
      });
    });

    test('priorTurns passes through as an array and a non-array is dropped to null', async () => {
      const turns = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }];
      await ipcMain._handlers['agent:start']({}, { description: 'd', priorTurns: turns });
      expect(agentService.startTask).toHaveBeenCalledWith(expect.objectContaining({ priorTurns: turns }));

      await ipcMain._handlers['agent:start']({}, { description: 'd', priorTurns: 'not-an-array' });
      expect(agentService.startTask).toHaveBeenLastCalledWith(expect.objectContaining({ priorTurns: null }));
    });
  });

  describe('agent:reattach', () => {
    beforeEach(() => { register(win, { agentService }); });

    test('forwards webContentsId', async () => {
      const res = await ipcMain._handlers['agent:reattach']({}, { webContentsId: 12 });
      expect(res.ok).toBe(true);
      expect(agentService.reattachTask).toHaveBeenCalledWith({ webContentsId: 12 });
    });

    test('opts defaults to {} when omitted', async () => {
      await ipcMain._handlers['agent:reattach']({});
      expect(agentService.reattachTask).toHaveBeenCalledWith({ webContentsId: undefined });
    });
  });

  describe('control channels (ipcMain.on)', () => {
    beforeEach(() => { register(win, { agentService }); });

    test('agent:stop / pause / resume delegate to the service', () => {
      ipcMain._handlers['agent:stop']();
      ipcMain._handlers['agent:pause']();
      ipcMain._handlers['agent:resume']();
      expect(agentService.stopTask).toHaveBeenCalled();
      expect(agentService.pauseTask).toHaveBeenCalled();
      expect(agentService.resumeTask).toHaveBeenCalled();
    });
  });

  describe('agent:reset-conversation', () => {
    test('no-op when resetConversation is not a function', () => {
      delete agentService.resetConversation;
      register(win, { agentService });
      expect(() => ipcMain._handlers['agent:reset-conversation']({}, { scope: 's' })).not.toThrow();
    });

    test('passes opts through when scope is present', () => {
      register(win, { agentService });
      ipcMain._handlers['agent:reset-conversation']({}, { scope: 'tab', tabId: 't1' });
      expect(agentService.resetConversation).toHaveBeenCalledWith({ scope: 'tab', tabId: 't1' });
    });

    test('passes opts through when only tabId is present (|| arm)', () => {
      register(win, { agentService });
      ipcMain._handlers['agent:reset-conversation']({}, { tabId: 't9' });
      expect(agentService.resetConversation).toHaveBeenCalledWith({ tabId: 't9' });
    });

    test('calls resetConversation with no args when opts is null', () => {
      register(win, { agentService });
      ipcMain._handlers['agent:reset-conversation']({}, null);
      expect(agentService.resetConversation).toHaveBeenCalledWith();
    });

    test('calls resetConversation with no args when opts has neither scope nor tabId', () => {
      register(win, { agentService });
      ipcMain._handlers['agent:reset-conversation']({}, { unrelated: true });
      expect(agentService.resetConversation).toHaveBeenCalledWith();
    });
  });

  describe('history surface', () => {
    beforeEach(() => { register(win, { agentService }); });

    test('history-open forwards the id', () => {
      agentHistoryService.open.mockReturnValue({ id: 'h1' });
      expect(ipcMain._handlers['agent:history-open']({}, 'h1')).toEqual({ id: 'h1' });
      expect(agentHistoryService.open).toHaveBeenCalledWith('h1');
    });

    test('the retired history list/mutate channels are not registered', () => {
      for (const ch of ['agent:history-list', 'agent:history-delete', 'agent:history-rename', 'agent:history-pin']) {
        expect(ipcMain._handlers[ch]).toBeUndefined();
      }
    });

    test('malformed or missing ids are rejected before reaching the service (path-traversal guard)', () => {
      // A '../' id is the traversal primitive; undefined and objects are malformed.
      for (const bad of ['../evil', '../../etc/passwd', undefined, null, { toString: () => '../a' }]) {
        expect(() => ipcMain._handlers['agent:history-open']({}, bad)).toThrow(/invalid run id/);
      }
      expect(agentHistoryService.open).not.toHaveBeenCalled();
    });

    test('a valid minted id passes the guard', () => {
      expect(() => ipcMain._handlers['agent:history-open']({}, 'task_123')).not.toThrow();
    });
  });

});
