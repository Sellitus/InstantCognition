// AgentService tests — fully mocks LLMClient and webContents.

jest.mock('../../../../main/services/LLMClientService', () => ({
  chatCompletion: jest.fn(),
}));

const svc = require('../../../../main/services/AgentService');
const llm = require('../../../../main/services/LLMClientService');

function makeWebContents(observation) {
  const calls = [];
  return {
    calls,
    executeJavaScript: jest.fn(async (src) => {
      calls.push(src);
      // Heuristic: if the script contains "interactives" it is the observe script.
      if (src.includes('interactives')) return observation;
      // Else action script — return a generic ok.
      if (src.includes('not_found_simulate')) return { ok: false, error: 'not_found' };
      return { ok: true };
    }),
    loadURL: jest.fn(async () => {}),
  };
}

// The private browsing session, with electron's session module as the boundary.
const privateSession = { name: 'private' };
function usePrivateSession() {
  const sessionService = require('../../../../main/services/SessionService');
  sessionService._setSessionModule({ fromPartition: () => privateSession });
  sessionService.initialize({});
  return privateSession;
}

beforeEach(() => {
  svc._setMaxSteps(5);
  svc._setLLMClient(llm);
  svc.removeAllListeners();
  svc.resetConversation();
});

describe('AgentService.startTask', () => {
  test('rejects when missing webContents', async () => {
    svc._setWebContentsModule({ fromId: () => null });
    await expect(svc.startTask({ description: 'do thing', webContentsId: 1 })).rejects.toThrow(/not found/);
  });

  test('refuses to start from a private tab and never reads the page', async () => {
    const wc = { ...makeWebContents({ title: 't', url: 'https://bank.example', interactives: [], links: [], text: 'balance' }), session: usePrivateSession() };
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion.mockClear();
    await expect(svc.startTask({ description: 'read my balance', webContentsId: 1 })).rejects.toThrow("The agent doesn't run in private tabs");
    expect(wc.executeJavaScript).not.toHaveBeenCalled();
    expect(llm.chatCompletion).not.toHaveBeenCalled();
    expect(svc._running).toBe(false);
  });

  test('rejects double start', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"finished"}' });
    const p = svc.startTask({ description: 'a', webContentsId: 1 });
    await expect(svc.startTask({ description: 'b', webContentsId: 1 })).rejects.toThrow(/already running/);
    await p;
  });

  test('completes when LLM returns done immediately', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"nothing to do, page is blank"}' });
    const result = await svc.startTask({ description: 'do nothing', webContentsId: 1 });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('nothing to do, page is blank');
  });

  test('executes click then done', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [{ selector: '#go' }], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"action":"click","selector":"#go"}' })
      .mockResolvedValueOnce({ content: '{"action":"done","summary":"clicked the go button successfully"}' });
    const result = await svc.startTask({ description: 'click go', webContentsId: 1 });
    expect(result.ok).toBe(true);
    expect(svc.getSteps().some((s) => s.kind === 'acted' && Array.isArray(s.calls) && s.calls.some((c) => c.name === 'browser.click'))).toBe(true);
  });

  test('halts at max steps when LLM never says done', async () => {
    svc._setMaxSteps(3);
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion.mockResolvedValue({ content: '{"action":"scroll","direction":"down","amount":300}' });
    const result = await svc.startTask({ description: 'forever', webContentsId: 1 });
    // Soft-landing path may extract a partial summary from the conversation
    // before hard-failing. Either outcome is correct — what matters is the
    // reason is one of the maxStep family.
    expect(['max_steps_exceeded', 'maxstepsexceeded_soft']).toContain(result.reason);
  });

  describe('remote tool format', () => {
    // Capture the invCtx the runtime is handed, with the remote reported active
    // and settings.llm supplied by a stub config service.
    async function forceModeFor(remoteSettings) {
      const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
      svc._setWebContentsModule({ fromId: () => wc });
      const prevLlmService = svc._llmService;
      const prevConfig = svc._configService;
      svc._llmService = { getStatus: () => ({ isRemote: true }), getEndpoint: () => 'http://remote:8100' };
      svc._configService = { get: (key, fallback) => (key === 'settings.llm' ? { remote: remoteSettings } : fallback) };
      const run = jest.spyOn(svc._runtime, 'run').mockResolvedValue({ ok: true, summary: 'done' });
      try {
        await svc.startTask({ description: 'research something', webContentsId: 1 });
        return run.mock.calls[0][0].invCtx.forceMode;
      } finally {
        run.mockRestore();
        svc._llmService = prevLlmService;
        svc._configService = prevConfig;
      }
    }

    test('a remote with no configured tool format negotiates tools instead of being forced to text JSON', async () => {
      expect(await forceModeFor({ endpoint: 'http://remote:8100' })).toBeNull();
    });

    test('toolMode json is honored as the explicit opt-out', async () => {
      expect(await forceModeFor({ endpoint: 'http://remote:8100', toolMode: 'json' })).toBe('json');
    });
  });

  describe('harness profile and instructions', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    // Capture what the runtime is handed for a run on `model` with settings.llm.agent = agentCfg.
    async function runWith(model, agentCfg, userDataDir) {
      const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
      svc._setWebContentsModule({ fromId: () => wc });
      const prev = { model: svc._getActiveModel, agent: svc._getAgentConfig, userData: svc._userDataDir };
      svc._getActiveModel = () => model;
      svc._getAgentConfig = () => agentCfg;
      svc._userDataDir = userDataDir;
      const run = jest.spyOn(svc._runtime, 'run').mockResolvedValue({ ok: true, summary: 'done' });
      try {
        await svc.startTask({ description: 'research something', webContentsId: 1 });
        return run.mock.calls[0][0];
      } finally {
        run.mockRestore();
        svc._getActiveModel = prev.model;
        svc._getAgentConfig = prev.agent;
        svc._userDataDir = prev.userData;
      }
    }

    let userData;
    beforeEach(() => { userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-agentsvc-'))); });
    afterEach(() => { fs.rmSync(userData, { recursive: true, force: true }); });

    test('a gemma model runs JSON tool calls with system text merged; auto streaming stays off', async () => {
      const { invCtx } = await runWith('gemma-3-12b-it', {}, userData);
      expect(invCtx).toMatchObject({ forceMode: 'json', harnessProfile: 'gemma', systemStyle: 'merge', streamSteps: false });
      expect(invCtx).not.toHaveProperty('temperature');
    });

    test('a gpt model runs native tools and streams on auto; a user profile and streamSteps off override', async () => {
      expect((await runWith('gpt-4.1', { streamSteps: 'auto' }, userData)).invCtx).toMatchObject({ forceMode: 'tools', streamSteps: true });
      const { invCtx } = await runWith('gpt-4.1', { streamSteps: 'off', harness: { profiles: [{ match: 'gpt-4*', toolFormat: 'json', temperature: 0.3 }] } }, userData);
      expect(invCtx).toMatchObject({ forceMode: 'json', harnessProfile: 'user:gpt-4*', streamSteps: false, temperature: 0.3 });
    });

    test('settings.llm.agent.compaction reaches the runtime', async () => {
      const { invCtx } = await runWith('gpt-4.1', { compaction: { auto: false, threshold: 0.6 } }, userData);
      expect(invCtx.compaction).toEqual({ auto: false, threshold: 0.6 });
    });

    test('an explicit agent.mode still beats the profile; an unknown model negotiates', async () => {
      expect((await runWith('gemma-3', { mode: 'tools' }, userData)).invCtx.forceMode).toBe('tools');
      expect((await runWith('phi-4', {}, userData)).invCtx.forceMode).toBeNull();
    });

    test('the global instructions file reaches the opening system prompt; disabled keeps it out', async () => {
      fs.writeFileSync(path.join(userData, 'instructions.md'), 'Answer in British English.');
      const on = await runWith('phi-4', {}, userData);
      expect(on.messages[0].content).toContain('### Global instructions\nAnswer in British English.');
      svc.resetConversation();
      const off = await runWith('phi-4', { instructions: { enabled: false } }, userData);
      expect(off.messages[0].content).not.toContain('British English');
    });
  });

  test('navigate action calls loadURL', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"action":"navigate","url":"https://example.com"}' })
      .mockResolvedValueOnce({ content: '{"action":"done","summary":"nav"}' });
    await svc.startTask({ description: 'nav', webContentsId: 1 });
    expect(wc.loadURL).toHaveBeenCalledWith('https://example.com');
  });

  test('emits step events', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"x"}' });
    const observed = jest.fn();
    const planned = jest.fn();
    svc.on('step-observed', observed);
    svc.on('step-planned', planned);
    await svc.startTask({ description: 'noop', webContentsId: 1 });
    expect(observed).toHaveBeenCalled();
    expect(planned).toHaveBeenCalled();
  });
});

