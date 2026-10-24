// Plan mode: the plan tools, the two-layer tool restriction (offered list +
// permission engine), and the plan-decision contract on both lanes. Real
// AgentService / SessionRun / sessionStore on a tmp dir; only electron and the
// LLM HTTP client are mocked.

const mockUserData = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ic-planmode-'));

jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: { on: jest.fn(), handle: jest.fn() },
}));
jest.mock('../../../../../main/services/LLMClientService', () => ({ chatCompletion: jest.fn() }));

const fs = require('fs');
const path = require('path');
const svc = require('../../../../../main/services/AgentService');
const llm = require('../../../../../main/services/LLMClientService');
const planTools = require('../../../../../main/agent/tools/planTools');
const ledgerModule = require('../../../../../main/agent/ledger');
const { buildToolFilter, PLAN_NOTE } = require('../../../../../main/agent/sessions/runTurn');
const { createSessionServices } = require('../../../../../main/agent/sessions/sessionServices');
const { createMockLlmQueue, waitFor } = require('../../../../helpers/mockLlmQueue');

const [todoWrite, exitPlan] = planTools;
const { normalizeTodos, normalizePlan } = planTools;
// Native tool calls: the text-JSON parser reads the first [...] in a reply, so
// an args object holding an array (todos) is only reliable on the native path.
let callSeq = 0;
const tool = (name, args) => ({ content: '', toolCalls: [{ id: `c${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const offeredNames = (call) => {
  const native = call.opts && Array.isArray(call.opts.tools) ? call.opts.tools.map((t) => t.function.name) : null;
  return native || (call.messages[0].content.match(/\b[a-z]+\.[a-z_]+\b/g) || []);
};

afterAll(() => { fs.rmSync(mockUserData, { recursive: true, force: true }); });

describe('agent.todo_write', () => {
  test('replaces the ledger plan, maps statuses and emits plan-updated', async () => {
    const toolCtx = { ledger: ledgerModule.init({ task: 't' }) };
    const emit = jest.fn();
    const res = await todoWrite.handler({ todos: [
      { content: 'read the docs', status: 'completed' },
      { content: 'write code', status: 'in_progress', activeForm: 'Writing code' },
      { content: 'test', status: 'pending' },
    ] }, toolCtx, { emit });
    expect(res).toEqual({ ok: true, count: 3 });
    expect(toolCtx.ledger.plan.map((p) => [p.step, p.status])).toEqual([['read the docs', 'done'], ['write code', 'doing'], ['test', 'todo']]);
    expect(toolCtx.todos[1]).toEqual({ content: 'write code', status: 'in_progress', activeForm: 'Writing code' });
    expect(emit).toHaveBeenCalledWith('plan-updated', expect.objectContaining({ todos: toolCtx.todos }));
  });

  test('rejects malformed lists without touching the ledger', async () => {
    const toolCtx = { ledger: ledgerModule.init({ task: 't' }) };
    const before = JSON.stringify(toolCtx.ledger);
    expect(await todoWrite.handler({ todos: 'x' }, toolCtx, {})).toEqual({ ok: false, error: 'todos must be an array' });
    expect(await todoWrite.handler({ todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] }, toolCtx, {}))
      .toEqual({ ok: false, error: 'only one todo may be in_progress' });
    expect(JSON.stringify(toolCtx.ledger)).toBe(before);
    expect(normalizeTodos([{ content: ' ', status: 'pending' }]).error).toBe('todos[0].content is required');
    expect(normalizeTodos([{ content: 'a', status: 'done' }]).error).toMatch(/status must be/);
    expect(normalizeTodos([null]).error).toBe('todos[0] must be an object');
    expect(normalizeTodos(Array.from({ length: 51 }, () => ({ content: 'a', status: 'pending' }))).error).toBe('at most 50 todos');
  });
});

describe('agent.exit_plan', () => {
  test('outside plan mode it refuses', async () => {
    expect(await exitPlan.handler({ summary: 's' }, { permissionMode: 'ask' })).toEqual({ ok: false, error: 'not_in_plan_mode' });
    expect(await exitPlan.handler({ summary: 's' }, null)).toEqual({ ok: false, error: 'not_in_plan_mode' });
  });

  test('in plan mode it proposes the plan, falling back to the current todos', async () => {
    const toolCtx = { permissionMode: 'plan', todos: [{ content: 'step one', status: 'pending' }] };
    expect(await exitPlan.handler({ summary: '  Do the thing  ' }, toolCtx)).toEqual({
      ok: true, awaiting: 'plan_approval', plan: { summary: 'Do the thing', todos: [{ content: 'step one', status: 'pending' }] },
    });
    expect(await exitPlan.handler({ summary: '' }, toolCtx)).toEqual({ ok: false, error: 'summary is required' });
    expect(await exitPlan.handler({ summary: 's', todos: [{ content: 'x', status: 'nope' }] }, toolCtx)).toMatchObject({ ok: false });
  });

  test('normalizePlan validates an edited plan', () => {
    expect(normalizePlan({ summary: 'S', todos: [{ content: 'a', status: 'pending' }] })).toEqual({ plan: { summary: 'S', todos: [{ content: 'a', status: 'pending' }] } });
    expect(normalizePlan(null)).toEqual({ error: 'plan must be an object' });
    expect(normalizePlan({ summary: '' })).toEqual({ error: 'plan.summary is required' });
  });
});

describe('plan-mode tool restriction', () => {
  test('plan mode offers only planSafe tools plus exit_plan; other modes hide exit_plan', () => {
    const plan = buildToolFilter(true, null);
    expect(plan('fs.read')).toBe(true);
    expect(plan('agent.todo_write')).toBe(true);
    expect(plan('agent.exit_plan')).toBe(true);
    expect(plan('fs.write')).toBe(false);
    expect(plan('shell.run')).toBe(false);
    const ask = buildToolFilter(false, null);
    expect(ask('agent.exit_plan')).toBe(false);
    expect(ask('fs.write')).toBe(true);
    const narrowed = buildToolFilter(true, (name) => name !== 'fs.read');
    expect(narrowed('fs.read')).toBe(false);
  });

  test('settings that switch off subagents or the shell take their tools out of every mode', () => {
    const off = buildToolFilter(false, null, { spawn: false, shell: false });
    expect(off('agent.spawn_subagent')).toBe(false);
    expect(off('shell.run')).toBe(false);
    expect(off('fs.read')).toBe(true);
    expect(off('fs.write')).toBe(true);
    const on = buildToolFilter(false, null, { spawn: true, shell: true });
    expect(on('agent.spawn_subagent')).toBe(true);
    expect(on('shell.run')).toBe(true);
    expect(buildToolFilter(false, null)('shell.run')).toBe(true);
  });

  test('the permission engine denies a non-planSafe call for a session in plan mode', () => {
    const sid = 's_planengine1';
    svc._approval.setSessionMode(sid, 'plan');
    try {
      const call = { id: 'c1', name: 'browser.type', args: { selector: '#q', text: 'x' } };
      const viaMode = svc._approval.decide([call], { sessionId: sid });
      expect(viaMode.denied).toEqual([{ call, reason: 'plan_mode_read_only' }]);
      const filter = buildToolFilter(true, null);
      const viaFilter = svc._approval.decide([call], { sessionId: sid, allowedTools: (n) => filter(n) });
      expect(viaFilter.denied).toEqual([{ call, reason: 'tool_not_available' }]);
      expect(viaFilter.allowed).toEqual([]);
    } finally { svc._approval.setSessionMode(sid, null); }
  });
});

describe('plan mode in a session run + session:plan-decision', () => {
  let userData;
  let services;
  let manager;
  let store;
  let events;
  let q;

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(mockUserData, 'run-'));
    events = [];
    q = createMockLlmQueue(llm.chatCompletion);
    svc.removeAllListeners();
    svc.resetConversation();
    svc._setMaxSteps(4);
    svc._setLLMClient(llm);
    const mockConfig = { get: (key, fallback) => (key === 'settings.llm.agent.sessions' ? { maxConcurrent: 2, llmConcurrency: 1 } : fallback) };
    services = createSessionServices({ configService: mockConfig, agentService: svc, userDataDir: userData });
    manager = services.sessionManager;
    store = services.sessionStore;
    manager.on('event', (e) => events.push(e));
  });

  afterEach(async () => {
    for (const r of manager.running()) if (r.lane === 'background') manager.stop(r.sessionId);
    await Promise.all(manager.running().map((r) => manager.settled(r.sessionId)));
    fs.rmSync(userData, { recursive: true, force: true });
  });

  async function proposePlan() {
    const s = store.create();
    svc._approval.setSessionMode(s.id, 'plan');
    manager.send({ sessionId: s.id, text: 'delta errand: update the notes file' });
    await waitFor(() => q.callFor('delta errand'), 'plan-mode request');
    const first = q.callFor('delta errand');
    expect(first.text).toContain('PLAN MODE: research only.');
    expect(PLAN_NOTE).toContain('agent.exit_plan');
    const names = offeredNames(first);
    expect(names).toContain('agent.exit_plan');
    expect(names).not.toContain('fs.write');
    q.answer('delta errand', tool('fs.write', { path: 'notes.md', content: 'x' }));
    await waitFor(() => q.open().length === 1, 'second plan-mode request');
    q.open()[0].resolve(tool('agent.exit_plan', { summary: 'Update notes.md with the summary', todos: [{ content: 'edit notes.md', status: 'pending' }] }));
    const res = await manager.settled(s.id);
    return { sessionId: s.id, res };
  }

  test('a plan-mode run refuses fs.write, ends with the proposed plan and persists it', async () => {
    const { sessionId, res } = await proposePlan();
    expect(res).toMatchObject({ ok: false, reason: 'awaiting_plan_approval' });
    const acted = events.filter((e) => e.sessionId === sessionId && e.channel === 'step-acted').map((e) => e.payload.results[0]);
    expect(acted[0]).toMatchObject({ name: 'fs.write', result: { ok: false, error: 'tool_not_available' } });
    const plan = { summary: 'Update notes.md with the summary', todos: [{ content: 'edit notes.md', status: 'pending' }] };
    expect(events).toContainEqual(expect.objectContaining({ sessionId, channel: 'plan-proposed', payload: expect.objectContaining({ sessionId, plan }) }));
    expect(manager.pendingPlan(sessionId)).toEqual(plan);
    const last = store.getPath(sessionId).pop();
    expect(last).toMatchObject({ kind: 'plan', content: 'Update notes.md with the summary\n\n1. edit notes.md' });
    expect(store.getPath(sessionId)[0].data).toEqual({ permissionMode: 'plan' });
  });

  test('reject keeps plan mode and resumes nothing', async () => {
    const { sessionId } = await proposePlan();
    const asked = q.pending.length;
    expect(manager.planDecision({ sessionId, decision: 'reject' })).toEqual({ ok: true, decision: 'reject', resumed: false });
    expect(svc._approval.getMode(sessionId)).toBe('plan');
    expect(manager.pendingPlan(sessionId)).toBeNull();
    expect(manager.running()).toEqual([]);
    expect(q.pending.length).toBe(asked);
    expect(() => manager.planDecision({ sessionId, decision: 'approve' })).toThrow('no_pending_plan');
  });

  test('approve switches to ask mode and resumes on the background lane with the plan', async () => {
    const { sessionId } = await proposePlan();
    const out = manager.planDecision({ sessionId, decision: 'approve' });
    expect(out).toEqual({ ok: true, decision: 'approve', resumed: true, lane: 'background', queued: false });
    expect(svc._approval.getMode(sessionId)).toBe('ask');
    await waitFor(() => q.callFor('The user approved the plan'), 'resumed run');
    const resumed = q.callFor('The user approved the plan');
    expect(resumed.text).toContain('1. edit notes.md');
    expect(resumed.text).not.toContain('PLAN MODE: research only.');
    expect(offeredNames(resumed)).not.toContain('agent.exit_plan');
    resumed.resolve({ content: JSON.stringify({ action: 'done', summary: 'notes.md now holds the summary text' }) });
    await expect(manager.settled(sessionId)).resolves.toMatchObject({ ok: true });
    svc._approval.setSessionMode(sessionId, null);
  });

  test('approve_auto_edit selects auto-edit; edit validates and uses the edited plan', async () => {
    const first = await proposePlan();
    manager.planDecision({ sessionId: first.sessionId, decision: 'approve_auto_edit' });
    expect(svc._approval.getMode(first.sessionId)).toBe('auto-edit');
    manager.stop(first.sessionId);
    await manager.settled(first.sessionId);
    svc._approval.setSessionMode(first.sessionId, null);

    const second = await proposePlan();
    expect(() => manager.planDecision({ sessionId: second.sessionId, decision: 'edit', plan: { summary: '' } })).toThrow('plan.summary is required');
    expect(manager.pendingPlan(second.sessionId)).not.toBeNull();
    expect(svc._approval.getMode(second.sessionId)).toBe('plan');
    const edited = { summary: 'Only append a line', todos: [{ content: 'append one line', status: 'pending' }] };
    expect(manager.planDecision({ sessionId: second.sessionId, decision: 'edit', plan: edited })).toMatchObject({ ok: true, decision: 'edit', resumed: true });
    expect(events).toContainEqual({ sessionId: second.sessionId, channel: 'plan-decided', payload: { decision: 'edit', plan: edited } });
    await waitFor(() => q.callFor('approved the plan with edits'), 'edited resume');
    expect(q.callFor('approved the plan with edits').text).toContain('1. append one line');
    svc._approval.setSessionMode(second.sessionId, null);
  });

  test('invalid decisions and ids are refused', () => {
    expect(() => manager.planDecision({ sessionId: 's_abcdef12', decision: 'maybe' })).toThrow('invalid_decision');
    expect(() => manager.planDecision({ sessionId: 'bad', decision: 'approve' })).toThrow('invalid_session_id');
    expect(() => manager.planDecision({ sessionId: 's_abcdef12', decision: 'approve' })).toThrow('no_pending_plan');
  });

  test('a foreground plan resumes on the foreground lane in the same session', async () => {
    const wc = {
      executeJavaScript: jest.fn(async (src) => (src.includes('interactives') ? { title: 't', url: 'about:blank', interactives: [], links: [], text: '' } : { ok: true })),
      loadURL: jest.fn(async () => {}), getURL: () => 'about:blank', on: jest.fn(), once: jest.fn(), removeListener: jest.fn(), isDestroyed: () => false,
    };
    svc._setWebContentsModule({ fromId: () => wc });
    manager.attachForeground(svc);
    const s = store.create();
    svc._approval.setSessionMode(s.id, 'plan');
    const run = svc.startTask({ description: 'echo errand: tidy the page', webContentsId: 7, sessionId: s.id });
    await waitFor(() => q.callFor('echo errand'), 'foreground plan request');
    q.answer('echo errand', tool('agent.exit_plan', { summary: 'Tidy the page layout', todos: [] }));
    await expect(run).resolves.toMatchObject({ reason: 'awaiting_plan_approval' });
    expect(manager.pendingPlan(s.id)).toEqual({ summary: 'Tidy the page layout', todos: [] });
    const started = [];
    svc.on('task-started', (e) => started.push(e));
    expect(manager.planDecision({ sessionId: s.id, decision: 'approve' })).toEqual({ ok: true, decision: 'approve', resumed: true, lane: 'foreground' });
    await waitFor(() => q.callFor('The user approved the plan'), 'foreground resume');
    expect(started[0]).toMatchObject({ sessionId: s.id, permissionMode: 'ask' });
    expect(manager.running()).toEqual([expect.objectContaining({ sessionId: s.id, lane: 'foreground' })]);
    q.callFor('The user approved the plan').resolve({ content: JSON.stringify({ action: 'done', summary: 'the page layout is tidy now' }) });
    await waitFor(() => !svc.isRunning(), 'foreground run end');
    svc._approval.setSessionMode(s.id, null);
  });

  test('approving a foreground plan while the foreground agent is busy changes nothing', async () => {
    const wc = {
      executeJavaScript: jest.fn(async (src) => (src.includes('interactives') ? { title: 't', url: 'about:blank', interactives: [], links: [], text: '' } : { ok: true })),
      loadURL: jest.fn(async () => {}), getURL: () => 'about:blank', on: jest.fn(), once: jest.fn(), removeListener: jest.fn(), isDestroyed: () => false,
    };
    svc._setWebContentsModule({ fromId: () => wc });
    manager.attachForeground(svc);
    const s = store.create();
    svc._approval.setSessionMode(s.id, 'plan');
    const planRun = svc.startTask({ description: 'foxtrot errand: tidy the page', webContentsId: 7, sessionId: s.id });
    await waitFor(() => q.callFor('foxtrot errand'), 'foreground plan request');
    q.answer('foxtrot errand', tool('agent.exit_plan', { summary: 'Tidy the page layout', todos: [] }));
    await planRun;
    // A tab-scoped conversation records to its own session, not s.
    const other = svc.startTask({ description: 'golf errand: unrelated work', webContentsId: 7, scope: 'tab', tabId: 'other-tab' });
    await waitFor(() => q.callFor('golf errand'), 'unrelated foreground request');
    events.length = 0;
    expect(() => manager.planDecision({ sessionId: s.id, decision: 'approve' })).toThrow('agent_busy');
    expect(manager.pendingPlan(s.id)).toEqual({ summary: 'Tidy the page layout', todos: [] });
    expect(svc._approval.getMode(s.id)).toBe('plan');
    expect(events.filter((e) => e.channel === 'plan-decided')).toEqual([]);
    q.answer('golf errand', { content: JSON.stringify({ action: 'done', summary: 'the unrelated work is complete' }) });
    await other;
    await waitFor(() => !svc.isRunning(), 'unrelated run end');
    // Once the foreground is free the same decision goes through.
    expect(manager.planDecision({ sessionId: s.id, decision: 'approve' })).toMatchObject({ ok: true, resumed: true, lane: 'foreground' });
    expect(svc._approval.getMode(s.id)).toBe('ask');
    await waitFor(() => q.callFor('The user approved the plan'), 'foreground resume');
    q.callFor('The user approved the plan').resolve({ content: JSON.stringify({ action: 'done', summary: 'the page layout is tidy now' }) });
    await waitFor(() => !svc.isRunning(), 'foreground run end');
    svc._approval.setSessionMode(s.id, null);
  });
});
