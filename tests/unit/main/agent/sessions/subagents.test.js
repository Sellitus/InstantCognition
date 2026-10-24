// agent.spawn_subagent end to end: real AgentService, SessionRun, runTurn,
// sessionManager/subagentRunner and sessionStore on a tmp dir; only electron
// and the LLM HTTP client are mocked.

const mockUserData = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ic-subagents-'));

jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: { on: jest.fn(), handle: jest.fn() },
}));
jest.mock('../../../../../main/services/LLMClientService', () => ({ chatCompletion: jest.fn() }));

const fs = require('fs');
const path = require('path');
const svc = require('../../../../../main/services/AgentService');
const llm = require('../../../../../main/services/LLMClientService');
const { createSessionServices } = require('../../../../../main/agent/sessions/sessionServices');
const { childToolFilter, capBytes, normalizeSubagentSettings, SUMMARY_MAX_BYTES } = require('../../../../../main/agent/sessions/subagentRunner');
const { createSubagentTool, bindSubagentManager } = require('../../../../../main/agent/tools/subagentTool');
const { createMockLlmQueue, waitFor } = require('../../../../helpers/mockLlmQueue');

let callSeq = 0;
const tool = (name, args) => ({ content: '', toolCalls: [{ id: `c${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const done = (summary) => ({ content: JSON.stringify({ action: 'done', summary }) });
const offeredNames = (call) => {
  const native = call.opts && Array.isArray(call.opts.tools) ? call.opts.tools.map((t) => t.function.name) : null;
  return native || (call.messages[0].content.match(/\b[a-z]+\.[a-z_]+\b/g) || []);
};

afterAll(() => { fs.rmSync(mockUserData, { recursive: true, force: true }); });

describe('subagentRunner helpers', () => {
  test('capBytes keeps short text and cuts long text to the byte budget on a character boundary', () => {
    expect(capBytes('short', 4096)).toEqual({ text: 'short', truncated: false });
    const long = 'é'.repeat(5000); // 2 bytes each
    const out = capBytes(long, SUMMARY_MAX_BYTES);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(out.text).not.toContain('�');
    expect(out.text.endsWith('[truncated]')).toBe(true);
  });

  test('normalizeSubagentSettings clamps numbers and keeps defaults for junk', () => {
    expect(normalizeSubagentSettings(null)).toEqual({ enabled: true, maxConcurrent: 2, maxDepth: 1, defaultMaxSteps: 8 });
    expect(normalizeSubagentSettings({ enabled: false, maxConcurrent: 99, maxDepth: -1, defaultMaxSteps: 'x' }))
      .toEqual({ enabled: false, maxConcurrent: 8, maxDepth: 1, defaultMaxSteps: 8 });
  });

  test('childToolFilter intersects with the parent, honors the request, and never widens', () => {
    const parent = (n) => n !== 'browser.web_search';
    const f = childToolFilter({ parentFilter: parent, requested: new Set(['browser.web_search', 'fs.read']), readOnly: false, canSpawn: false });
    expect(f('fs.read')).toBe(true);
    expect(f('browser.web_search')).toBe(false); // requested, but the parent lacks it
    expect(f('fs.write')).toBe(false); // the parent has it, but it was not requested
    expect(f('agent.done')).toBe(true);
    expect(f('agent.spawn_subagent')).toBe(false);
    expect(f('agent.exit_plan')).toBe(false);
    const ro = childToolFilter({ parentFilter: null, requested: null, readOnly: true, canSpawn: true });
    expect(ro('fs.read')).toBe(true);
    expect(ro('fs.write')).toBe(false);
    expect(ro('shell.run')).toBe(false);
    expect(ro('browser.type')).toBe(false);
  });

  test('the tool reports subagents_unavailable when no manager is bound', async () => {
    const t = createSubagentTool({ getManager: () => null });
    expect(t.name).toBe('agent.spawn_subagent');
    expect(await t.handler({ task: 'x' }, {}, {})).toEqual({ ok: false, error: 'subagents_unavailable' });
  });
});

describe('agent.spawn_subagent in session runs', () => {
  let services;
  let manager;
  let store;
  let events;
  let q;
  let sub;

  beforeEach(() => {
    const userData = fs.mkdtempSync(path.join(mockUserData, 'run-'));
    events = [];
    sub = { enabled: true, maxConcurrent: 2, maxDepth: 1, defaultMaxSteps: 4 };
    q = createMockLlmQueue(llm.chatCompletion);
    svc.removeAllListeners();
    svc.resetConversation();
    svc._setMaxSteps(4);
    svc._setLLMClient(llm);
    const mockConfig = { get: (key, fallback) => (key === 'settings.llm.agent.sessions' ? { maxConcurrent: 2, llmConcurrency: 4 } : fallback) };
    services = createSessionServices({ configService: mockConfig, agentService: svc, userDataDir: userData });
    manager = services.sessionManager;
    manager.setSubagentSettings(() => sub);
    bindSubagentManager(manager);
    store = services.sessionStore;
    manager.on('event', (e) => events.push(e));
  });

  afterEach(async () => {
    for (const r of manager.running()) if (r.lane !== 'foreground') manager.stop(r.sessionId);
    await waitFor(() => manager.running().length === 0, 'runs to end');
    bindSubagentManager(null);
  });

  function startParent(text, mode = 'bypass') {
    const s = store.create();
    svc._approval.setSessionMode(s.id, mode);
    manager.send({ sessionId: s.id, text });
    return s.id;
  }

  test('the child starts from a fresh context and only its summary returns to the parent', async () => {
    const parentId = startParent('omega parent errand: compare the two vendors');
    await waitFor(() => q.callFor('omega parent errand'), 'parent request');
    q.answer('omega parent errand', tool('agent.spawn_subagent', { task: 'kappa child errand: list vendor A prices' }));
    await waitFor(() => q.open().length === 1 && q.callFor('kappa child errand'), 'child request');
    const childCall = q.open()[0];
    expect(childCall.text).not.toContain('omega parent errand');
    const child = manager.running().find((r) => r.lane === 'subagent');
    expect(child).toMatchObject({ parentSessionId: parentId, depth: 1 });
    // The child does one intermediate step whose output must not reach the parent.
    childCall.resolve(tool('agent.update_ledger', { facts: ['zeta intermediate finding'] }));
    await waitFor(() => q.open().length === 1 && q.open()[0] !== childCall, 'child second request');
    q.open()[0].resolve(done('Vendor A charges ten dollars per seat per month'));
    await waitFor(() => q.open().length === 1 && q.open()[0].text.includes('Vendor A charges'), 'parent resumes');
    const parentNext = q.open()[0];
    expect(parentNext.text).not.toContain('zeta intermediate finding');
    parentNext.resolve(done('Vendor A is cheaper at ten dollars per seat'));
    await manager.settled(parentId);

    const acted = events.filter((e) => e.sessionId === parentId && e.channel === 'step-acted').map((e) => e.payload.results[0]);
    const spawnResult = acted.find((r) => r.name === 'agent.spawn_subagent').result;
    expect(Object.keys(spawnResult).sort()).toEqual(['ok', 'subagentSessionId', 'summary', 'truncated']);
    expect(spawnResult).toMatchObject({ ok: true, summary: 'Vendor A charges ten dollars per seat per month', truncated: false });
    expect(store.get(spawnResult.subagentSessionId).meta).toMatchObject({ source: 'subagent', title: 'Subagent: kappa child errand: list vendor A prices' });
    expect(events).toContainEqual({ sessionId: parentId, channel: 'subagent-completed', payload: { childSessionId: spawnResult.subagentSessionId, ok: true, error: null } });
    const childDone = events.find((e) => e.sessionId === spawnResult.subagentSessionId && e.channel === 'task-completed');
    expect(childDone.payload.notify).toBe(false);
    expect(svc._approval.getSessionModes()[spawnResult.subagentSessionId]).toBeUndefined();
    svc._approval.setSessionMode(parentId, null);
  });

  test('a long child summary is capped at 4KB', async () => {
    const p = manager.spawnSubagent({ task: 'lambda child errand: write it all' });
    await waitFor(() => q.callFor('lambda child errand'), 'child request');
    q.answer('lambda child errand', done('x'.repeat(10000)));
    const out = await p;
    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.summary, 'utf8')).toBeLessThanOrEqual(4096);
  });

  test('stopping the parent aborts its running child', async () => {
    const parentId = startParent('sigma parent errand: delegate the research');
    await waitFor(() => q.callFor('sigma parent errand'), 'parent request');
    q.answer('sigma parent errand', tool('agent.spawn_subagent', { task: 'tau child errand: research slowly' }));
    await waitFor(() => q.callFor('tau child errand'), 'child request');
    const childCall = q.callFor('tau child errand');
    const childId = manager.running().find((r) => r.lane === 'subagent').sessionId;
    manager.stop(parentId);
    await expect(manager.settled(parentId)).resolves.toMatchObject({ ok: false, reason: 'stopped' });
    await waitFor(() => !manager.running().some((r) => r.lane === 'subagent'), 'child to stop');
    expect(childCall.opts.signal.aborted).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ sessionId: childId, channel: 'task-completed', payload: expect.objectContaining({ ok: false, reason: 'stopped' }) }));
    svc._approval.setSessionMode(parentId, null);
  });

  test('depth beyond maxDepth is denied and the child is not offered the spawn tool', async () => {
    const p = manager.spawnSubagent({ task: 'mu child errand: nested work', parentMode: 'bypass' });
    await waitFor(() => q.callFor('mu child errand'), 'child request');
    const childCall = q.callFor('mu child errand');
    expect(offeredNames(childCall)).not.toContain('agent.spawn_subagent');
    const childId = manager.running().find((r) => r.lane === 'subagent').sessionId;
    await expect(manager.spawnSubagent({ task: 'grandchild work', parentSessionId: childId })).rejects.toThrow('subagent_depth_exceeded');
    // A spawn call the child invents anyway is refused, not run.
    childCall.resolve(tool('agent.spawn_subagent', { task: 'grandchild work' }));
    await waitFor(() => q.open().length === 1, 'child second request');
    q.open()[0].resolve(done('The nested work finished without a grandchild'));
    await expect(p).resolves.toMatchObject({ ok: true });
    const acted = events.filter((e) => e.sessionId === childId && e.channel === 'step-acted').map((e) => e.payload.results[0]);
    expect(acted[0]).toMatchObject({ name: 'agent.spawn_subagent', result: { ok: false, error: 'tool_not_available' } });
    expect(manager.running()).toEqual([]);
  });

  test('a Plan-mode parent gets a read-only child', async () => {
    const p = manager.spawnSubagent({ task: 'nu child errand: inspect the repo', parentMode: 'plan' });
    await waitFor(() => q.callFor('nu child errand'), 'child request');
    const childCall = q.callFor('nu child errand');
    const names = offeredNames(childCall);
    expect(names).toContain('fs.read');
    expect(names).not.toContain('fs.write');
    expect(names).not.toContain('shell.run');
    expect(names).not.toContain('agent.exit_plan');
    expect(childCall.text).not.toContain('PLAN MODE');
    const childId = manager.running().find((r) => r.lane === 'subagent').sessionId;
    expect(svc._approval.getMode(childId)).toBe('ask');
    childCall.resolve(tool('fs.write', { path: 'notes.md', content: 'x' }));
    await waitFor(() => q.open().length === 1, 'child second request');
    q.open()[0].resolve(done('The repository was inspected without changes'));
    await expect(p).resolves.toMatchObject({ ok: true });
    const acted = events.filter((e) => e.sessionId === childId && e.channel === 'step-acted').map((e) => e.payload.results[0]);
    expect(acted[0]).toMatchObject({ name: 'fs.write', result: { ok: false, error: 'tool_not_available' } });
  });

  test('requested tools narrow the child but never add what the parent lacks', async () => {
    const parentFilter = (n) => n !== 'browser.web_search';
    const p = manager.spawnSubagent({ task: 'xi child errand: read a file', tools: ['fs.read', 'browser.web_search'], parentFilter });
    await waitFor(() => q.callFor('xi child errand'), 'child request');
    const names = offeredNames(q.callFor('xi child errand'));
    expect(names).toContain('fs.read');
    expect(names).toContain('agent.done');
    expect(names).not.toContain('browser.web_search');
    expect(names).not.toContain('fs.write');
    q.answer('xi child errand', done('The file was read and nothing else was used'));
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  test('maxConcurrent holds extra children until a slot frees', async () => {
    sub.maxConcurrent = 1;
    const a = manager.spawnSubagent({ task: 'rho child errand one' });
    const b = manager.spawnSubagent({ task: 'phi child errand two' });
    await waitFor(() => q.callFor('rho child errand'), 'first child request');
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(q.callFor('phi child errand')).toBeUndefined();
    expect(manager.running().filter((r) => r.lane === 'subagent')).toHaveLength(1);
    q.answer('rho child errand', done('The first child finished its whole errand'));
    await expect(a).resolves.toMatchObject({ ok: true });
    await waitFor(() => q.callFor('phi child errand'), 'second child request');
    q.answer('phi child errand', done('The second child finished its whole errand'));
    await expect(b).resolves.toMatchObject({ ok: true });
  });

  test('a waiting child is abandoned when its parent aborts', async () => {
    sub.maxConcurrent = 1;
    const first = manager.spawnSubagent({ task: 'chi child errand one' });
    await waitFor(() => q.callFor('chi child errand'), 'first child request');
    const ac = new AbortController();
    const waiting = manager.spawnSubagent({ task: 'psi child errand two', signal: ac.signal });
    ac.abort();
    await expect(waiting).rejects.toThrow('aborted');
    q.answer('chi child errand', done('The first child finished its whole errand'));
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(q.callFor('psi child errand')).toBeUndefined();
  });

  test('a nested child runs inside its parent child\'s slot instead of waiting forever for a second one', async () => {
    const { gate } = require('../../../../../main/agent/sessions/llmGate');
    gate.configure({ limit: () => 1 });
    sub.maxConcurrent = 1;
    sub.maxDepth = 2;
    const p = manager.spawnSubagent({ task: 'upsilon child errand: delegate once', parentMode: 'bypass' });
    await waitFor(() => q.callFor('upsilon child errand'), 'child request');
    q.answer('upsilon child errand', tool('agent.spawn_subagent', { task: 'omicron grandchild errand: do the work' }));
    await waitFor(() => q.callFor('omicron grandchild errand'), 'grandchild request');
    expect(manager.running().filter((r) => r.lane === 'subagent').map((r) => r.depth).sort()).toEqual([1, 2]);
    q.answer('omicron grandchild errand', done('The grandchild did the work it was given'));
    await waitFor(() => q.open().length === 1 && q.open()[0].text.includes('The grandchild did the work'), 'child resumes');
    q.open()[0].resolve(done('The child relayed the grandchild result'));
    await expect(p).resolves.toMatchObject({ ok: true, summary: 'The child relayed the grandchild result' });
    // Top-level children still queue on the slot.
    const a = manager.spawnSubagent({ task: 'pi child errand one' });
    const b = manager.spawnSubagent({ task: 'beta child errand two' });
    await waitFor(() => q.callFor('pi child errand'), 'first top-level child');
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(q.callFor('beta child errand')).toBeUndefined();
    q.answer('pi child errand', done('The first child finished its whole errand'));
    await waitFor(() => q.callFor('beta child errand'), 'second top-level child');
    q.answer('beta child errand', done('The second child finished its whole errand'));
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });

  test('bad requests and disabled subagents are refused before anything runs', async () => {
    await expect(manager.spawnSubagent({ task: '   ' })).rejects.toThrow('task required');
    await expect(manager.spawnSubagent({ task: 'x'.repeat(20001) })).rejects.toThrow('task_too_large');
    await expect(manager.spawnSubagent({ task: 't', tools: 'fs.read' })).rejects.toThrow('invalid_tools');
    await expect(manager.spawnSubagent({ task: 't', maxSteps: 0 })).rejects.toThrow('invalid_max_steps');
    sub.enabled = false;
    await expect(manager.spawnSubagent({ task: 't' })).rejects.toThrow('subagents_disabled');
    expect(q.pending).toHaveLength(0);
    expect(store.list()).toEqual([]);
  });
});

describe('subagentRunner deadline', () => {
  const { SubagentRunner } = require('../../../../../main/agent/sessions/subagentRunner');
  const { createSessionStore } = require('../../../../../main/agent/sessions/sessionStore');

  // A host whose run ends only when the test (or a stop) ends it.
  function mockHostFactory() {
    const hosts = [];
    const createHost = () => {
      let finish;
      const host = {
        _paused: false,
        start: jest.fn(() => new Promise((r) => { finish = r; })),
        stopTask: jest.fn(() => finish({ ok: false, reason: 'stopped' })),
        finish: (res) => finish(res),
      };
      hosts.push(host);
      return host;
    };
    return { hosts, createHost };
  }

  test('a child still queued for a slot when the deadline passes fails with subagent_timeout', async () => {
    const store = createSessionStore({ baseDir: fs.mkdtempSync(path.join(mockUserData, 'deadline-')) });
    const { hosts, createHost } = mockHostFactory();
    const runner = new SubagentRunner({ store, createHost, getSettings: () => ({ maxConcurrent: 1, maxDepth: 1 }), emitEvent: () => {}, deadlineMs: 150 });
    const first = runner.spawn({ task: 'hold the only slot' });
    await waitFor(() => hosts.length === 1 && hosts[0].start.mock.calls.length === 1, 'first child started');
    // The first child ignores its deadline stop so the slot stays taken.
    hosts[0].stopTask.mockImplementation(() => {});
    const queued = runner.spawn({ task: 'wait for the slot' });
    const outcome = await Promise.race([queued.then(() => 'resolved', (err) => err.message), new Promise((r) => setTimeout(() => r('still waiting'), 1500))]);
    expect(outcome).toBe('subagent_timeout');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].stopTask).toHaveBeenCalledTimes(1);
    hosts[0].finish({ ok: true, summary: 'the slot holder finished late' });
    await expect(first).resolves.toMatchObject({ ok: true });
    // Negative: the slot is free again, and a child that gets it in time runs normally.
    const next = runner.spawn({ task: 'run in time' });
    await waitFor(() => hosts.length === 2 && hosts[1].start.mock.calls.length === 1, 'next child started');
    hosts[1].finish({ ok: true, summary: 'finished well inside the deadline' });
    await expect(next).resolves.toMatchObject({ ok: true, summary: 'finished well inside the deadline' });
  });
});
