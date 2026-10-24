// Background session approvals end to end: the prompt a SessionRun raises is
// settled by the approval service, which announces it as
// agent:approval-resolved and as the session's 'approval-resolved' event,
// whether the user answered, the background bound expired or the run stopped.
// Real AgentService, SessionRun, AgentApprovalService and ConfigService on tmp
// dirs; only electron and the LLM HTTP client are mocked.

const mockUserData = require('fs').realpathSync(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ic-apres-')));

jest.mock('electron', () => {
  const handlers = {};
  return {
    app: { getPath: () => mockUserData, isPackaged: false, getVersion: () => '0.0.0' },
    ipcMain: {
      on: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      handle: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      _handlers: handlers,
    },
  };
});
jest.mock('../../../../../main/services/LLMClientService', () => ({ chatCompletion: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const svc = require('../../../../../main/services/AgentService');
const llm = require('../../../../../main/services/LLMClientService');
const configService = require('../../../../../main/services/ConfigService');
const { createSessionServices } = require('../../../../../main/agent/sessions/sessionServices');
const { createMockLlmQueue, waitFor } = require('../../../../helpers/mockLlmQueue');

// waitFor counts event-loop turns; the background bound is wall-clock, so its wait polls on a deadline.
async function waitForMs(cond, label, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const toolCall = (name, args) => ({ content: '', toolCalls: [{ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

describe('background approval-resolved', () => {
  let ws;
  let sent;
  let events;
  let services;
  let q;

  beforeAll(() => {
    ws = path.join(mockUserData, 'workspace');
    fs.mkdirSync(ws);
    configService.set('settings.llm.agent.workspace.roots', [ws]);
    sent = [];
    const mockWindow = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };
    svc._approval.bind(mockWindow, ipcMain, configService);
  });
  afterAll(() => {
    configService.dispose();
    fs.rmSync(mockUserData, { recursive: true, force: true });
  });

  beforeEach(() => {
    sent.length = 0;
    events = [];
    fs.writeFileSync(path.join(ws, 'notes.md'), 'original notes\n');
    configService.set('settings.llm.agent.sessions.backgroundApprovalTimeoutMs', 0);
    q = createMockLlmQueue(llm.chatCompletion);
    svc.removeAllListeners();
    svc.resetConversation();
    svc._setMaxSteps(4);
    svc._setLLMClient(llm);
    services = createSessionServices({ configService, agentService: svc, userDataDir: fs.mkdtempSync(path.join(mockUserData, 'ud-')) });
    services.sessionManager.on('event', (e) => events.push(e));
  });

  afterEach(async () => {
    const manager = services.sessionManager;
    for (const r of manager.running()) manager.stop(r.sessionId);
    await Promise.all(manager.running().map((r) => manager.settled(r.sessionId)));
    svc._approval._reset();
  });

  // Starts a background turn in 'ask' mode and waits for its fs.write prompt.
  async function promptingTurn(word) {
    const s = services.sessionStore.create();
    svc._approval.setSessionMode(s.id, 'ask');
    services.sessionManager.send({ sessionId: s.id, text: `${word} errand: rewrite notes.md` });
    await waitFor(() => q.callFor(`${word} errand`), 'first request');
    q.answer(`${word} errand`, toolCall('fs.write', { path: 'notes.md', content: 'agent rewrote this\n' }));
    await waitFor(() => sent.some((m) => m.channel === 'agent:approval-request'), 'approval request');
    const { requestId } = sent.find((m) => m.channel === 'agent:approval-request').payload;
    return { sessionId: s.id, requestId };
  }

  const resolvedEvents = (sid) => events.filter((e) => e.sessionId === sid && e.channel === 'approval-resolved').map((e) => e.payload);
  const resolvedSends = () => sent.filter((m) => m.channel === 'agent:approval-resolved').map((m) => m.payload);

  test('a user decision is announced on the session stream and the foreground channel', async () => {
    const { sessionId, requestId } = await promptingTurn('golf');
    expect(resolvedEvents(sessionId)).toEqual([]);
    ipcMain._handlers['agent:approval-response']({}, { requestId, decision: 'approve' });
    const info = { requestId, sessionId, decision: 'approve' };
    expect(resolvedEvents(sessionId)).toEqual([info]);
    expect(resolvedSends()).toEqual([info]);
    await waitFor(() => q.open().length === 1, 'second request');
    q.open()[0].resolve(toolCall('agent.done', { summary: 'notes.md now holds the rewritten text' }));
    await expect(services.sessionManager.settled(sessionId)).resolves.toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8')).toBe('agent rewrote this\n');
    svc._approval.setSessionMode(sessionId, null);
  });

  test('the background bound settles the prompt in the service and announces background_timeout', async () => {
    configService.set('settings.llm.agent.sessions.backgroundApprovalTimeoutMs', 30);
    const { sessionId, requestId } = await promptingTurn('hotel');
    await waitForMs(() => resolvedEvents(sessionId).length === 1, 'timeout announcement');
    expect(resolvedEvents(sessionId)).toEqual([{ requestId, sessionId, decision: 'reject', reason: 'background_timeout' }]);
    expect(svc._approval._pending.size).toBe(0);
    services.sessionManager.stop(sessionId);
    await services.sessionManager.settled(sessionId);
    expect(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8')).toBe('original notes\n');
    svc._approval.setSessionMode(sessionId, null);
  });

  test('stopping the run rejects its open prompt as stopped', async () => {
    const { sessionId, requestId } = await promptingTurn('india');
    expect(services.sessionManager.stop(sessionId)).toEqual({ ok: true, state: 'stopping' });
    expect(resolvedEvents(sessionId)).toEqual([{ requestId, sessionId, decision: 'reject', reason: 'stopped' }]);
    expect(svc._approval._pending.size).toBe(0);
    await services.sessionManager.settled(sessionId);
    expect(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8')).toBe('original notes\n');
    svc._approval.setSessionMode(sessionId, null);
  });
});
