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

const { EventEmitter } = require('events');
const { ipcMain } = require('electron');
const { register, sendArgs } = require('../../../../main/ipc/agentRunHandlers');

const invoke = (ch, arg) => ipcMain._handlers[ch]({}, arg);

describe('agentRunHandlers', () => {
  let manager;
  let win;

  beforeEach(() => {
    for (const k of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[k];
    manager = Object.assign(new EventEmitter(), {
      send: jest.fn((req) => ({ ok: true, sessionId: req.sessionId || 's_new12345', queued: false })),
      stop: jest.fn(() => { throw new Error('not_running'); }),
      planDecision: jest.fn(() => ({ ok: true, decision: 'reject', resumed: false })),
      running: jest.fn(() => [{ sessionId: 's_abcdef12', state: 'running', lane: 'background' }]),
    });
    win = { destroyed: false, isDestroyed() { return this.destroyed; }, webContents: { send: jest.fn() } };
    register(win, { sessionManager: manager });
  });

  test('registers nothing without a session manager', () => {
    for (const k of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[k];
    register(win, {});
    expect(Object.keys(ipcMain._handlers)).toEqual([]);
  });

  test('session:send forwards a validated request', async () => {
    await expect(invoke('session:send', { text: 'go', source: 'chat', webContentsId: 3, extra: 'dropped' })).resolves.toMatchObject({ ok: true });
    expect(manager.send).toHaveBeenCalledWith({ text: 'go', source: 'chat', webContentsId: 3 });
    await invoke('session:send', { sessionId: 's_abcdef12', fromNodeId: 'n_abcdef12' });
    expect(manager.send).toHaveBeenLastCalledWith({ sessionId: 's_abcdef12', fromNodeId: 'n_abcdef12' });
  });

  test('session:send rejects malformed requests without calling the manager', async () => {
    await expect(invoke('session:send', { text: '   ' })).resolves.toEqual({ ok: false, error: 'invalid_text' });
    await expect(invoke('session:send', { text: 'x'.repeat(100001) })).resolves.toEqual({ ok: false, error: 'invalid_text' });
    await expect(invoke('session:send', { fromNodeId: 'n_abcdef12' })).resolves.toEqual({ ok: false, error: 'session_required' });
    await expect(invoke('session:send', { text: 'go', webContentsId: -1 })).resolves.toEqual({ ok: false, error: 'invalid_webContentsId' });
    await expect(invoke('session:send', { text: 'go', webContentsId: '3' })).resolves.toEqual({ ok: false, error: 'invalid_webContentsId' });
    await expect(invoke('session:send', { text: 'go', source: 'shell' })).resolves.toEqual({ ok: false, error: 'invalid_source' });
    await expect(invoke('session:send', { sessionId: '../x', text: 'go' })).resolves.toEqual({ ok: false, error: 'invalid_session_id' });
    await expect(invoke('session:send', null)).resolves.toEqual({ ok: false, error: 'invalid_text' });
    expect(manager.send).not.toHaveBeenCalled();
    expect(() => sendArgs({ sessionId: 's_abcdef12', fromNodeId: 'x' })).toThrow('invalid_node_id');
  });

  test('manager errors come back as {ok:false, error}', async () => {
    await expect(invoke('session:stop', { sessionId: 's_abcdef12' })).resolves.toEqual({ ok: false, error: 'not_running' });
    await expect(invoke('session:stop', { sessionId: 'nope' })).resolves.toEqual({ ok: false, error: 'invalid_session_id' });
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  test('plan decisions and running list pass through', async () => {
    await expect(invoke('session:plan-decision', { sessionId: 's_abcdef12', decision: 'reject', plan: { a: 1 } })).resolves.toMatchObject({ ok: true });
    expect(manager.planDecision).toHaveBeenCalledWith({ sessionId: 's_abcdef12', decision: 'reject', plan: { a: 1 } });
    await expect(invoke('session:running')).resolves.toEqual({ ok: true, runs: manager.running() });
  });

  test('manager events leave as session:event and stop once the window is gone', () => {
    const e = { sessionId: 's_abcdef12', channel: 'task-started', payload: {} };
    manager.emit('event', e);
    expect(win.webContents.send).toHaveBeenCalledWith('session:event', e);
    win.destroyed = true;
    manager.emit('event', e);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });
});