describe('AgentService multi-turn conversations', () => {
  test('first turn seeds conversation; follow-up turn appends to same messages', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"first answer with enough detail"}' });

    await svc.startTask({ description: 'first task', webContentsId: 1 });
    expect(svc.hasConversation()).toBe(true);
    const firstLen = svc._conversation.messages.length;
    expect(firstLen).toBeGreaterThanOrEqual(2);
    expect(svc._conversation.messages[0].role).toBe('system');
    expect(svc._conversation.messages[firstLen - 1]).toEqual({ role: 'assistant', content: 'first answer with enough detail' });

    llm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"second answer with enough detail"}' });
    await svc.startTask({ description: 'follow up question', webContentsId: 1 });
    expect(svc._conversation.messages.length).toBeGreaterThan(firstLen);
    const messages = svc._conversation.messages;
    expect(messages[0].role).toBe('system'); // system prompt is still the first
    expect(messages.some((m) => m.role === 'user' && /follow up question/.test(m.content))).toBe(true);
    expect(messages[messages.length - 1]).toEqual({ role: 'assistant', content: 'second answer with enough detail' });
  });

  test('emits isFollowUp=true on subsequent turns', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"ok"}' });

    const starts = [];
    svc.on('task-started', (e) => starts.push(e));
    await svc.startTask({ description: 'a', webContentsId: 1 });
    await svc.startTask({ description: 'b', webContentsId: 1 });
    expect(starts).toHaveLength(2);
    expect(starts[0].isFollowUp).toBe(false);
    expect(starts[1].isFollowUp).toBe(true);
  });

  test('priorTurns seed a fresh conversation and are ignored once it exists', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"ok answer with detail"}' });

    const priorTurns = [
      { role: 'user', content: 'what monitor did we pick?' },
      { role: 'assistant', content: 'The Dell U2723QE.' },
    ];
    await svc.startTask({ description: 'first', webContentsId: 1, priorTurns });
    const seeded = svc._conversation.messages.filter((m) => /Earlier in this conversation/.test(String(m.content || '')));
    expect(seeded).toHaveLength(1);
    expect(seeded[0].content).toContain('The Dell U2723QE.');

    // The follow-up already holds the whole history; re-seeding would duplicate it.
    await svc.startTask({ description: 'second', webContentsId: 1, priorTurns });
    expect(svc._conversation.messages.filter((m) => /Earlier in this conversation/.test(String(m.content || '')))).toHaveLength(1);
  });

  test('resetConversation drops state; next turn is fresh', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"ok"}' });

    await svc.startTask({ description: 'first', webContentsId: 1 });
    expect(svc.hasConversation()).toBe(true);
    svc.resetConversation();
    expect(svc.hasConversation()).toBe(false);

    const starts = [];
    svc.on('task-started', (e) => starts.push(e));
    await svc.startTask({ description: 'second', webContentsId: 1 });
    expect(starts[0].isFollowUp).toBe(false);
  });

  test('failed turn (no summary) still keeps prior messages for next turn context', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    svc._setMaxSteps(2);
    // Never emits done — runtime halts at max steps.
    llm.chatCompletion.mockResolvedValue({ content: '{"action":"scroll","direction":"down","amount":100}' });

    const result = await svc.startTask({ description: 'loops forever', webContentsId: 1 });
    // With Phase 4.4 soft-landing, max-step exhaustion may produce a partial
    // summary (ok:true) or a hard fail (ok:false); both leave the conversation
    // in a usable state for the next turn.
    expect(['max_steps_exceeded', 'maxstepsexceeded_soft']).toContain(result.reason);
    // Conversation still seeded — runtime-appended turns provide context.
    expect(svc.hasConversation()).toBe(true);
    const msgs = svc._conversation.messages;
    expect(msgs[0].role).toBe('system');
  });
});

