// Background session runs end to end: the real AgentService as the source
// host, real SessionRun / runTurn / sessionStore on a tmp dir, and the shared
// llmGate. Only the LLM HTTP client and electron are mocked.

const mockUserData = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ic-sessmgr-'));

jest.mock('electron', () => {
  const handlers = {};
  return {
    app: { getPath: () => mockUserData },
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
const svc = require('../../../../../main/services/AgentService');
const llm = require('../../../../../main/services/LLMClientService');
const agentHandlers = require('../../../../../main/ipc/agentHandlers');
const agentRunHandlers = require('../../../../../main/ipc/agentRunHandlers');
const { createSessionServices } = require('../../../../../main/agent/sessions/sessionServices');
const { gate } = require('../../../../../main/agent/sessions/llmGate');
const { SessionManager, normalizeSettings } = require('../../../../../main/agent/sessions/sessionManager');
const { createSessionStore } = require('../../../../../main/agent/sessions/sessionStore');
const { createMockLlmQueue, waitFor } = require('../../../../helpers/mockLlmQueue');

// agent.done refuses summaries under 20 chars, so every summary is a full sentence.
const SUMMARY = (word) => `${word} finished with every requested detail`;
const DONE = (word) => ({ content: JSON.stringify({ action: 'done', summary: SUMMARY(word) }) });

describe('sessionManager (background runs)', () => {
  let userData;
  let q;
  let services;
  let manager;
  let events;
  let sent;
  let settings;

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(mockUserData, 'run-'));
    events = []; sent = [];
    settings = { maxConcurrent: 2, llmConcurrency: 1, notifyOnComplete: true };
    q = createMockLlmQueue(llm.chatCompletion);
    svc.removeAllListeners();
    svc.resetConversation();
    svc._setMaxSteps(3);
    svc._setLLMClient(llm);
    const mockConfig = { get: (key, fallback) => (key === 'settings.llm.agent.sessions' ? settings : fallback) };
    services = createSessionServices({ configService: mockConfig, agentService: svc, userDataDir: userData });
    manager = services.sessionManager;
    manager.on('event', (e) => events.push(e));
    const mockWindow = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };
    agentHandlers.register(mockWindow, { agentService: svc });
    agentRunHandlers.register(mockWindow, { sessionManager: manager });
  });

  afterEach(async () => {
    for (const r of manager.running()) {
      if (r.lane === 'background') manager.stop(r.sessionId);
    }
    await Promise.all(manager.running().map((r) => manager.settled(r.sessionId)));
    gate.configure({ limit: () => 1 });
    fs.rmSync(userData, { recursive: true, force: true });
  });
  afterAll(() => { fs.rmSync(mockUserData, { recursive: true, force: true }); });

  const callFor = (word) => q.callFor(word);
  const answer = (word, resp) => q.answer(word, resp);

  test('gate=1 keeps one LLM call in flight across two sessions; a third send queues', async () => {
    const a = manager.send({ text: 'alpha errand' });
    const b = manager.send({ text: 'beta errand' });
    const c = manager.send({ text: 'gamma errand' });
    expect(a).toMatchObject({ ok: true, queued: false });
    expect(b).toMatchObject({ ok: true, queued: false });
    expect(c).toMatchObject({ ok: true, queued: true });
    expect(events).toContainEqual({ sessionId: c.sessionId, channel: 'queued', payload: { position: 1 } });

    await waitFor(() => q.pending.length === 1 && gate.stats().waiting === 1, 'one call in flight, one waiting');
    expect(q.inFlight).toBe(1);

    const first = q.pending[0].text.includes('alpha') ? 'alpha' : 'beta';
    const second = first === 'alpha' ? 'beta' : 'alpha';
    answer(first, DONE(first));
    await waitFor(() => q.open().length === 1 && callFor(second), 'second session call');
    expect(q.inFlight).toBe(1);
    answer(second, DONE(second));

    await waitFor(() => callFor('gamma'), 'queued session to start');
    expect(events).toContainEqual({ sessionId: c.sessionId, channel: 'task-started', payload: expect.objectContaining({ sessionId: c.sessionId }) });
    answer('gamma', DONE('gamma'));
    await manager.settled(c.sessionId);
    expect(q.peak).toBe(1);

    const aPath = services.sessionStore.getPath(a.sessionId);
    expect(aPath.map((n) => [n.role, n.kind === 'message' ? n.content : n.kind])).toEqual([['user', 'alpha errand'], ['assistant', 'tool_calls'], ['tool', 'tool_results'], ['assistant', SUMMARY('alpha')]]);
    const completed = events.filter((e) => e.channel === 'task-completed');
    expect(completed.map((e) => e.sessionId).sort()).toEqual([a.sessionId, b.sessionId, c.sessionId].sort());
    expect(completed.every((e) => e.payload.notify === true)).toBe(true);
    expect(sent.some((s) => s.channel.startsWith('agent:'))).toBe(false);
    expect(sent.filter((s) => s.channel === 'session:event').length).toBe(events.length);
  });

  test('task-completed names the persisted answer node on the background and foreground lanes', async () => {
    const store = services.sessionStore;
    const a = manager.send({ text: 'alpha errand' });
    await waitFor(() => callFor('alpha'), 'alpha call');
    answer('alpha', DONE('alpha'));
    await manager.settled(a.sessionId);
    const bgAnswer = store.getPath(a.sessionId).pop();
    expect(bgAnswer).toMatchObject({ role: 'assistant', kind: 'message', content: SUMMARY('alpha') });
    const bg = events.find((e) => e.channel === 'task-completed' && e.sessionId === a.sessionId);
    expect(bg.payload.assistantNodeId).toBe(bgAnswer.id);

    const wc = {
      executeJavaScript: jest.fn(async (src) => (src.includes('interactives') ? { title: 't', url: 'about:blank', interactives: [], links: [], text: '' } : { ok: true })),
      loadURL: jest.fn(async () => {}), getURL: () => 'about:blank', on: jest.fn(), once: jest.fn(), removeListener: jest.fn(), isDestroyed: () => false,
    };
    svc._setWebContentsModule({ fromId: () => wc });
    const fgSession = store.create();
    const run = svc.startTask({ description: 'delta errand', webContentsId: 7, sessionId: fgSession.id });
    await waitFor(() => callFor('delta'), 'foreground call');
    answer('delta', DONE('delta'));
    await run;
    await waitFor(() => !svc.isRunning(), 'foreground run end');
    const fgAnswer = store.getPath(fgSession.id).pop();
    expect(fgAnswer.content).toBe(SUMMARY('delta'));
    const fg = sent.find((m) => m.channel === 'agent:task-completed');
    expect(fg.payload).toMatchObject({ sessionId: fgSession.id, assistantNodeId: fgAnswer.id });
  });

  test('a skill run in a session persists /<name> <task> and sends the skill body on the task message', async () => {
    const { SkillsService } = require('../../../../../main/services/SkillsService');
    const skills = new SkillsService();
    const mockSkillsConfig = { get: (key, fallback) => fallback, set: jest.fn() };
    skills.bind({ agentService: svc, configService: mockSkillsConfig, baseDir: fs.mkdtempSync(path.join(userData, 'skills-')), homeDir: fs.mkdtempSync(path.join(userData, 'home-')) });
    skills.save({ name: 'tidy-tabs', description: 'Close duplicate tabs', body: 'Group tabs by host, then close the repeats.' });
    const wc = {
      executeJavaScript: jest.fn(async (src) => (src.includes('interactives') ? { title: 't', url: 'about:blank', interactives: [], links: [], text: '' } : { ok: true })),
      loadURL: jest.fn(async () => {}), getURL: () => 'about:blank', on: jest.fn(), once: jest.fn(), removeListener: jest.fn(), isDestroyed: () => false,
    };
    svc._setWebContentsModule({ fromId: () => wc });
    const session = services.sessionStore.create();
    const run = skills.run({ name: 'tidy-tabs', task: 'kilo dupes', webContentsId: 7, sessionId: session.id });
    await waitFor(() => callFor('kilo dupes'), 'skill call');
    const { messages } = callFor('kilo dupes');
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).not.toContain('Group tabs by host');
    expect(messages.slice(-1)[0].content).toMatch(/^Task: \/tidy-tabs kilo dupes\n\nFollow the "tidy-tabs" skill\.\n\nGroup tabs by host, then close the repeats\./);
    answer('kilo dupes', DONE('kilo'));
    await run;
    await waitFor(() => !svc.isRunning(), 'skill run end');
    const turn = services.sessionStore.getPath(session.id);
    expect(turn[0]).toMatchObject({ role: 'user', content: '/tidy-tabs kilo dupes' });
    expect(turn.pop().content).toBe(SUMMARY('kilo'));
    expect(sent.find((m) => m.channel === 'agent:task-completed').payload).toMatchObject({ sessionId: session.id });

    // A plain follow-up rebuilds the system prompt; the skill body stays in the thread on the first task message.
    const plain = svc.startTask({ description: 'mike dupes', webContentsId: 7, sessionId: session.id });
    await waitFor(() => callFor('mike dupes'), 'plain follow-up call');
    const plainMessages = callFor('mike dupes').messages;
    expect(plainMessages[0].content).not.toContain('Group tabs by host');
    expect(plainMessages.slice(-1)[0].content).toMatch(/^New task: mike dupes/);
    expect(plainMessages.slice(1, -1).map((m) => m.content).join('\n')).toContain('Group tabs by host, then close the repeats.');
    answer('mike dupes', DONE('mike'));
    await plain;
    await waitFor(() => !svc.isRunning(), 'plain follow-up run end');

    const next = skills.run({ name: 'tidy-tabs', task: 'lima dupes', webContentsId: 7, sessionId: session.id });
    await waitFor(() => callFor('lima dupes'), 'follow-up skill call');
    const last = callFor('lima dupes').messages.slice(-1)[0];
    expect(last.content).toMatch(/^New task: \/tidy-tabs lima dupes\n\nFollow the "tidy-tabs" skill\.\n\nGroup tabs by host/);
    answer('lima dupes', DONE('lima'));
    await next;
    await waitFor(() => !svc.isRunning(), 'follow-up run end');
    expect(services.sessionStore.getPath(session.id).filter((n) => n.role === 'user').map((n) => n.content)).toEqual(['/tidy-tabs kilo dupes', 'mike dupes', '/tidy-tabs lima dupes']);
  });

  describe('tools switched off in settings are not offered', () => {
    let agentSettings;
    let savedConfig;
    beforeEach(() => {
      savedConfig = svc._configService;
      svc._configService = { get: (key, fallback) => (key === 'settings.llm.agent' ? agentSettings : key === 'settings.llm.agent.subagents' ? agentSettings.subagents : fallback) };
    });
    afterEach(() => { svc._configService = savedConfig; });

    async function toolsOffered(word) {
      const a = manager.send({ text: `${word} errand` });
      await waitFor(() => callFor(word), `${word} call`);
      const call = callFor(word);
      const offered = `${call.messages[0].content}\n${JSON.stringify((call.opts && call.opts.tools) || [])}`;
      answer(word, DONE(word));
      await manager.settled(a.sessionId);
      return offered;
    }

    test('subagents disabled and the shell disabled drop agent.spawn_subagent and shell.run', async () => {
      agentSettings = { subagents: { enabled: false }, shell: { enabled: false } };
      const offered = await toolsOffered('sierra');
      expect(offered).not.toContain('agent.spawn_subagent');
      expect(offered).not.toContain('shell.run');
      expect(offered).toContain('fs.read');
    });

    test('a subagent depth of 0 drops the spawn tool too', async () => {
      agentSettings = { subagents: { enabled: true, maxDepth: 0 }, shell: { enabled: true } };
      const offered = await toolsOffered('tango');
      expect(offered).not.toContain('agent.spawn_subagent');
      expect(offered).toContain('shell.run');
    });

    test('both enabled keeps both tools on offer', async () => {
      agentSettings = { subagents: { enabled: true, maxDepth: 1 }, shell: { enabled: true } };
      const offered = await toolsOffered('uniform');
      expect(offered).toContain('agent.spawn_subagent');
      expect(offered).toContain('shell.run');
    });
  });

  describe('skills index follows skills.autoTrigger and matchThreshold', () => {
    let skillSettings;
    let savedConfig;
    let skills;
    beforeEach(() => {
      const { SkillsService } = require('../../../../../main/services/SkillsService');
      skillSettings = { autoTrigger: true, matchThreshold: 0.35 };
      const mockSkillConfig = { get: (key, fallback) => (key === 'settings.llm.agent.skills' ? skillSettings : fallback), set: jest.fn() };
      skills = new SkillsService();
      skills.bind({ agentService: svc, configService: mockSkillConfig, baseDir: fs.mkdtempSync(path.join(userData, 'skills-')), homeDir: fs.mkdtempSync(path.join(userData, 'home-')) });
      skills.save({ name: 'weather-report', description: 'Summarize the local weather forecast for the week', body: 'Check the forecast.' });
      skills.save({ name: 'tidy-tabs', description: 'Close duplicate browser tabs and group the rest by host', body: 'Group tabs by host.' });
      savedConfig = svc._configService;
      svc._configService = mockSkillConfig;
      svc._skillsService = skills;
      const wc = {
        executeJavaScript: jest.fn(async (src) => (src.includes('interactives') ? { title: 't', url: 'about:blank', interactives: [], links: [], text: '' } : { ok: true })),
        loadURL: jest.fn(async () => {}), getURL: () => 'about:blank', on: jest.fn(), once: jest.fn(), removeListener: jest.fn(), isDestroyed: () => false,
      };
      svc._setWebContentsModule({ fromId: () => wc });
    });
    afterEach(() => { svc._configService = savedConfig; delete svc._skillsService; });

    // One agent turn on the foreground host; returns the request's system prompt and task message.
    async function turn(word, sessionId) {
      const run = svc.startTask({ description: `${word}: close the duplicate browser tabs`, webContentsId: 7, sessionId });
      await waitFor(() => callFor(word), `${word} call`);
      const { messages } = callFor(word);
      const out = { system: messages[0].content, task: messages[messages.length - 1].content };
      answer(word, DONE(word));
      await run;
      return out;
    }
    async function openingFor(word) {
      svc.resetConversation();
      return turn(word, services.sessionStore.create().id);
    }
    const NOTE = 'Skills matching this request:';

    test('a request that matches a skill names it on the task message; the index lists every enabled skill', async () => {
      const { system, task } = await openingFor('papa');
      expect(task).toContain(`${NOTE} tidy-tabs. Load the best fit with agent.use_skill before acting.`);
      expect(task).not.toContain('weather-report');
      expect(system).toContain('- tidy-tabs: Close duplicate');
      expect(system).toContain('- weather-report: Summarize');
      expect(system).not.toContain(NOTE);
    });

    test('a strict threshold leaves the same request unmatched', async () => {
      skillSettings = { autoTrigger: true, matchThreshold: 0.99 };
      const { system, task } = await openingFor('quebec');
      expect(task).not.toContain(NOTE);
      expect(system).toContain('- tidy-tabs: Close duplicate');
    });

    test('autoTrigger off leaves the skills index and the match note out', async () => {
      skillSettings = { autoTrigger: false, matchThreshold: 0.35 };
      const { system, task } = await openingFor('romeo');
      expect(system).not.toContain('agent.use_skill {name}');
      expect(system).not.toContain('tidy-tabs');
      expect(system).not.toContain('weather-report');
      expect(task).not.toContain(NOTE);
    });

    test('a follow-up turn rebuilds the system prompt from current skills, and leaves it byte-identical when nothing changed', async () => {
      svc.resetConversation();
      const sessionId = services.sessionStore.create().id;
      const first = await turn('victor', sessionId);
      const same = await turn('whiskey', sessionId);
      expect(same.task).toMatch(/^New task: whiskey/);
      expect(same.system).toBe(first.system);
      skills.save({ name: 'calendar-sync', description: 'Copy meeting invites into the calendar', body: 'Open the calendar.' });
      const next = await turn('xray', sessionId);
      expect(first.system).not.toContain('calendar-sync');
      expect(next.system).toContain('- calendar-sync: Copy meeting invites');
      skillSettings = { autoTrigger: false, matchThreshold: 0.35 };
      const off = await turn('yankee', sessionId);
      expect(off.system).not.toContain('agent.use_skill {name}');
    });
  });

  test('stopping session A leaves session B running to completion', async () => {
    const a = manager.send({ text: 'alpha errand' });
    const b = manager.send({ text: 'beta errand' });
    await waitFor(() => q.pending.length === 1, 'first call');
    expect(manager.stop(a.sessionId)).toEqual({ ok: true, state: 'stopping' });
    await manager.settled(a.sessionId);
    expect(manager.running().map((r) => r.sessionId)).toEqual([b.sessionId]);
    await waitFor(() => callFor('beta'), 'beta call');
    answer('beta', DONE('beta'));
    const res = await manager.settled(b.sessionId);
    expect(res).toMatchObject({ ok: true, summary: SUMMARY('beta') });
    expect(services.sessionStore.getPath(b.sessionId).pop().content).toBe(SUMMARY('beta'));
    expect(services.sessionStore.getPath(a.sessionId).pop().kind).toBe('error');
    expect(sent.some((s) => s.channel === 'agent:task-completed')).toBe(false);
  });

  test('a stop issued before the run starts is honored, not lost', async () => {
    const a = manager.send({ text: 'alpha errand' });
    expect(manager.stop(a.sessionId)).toEqual({ ok: true, state: 'stopping' });
    await expect(manager.settled(a.sessionId)).resolves.toEqual({ ok: false, reason: 'stopped' });
    expect(q.pending).toHaveLength(0);
    expect(events).toContainEqual({ sessionId: a.sessionId, channel: 'task-completed', payload: { ok: false, reason: 'stopped', sessionId: a.sessionId, notify: true } });
    expect(manager.running()).toEqual([]);
  });

  test('stop dequeues a queued session; busy and unknown sessions are refused', async () => {
    settings.maxConcurrent = 1;
    const a = manager.send({ text: 'alpha errand' });
    const b = manager.send({ text: 'beta errand' });
    expect(b.queued).toBe(true);
    expect(() => manager.send({ sessionId: a.sessionId, text: 'again' })).toThrow('session_busy');
    expect(() => manager.send({ sessionId: 's_unknown1', text: 'x' })).toThrow('session_not_found');
    expect(() => manager.send({ text: '   ' })).toThrow('text required');
    expect(manager.stop(b.sessionId)).toEqual({ ok: true, state: 'dequeued' });
    expect(() => manager.stop(b.sessionId)).toThrow('not_running');
    await waitFor(() => q.pending.length === 1, 'alpha call');
    answer('alpha', DONE('alpha'));
    await manager.settled(a.sessionId);
    expect(manager.running()).toEqual([]);
  });

  test('a run that cannot start reports start-failed on its session', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = services.sessionStore;
      const s = store.create();
      const asst = store.append(s.id, { role: 'assistant', content: 'hi' });
      manager.send({ sessionId: s.id, fromNodeId: asst.id });
      const res = await manager.settled(s.id);
      expect(res).toMatchObject({ ok: false, error: 'not_a_user_message' });
      expect(events).toContainEqual({ sessionId: s.id, channel: 'start-failed', payload: { error: 'not_a_user_message' } });
    } finally { errSpy.mockRestore(); }
  });

  test('contextUsage and compact work off the session path', async () => {
    const store = services.sessionStore;
    const s = store.create();
    store.append(s.id, { role: 'user', content: 'q'.repeat(40) });
    store.append(s.id, { role: 'assistant', content: 'a'.repeat(40) });
    const usage = manager.contextUsage(s.id);
    expect(usage).toMatchObject({ ok: true, tokens: 28, contextSize: 65536, messages: 2 });
    const p = manager.compact(s.id);
    await waitFor(() => q.pending.length === 1, 'compaction call');
    q.pending[0].resolve({ content: 'summary of q and a' });
    const out = await p;
    expect(out).toMatchObject({ ok: true, coveredMessages: 2 });
    expect(store.getPath(s.id).pop()).toMatchObject({ kind: 'compaction', content: 'summary of q and a' });
    expect(events).toContainEqual({ sessionId: s.id, channel: 'compacted', payload: { nodeId: out.nodeId, coveredMessages: 2 } });
  });

  describe('replaying a session into a fresh run', () => {
    const { countTokens } = require('../../../../../main/agent/sessions/contextProjection');
    const CONTEXT = 8000;
    let savedConfig;
    beforeEach(() => {
      savedConfig = svc._configService;
      svc._configService = { get: (key, fallback) => (key === 'settings.llm' ? { activeBackend: 'llamaCpp', llamaCpp: { contextSize: CONTEXT } } : fallback) };
    });
    afterEach(() => { svc._configService = savedConfig; });

    // Each past turn: a user ask, one acted step (call + result) and the answer.
    function seed(turns, filler) {
      const store = services.sessionStore;
      const s = store.create();
      for (let i = 0; i < turns; i++) {
        const tag = `turn-${String(i).padStart(2, '0')}`;
        store.append(s.id, { role: 'user', content: `${tag} ask ${filler}` });
        store.append(s.id, { role: 'assistant', kind: 'tool_calls', content: `${tag} acting`, data: { calls: [{ id: `c${i}`, name: 'browser.read_tab', args: {} }], mode: 'json' } });
        store.append(s.id, { role: 'tool', kind: 'tool_results', content: '', data: { results: [{ id: `c${i}`, name: 'browser.read_tab', content: `${tag} page ${filler}` }] } });
        store.append(s.id, { role: 'assistant', content: `${tag} answer ${filler}` });
      }
      return s;
    }

    async function firstRequest(sessionId, word) {
      manager.send({ sessionId, text: `${word} errand` });
      await waitFor(() => callFor(word), `${word} call`);
      // Copied now: the run appends its answer to the same array once it settles.
      const messages = callFor(word).messages.slice();
      answer(word, DONE(word));
      await manager.settled(sessionId);
      return messages;
    }

    test('a history larger than the context window is cut to whole recent turns that fit', async () => {
      const s = seed(40, 'x'.repeat(1600));
      const messages = await firstRequest(s.id, 'mike');
      expect(countTokens(messages)).toBeLessThanOrEqual(CONTEXT * 0.8);
      const text = messages.map((m) => m.content).join('\n');
      expect(text).not.toContain('turn-00');
      expect(text).toContain('turn-39 answer');
      expect(messages[messages.length - 1].content).toMatch(/^New task: mike errand/);
      // The replay starts on a user ask, so no step is cut from its call.
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toMatch(/^turn-\d\d ask/);
      messages.forEach((m, i) => {
        if (/^Results:/.test(m.content)) expect(messages[i - 1].content).toMatch(/acting$/);
      });
    });

    test('a compaction summary rides in the system prompt and survives the cut; the replay opens on a user ask', async () => {
      const store = services.sessionStore;
      const s = store.create();
      store.append(s.id, { role: 'user', content: 'early ask' });
      store.append(s.id, { role: 'assistant', kind: 'compaction', content: 'summary-of-early-work' });
      const seeded = seed(40, 'x'.repeat(1600));
      for (const n of store.getPath(seeded.id)) store.append(s.id, { role: n.role, kind: n.kind, content: n.content, data: n.data });
      const messages = await firstRequest(s.id, 'oscar');
      expect(countTokens(messages)).toBeLessThanOrEqual(CONTEXT * 0.8);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toMatch(/\[Compacted earlier turns\] Summary of prior progress:\nsummary-of-early-work$/);
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toMatch(/^turn-\d\d ask/);
      expect(messages.slice(1).map((m) => m.content).join('\n')).not.toContain('summary-of-early-work');
      const next = await firstRequest(s.id, 'papa');
      expect(next[0].content).toMatch(/summary-of-early-work$/);
      expect(messages.map((m) => m.content).join('\n')).not.toContain('turn-00');
    });

    test('a foreground follow-up rebuilds the system prompt and keeps the replayed recap', async () => {
      const store = services.sessionStore;
      const s = store.create();
      store.append(s.id, { role: 'user', content: 'early ask' });
      store.append(s.id, { role: 'system', kind: 'compaction', content: 'recap-of-early-work' });
      const wc = {
        executeJavaScript: jest.fn(async (src) => (src.includes('interactives') ? { title: 't', url: 'about:blank', interactives: [], links: [], text: '' } : { ok: true })),
        loadURL: jest.fn(async () => {}), getURL: () => 'about:blank', on: jest.fn(), once: jest.fn(), removeListener: jest.fn(), isDestroyed: () => false,
      };
      svc._setWebContentsModule({ fromId: () => wc });
      svc.resetConversation();
      const sentFor = {};
      for (const word of ['quebec', 'romeo']) {
        const run = svc.startTask({ description: `${word} errand`, webContentsId: 7, sessionId: s.id });
        await waitFor(() => callFor(word), `${word} call`);
        const msgs = callFor(word).messages.slice();
        sentFor[word] = msgs;
        expect(msgs[0].content).toMatch(/\[Compacted earlier turns\] Summary of prior progress:\nrecap-of-early-work$/);
        expect(msgs.filter((m) => /recap-of-early-work/.test(String(m.content)))).toHaveLength(1);
        answer(word, DONE(word));
        await run;
        await waitFor(() => !svc.isRunning(), `${word} run end`);
      }
      // romeo continues quebec's thread (a follow-up), so its system prompt was rebuilt, not replayed.
      expect(sentFor.romeo.some((m) => /^Task: quebec errand/.test(String(m.content)))).toBe(true);
    });

    test('a history that fits is replayed whole', async () => {
      const s = seed(3, 'short');
      const messages = await firstRequest(s.id, 'november');
      const text = messages.map((m) => m.content).join('\n');
      for (const tag of ['turn-00 ask', 'turn-00 acting', 'turn-00 page', 'turn-01 answer', 'turn-02 answer']) expect(text).toContain(tag);
      expect(messages.length).toBe(1 + 3 * 4 + 1);
    });
  });

  // Every lane that writes a session turn must see the same busy state, or two
  // writers interleave nodes on one path (a chat answer landing mid-compaction).
  function registerChat() {
    const chatHandlers = require('../../../../../main/ipc/chatHandlers');
    const mockWindow = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };
    chatHandlers.register(mockWindow, { agentService: svc, sessionManager: manager, sessionStore: services.sessionStore });
    return require('electron').ipcMain._handlers['chat:ask'];
  }

  test('a compacting session is busy for every lane, and free again once the summary lands', async () => {
    const store = services.sessionStore;
    const s = store.create();
    store.append(s.id, { role: 'user', content: 'what changed' });
    store.append(s.id, { role: 'assistant', content: 'two files changed' });
    const ask = registerChat();
    const p = manager.compact(s.id);
    await waitFor(() => q.pending.length === 1, 'compaction call');
    expect(manager.isBusy(s.id)).toBe(true);
    expect(() => manager.send({ sessionId: s.id, text: 'next step' })).toThrow('session_busy');
    await expect(manager.compact(s.id)).rejects.toThrow('session_busy');
    await expect(svc.startTask({ description: 'foreground errand', webContentsId: 7, sessionId: s.id })).rejects.toThrow('session_busy');
    await expect(ask({}, { id: 'chat-1', sessionId: s.id, messages: [{ role: 'user', content: 'hi' }] })).resolves.toEqual({ ok: false, error: 'session_busy' });
    require('../../../../../main/ipc/agentSessionHandlers').register({ isDestroyed: () => false, webContents: { send: () => {} } }, { sessionStore: store, sessionManager: manager });
    const del = require('electron').ipcMain._handlers['session:delete'];
    await expect(del({}, { sessionId: s.id })).resolves.toEqual({ ok: false, error: 'session_busy' });
    const other = store.create();
    expect(manager.isBusy(other.id)).toBe(false);
    q.pending[0].resolve({ content: 'two files changed after the question' });
    await p;
    expect(manager.isBusy(s.id)).toBe(false);
    expect(store.getPath(s.id).map((n) => n.kind)).toEqual(['message', 'message', 'compaction']);
  });

  test('a failed compaction still frees the session', async () => {
    const store = services.sessionStore;
    const s = store.create();
    store.append(s.id, { role: 'user', content: 'q' });
    const p = manager.compact(s.id);
    await waitFor(() => q.pending.length === 1, 'compaction call');
    q.pending[0].resolve({ content: '' });
    await expect(p).rejects.toThrow('empty_summary');
    expect(manager.isBusy(s.id)).toBe(false);
  });

  test('a chat answer in flight holds its session against a background send and a compaction', async () => {
    const chatStream = require('../../../../../main/services/ChatStreamService');
    let finish;
    const done = new Promise((r) => { finish = r; });
    chatStream._setClient({ chatCompletionStream: async function* stream() { yield 'part of the answer'; await done; } });
    try {
      const store = services.sessionStore;
      const s = store.create();
      const ask = registerChat();
      const answer = ask({}, { id: 'chat-2', sessionId: s.id, messages: [{ role: 'user', content: 'explain the diff' }] });
      await waitFor(() => manager.isBusy(s.id), 'chat claim');
      expect(() => manager.send({ sessionId: s.id, text: 'background errand' })).toThrow('session_busy');
      await expect(manager.compact(s.id)).rejects.toThrow('session_busy');
      finish();
      await expect(answer).resolves.toMatchObject({ ok: true, sessionId: s.id });
      expect(manager.isBusy(s.id)).toBe(false);
      expect(store.getPath(s.id).map((n) => [n.role, n.content])).toEqual([['user', 'explain the diff'], ['assistant', 'part of the answer']]);
    } finally { chatStream._setClient(require('../../../../../main/services/LLMClientService')); }
  });

  test('deleting a session drops its permission grants, mode override and pending plan', async () => {
    const store = services.sessionStore;
    const approval = svc._approval;
    const s = store.create();
    const keep = store.create();
    const call = { id: 'c1', name: 'browser.close_tab', args: {} };
    const promptsFor = (sessionId) => approval.decide([call], { sessionId, url: 'https://grant.example/x' }).prompts.length;
    for (const id of [s.id, keep.id]) {
      approval.applyDecision({ call, class: 'destructive', origin: 'https://grant.example', sessionId: id }, 'approve_session');
      approval.setSessionMode(id, 'auto-edit');
    }
    expect(promptsFor(s.id)).toBe(0);
    require('../../../../../main/ipc/agentSessionHandlers').register({ isDestroyed: () => false, webContents: { send: () => {} } }, { sessionStore: store, sessionManager: manager });
    await expect(require('electron').ipcMain._handlers['session:delete']({}, { sessionId: s.id })).resolves.toEqual({ ok: true });
    expect(promptsFor(s.id)).toBe(1);
    expect(approval.getSessionModes()[s.id]).toBeUndefined();
    // Another session keeps what it was granted.
    expect(promptsFor(keep.id)).toBe(0);
    expect(approval.getSessionModes()[keep.id]).toBe('auto-edit');
    approval.clearSession(keep.id);
    approval.setSessionMode(keep.id, null);
  });

  test('compact refuses an empty session and an empty summary', async () => {
    const store = services.sessionStore;
    const empty = store.create();
    await expect(manager.compact(empty.id)).rejects.toThrow('nothing_to_compact');
    store.append(empty.id, { role: 'user', content: 'q' });
    const p = manager.compact(empty.id);
    await waitFor(() => q.pending.length === 1, 'compaction call');
    q.pending[0].resolve({ content: '   ' });
    await expect(p).rejects.toThrow('empty_summary');
  });
});

describe('sessionManager settings and construction', () => {
  test('normalizeSettings clamps maxConcurrent and keeps defaults for junk', () => {
    expect(normalizeSettings({ maxConcurrent: 50 })).toMatchObject({ maxConcurrent: 8, notifyOnComplete: true, backgroundApprovalTimeoutMs: 0 });
    expect(normalizeSettings({ maxConcurrent: 'x', notifyOnComplete: false, backgroundApprovalTimeoutMs: -5 })).toEqual({ maxConcurrent: 2, notifyOnComplete: false, backgroundApprovalTimeoutMs: 0 });
    expect(normalizeSettings(null).maxConcurrent).toBe(2);
  });

  test('constructor requires a store and a host factory', () => {
    const store = createSessionStore({ baseDir: path.join(mockUserData, 'unused') });
    expect(() => new SessionManager({ store: null, createHost: () => null })).toThrow('store required');
    expect(() => new SessionManager({ store, createHost: null })).toThrow('createHost required');
  });
});
