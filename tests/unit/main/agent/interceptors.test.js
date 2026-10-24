// interceptors — pure hot-path hook factory. Dependencies (approval, log, llm)
// are hand-rolled fakes; approvalPolicy + panelOfJudges are the real modules.

const { buildInterceptors } = require('../../../../main/agent/interceptors');

function fakeLog() {
  return {
    tokensUsed: 0, elapsedMs: 0, navigations: 0,
    logStep: jest.fn(),
    logApproval: jest.fn(),
  };
}

describe('shouldStop budget guards', () => {
  test('returns false (and never records) when there is no log', () => {
    const recordBudget = jest.fn();
    const hooks = buildInterceptors({ budget: { maxSteps: 1 }, recordBudget });
    expect(hooks.shouldStop({ step: 5 })).toBe(false);
    expect(recordBudget).not.toHaveBeenCalled();
  });

  test('trips maxSteps', () => {
    const recordBudget = jest.fn(() => true);
    const hooks = buildInterceptors({ budget: { maxSteps: 3 }, log: fakeLog(), recordBudget });
    expect(hooks.shouldStop({ step: 3 })).toBe(true);
    expect(recordBudget).toHaveBeenCalledWith('maxSteps', { step: 3 }, { maxSteps: 3 });
  });

  test('trips maxTokens', () => {
    const recordBudget = jest.fn(() => true);
    const log = fakeLog(); log.tokensUsed = 500;
    const hooks = buildInterceptors({ budget: { maxTokens: 400 }, log, recordBudget });
    expect(hooks.shouldStop({ step: 1 })).toBe(true);
    expect(recordBudget).toHaveBeenCalledWith('maxTokens', { tokens: 500 }, { maxTokens: 400 });
  });

  test('trips maxSeconds', () => {
    const recordBudget = jest.fn(() => true);
    const log = fakeLog(); log.elapsedMs = 11000;
    const hooks = buildInterceptors({ budget: { maxSeconds: 10 }, log, recordBudget });
    expect(hooks.shouldStop({ step: 1 })).toBe(true);
  });

  test('trips maxNavigations', () => {
    const recordBudget = jest.fn(() => true);
    const log = fakeLog(); log.navigations = 7;
    const hooks = buildInterceptors({ budget: { maxNavigations: 5 }, log, recordBudget });
    expect(hooks.shouldStop({ step: 1 })).toBe(true);
  });

  test('returns false when no budget threshold is exceeded', () => {
    const hooks = buildInterceptors({ budget: { maxSteps: 100 }, log: fakeLog(), recordBudget: jest.fn() });
    expect(hooks.shouldStop({ step: 2 })).toBe(false);
  });
});

describe('beforeStep pause handling', () => {
  test('no-ops when not paused', async () => {
    const hooks = buildInterceptors({ budget: {}, getPaused: () => false });
    const ctx = { messages: [] };
    await hooks.beforeStep(ctx);
    expect(ctx.messages).toHaveLength(0);
  });

  test('pushes a resume message and awaits the resume promise when paused', async () => {
    let resolved = false;
    const resumeP = new Promise((r) => setTimeout(() => { resolved = true; r(); }, 0));
    const hooks = buildInterceptors({
      budget: {}, getPaused: () => true, getResumePromise: () => resumeP,
    });
    const ctx = { messages: [] };
    await hooks.beforeStep(ctx);
    expect(ctx.messages[0].content).toMatch(/resumed agent control/);
    expect(resolved).toBe(true);
  });

  test('an abort ends the wait on a resume that never comes', async () => {
    const ac = new AbortController();
    const never = new Promise(() => {});
    const hooks = buildInterceptors({ budget: {}, getPaused: () => true, getResumePromise: () => never, signal: ac.signal });
    const waiting = hooks.beforeStep({ messages: [] });
    let settled = false;
    waiting.then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    ac.abort();
    await waiting;
    expect(settled).toBe(true);
  });

  test('an already-aborted signal does not wait at all', async () => {
    const ac = new AbortController();
    ac.abort();
    const hooks = buildInterceptors({ budget: {}, getPaused: () => true, getResumePromise: () => new Promise(() => {}), signal: ac.signal });
    await expect(hooks.beforeStep({ messages: [] })).resolves.toBeUndefined();
  });
});

