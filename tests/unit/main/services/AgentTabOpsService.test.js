const { AgentTabOpsService } = require('../../../../main/services/AgentTabOpsService');

function makeMainWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (ch, payload) => sent.push({ ch, payload }) },
  };
}

function makeIpcMain() {
  const listeners = {};
  return {
    on: (ch, fn) => { listeners[ch] = fn; },
    fire: (ch, payload) => { if (listeners[ch]) listeners[ch](null, payload); },
  };
}

describe('AgentTabOpsService', () => {
  test('openTab sends an agent-workspace:tab-op and resolves on matching result', async () => {
    const svc = new AgentTabOpsService();
    const mw = makeMainWindow();
    const ipc = makeIpcMain();
    svc.bind(mw, ipc);

    const p = svc.openTab('https://example.com');
    expect(mw.sent).toHaveLength(1);
    const { requestId, op, args } = mw.sent[0].payload;
    expect(op).toBe('open');
    expect(args).toEqual({ url: 'https://example.com' });

    ipc.fire('agent-workspace:tab-op-result', { requestId, ok: true, spaceId: 'tab_9' });
    await expect(p).resolves.toMatchObject({ ok: true, spaceId: 'tab_9' });
  });

  test('rejects when renderer replies ok:false', async () => {
    const svc = new AgentTabOpsService();
    const mw = makeMainWindow();
    const ipc = makeIpcMain();
    svc.bind(mw, ipc);

    const p = svc.closeTab('s1');
    const { requestId } = mw.sent[0].payload;
    ipc.fire('agent-workspace:tab-op-result', { requestId, ok: false, error: 'no_manager' });
    await expect(p).rejects.toThrow(/no_manager/);
  });

  test('times out when no result arrives', async () => {
    jest.useFakeTimers();
    const svc = new AgentTabOpsService();
    svc.bind(makeMainWindow(), makeIpcMain());
    const p = svc.openTab('https://x');
    p.catch(() => {}); // prevent unhandled rejection
    jest.advanceTimersByTime(11000);
    await expect(p).rejects.toThrow(/tab_op_timeout/);
    jest.useRealTimers();
  });

  test('ignores stray tab-op-result for unknown requestId', () => {
    const svc = new AgentTabOpsService();
    const ipc = makeIpcMain();
    svc.bind(makeMainWindow(), ipc);
    expect(() => ipc.fire('agent-workspace:tab-op-result', { requestId: 'ghost', ok: true })).not.toThrow();
  });

  test('rejects when mainWindow is unavailable', async () => {
    const svc = new AgentTabOpsService();
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, makeIpcMain());
    await expect(svc.openTab('https://x')).rejects.toThrow(/no_main_window/);
  });

  test('rejects when mainWindow is entirely null (no isDestroyed)', async () => {
    const svc = new AgentTabOpsService();
    svc.bind(null, makeIpcMain());
    await expect(svc.closeTab('s1')).rejects.toThrow(/no_main_window/);
  });

  test('rejects (and cleans up pending) when webContents.send throws', async () => {
    const svc = new AgentTabOpsService();
    const mw = {
      isDestroyed: () => false,
      webContents: { send: () => { throw new Error('send blew up'); } },
    };
    svc.bind(mw, makeIpcMain());
    await expect(svc.openTab('https://boom')).rejects.toThrow(/send blew up/);
    // The pending entry must have been removed so it cannot leak / double-reject.
    expect(svc._pending.size).toBe(0);
  });

  test('focusTab and duplicateTab send the right op and resolve on result', async () => {
    const svc = new AgentTabOpsService();
    const mw = makeMainWindow();
    const ipc = makeIpcMain();
    svc.bind(mw, ipc);

    const pf = svc.focusTab('s7');
    expect(mw.sent[0].payload.op).toBe('focus');
    expect(mw.sent[0].payload.args).toEqual({ spaceId: 's7' });
    ipc.fire('agent-workspace:tab-op-result', { requestId: mw.sent[0].payload.requestId, ok: true });
    await expect(pf).resolves.toMatchObject({ ok: true });

    const pd = svc.duplicateTab('s8');
    expect(mw.sent[1].payload.op).toBe('duplicate');
    expect(mw.sent[1].payload.args).toEqual({ spaceId: 's8' });
    ipc.fire('agent-workspace:tab-op-result', { requestId: mw.sent[1].payload.requestId, ok: true, spaceId: 'dup' });
    await expect(pd).resolves.toMatchObject({ ok: true, spaceId: 'dup' });
  });

  test('a custom timeoutMs overrides the default timeout window', async () => {
    jest.useFakeTimers();
    const svc = new AgentTabOpsService();
    svc.bind(makeMainWindow(), makeIpcMain());
    const p = svc._send('open', { url: 'https://slow', timeoutMs: 200 });
    p.catch(() => {});
    jest.advanceTimersByTime(199);
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); // not yet — custom window is 200ms
    jest.advanceTimersByTime(1);
    await expect(p).rejects.toThrow(/tab_op_timeout/);
    jest.useRealTimers();
  });

  test('_onResult ignores a null payload and a payload without requestId', () => {
    const svc = new AgentTabOpsService();
    svc.bind(makeMainWindow(), makeIpcMain());
    expect(() => svc._onResult(null)).not.toThrow();
    expect(() => svc._onResult({ ok: true })).not.toThrow();
  });

  test('bind tolerates an ipcMain without an .on method (no listener wired)', () => {
    const svc = new AgentTabOpsService();
    expect(() => svc.bind(makeMainWindow(), {})).not.toThrow();
    expect(() => svc.bind(makeMainWindow(), null)).not.toThrow();
  });

  test('_reset rejects every in-flight request and clears the pending map', async () => {
    jest.useFakeTimers();
    const svc = new AgentTabOpsService();
    svc.bind(makeMainWindow(), makeIpcMain());
    const p1 = svc.openTab('https://a');
    const p2 = svc.closeTab('s2');
    expect(svc._pending.size).toBe(2);
    svc._reset();
    expect(svc._pending.size).toBe(0);
    await expect(p1).rejects.toThrow(/reset/);
    await expect(p2).rejects.toThrow(/reset/);
    // Timers were cleared by _reset: advancing past the timeout fires nothing new.
    jest.advanceTimersByTime(20000);
    jest.useRealTimers();
  });
});
