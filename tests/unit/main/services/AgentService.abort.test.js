// AgentService stop → abort wiring: stopTask must cancel the in-flight LLM
// request through the run's AbortSignal, not just set a flag the loop checks
// after the (possibly minutes-long) request returns.

jest.mock('../../../../main/services/LLMClientService', () => ({
  chatCompletion: jest.fn(),
}));

const svc = require('../../../../main/services/AgentService');
const mockLlm = require('../../../../main/services/LLMClientService');

function makeWebContents() {
  return {
    executeJavaScript: jest.fn(async () => ({ title: 't', url: 'about:blank', interactives: [], links: [], text: '' })),
    loadURL: jest.fn(async () => {}),
  };
}

// Agent-loop requests carry a signal; resolve them only when it aborts. Any
// other request (persona routing) answers immediately.
function hangUntilAborted(seen) {
  return (_messages, opts = {}) => {
    if (!opts.signal) return Promise.resolve({ content: '{"tool":"agent.done","args":{"summary":"x"}}' });
    seen.push(opts.signal);
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true });
    });
  };
}

async function waitFor(pred) {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setImmediate(r));
  if (!pred()) throw new Error('condition never became true');
}

beforeEach(() => {
  svc._setMaxSteps(5);
  svc._setLLMClient(mockLlm);
  svc.removeAllListeners();
  svc.resetConversation();
  svc._setWebContentsModule({ fromId: () => makeWebContents() });
});

describe('AgentService stopTask aborts the in-flight request', () => {
  test('the chatCompletion signal aborts and the task resolves stopped', async () => {
    const seen = [];
    mockLlm.chatCompletion.mockImplementation(hangUntilAborted(seen));
    const completed = jest.fn();
    svc.on('task-completed', completed);

    const run = svc.startTask({ description: 'look something up', webContentsId: 1 });
    await waitFor(() => seen.length > 0);
    expect(seen[0].aborted).toBe(false);

    svc.stopTask();
    const result = await run;

    expect(seen[0].aborted).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'stopped' });
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ ok: false, reason: 'stopped' }));
    expect(svc.isRunning()).toBe(false);
  });

  test('a new task gets a fresh, un-aborted signal after a stop', async () => {
    const seen = [];
    mockLlm.chatCompletion.mockImplementation(hangUntilAborted(seen));
    const first = svc.startTask({ description: 'first', webContentsId: 1 });
    await waitFor(() => seen.length === 1);
    svc.stopTask();
    await first;

    const second = svc.startTask({ description: 'second', webContentsId: 1 });
    await waitFor(() => seen.length === 2);
    expect(seen[1]).not.toBe(seen[0]);
    expect(seen[1].aborted).toBe(false);
    svc.stopTask();
    await expect(second).resolves.toEqual({ ok: false, reason: 'stopped' });
  });

  test('stopTask with no task ever started does not throw', () => {
    expect(() => svc.stopTask()).not.toThrow();
  });
});

