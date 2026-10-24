// Per-session agent tabs: AgentTabOpsService.forSession tags the tabs a
// session opens in the real tabRegistry and refuses ops on another session's
// tab; tabRegistry.forSession hides them. The end-to-end case runs two
// background sessions through the real session manager. Only electron, the
// window/ipcMain pair and the LLM HTTP client are mocked.

const mockUserData = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ic-tab-sessions-'));

jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: { on: jest.fn(), handle: jest.fn() },
}));
jest.mock('../../../../main/services/LLMClientService', () => ({ chatCompletion: jest.fn() }));

const fs = require('fs');
const path = require('path');
const tabOps = require('../../../../main/services/AgentTabOpsService');
const tabRegistry = require('../../../../main/services/tabRegistry');

const SA = 's_aaaaaa01';
const SB = 's_bbbbbb02';

function mockWindowAndIpc() {
  const listeners = {};
  const ipc = { on: (ch, fn) => { listeners[ch] = fn; } };
  const sent = [];
  let next = 0;
  const win = {
    sent,
    isDestroyed: () => false,
    webContents: {
      send: (ch, payload) => {
        sent.push(payload);
        // Reply like AgentWorkspaceManager: open/duplicate mint a new spaceId.
        const spaceId = payload.op === 'open' || payload.op === 'duplicate' ? `agent_tab_${++next}` : payload.args.spaceId;
        setImmediate(() => listeners['agent-workspace:tab-op-result'](null, { requestId: payload.requestId, ok: true, spaceId }));
      },
    },
  };
  return { win, ipc };
}

afterAll(() => { fs.rmSync(mockUserData, { recursive: true, force: true }); });