describe('AgentService rollback when first chat call fails (engine unreachable)', () => {
  test('clears conversation if no steps completed — retry starts fresh, no phantom follow-up', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    // First send: LLM throws on the very first call (engine unreachable).
    llm.chatCompletion.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    let firstErr;
    try { await svc.startTask({ description: 'reddit task', webContentsId: 1 }); }
    catch (e) { firstErr = e; }
    expect(firstErr && firstErr.message).toMatch(/ECONNREFUSED/);
    // No steps ran — conversation must have been rolled back so retry is fresh.
    expect(svc.hasConversation()).toBe(false);

    // Second send: now the engine works. Should be a NEW conversation,
    // not isFollowUp:true layered on top of the failed one.
    llm.chatCompletion.mockResolvedValueOnce({ content: '{"action":"done","summary":"recovered answer for retry."}' });
    const events = [];
    svc.on('task-started', (p) => events.push(p));
    await svc.startTask({ description: 'reddit task', webContentsId: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].isFollowUp).toBe(false);
  });

  test('does NOT roll back when at least one step completed — preserves multi-turn context', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    // First call succeeds (one step), then the LLM throws — task fails mid-run
    // but the conversation has real progress that should survive for follow-ups.
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"action":"click","selector":"#x"}' })
      .mockRejectedValueOnce(new Error('mid-run failure'));
    try { await svc.startTask({ description: 'partial task', webContentsId: 1 }); } catch (_) {}
    // At least one step ran — conversation is preserved so the user can pick up from there.
    expect(svc.hasConversation()).toBe(true);
  });
});