describe('beforeInvoke approval flow', () => {
  function fakeApproval(decision) {
    return {
      decide: jest.fn(() => decision),
      requestApproval: jest.fn(),
      applyDecision: jest.fn(),
    };
  }

  test('passes all calls through unchanged when there is no approval service', async () => {
    const hooks = buildInterceptors({ budget: {} });
    const calls = [{ name: 'browser.read_tab', args: {} }];
    const r = await hooks.beforeInvoke({ calls });
    expect(r).toEqual({ allowed: calls, denied: [] });
  });

  test('returns the approval decision split when nothing needs prompting/judging', async () => {
    const approval = fakeApproval({ allowed: [{ name: 'browser.read_tab', args: {} }], denied: [], prompts: [] });
    const hooks = buildInterceptors({ budget: {}, approval, qualityMode: {}, getUrl: () => 'https://a.com' });
    const r = await hooks.beforeInvoke({ calls: [{ name: 'browser.read_tab', args: {} }] });
    expect(approval.decide).toHaveBeenCalled();
    expect(r.allowed).toHaveLength(1);
    expect(r.denied).toHaveLength(0);
  });

  test('panel of judges rejects a payment action and moves it to denied', async () => {
    const navCall = { name: 'browser.navigate', args: { url: 'https://shop.com/checkout' } };
    const approval = fakeApproval({ allowed: [navCall], denied: [], prompts: [] });
    const llm = { chatCompletion: jest.fn(async () => ({ content: 'REJECT: looks like a real purchase' })) };
    const log = fakeLog();
    const hooks = buildInterceptors({
      budget: {}, approval, qualityMode: { judges: { policy: 'payment_auth' } },
      llm, log, getUrl: () => 'https://shop.com/checkout', task: 'buy stuff',
    });
    const r = await hooks.beforeInvoke({ calls: [navCall] });
    expect(r.allowed).toHaveLength(0);
    expect(r.denied).toEqual([{ call: navCall, reason: 'panel_of_judges_rejected' }]);
    expect(log.logApproval).toHaveBeenCalled();
  });

  test('panel of judges denies when the llm errors internally', async () => {
    const navCall = { name: 'browser.navigate', args: { url: 'https://shop.com/checkout' } };
    const approval = fakeApproval({ allowed: [navCall], denied: [], prompts: [] });
    // runJudges swallows per-prompt llm errors and yields approve:false ->
    // beforeInvoke denies the call (NOT fail-open, since runJudges resolved).
    const llm = { chatCompletion: jest.fn(async () => { throw new Error('judge llm 500'); }) };
    const hooks = buildInterceptors({
      budget: {}, approval, qualityMode: { judges: { policy: 'payment_auth' } },
      llm, getUrl: () => 'https://shop.com/checkout',
    });
    const r = await hooks.beforeInvoke({ calls: [navCall] });
    expect(r.allowed).toHaveLength(0);
    expect(r.denied).toEqual([{ call: navCall, reason: 'panel_of_judges_rejected' }]);
  });

  test('non-trigger actions skip the judges entirely', async () => {
    const readCall = { name: 'browser.read_tab', args: {} };
    const approval = fakeApproval({ allowed: [readCall], denied: [], prompts: [] });
    const llm = { chatCompletion: jest.fn() };
    const hooks = buildInterceptors({
      budget: {}, approval, qualityMode: { judges: { policy: 'payment_auth' } },
      llm, getUrl: () => 'https://a.com',
    });
    const r = await hooks.beforeInvoke({ calls: [readCall] });
    expect(llm.chatCompletion).not.toHaveBeenCalled();
    expect(r.allowed).toEqual([readCall]);
  });

  test('prompts that the user approves are applied and moved to allowed', async () => {
    const call = { name: 'browser.close_tab', args: {} };
    const prompt = { call, class: 'destructive', origin: 'https://a.com' };
    const approval = fakeApproval({ allowed: [], denied: [], prompts: [prompt] });
    approval.requestApproval.mockResolvedValue({ decision: 'approve_session' });
    const log = fakeLog();
    const hooks = buildInterceptors({ budget: {}, approval, qualityMode: {}, log, getUrl: () => 'https://a.com' });
    const r = await hooks.beforeInvoke({ calls: [call] });
    expect(approval.applyDecision).toHaveBeenCalledWith(prompt, 'approve_session');
    expect(r.allowed).toEqual([call]);
    expect(log.logApproval).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approve_session' }));
  });

  test('prompts the user rejects go to denied with the reason', async () => {
    const call = { name: 'browser.close_tab', args: {} };
    const prompt = { call, class: 'destructive', origin: 'https://a.com' };
    const approval = fakeApproval({ allowed: [], denied: [], prompts: [prompt] });
    approval.requestApproval.mockResolvedValue({ decision: 'reject', reason: 'user_said_no' });
    const log = fakeLog();
    const hooks = buildInterceptors({ budget: {}, approval, qualityMode: {}, log, getUrl: () => 'https://a.com' });
    const r = await hooks.beforeInvoke({ calls: [call] });
    expect(r.denied).toEqual([{ call, reason: 'user_said_no' }]);
    expect(r.allowed).toHaveLength(0);
  });

  test('getUrl absent yields an empty url passed to decide', async () => {
    const approval = fakeApproval({ allowed: [], denied: [], prompts: [] });
    const hooks = buildInterceptors({ budget: {}, approval, qualityMode: {} });
    await hooks.beforeInvoke({ calls: [{ name: 'browser.read_tab', args: {} }] });
    expect(approval.decide).toHaveBeenCalledWith(expect.anything(), { mode: {}, url: '' });
  });

  test('a stop during an approval prompt rejects the remaining prompts without asking', async () => {
    const a = { call: { id: 'a', name: 'browser.close_tab', args: {} }, class: 'destructive', origin: 'https://a.com' };
    const b = { call: { id: 'b', name: 'fs.write', args: {} }, class: 'edit', origin: '' };
    const approval = fakeApproval({ allowed: [], denied: [], prompts: [a, b] });
    const ac = new AbortController();
    approval.requestApproval.mockImplementation(async () => { ac.abort(); return { decision: 'reject', reason: 'stopped' }; });
    const hooks = buildInterceptors({ budget: {}, approval, qualityMode: {}, getUrl: () => 'https://a.com', signal: ac.signal });
    const r = await hooks.beforeInvoke({ calls: [a.call, b.call] });
    expect(approval.requestApproval).toHaveBeenCalledTimes(1);
    expect(r.allowed).toEqual([]);
    expect(r.denied).toEqual([{ call: a.call, reason: 'stopped' }, { call: b.call, reason: 'stopped' }]);
  });

  test('a run stopped before beforeInvoke asks for nothing', async () => {
    const p = { call: { id: 'a', name: 'browser.close_tab', args: {} }, class: 'destructive', origin: 'https://a.com' };
    const approval = fakeApproval({ allowed: [], denied: [], prompts: [p] });
    const ac = new AbortController();
    ac.abort();
    const hooks = buildInterceptors({ budget: {}, approval, qualityMode: {}, signal: ac.signal });
    const r = await hooks.beforeInvoke({ calls: [p.call] });
    expect(approval.requestApproval).not.toHaveBeenCalled();
    expect(r.denied).toEqual([{ call: p.call, reason: 'stopped' }]);
  });

  test('each call is decided against the URL of the tab it targets', async () => {
    const bankClick = { id: 'c1', name: 'browser.click_idx', args: { spaceId: 'bank', idx: 3 } };
    const read = { id: 'c2', name: 'browser.read_tab', args: {} };
    const approval = {
      decide: jest.fn((calls) => ({ allowed: calls.filter((c) => c === read), denied: calls.filter((c) => c === bankClick).map((call) => ({ call, reason: 'origin_deny' })), prompts: [] })),
      requestApproval: jest.fn(), applyDecision: jest.fn(),
    };
    const getUrlFor = (call) => (call.args.spaceId === 'bank' ? 'https://bank.example/home' : 'https://google.com/');
    const hooks = buildInterceptors({ budget: {}, approval, qualityMode: {}, getUrl: () => 'https://google.com/', getUrlFor });
    const r = await hooks.beforeInvoke({ calls: [bankClick, read] });
    expect(approval.decide).toHaveBeenCalledWith([bankClick], { mode: {}, url: 'https://bank.example/home' });
    expect(approval.decide).toHaveBeenCalledWith([read], { mode: {}, url: 'https://google.com/' });
    expect(r.allowed).toEqual([read]);
    expect(r.denied).toEqual([{ call: bankClick, reason: 'origin_deny' }]);
  });

  test('calls on the same tab share one decide', async () => {
    const approval = fakeApproval({ allowed: [], denied: [], prompts: [] });
    const calls = [{ id: 'c1', name: 'browser.read_tab', args: {} }, { id: 'c2', name: 'browser.snapshot_ax', args: {} }];
    const hooks = buildInterceptors({ budget: {}, approval, qualityMode: {}, getUrlFor: () => 'https://a.com/' });
    await hooks.beforeInvoke({ calls });
    expect(approval.decide).toHaveBeenCalledTimes(1);
    expect(approval.decide).toHaveBeenCalledWith(calls, { mode: {}, url: 'https://a.com/' });
  });

  test('sessionId and allowedTools reach decide so session mode and plan-mode filtering apply', async () => {
    const approval = fakeApproval({ allowed: [], denied: [], prompts: [] });
    const allowedTools = (name) => name === 'fs.read';
    const hooks = buildInterceptors({ budget: {}, approval, qualityMode: {}, sessionId: 's_abcdef12', allowedTools });
    await hooks.beforeInvoke({ calls: [{ name: 'fs.write', args: {} }] });
    expect(approval.decide).toHaveBeenCalledWith(expect.anything(), { mode: {}, url: '', sessionId: 's_abcdef12', allowedTools });
  });
});

