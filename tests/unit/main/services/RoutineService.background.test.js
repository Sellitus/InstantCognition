// RoutineService background mode: a due routine runs as a background session
// through the real session manager (AgentService, SessionRun, sessionStore on
// a tmp dir) and its result lands in a real InboxService file. Only electron
// and the LLM HTTP client are mocked; the clock is injected via _setNow.

const mockUserData = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ic-routine-bg-'));

jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: { on: jest.fn(), handle: jest.fn() },
}));
jest.mock('../../../../main/services/LLMClientService', () => ({ chatCompletion: jest.fn() }));

const fs = require('fs');
const path = require('path');
const agent = require('../../../../main/services/AgentService');
const llm = require('../../../../main/services/LLMClientService');
const { RoutineService } = require('../../../../main/services/RoutineService');
const { InboxService } = require('../../../../main/services/InboxService');
const { createSessionServices } = require('../../../../main/agent/sessions/sessionServices');
const { createMockLlmQueue, waitFor } = require('../../../helpers/mockLlmQueue');

const NOW = 10_000_000;
const done = (summary) => ({ content: JSON.stringify({ action: 'done', summary }) });

function mockConfig(initial) {
  const store = JSON.parse(JSON.stringify(initial));
  return {
    get(key, fallback) {
      let c = store;
      for (const p of key.split('.')) { if (c == null || typeof c !== 'object') return fallback; c = c[p]; }
      return c === undefined ? fallback : c;
    },
    set(key, val) {
      const parts = key.split('.');
      let c = store;
      for (const p of parts.slice(0, -1)) c = c[p];
      c[parts[parts.length - 1]] = val;
    },
  };
}

function routine(over) {
  return { id: 'r1', name: 'Morning digest', task: 'gamma routine errand: summarize the news', schedule: { kind: 'interval', everyMinutes: 30 }, enabled: true, lastRunAt: null, createdAt: 0, version: 1, ...over };
}

afterAll(() => { fs.rmSync(mockUserData, { recursive: true, force: true }); });