describe('AgentService control surface (pure methods + guards)', () => {
  test('isRunning / getSteps reflect lifecycle state', async () => {
    svc._steps = []; svc._task = null; // singleton — clear residue from prior tests
    expect(svc.isRunning()).toBe(false);
    expect(svc.getSteps()).toEqual([]);

    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"action":"scroll","direction":"down","amount":10}' })
      .mockResolvedValueOnce({ content: '{"action":"done","summary":"done with enough detail here"}' });
    await svc.startTask({ description: 'status task', webContentsId: 1 });

    // After completion, running flips back to false but steps are retained.
    expect(svc.isRunning()).toBe(false);
    expect(svc.getSteps().length).toBeGreaterThan(0);
    const steps = svc.getSteps();
    steps.push('mutation');
    expect(svc.getSteps()).not.toContain('mutation'); // returns a copy
  });

  test('stopTask sets the stop flag so the runtime loop ends', () => {
    svc._stopRequested = false;
    svc.stopTask();
    expect(svc._stopRequested).toBe(true);
  });

  test('pauseTask is a no-op when not running', () => {
    svc._running = false; svc._paused = false;
    const paused = jest.fn();
    svc.on('task-paused', paused);
    svc.pauseTask();
    expect(svc._paused).toBe(false);
    expect(paused).not.toHaveBeenCalled();
  });

  test('pauseTask while running arms a resume promise and emits task-paused', () => {
    svc._running = true; svc._paused = false; svc._task = { description: 'x' };
    const paused = jest.fn();
    svc.on('task-paused', paused);
    svc.pauseTask();
    expect(svc._paused).toBe(true);
    expect(svc._resumePromise).toBeInstanceOf(Promise);
    expect(typeof svc._resumeResolver).toBe('function');
    expect(paused).toHaveBeenCalledWith({ task: { description: 'x' } });
    // Second pause while already paused: no new promise.
    const existing = svc._resumePromise;
    svc.pauseTask();
    expect(svc._resumePromise).toBe(existing);
    svc._running = false; svc._paused = false; svc._resumePromise = null; svc._resumeResolver = null;
  });

  test('resumeTask resolves the pending promise and emits task-resumed', async () => {
    svc._running = true; svc._paused = false; svc._task = { description: 'y' };
    svc.pauseTask();
    const p = svc._resumePromise;
    const resumed = jest.fn();
    svc.on('task-resumed', resumed);
    svc.resumeTask();
    await expect(p).resolves.toBeUndefined();
    expect(svc._paused).toBe(false);
    expect(svc._resumePromise).toBeNull();
    expect(svc._resumeResolver).toBeNull();
    expect(resumed).toHaveBeenCalledWith({ task: { description: 'y' } });
    svc._running = false;
  });

  test('resumeTask is a no-op when not paused', () => {
    svc._paused = false;
    const resumed = jest.fn();
    svc.on('task-resumed', resumed);
    svc.resumeTask();
    expect(resumed).not.toHaveBeenCalled();
  });

  test('reattachTask returns not_running when no task is in flight', () => {
    svc._running = false;
    expect(svc.reattachTask({ webContentsId: 9 })).toEqual({ ok: false, error: 'not_running' });
  });

  test('reattachTask returns an error when the new webContents is missing', () => {
    svc._running = true;
    svc._setWebContentsModule({ fromId: () => null });
    expect(svc.reattachTask({ webContentsId: 9 })).toEqual({ ok: false, error: 'webContents not found' });
    svc._running = false;
  });

  test('reattachTask refuses a private tab and leaves the task on its old tab', () => {
    const privateWc = { session: usePrivateSession(), getURL: () => 'https://bank.example', once: jest.fn() };
    svc._running = true;
    svc._task = { description: 'stay put', webContentsId: 1 };
    svc._toolCtx = { defaultWebContents: null };
    svc._setWebContentsModule({ fromId: () => privateWc });
    expect(svc.reattachTask({ webContentsId: 7 })).toEqual({ ok: false, error: "The agent doesn't run in private tabs" });
    expect(svc._task.webContentsId).toBe(1);
    expect(svc._toolCtx.defaultWebContents).toBeNull();
    svc._running = false; svc._toolCtx = null;
  });

  test('reattachTask rebinds the task, refreshes tool ctx, and resumes', () => {
    const wc = { getURL: () => 'https://re.com', once: jest.fn() };
    svc._running = true; svc._paused = true;
    svc._task = { description: 'reattach me', webContentsId: 1 };
    svc._resumePromise = Promise.resolve(); svc._resumeResolver = jest.fn();
    svc._toolCtx = { defaultWebContents: null };
    svc._setWebContentsModule({ fromId: () => wc });
    const reattached = jest.fn();
    svc.on('task-reattached', reattached);
    const r = svc.reattachTask({ webContentsId: 7 });
    expect(r).toEqual({ ok: true });
    expect(svc._task.webContentsId).toBe(7);
    expect(svc._toolCtx.defaultWebContents).toBe(wc);
    expect(reattached).toHaveBeenCalledWith({ webContentsId: 7 });
    expect(svc._paused).toBe(false); // resumeTask ran
    svc._running = false; svc._toolCtx = null;
  });

  test('reattachTask without a tool ctx still rebinds and resumes', () => {
    const wc = { getURL: () => 'https://x', once: jest.fn() };
    svc._running = true; svc._paused = false;
    svc._task = { description: 'no ctx', webContentsId: 1 };
    svc._toolCtx = null;
    svc._setWebContentsModule({ fromId: () => wc });
    const r = svc.reattachTask({ webContentsId: 3 });
    expect(r).toEqual({ ok: true });
    expect(svc._task.webContentsId).toBe(3);
    svc._running = false;
  });

  test('_resolveWebContents returns null for a null id (no module lookup)', () => {
    svc._setWebContentsModule({ fromId: jest.fn(() => ({})) });
    expect(svc._resolveWebContents(null)).toBeNull();
    expect(svc._resolveWebContents(undefined)).toBeNull();
  });

  test('_resolveWebContents falls back to electron.webContents and tolerates its absence', () => {
    svc._setWebContentsModule(null);
    // In the test env electron.webContents.fromId is unavailable -> caught -> null.
    expect(svc._resolveWebContents(42)).toBeNull();
  });

  test('_recordBudget logs to the current log, emits budget-breach, and returns true', () => {
    const logged = [];
    svc._currentLog = { logBudget: (p) => logged.push(p) };
    const breach = jest.fn();
    svc.on('budget-breach', breach);
    const ret = svc._recordBudget('maxSteps', { step: 3 }, { maxSteps: 3 });
    expect(ret).toBe(true);
    expect(logged).toEqual([{ reason: 'maxSteps', usage: { step: 3 }, budget: { maxSteps: 3 } }]);
    expect(breach).toHaveBeenCalledWith({ reason: 'maxSteps', usage: { step: 3 }, budget: { maxSteps: 3 } });
    svc._currentLog = null;
  });

  test('_recordBudget without a current log still emits and returns true', () => {
    svc._currentLog = null;
    const breach = jest.fn();
    svc.on('budget-breach', breach);
    expect(svc._recordBudget('maxTokens', { tokens: 9 }, { maxTokens: 5 })).toBe(true);
    expect(breach).toHaveBeenCalled();
  });

  test('_currentUrl returns the resolved tab URL, or "" when unresolvable', () => {
    svc._task = { webContentsId: 1 };
    svc._setWebContentsModule({ fromId: () => ({ getURL: () => 'https://cur.com' }) });
    expect(svc._currentUrl()).toBe('https://cur.com');
    svc._setWebContentsModule({ fromId: () => null });
    expect(svc._currentUrl()).toBe('');
    svc._task = null;
    expect(svc._currentUrl()).toBe('');
  });

  test('resetConversation with a scoped opts clears only that thread', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    llm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"scoped answer with detail"}' });
    await svc.startTask({ description: 'global task', webContentsId: 1 });
    await svc.startTask({ description: 'tab task', webContentsId: 1, scope: 'tab', tabId: 'tab_9' });
    expect(svc.hasConversation({ scope: 'global' })).toBe(true);
    expect(svc.hasConversation({ scope: 'tab', tabId: 'tab_9' })).toBe(true);
    // Clear only the tab thread; global survives.
    svc.resetConversation({ scope: 'tab', tabId: 'tab_9' });
    expect(svc.hasConversation({ scope: 'tab', tabId: 'tab_9' })).toBe(false);
    expect(svc.hasConversation({ scope: 'global' })).toBe(true);
  });
});