describe('session-scoped tab ops', () => {
  let win;

  beforeEach(() => {
    tabRegistry.clear();
    tabOps._reset();
    const pair = mockWindowAndIpc();
    win = pair.win;
    tabOps.bind(win, pair.ipc);
  });

  test('a tab opened by a session carries its sessionId and is tagged in the registry', async () => {
    const res = await tabOps.forSession(SA).openTab('https://a.example');
    expect(win.sent[0]).toMatchObject({ op: 'open', args: { url: 'https://a.example', sessionId: SA } });
    expect(tabRegistry.get(res.spaceId)).toMatchObject({ sessionId: SA });
  });

  test("one session's view never shows another session's tabs; untagged tabs stay shared", async () => {
    const a = await tabOps.forSession(SA).openTab('https://a.example');
    const b = await tabOps.forSession(SB).openTab('https://b.example');
    tabRegistry.set(a.spaceId, 101, true);
    tabRegistry.set(b.spaceId, 202, true);
    tabRegistry.set('user_tab', 303, false);

    const viewA = tabRegistry.forSession(SA);
    const viewB = tabRegistry.forSession(SB);
    expect(viewA.list().map((t) => t.spaceId).sort()).toEqual([a.spaceId, 'user_tab']);
    expect(viewB.list().map((t) => t.spaceId).sort()).toEqual([b.spaceId, 'user_tab']);
    expect(viewA.get(b.spaceId)).toBeNull();
    expect(viewA.findBySpaceId(202)).toBeNull();
    expect(viewB.findBySpaceId(202)).toBe(b.spaceId);
    expect(tabRegistry.forSession(null).list().map((t) => t.spaceId)).toEqual(['user_tab']);
  });

  test("close, focus and duplicate on another session's tab are refused without IPC", async () => {
    const a = await tabOps.forSession(SA).openTab('https://a.example');
    const opsB = tabOps.forSession(SB);
    win.sent.length = 0;
    await expect(opsB.closeTab(a.spaceId)).rejects.toThrow('tab_not_owned');
    await expect(opsB.focusTab(a.spaceId)).rejects.toThrow('tab_not_owned');
    await expect(opsB.duplicateTab(a.spaceId)).rejects.toThrow('tab_not_owned');
    expect(win.sent).toEqual([]);
    await expect(tabOps.forSession(SA).closeTab(a.spaceId)).resolves.toMatchObject({ ok: true });
    expect(win.sent[0]).toMatchObject({ op: 'close', args: { spaceId: a.spaceId, sessionId: SA } });
  });

  test('close, focus and duplicate on a private tab are refused without IPC, for every session', async () => {
    tabRegistry.set('priv_tab', 404, false);
    tabRegistry.setMeta('priv_tab', { kind: 'user', private: true });
    win.sent.length = 0;
    for (const ops of [tabOps.forSession(SA), tabOps.forSession(null)]) {
      await expect(ops.closeTab('priv_tab')).rejects.toThrow('private_tab');
      await expect(ops.focusTab('priv_tab')).rejects.toThrow('private_tab');
      await expect(ops.duplicateTab('priv_tab')).rejects.toThrow('private_tab');
    }
    expect(win.sent).toEqual([]);
  });

  test('a background surface marks its ops and keeps its own active tab', async () => {
    const fgOps = tabOps.forSession(SA);
    const bgOps = tabOps.forSession(SB, { background: true });
    const a = await fgOps.openTab('https://a.example');
    const b1 = await bgOps.openTab('https://b1.example');
    const b2 = await bgOps.openTab('https://b2.example');
    expect(win.sent[0].args).not.toHaveProperty('background');
    expect(win.sent[1].args).toMatchObject({ sessionId: SB, background: true });
    // The renderer kept A's tab on screen.
    tabRegistry.set(a.spaceId, 1, true);
    tabRegistry.set(b1.spaceId, 2, false);
    tabRegistry.set(b2.spaceId, 3, false);
    const activeIn = (sid) => tabRegistry.forSession(sid).list().filter((t) => t.isActive).map((t) => t.spaceId);
    expect(activeIn(SB)).toEqual([b2.spaceId]);
    await bgOps.focusTab(b1.spaceId);
    expect(win.sent[win.sent.length - 1]).toMatchObject({ op: 'focus', args: { spaceId: b1.spaceId, background: true } });
    expect(activeIn(SB)).toEqual([b1.spaceId]);
    expect(activeIn(SA)).toEqual([a.spaceId]);
    // A nested scope keeps the background flag.
    await bgOps.forSession(SB).openTab('https://b3.example');
    expect(win.sent[win.sent.length - 1].args).toMatchObject({ background: true });
  });

  test("a closed tab stops being its session's active tab", async () => {
    const bgOps = tabOps.forSession(SB, { background: true });
    const b1 = await bgOps.openTab('https://b1.example');
    const b2 = await bgOps.openTab('https://b2.example');
    tabRegistry.set(b1.spaceId, 2, true);
    tabRegistry.set(b2.spaceId, 3, false);
    tabRegistry.remove(b2.spaceId);
    // Falls back to the renderer's flag once the session's own tab is gone.
    expect(tabRegistry.forSession(SB).list().filter((t) => t.isActive).map((t) => t.spaceId)).toEqual([b1.spaceId]);
  });

  test('a getter-scoped surface follows the current session between runs', async () => {
    let current = SA;
    const ops = tabOps.forSession(() => current);
    const a = await ops.openTab('https://a.example');
    current = SB;
    await expect(ops.closeTab(a.spaceId)).rejects.toThrow('tab_not_owned');
    const view = tabRegistry.forSession(() => current);
    expect(view.get(a.spaceId)).toBeNull();
    current = SA;
    expect(view.get(a.spaceId)).toMatchObject({ sessionId: SA });
  });
});