describe('onStep', () => {
  test('logs the step when a log is present', async () => {
    const log = fakeLog();
    const hooks = buildInterceptors({ budget: {}, log, getUrl: () => 'https://x' });
    await hooks.onStep({ step: 2, calls: [], results: [], latencyMs: 5, tokens: 9 });
    expect(log.logStep).toHaveBeenCalledWith(expect.objectContaining({ step: 2, url: 'https://x' }));
  });

  test('is a no-op when there is no log', async () => {
    const hooks = buildInterceptors({ budget: {} });
    await expect(hooks.onStep({ step: 1, calls: [], results: [] })).resolves.toBeUndefined();
  });
});

describe('shouldReflect policies', () => {
  const failing = { results: [{ result: { ok: false } }] };
  const passing = { results: [{ result: { ok: true } }] };

  test('"every" always asks for a reflection', async () => {
    const hooks = buildInterceptors({ budget: {}, qualityMode: { reflection: { after: 'every' } } });
    const r = await hooks.shouldReflect(passing);
    expect(r.prompt).toMatch(/reflect/i);
  });

  test('default "failure" policy reflects only on a failure', async () => {
    const hooks = buildInterceptors({ budget: {}, qualityMode: {} });
    expect(await hooks.shouldReflect(failing)).toBeTruthy();
    expect(await hooks.shouldReflect(passing)).toBeNull();
  });

  test('"failure_or_plan_end" reflects on failure', async () => {
    const hooks = buildInterceptors({ budget: {}, qualityMode: { reflection: { after: 'failure_or_plan_end' } } });
    expect(await hooks.shouldReflect(failing)).toBeTruthy();
    expect(await hooks.shouldReflect(passing)).toBeNull();
  });
});