describe('RoutineService background runs', () => {
  let cfg;
  let manager;
  let store;
  let inbox;
  let routines;
  let q;
  let clock;

  function setup({ items = [routine()], maxConcurrent = 2, runInBackground = true } = {}) {
    const dir = fs.mkdtempSync(path.join(mockUserData, 'run-'));
    cfg = mockConfig({
      settings: {
        routines: { enabled: true, runInBackground, items },
        llm: { agent: { sessions: { maxConcurrent, llmConcurrency: 4, notifyOnComplete: true } } },
      },
    });
    q = createMockLlmQueue(llm.chatCompletion);
    agent.removeAllListeners();
    agent.resetConversation();
    agent._setMaxSteps(4);
    agent._setLLMClient(llm);
    const services = createSessionServices({ configService: cfg, agentService: agent, userDataDir: dir });
    manager = services.sessionManager;
    store = services.sessionStore;
    inbox = new InboxService({ filePath: path.join(dir, 'inbox.json') });
    manager.bindInbox(inbox);
    routines = new RoutineService();
    routines.bind({ configService: cfg, agentService: agent, sessionManager: manager, inboxService: inbox });
    clock = NOW;
    routines._setNow(() => clock);
  }

  afterEach(async () => {
    for (const r of manager.running()) if (r.lane !== 'foreground') manager.stop(r.sessionId);
    await waitFor(() => manager.running().length === 0, 'runs to end');
  });

  test('a due routine starts a routine session and files an unread inbox item', async () => {
    setup();
    const events = [];
    manager.on('event', (e) => events.push(e));
    routines._tickOnce();
    const sessionId = routines._running.get('r1').sessionId;
    expect(store.get(sessionId).meta).toMatchObject({ source: 'routine', title: 'Morning digest' });
    await waitFor(() => q.callFor('gamma routine errand'), 'routine LLM request');
    q.answer('gamma routine errand', done('Three stories about the local election today'));
    await manager.settled(sessionId);
    await waitFor(() => routines._running.size === 0, 'routine to settle');

    expect(inbox.list()).toEqual([expect.objectContaining({
      sessionId, title: 'Morning digest', summary: 'Three stories about the local election today', ok: true, source: 'routine', read: false,
    })]);
    expect(inbox.unreadCount()).toBe(1);
    expect(cfg.get('settings.routines.items')[0].lastRunAt).toBe(NOW);
    expect(events).toContainEqual(expect.objectContaining({ sessionId, channel: 'task-completed', payload: expect.objectContaining({ ok: true, notify: true }) }));
  });

  test('a failed run files ok:false, keeps lastRunAt, and backs off before retrying', async () => {
    setup();
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    routines._tickOnce();
    const sessionId = routines._running.get('r1').sessionId;
    await waitFor(() => q.callFor('gamma routine errand'), 'routine LLM request');
    q.callFor('gamma routine errand').resolve(Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8080')));
    await manager.settled(sessionId);
    expect(logged).toHaveBeenCalledWith(`[sessionManager] session ${sessionId} run failed:`, 'connect ECONNREFUSED 127.0.0.1:8080');
    logged.mockRestore();
    await waitFor(() => routines._running.size === 0, 'routine to settle');

    const [item] = inbox.list();
    expect(item).toMatchObject({ sessionId, ok: false, source: 'routine', read: false });
    expect(item.summary).toContain('ECONNREFUSED');
    expect(cfg.get('settings.routines.items')[0].lastRunAt).toBeNull();

    const before = q.pending.length;
    clock = NOW + 60_000;
    routines._tickOnce();
    expect(routines._running.size).toBe(0);
    clock = NOW + 300_001;
    routines._tickOnce();
    expect(routines._running.get('r1')).toMatchObject({ sessionId: expect.any(String) });
    await waitFor(() => q.pending.length > before, 'retry LLM request');
  });

  test('a run that ends without an error (stopped) counts as run: lastRunAt advances and it waits for its next slot', async () => {
    setup();
    routines._tickOnce();
    const sessionId = routines._running.get('r1').sessionId;
    await waitFor(() => q.callFor('gamma routine errand'), 'routine LLM request');
    manager.stop(sessionId);
    const result = await manager.settled(sessionId);
    expect(result).toMatchObject({ ok: false, reason: 'stopped' });
    await waitFor(() => routines._running.size === 0, 'routine to settle');
    expect(cfg.get('settings.routines.items')[0].lastRunAt).toBe(NOW);

    clock = NOW + 300_001;
    routines._tickOnce();
    expect(routines._running.size).toBe(0);
    clock = NOW + 30 * 60_000;
    routines._tickOnce();
    expect(routines._running.get('r1')).toMatchObject({ sessionId: expect.any(String) });
  });

  test('a routine that cannot start is filed as ok:false without a session', () => {
    setup({ items: [routine({ task: '   ' })] });
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    routines._tickOnce();
    expect(logged).toHaveBeenCalledWith('[RoutineService] routine r1 could not start:', 'text required');
    logged.mockRestore();
    expect(routines._running.size).toBe(0);
    expect(store.list()).toEqual([]);
    const [item] = inbox.list();
    expect(item).toMatchObject({ sessionId: null, title: 'Morning digest', ok: false, source: 'routine' });
    expect(item.summary).toMatch(/^Routine could not start: /);
    routines._tickOnce();
    expect(inbox.list()).toHaveLength(1);
  });

  test('at capacity the routine stays pending until a slot frees', async () => {
    setup({ maxConcurrent: 1 });
    const other = manager.send({ text: 'delta other errand: keep busy' });
    await waitFor(() => q.callFor('delta other errand'), 'other LLM request');
    expect(manager.hasCapacity()).toBe(false);
    routines._tickOnce();
    expect(routines._running.size).toBe(0);
    expect(store.list().map((s) => s.id)).toEqual([other.sessionId]);
    expect(routines.runNow('r1')).toEqual({ ok: false, error: 'busy' });

    q.answer('delta other errand', done('The other errand finished completely'));
    await manager.settled(other.sessionId);
    await waitFor(() => manager.hasCapacity(), 'capacity');
    routines._tickOnce();
    expect(routines._running.get('r1')).toMatchObject({ sessionId: expect.any(String) });
    await waitFor(() => q.callFor('gamma routine errand'), 'routine LLM request');
    q.answer('gamma routine errand', done('Three stories about the local election today'));
    await manager.settled(routines._running.get('r1').sessionId);
    expect(inbox.list().filter((it) => it.source === 'routine')).toHaveLength(1);
  });

  test('a routine whose run never settles holds back only itself', async () => {
    setup({ items: [routine(), routine({ id: 'r2', name: 'Evening digest', task: 'hotel routine errand: tidy the inbox' })] });
    routines._tickOnce();
    await waitFor(() => q.callFor('gamma routine errand'), 'first routine LLM request');
    const first = routines._running.get('r1').sessionId;
    routines._tickOnce();
    expect(routines._running.get('r2')).toMatchObject({ sessionId: expect.any(String) });
    await waitFor(() => q.callFor('hotel routine errand'), 'second routine LLM request');
    expect(manager.hasCapacity()).toBe(false);
    expect(routines.runNow('r1')).toEqual({ ok: false, error: 'busy' });

    q.answer('hotel routine errand', done('The inbox is tidy and sorted now'));
    await waitFor(() => !routines._running.has('r2'), 'second routine to settle');
    expect(cfg.get('settings.routines.items').find((r) => r.id === 'r2').lastRunAt).toBe(NOW);
    expect(cfg.get('settings.routines.items').find((r) => r.id === 'r1').lastRunAt).toBeNull();
    // r1 is still in flight: a tick never starts it a second time.
    routines._tickOnce();
    expect(routines._running.get('r1').sessionId).toBe(first);
    expect(store.list()).toHaveLength(2);
  });

  test('runInBackground:false keeps the renderer dispatch path', () => {
    setup({ runInBackground: false });
    const mockWindow = { webContents: { send: jest.fn() }, isDestroyed: () => false };
    routines._window = mockWindow;
    routines._tickOnce();
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('routine:run', { id: 'r1', name: 'Morning digest', task: 'gamma routine errand: summarize the news' });
    expect(store.list()).toEqual([]);
  });
});