describe('AgentService pause/resume during a live task', () => {
  test('a paused task blocks the runtime until resumeTask is called', async () => {
    const wc = makeWebContents({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' });
    svc._setWebContentsModule({ fromId: () => wc });
    svc._setMaxSteps(4);
    let chatCalls = 0;
    llm.chatCompletion.mockImplementation(async () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        // Pause after the first plan; resume shortly after.
        svc.pauseTask();
        setImmediate(() => svc.resumeTask());
        return { content: '{"action":"scroll","direction":"down","amount":50}' };
      }
      return { content: '{"action":"done","summary":"resumed and finished the task"}' };
    });
    const result = await svc.startTask({ description: 'pause mid-run', webContentsId: 1 });
    expect(result.ok).toBe(true);
    expect(chatCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('AgentService.flushOnQuit', () => {
  test('writes task-end on the in-flight log when the app is quitting', () => {
    const calls = [];
    svc._currentLog = { logTaskEnd: (payload) => calls.push(payload) };
    svc.flushOnQuit();
    expect(calls).toEqual([{ ok: false, reason: 'app_quit' }]);
    expect(svc._currentLog).toBeNull();
  });

  test('is a no-op when no task is in flight', () => {
    svc._currentLog = null;
    expect(() => svc.flushOnQuit()).not.toThrow();
    expect(svc._currentLog).toBeNull();
  });

  test('swallows errors so shutdown is never blocked', () => {
    svc._currentLog = { logTaskEnd: () => { throw new Error('disk full'); } };
    expect(() => svc.flushOnQuit()).not.toThrow();
  });
});
