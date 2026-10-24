// End to end: an fs.write made during a session turn is checkpointed and
// session:rewind restores the file and moves the conversation head back.
// Real AgentService, SessionRun, fsTools, checkpointStore and ConfigService
// on tmp dirs; only electron and the LLM HTTP client are mocked.

const mockUserData = require('fs').realpathSync(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ic-rewind-')));

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
const agentSessionHandlers = require('../../../../../main/ipc/agentSessionHandlers');
const { createSessionServices } = require('../../../../../main/agent/sessions/sessionServices');
const { createMockLlmQueue, waitFor } = require('../../../../helpers/mockLlmQueue');

const toolCall = (name, args) => ({ content: '', toolCalls: [{ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const invoke = (channel, arg) => ipcMain._handlers[channel]({}, arg);

describe('session rewind after an fs.write turn', () => {
  let ws;
  let services;
  let q;

  beforeAll(() => {
    ws = path.join(mockUserData, 'workspace');
    fs.mkdirSync(ws);
    configService.set('settings.llm.agent.workspace.roots', [ws]);
    // The permission engine reads workspace roots through the approval service's config.
    svc._approval.bind(null, ipcMain, configService);
  });
  afterAll(() => {
    configService.dispose();
    fs.rmSync(mockUserData, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.writeFileSync(path.join(ws, 'notes.md'), 'original notes\n');
    q = createMockLlmQueue(llm.chatCompletion);
    svc.removeAllListeners();
    svc.resetConversation();
    svc._setMaxSteps(4);
    svc._setLLMClient(llm);
    services = createSessionServices({ configService, agentService: svc, userDataDir: fs.mkdtempSync(path.join(mockUserData, 'ud-')) });
    agentSessionHandlers.register({ isDestroyed: () => false, webContents: { send: jest.fn() } }, { ...services, configService });
  });

  async function writeTurn() {
    const store = services.sessionStore;
    const s = store.create();
    svc._approval.setSessionMode(s.id, 'bypass');
    services.sessionManager.send({ sessionId: s.id, text: 'foxtrot errand: rewrite notes.md' });
    await waitFor(() => q.callFor('foxtrot errand'), 'first request');
    q.answer('foxtrot errand', toolCall('fs.write', { path: 'notes.md', content: 'agent rewrote this\n' }));
    await waitFor(() => q.open().length === 1, 'second request');
    q.open()[0].resolve(toolCall('agent.done', { summary: 'notes.md now holds the rewritten text' }));
    await expect(services.sessionManager.settled(s.id)).resolves.toMatchObject({ ok: true });
    svc._approval.setSessionMode(s.id, null);
    return { sessionId: s.id, userNode: store.getPath(s.id)[0] };
  }

  test('rewinding the turn restores the file and drops the turn from the conversation', async () => {
    const { sessionId, userNode } = await writeTurn();
    expect(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8')).toBe('agent rewrote this\n');
    const listed = await services.checkpointStore.list({ sessionId });
    expect(JSON.stringify(listed)).toContain(userNode.id);

    const out = await invoke('session:rewind', { sessionId, turnId: userNode.id });
    expect(out).toMatchObject({ ok: true, conflicts: [], conversationRewound: true, headId: null, conversationNodeId: userNode.id });
    expect(out.restored).toEqual([path.join(ws, 'notes.md')]);
    expect(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8')).toBe('original notes\n');
    expect(services.sessionStore.getPath(sessionId)).toEqual([]);
  });

  test('a file changed after the turn is a conflict: nothing restored and the head stays', async () => {
    const { sessionId, userNode } = await writeTurn();
    fs.writeFileSync(path.join(ws, 'notes.md'), 'the user edited it afterwards\n');
    const headBefore = services.sessionStore.get(sessionId).meta.headId;
    const out = await invoke('session:rewind', { sessionId, turnId: userNode.id });
    expect(out.ok).toBe(true);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conversationRewound).toBe(false);
    expect(out.headId).toBe(headBefore);
    expect(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8')).toBe('the user edited it afterwards\n');
  });

  test('rewind refuses non-user nodes, malformed ids and bad flags', async () => {
    const { sessionId } = await writeTurn();
    const answer = services.sessionStore.getPath(sessionId).pop();
    await expect(invoke('session:rewind', { sessionId, turnId: answer.id })).resolves.toEqual({ ok: false, error: 'not_a_user_message' });
    await expect(invoke('session:rewind', { sessionId: '../x', turnId: answer.id })).resolves.toEqual({ ok: false, error: 'invalid_session_id' });
    await expect(invoke('session:rewind', { sessionId, turnId: 'nope' })).resolves.toEqual({ ok: false, error: 'invalid_node_id' });
    const user = services.sessionStore.getPath(sessionId)[0];
    await expect(invoke('session:rewind', { sessionId, turnId: user.id, force: 'yes' })).resolves.toEqual({ ok: false, error: 'invalid_force_flag' });
    expect(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8')).toBe('agent rewrote this\n');
  });
});