describe('AgentService stop and orphan handling while paused', () => {
  const { EventEmitter } = require('events');
  const tab = (url) => Object.assign(new EventEmitter(), {
    executeJavaScript: jest.fn(async () => ({ title: 't', url, interactives: [], links: [], text: '' })),
    loadURL: jest.fn(async () => {}),
    getURL: () => url,
  });
  // Bounded wait for a run: a hung promise fails the test instead of the suite timeout.
  const settleWithin = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('hung'), 2000))]);
  // Step 1 pauses mid-request and returns a tool call, so step 2 waits in beforeStep for a resume.
  function pauseAfterFirstStep() {
    let n = 0;
    mockLlm.chatCompletion.mockImplementation(async (_m, opts = {}) => {
      if (!opts.signal) return { content: '{"tool":"agent.done","args":{"summary":"x"}}' };
      n += 1;
      if (n === 1) { svc.pauseTask(); return { content: '{"action":"scroll","direction":"down","amount":10}' }; }
      return { content: '{"action":"done","summary":"finished after the resume point"}' };
    });
  }

  test('stopTask ends a run that is waiting on a pause', async () => {
    pauseAfterFirstStep();
    svc._setWebContentsModule({ fromId: () => tab('https://a.example') });
    const run = svc.startTask({ description: 'pause then stop', webContentsId: 1 });
    await waitFor(() => svc._paused && svc.getSteps().some((s) => s.kind === 'acted'));
    svc.stopTask();
    await expect(settleWithin(run)).resolves.toEqual({ ok: false, reason: 'stopped' });
    expect(svc.isRunning()).toBe(false);
    expect(svc._paused).toBe(false);
    expect(svc._resumePromise).toBeNull();
  });

  test('a finished run leaves no destroyed listener on its tab', async () => {
    mockLlm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"finished with no listener left"}' });
    const wc = tab('https://a.example');
    svc._setWebContentsModule({ fromId: () => wc });
    await svc.startTask({ description: 'short run', webContentsId: 1 });
    expect(wc.listenerCount('destroyed')).toBe(0);
  });

  test('closing the tab of an earlier run does not pause the current run', async () => {
    mockLlm.chatCompletion.mockResolvedValue({ content: '{"action":"done","summary":"first run finished cleanly"}' });
    const oldTab = tab('https://old.example');
    const newTab = tab('https://new.example');
    svc._setWebContentsModule({ fromId: (id) => (id === 1 ? oldTab : newTab) });
    await svc.startTask({ description: 'first run', webContentsId: 1 });
    const seen = [];
    mockLlm.chatCompletion.mockImplementation(hangUntilAborted(seen));
    const orphaned = jest.fn();
    svc.on('task-orphaned', orphaned);
    const run = svc.startTask({ description: 'second run', webContentsId: 2 });
    await waitFor(() => seen.length > 0);
    oldTab.emit('destroyed');
    expect(svc._paused).toBe(false);
    expect(orphaned).not.toHaveBeenCalled();
    // The run's own tab closing still orphans it.
    newTab.emit('destroyed');
    expect(svc._paused).toBe(true);
    expect(orphaned).toHaveBeenCalledTimes(1);
    svc.stopTask();
    await expect(settleWithin(run)).resolves.toEqual({ ok: false, reason: 'stopped' });
  });

  test('after a reattach, closing the original tab no longer pauses the run', async () => {
    const seen = [];
    mockLlm.chatCompletion.mockImplementation(hangUntilAborted(seen));
    const first = tab('https://first.example');
    const second = tab('https://second.example');
    svc._setWebContentsModule({ fromId: (id) => (id === 1 ? first : second) });
    const run = svc.startTask({ description: 'reattach run', webContentsId: 1 });
    await waitFor(() => seen.length > 0);
    expect(svc.reattachTask({ webContentsId: 2 })).toEqual({ ok: true });
    expect(first.listenerCount('destroyed')).toBe(0);
    first.emit('destroyed');
    expect(svc._paused).toBe(false);
    svc.stopTask();
    await expect(settleWithin(run)).resolves.toEqual({ ok: false, reason: 'stopped' });
    expect(second.listenerCount('destroyed')).toBe(0);
  });
});

describe('AgentService permission URL follows the tab a call targets', () => {
  const tabRegistry = require('../../../../main/services/tabRegistry');
  const page = (url) => ({ executeJavaScript: jest.fn(async () => ({ title: 't', url, interactives: [], links: [], text: '' })), loadURL: jest.fn(async () => {}), getURL: () => url });
  const settingsByKey = {
    'settings.llm.agent': { permissions: { mode: 'bypass' } },
    'settings.llm.agent.approval': { deny: [], perOrigin: { 'https://bank.example': { click: 'deny' } } },
  };
  const mockConfig = { get: (key, def) => (key in settingsByKey ? settingsByKey[key] : def) };
  let bank;
  let google;

  beforeEach(() => {
    bank = page('https://bank.example/login');
    google = page('https://google.com/');
    svc._setWebContentsModule({ fromId: (id) => (id === 22 ? bank : google) });
    tabRegistry.clear();
    tabRegistry.set('bank', 22, false);
    tabRegistry.setMeta('bank', { kind: 'agent' });
    svc._approval.bind(null, null, mockConfig);
  });
  afterEach(() => {
    svc._approval.bind(null, null, null);
    tabRegistry.clear();
  });

  // Step 1 emits `call`; step 2 finishes. Returns what step 2 was told about step 1.
  async function runOneCall(call) {
    let n = 0;
    let secondPrompt = '';
    mockLlm.chatCompletion.mockImplementation(async (messages, opts = {}) => {
      if (!opts.signal) return { content: '{"tool":"agent.done","args":{"summary":"x"}}' };
      n += 1;
      if (n === 1) return { content: JSON.stringify(call) };
      secondPrompt = JSON.stringify(messages);
      return { content: '{"tool":"agent.done","args":{"summary":"done after one call"}}' };
    });
    await svc.startTask({ description: 'click the thing', webContentsId: 1 });
    return secondPrompt;
  }

  test('a click aimed at the bank tab by spaceId is denied by the bank per-origin rule', async () => {
    const told = await runOneCall({ tool: 'browser.click_idx', args: { spaceId: 'bank', idx: 1 } });
    expect(told).toContain('origin_deny');
  });

  test('the same click on the default tab is not caught by the bank rule', async () => {
    const told = await runOneCall({ tool: 'browser.click_idx', args: { idx: 1 } });
    expect(told).not.toContain('origin_deny');
  });
});
