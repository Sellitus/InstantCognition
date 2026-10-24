// RoutineService — the scheduler tick/state machine. The clock is injected
// (_setNow) and ticks are driven manually (_tickOnce) so there are no real
// timers. ConfigService / AgentService / the window are stubbed (external
// boundaries); the service logic itself is exercised directly.

const { RoutineService } = require('../../../../main/services/RoutineService');

function fakeConfig(initial) {
  const store = JSON.parse(JSON.stringify(initial || {}));
  const walk = (path) => path.split('.');
  return {
    _store: store,
    get(path, dflt) {
      let c = store;
      for (const p of walk(path)) { if (c == null || typeof c !== 'object') return dflt; c = c[p]; }
      return c === undefined ? dflt : c;
    },
    set(path, val) {
      const parts = walk(path);
      let c = store;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (c[parts[i]] == null || typeof c[parts[i]] !== 'object') c[parts[i]] = {};
        c = c[parts[i]];
      }
      c[parts[parts.length - 1]] = val;
    },
  };
}

function fakeWindow() {
  return { webContents: { send: jest.fn() }, isDestroyed: () => false };
}

function routine(over) {
  return {
    id: 'r1', name: 'Digest', task: 'do the thing',
    schedule: { kind: 'interval', everyMinutes: 30 },
    enabled: true, lastRunAt: null, createdAt: 0, version: 1,
    ...over,
  };
}

function make({ items = [routine()], enabled = true, running = false } = {}) {
  const svc = new RoutineService();
  const cfg = fakeConfig({ settings: { routines: { enabled, items } } });
  const agent = { isRunning: () => running };
  const win = fakeWindow();
  svc.bind({ configService: cfg, agentService: agent });
  svc._setNow(() => 1_000_000);
  return { svc, cfg, agent, win };
}

describe('RoutineService scheduling', () => {
  test('dispatches a due routine to the renderer and marks it pending', () => {
    const { svc, win } = make();
    svc._window = win;
    svc._tickOnce();
    expect(win.webContents.send).toHaveBeenCalledWith('routine:run', { id: 'r1', name: 'Digest', task: 'do the thing' });
    expect(svc._pending).toMatchObject({ id: 'r1' });
  });

  test('does not dispatch when the master switch is off', () => {
    const { svc, win } = make({ enabled: false });
    svc._window = win;
    svc._tickOnce();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  test('does not dispatch while the agent is busy', () => {
    const { svc, win } = make({ running: true });
    svc._window = win;
    svc._tickOnce();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  test('one routine at a time — a pending dispatch blocks the next tick', () => {
    const { svc, win } = make({ items: [routine({ id: 'a' }), routine({ id: 'b' })] });
    svc._window = win;
    svc._tickOnce();
    svc._tickOnce();
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });

  test('noteRan(ok) advances lastRunAt and clears pending; routine no longer due', () => {
    const { svc, cfg, win } = make();
    svc._window = win;
    svc._tickOnce();
    svc.noteRan({ id: 'r1', ok: true });
    expect(svc._pending).toBeNull();
    expect(cfg._store.settings.routines.items[0].lastRunAt).toBe(1_000_000);
    win.webContents.send.mockClear();
    svc._tickOnce(); // interval not elapsed → no re-dispatch
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  test('noteRan(failure) clears pending without advancing lastRunAt; next tick retries', () => {
    const { svc, cfg, win } = make();
    svc._window = win;
    svc._tickOnce();
    svc.noteRan({ id: 'r1', ok: false });
    expect(svc._pending).toBeNull();
    expect(cfg._store.settings.routines.items[0].lastRunAt).toBeNull();
    win.webContents.send.mockClear();
    svc._tickOnce();
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });

  test('noteRan ignores a mismatched id', () => {
    const { svc, cfg, win } = make();
    svc._window = win;
    svc._tickOnce();
    svc.noteRan({ id: 'other', ok: true });
    expect(svc._pending).toMatchObject({ id: 'r1' });
    expect(cfg._store.settings.routines.items[0].lastRunAt).toBeNull();
  });

  test('a stranded pending dispatch is cleared after the timeout and retried', () => {
    const { svc, win } = make();
    svc._window = win;
    let t = 1_000_000;
    svc._setNow(() => t);
    svc._tickOnce();
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    t += 16 * 60 * 1000; // > 15 min PENDING_TIMEOUT
    svc._tickOnce();
    expect(svc._pending).toMatchObject({ id: 'r1' });
    expect(win.webContents.send).toHaveBeenCalledTimes(2);
  });

  test('runNow dispatches immediately; reports not_found and busy', () => {
    const { svc, agent, win } = make();
    svc._window = win;
    expect(svc.runNow('missing')).toEqual({ ok: false, error: 'not_found' });
    expect(svc.runNow('r1')).toEqual({ ok: true });
    expect(win.webContents.send).toHaveBeenCalledWith('routine:run', expect.objectContaining({ id: 'r1' }));
    // pending now set → busy
    expect(svc.runNow('r1')).toEqual({ ok: false, error: 'busy' });
    svc._pending = null;
    agent.isRunning = () => true;
    expect(svc.runNow('r1')).toEqual({ ok: false, error: 'busy' });
  });

  test('start() then stop() is safe and idempotent (no real timer fires)', () => {
    const { svc, win } = make();
    svc.start(win, { tickMs: 999999 });
    svc.stop();
    svc.stop();
    expect(() => svc._tickOnce()).not.toThrow();
  });
});