describe('two concurrent background sessions', () => {
  const agent = require('../../../../main/services/AgentService');
  const llm = require('../../../../main/services/LLMClientService');
  const { createSessionServices } = require('../../../../main/agent/sessions/sessionServices');
  const { createMockLlmQueue, waitFor } = require('../../../helpers/mockLlmQueue');
  const tool = (id, name, args) => ({ content: '', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const done = (summary) => ({ content: JSON.stringify({ action: 'done', summary }) });

  test("each session's tab ops stay inside its own tabs", async () => {
    tabRegistry.clear();
    tabOps._reset();
    const { win, ipc } = mockWindowAndIpc();
    tabOps.bind(win, ipc);
    const q = createMockLlmQueue(llm.chatCompletion);
    agent.removeAllListeners();
    agent.resetConversation();
    agent._setMaxSteps(4);
    agent._setLLMClient(llm);
    const mockConfig = { get: (key, fallback) => (key === 'settings.llm.agent.sessions' ? { maxConcurrent: 2, llmConcurrency: 4 } : fallback) };
    const dir = fs.mkdtempSync(path.join(mockUserData, 'run-'));
    const { sessionManager: manager, sessionStore: store } = createSessionServices({ configService: mockConfig, agentService: agent, userDataDir: dir });
    const events = [];
    manager.on('event', (e) => events.push(e));
    const sa = store.create().id;
    const sb = store.create().id;
    agent._approval.setSessionMode(sa, 'bypass');
    agent._approval.setSessionMode(sb, 'bypass');

    manager.send({ sessionId: sa, text: 'alpha tab errand' });
    manager.send({ sessionId: sb, text: 'beta tab errand' });
    await waitFor(() => q.callFor('alpha tab errand') && q.callFor('beta tab errand'), 'both sessions');
    q.answer('alpha tab errand', tool('ca1', 'browser.open_tab', { url: 'https://a.example' }));
    await waitFor(() => win.sent.some((p) => p.args.sessionId === sa), 'session A open');
    const tabA = await (async () => {
      await waitFor(() => tabRegistry.list().some((t) => t.sessionId === sa), 'tab A tagged');
      return tabRegistry.list().find((t) => t.sessionId === sa).spaceId;
    })();

    tabRegistry.setMeta(tabA, { url: 'https://a.example', kind: 'agent' });

    // browser.close_tab is 'destructive' and asks even in Bypass, so the
    // ownership check is exercised through focus_tab and duplicate_tab.
    q.answer('beta tab errand', tool('cb1', 'browser.focus_tab', { spaceId: tabA }));
    const actedB = () => events.filter((e) => e.sessionId === sb && e.channel === 'step-acted').map((e) => e.payload.results[0]);
    await waitFor(() => actedB().length === 1, 'session B focus');
    expect(actedB()[0]).toMatchObject({ name: 'browser.focus_tab', result: { ok: false, error: 'tab_not_owned' } });
    await waitFor(() => q.callFor('cb1') && q.open().some((c) => c.text.includes('tab_not_owned')), 'session B next step');
    q.open().find((c) => c.text.includes('tab_not_owned')).resolve(tool('cb2', 'browser.duplicate_tab', { spaceId: tabA }));
    await waitFor(() => actedB().length === 2, 'session B duplicate');
    expect(actedB()[1]).toMatchObject({ name: 'browser.duplicate_tab', result: { ok: false, error: 'source_tab_not_found' } });
    expect(win.sent.filter((p) => p.args.sessionId === sb)).toEqual([]);
    expect(tabRegistry.get(tabA)).toMatchObject({ sessionId: sa });

    // The owner still sees and works on its own tab.
    await waitFor(() => q.open().length === 2, 'both sessions next step');
    q.open().find((c) => !c.text.includes('tab_not_owned')).resolve(tool('ca2', 'browser.duplicate_tab', { spaceId: tabA }));
    const actedA = () => events.filter((e) => e.sessionId === sa && e.channel === 'step-acted').map((e) => e.payload.results[0]);
    await waitFor(() => actedA().length === 2, 'session A duplicate');
    expect(actedA()[1]).toMatchObject({ name: 'browser.duplicate_tab', result: { ok: true, fromSpaceId: tabA } });
    expect(win.sent.filter((p) => p.op === 'open').map((p) => p.args)).toEqual([
      { url: 'https://a.example', sessionId: sa, background: true },
      { url: 'https://a.example', sessionId: sa, background: true },
    ]);

    await waitFor(() => q.open().length === 2, 'both sessions final step');
    for (const call of q.open()) call.resolve(done('The tab errand finished for this session'));
    await Promise.all([manager.settled(sa), manager.settled(sb)]);
    agent._approval.setSessionMode(sa, null);
    agent._approval.setSessionMode(sb, null);
  });
});
