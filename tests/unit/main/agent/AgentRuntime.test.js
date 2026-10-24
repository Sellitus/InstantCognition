const { AgentRuntime, shapeMessages } = require('../../../../main/agent/AgentRuntime');
const { createRegistry } = require('../../../../main/agent/toolRegistry');

function makeLlm() {
  const mock = { chatCompletion: jest.fn() };
  return mock;
}

function registerBasics() {
  const r = createRegistry();
  r.register({
    name: 'browser.click', description: 'click', sideEffect: true,
    parameters: { type: 'object', properties: { spaceId: { type: 'string' }, selector: { type: 'string' } }, required: ['selector'] },
    handler: async (args) => ({ ok: true, clicked: args.selector, tab: args.spaceId || null }),
  });
  r.register({
    name: 'browser.read_tab', description: 'read',
    parameters: { type: 'object', properties: { spaceId: { type: 'string' } }, required: [] },
    handler: async (args) => ({ ok: true, title: 'T-' + (args.spaceId || 'active'), wordCount: 10 }),
  });
  r.register({
    name: 'agent.done', description: 'done',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    handler: async (args) => ({ ok: true, summary: args.summary }),
  });
  r.register({
    name: 'agent.ask_user', description: 'ask',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    handler: async (args) => ({ ok: true, awaitingUser: true, question: args.question }),
  });
  return r;
}

describe('AgentRuntime', () => {
  test('tools mode: single tool_call terminates via agent.done', async () => {
    const llm = makeLlm();
    llm.chatCompletion.mockResolvedValueOnce({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"finished"}' } }],
    });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: { endpoint: 'x', modelName: 'm' },
    });
    expect(res).toMatchObject({ ok: true, summary: 'finished', mode: 'tools' });
  });

  test('json mode: plain JSON object is parsed and dispatched', async () => {
    const llm = makeLlm();
    // No toolCalls — forces json mode. Runtime will then use json extraction.
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"tool":"browser.click","args":{"selector":"#go"}}', toolCalls: null })
      .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"ok"}}', toolCalls: null });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const emitted = [];
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
      emit: (channel, payload) => emitted.push({ channel, payload }),
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('json');
    const planned = emitted.filter((e) => e.channel === 'step-planned');
    expect(planned[0].payload.calls[0].name).toBe('browser.click');
  });

  test('parallel tool calls: two read_tab calls dispatch concurrently', async () => {
    const llm = makeLlm();
    llm.chatCompletion
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'browser.read_tab', arguments: '{"spaceId":"tab1"}' } },
          { id: 'c2', type: 'function', function: { name: 'browser.read_tab', arguments: '{"spaceId":"tab2"}' } },
        ],
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'c3', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"two"}' } }],
      });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const emitted = [];
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: { endpoint: 'x', modelName: 'm' },
      emit: (channel, payload) => emitted.push({ channel, payload }),
    });
    expect(res.ok).toBe(true);
    const firstAct = emitted.find((e) => e.channel === 'step-acted');
    expect(firstAct.payload.results).toHaveLength(2);
    expect(firstAct.payload.results[0].result.title).toBe('T-tab1');
    expect(firstAct.payload.results[1].result.title).toBe('T-tab2');
  });

  test('ask_user returns awaiting_user and stops', async () => {
    const llm = makeLlm();
    llm.chatCompletion.mockResolvedValueOnce({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'agent.ask_user', arguments: '{"question":"which?"}' } }],
    });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: { endpoint: 'x', modelName: 'm' },
    });
    expect(res).toMatchObject({ ok: false, reason: 'awaiting_user', question: 'which?' });
  });

  test('max_steps ceiling fires when model never says done', async () => {
    const llm = makeLlm();
    llm.chatCompletion.mockResolvedValue({
      content: '',
      toolCalls: [{ id: 'c', type: 'function', function: { name: 'browser.read_tab', arguments: '{}' } }],
    });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: { endpoint: 'x', modelName: 'm' },
      maxSteps: 3,
    });
    expect(res).toMatchObject({ ok: false, reason: 'max_steps_exceeded' });
  });

  test('shouldStop signal short-circuits the loop', async () => {
    const llm = makeLlm();
    llm.chatCompletion.mockResolvedValue({ content: '', toolCalls: [{ id: 'c', type: 'function', function: { name: 'browser.read_tab', arguments: '{}' } }] });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    let stop = false;
    const p = runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
      shouldStop: () => stop,
    });
    stop = true;
    const res = await p;
    expect(res).toMatchObject({ ok: false, reason: 'stopped' });
  });

  test('json mode: JSON array of parallel calls both dispatched', async () => {
    const llm = makeLlm();
    llm.chatCompletion
      .mockResolvedValueOnce({
        content: '[{"tool":"browser.read_tab","args":{"spaceId":"a"}},{"tool":"browser.read_tab","args":{"spaceId":"b"}}]',
        toolCalls: null,
      })
      .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"done"}}', toolCalls: null });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const emitted = [];
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
      emit: (channel, payload) => emitted.push({ channel, payload }),
    });
    expect(res.ok).toBe(true);
    const firstAct = emitted.find((e) => e.channel === 'step-acted');
    expect(firstAct.payload.results).toHaveLength(2);
  });

  test('Hermes <tool_call>{...}</tool_call> format is recognized', async () => {
    const llm = makeLlm();
    llm.chatCompletion
      .mockResolvedValueOnce({
        content: 'Let me check.\n<tool_call>{"name":"browser.read_tab","arguments":{"spaceId":"a"}}</tool_call>',
        toolCalls: null,
      })
      .mockResolvedValueOnce({ content: '<tool_call>{"name":"agent.done","arguments":{"summary":"k"}}</tool_call>', toolCalls: null });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const res = await runtime.run({ task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {} });
    expect(res).toMatchObject({ ok: true, summary: 'k' });
  });

  test('Llama <function=name><parameter=k>v</parameter></function> format is recognized', async () => {
    const llm = makeLlm();
    llm.chatCompletion
      .mockResolvedValueOnce({
        content: '<function=browser.read_tab>\n<parameter=spaceId>\nab\n</parameter>\n</function>',
        toolCalls: null,
      })
      .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"ok"}}', toolCalls: null });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const emitted = [];
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
      emit: (channel, payload) => emitted.push({ channel, payload }),
    });
    expect(res.ok).toBe(true);
    const planned = emitted.find((e) => e.channel === 'step-planned');
    expect(planned.payload.calls[0].name).toBe('browser.read_tab');
    expect(planned.payload.calls[0].args.spaceId).toBe('ab');
  });

  test('<think>…</think> reasoning is stripped before parse', async () => {
    const llm = makeLlm();
    llm.chatCompletion
      .mockResolvedValueOnce({
        content: '<think>I should check tab a first.</think>\n{"tool":"browser.read_tab","args":{"spaceId":"a"}}',
        toolCalls: null,
      })
      .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"done"}}', toolCalls: null });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const res = await runtime.run({ task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {} });
    expect(res).toMatchObject({ ok: true, summary: 'done' });
  });

  test('unparseable tool-call marker triggers retry with correction, not silent done', async () => {
    const llm = makeLlm();
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '<tool_call>garbage not json</tool_call>', toolCalls: null })
      .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"recovered"}}', toolCalls: null });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const emitted = [];
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
      emit: (channel, payload) => emitted.push({ channel, payload }),
    });
    expect(res).toMatchObject({ ok: true, summary: 'recovered' });
    const retries = emitted.filter((e) => e.channel === 'step-parse-retry');
    expect(retries).toHaveLength(1);
  });

  test('reasoning prose without tool call is rejected and retried, not silently accepted as summary', async () => {
    const llm = makeLlm();
    const reasoning = 'Looking at the search results, the dates do not match. I will navigate to a date-sorted URL. Plan: 1. Open the date-sorted page. 2. Re-read.';
    llm.chatCompletion
      .mockResolvedValueOnce({ content: reasoning, toolCalls: null })
      .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"recovered after planning prose was rejected"}}', toolCalls: null });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const emitted = [];
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
      emit: (channel, payload) => emitted.push({ channel, payload }),
    });
    expect(res.ok).toBe(true);
    expect(res.summary).not.toContain('Plan:');
    const retries = emitted.filter((e) => e.channel === 'step-parse-retry');
    expect(retries.length).toBe(1);
  });

  test('forced final summary recovers a real agent.done after the parse-retry cap', async () => {
    const llm = makeLlm();
    const reasoning = 'I have gathered enough information from the previous turns. I need to call agent.done with a comprehensive summary of the findings.';
    // PARSE_RETRY_CAP = 5 → 5 reasoning replies trip the cap. Then the runtime
    // makes ONE forced-summary attempt with a tightly-scoped prompt.
    llm.chatCompletion
      .mockResolvedValueOnce({ content: reasoning, toolCalls: null })
      .mockResolvedValueOnce({ content: reasoning, toolCalls: null })
      .mockResolvedValueOnce({ content: reasoning, toolCalls: null })
      .mockResolvedValueOnce({ content: reasoning, toolCalls: null })
      .mockResolvedValueOnce({ content: reasoning, toolCalls: null })
      .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"Recovered final answer."}}', toolCalls: null });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('forced_summary');
    expect(res.summary).toBe('Recovered final answer.');
    expect(llm.chatCompletion).toHaveBeenCalledTimes(6);
  });

  test('parse-loop bail returns a CLEAN status — never the raw reasoning dump', async () => {
    const llm = makeLlm();
    const reasoning = 'I have gathered enough information from the previous turns. I need to call agent.done with a comprehensive summary of the findings.';
    // 5 reasoning replies trip the cap; the forced-summary attempt ALSO returns
    // reasoning, so the runtime must surface a clean fallback message — NOT
    // the model's raw stream-of-consciousness.
    for (let i = 0; i < 6; i++) {
      llm.chatCompletion.mockResolvedValueOnce({ content: reasoning, toolCalls: null });
    }
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const emitted = [];
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
      emit: (channel, payload) => emitted.push({ channel, payload }),
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('parse_loop_recovered');
    // Clean status sentinel — present in the bail message, NOT in the raw reasoning.
    expect(res.summary).toMatch(/could not produce a structured final answer/i);
    // The reasoning fragment is included as a quoted preview, not as the whole summary.
    expect(res.summary).toMatch(/Last reasoning fragment:/);
    expect(res.summary.length).toBeLessThan(reasoning.length + 400); // not a 12k-token dump
    const retries = emitted.filter((e) => e.channel === 'step-parse-retry');
    expect(retries.length).toBe(5);
    expect(retries[retries.length - 1].payload.giveUp).toBe(true);
    // 5 retries + 1 forced-summary attempt.
    expect(llm.chatCompletion).toHaveBeenCalledTimes(6);
  });

  test('short declarative summary without tool call IS accepted as final answer', async () => {
    const llm = makeLlm();
    llm.chatCompletion.mockResolvedValueOnce({ content: 'Top 3: alpha, beta, gamma.', toolCalls: null });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const res = await runtime.run({ task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {} });
    expect(res).toMatchObject({ ok: true, summary: 'Top 3: alpha, beta, gamma.' });
  });

  test('legacy action-key JSON normalizes to browser.*', async () => {
    const llm = makeLlm();
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"action":"click","selector":"#x"}', toolCalls: null })
      .mockResolvedValueOnce({ content: '{"action":"done","summary":"k"}', toolCalls: null });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm });
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
    });
    expect(res).toMatchObject({ ok: true, summary: 'k' });
  });

  describe('constructor guards', () => {
    test('throws without a registry', () => {
      expect(() => new AgentRuntime({ llm: makeLlm() })).toThrow('registry required');
    });
    test('throws without an llm', () => {
      expect(() => new AgentRuntime({ registry: registerBasics() })).toThrow('llm required');
    });
  });

  describe('interceptor hooks', () => {
    test('hooks.shouldStop short-circuits with budget_exceeded', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValue({ content: '', toolCalls: [] });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
        interceptors: { shouldStop: ({ step }) => step >= 0 },
      });
      expect(res).toEqual({ ok: false, reason: 'budget_exceeded' });
      expect(llm.chatCompletion).not.toHaveBeenCalled();
    });

    test('hooks.beforeStep is awaited; its throw aborts with hook_error', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValue({ content: '{"tool":"agent.done","args":{"summary":"x"}}', toolCalls: null });
      const beforeStep = jest.fn(async () => { throw new Error('hook-bad'); });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
        interceptors: { beforeStep },
      });
      expect(res).toEqual({ ok: false, reason: 'hook_error', error: 'hook-bad' });
      expect(beforeStep).toHaveBeenCalled();
    });

    test('beforeStep throwing a non-Error stringifies via String(err)', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValue({ content: '{}', toolCalls: null });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
        interceptors: { beforeStep: async () => { throw 'plain-hook-fail'; } }, // eslint-disable-line no-throw-literal
      });
      expect(res).toEqual({ ok: false, reason: 'hook_error', error: 'plain-hook-fail' });
    });

    test('beforeInvoke gate splits allowed/denied; denied calls get rejection results', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'browser.click', arguments: '{"selector":"#a"}' } },
            { id: 'c2', type: 'function', function: { name: 'browser.click', arguments: '{"selector":"#b"}' } },
          ],
        })
        .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'd', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"ok"}' } }] });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const emitted = [];
      const beforeInvoke = jest.fn(async ({ calls }) => ({
        allowed: [calls[0]],
        denied: [{ call: calls[1], reason: 'policy' }],
      }));
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: { endpoint: 'e', modelName: 'm' },
        emit: (c, p) => emitted.push({ c, p }), interceptors: { beforeInvoke },
      });
      expect(res.ok).toBe(true);
      const acted = emitted.find((e) => e.c === 'step-acted');
      const denied = acted.p.results.find((r) => r.id === 'c2');
      expect(denied.result).toMatchObject({ ok: false, error: 'denied_by_user', reason: 'policy' });
    });

    test('beforeInvoke denying with no reason falls back to "rejected"', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'browser.click', arguments: '{"selector":"#a"}' } }] })
        .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'd', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"s"}' } }] });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const emitted = [];
      // Deny only the first step's call (no reason → "rejected"); let the
      // subsequent agent.done through so the run terminates.
      const beforeInvoke = jest.fn(async ({ step, calls }) => (
        step === 0 ? { allowed: [], denied: [{ call: calls[0] }] } : { allowed: calls, denied: [] }
      ));
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: { endpoint: 'e', modelName: 'm' },
        emit: (c, p) => emitted.push({ c, p }), interceptors: { beforeInvoke },
      });
      expect(res).toMatchObject({ ok: true, summary: 's' });
      const acted = emitted.find((e) => e.c === 'step-acted');
      expect(acted.p.results[0].result.reason).toBe('rejected');
    });

    test('beforeInvoke returning no gate object leaves calls unchanged', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{"spaceId":"a"}}', toolCalls: null })
        .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"z"}}', toolCalls: null });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
        interceptors: { beforeInvoke: async () => undefined },
      });
      expect(res).toMatchObject({ ok: true, summary: 'z' });
    });

    test('hooks.onStep throw is swallowed (logging must not stop the loop)', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{"spaceId":"a"}}', toolCalls: null })
        .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"done"}}', toolCalls: null });
      const onStep = jest.fn(async () => { throw new Error('log-fail'); });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
        interceptors: { onStep },
      });
      expect(res.ok).toBe(true);
      expect(onStep).toHaveBeenCalled();
    });

    test('hooks.shouldReflect injects a reflect turn; its throw is non-fatal', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{"spaceId":"a"}}', toolCalls: null })
        .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"r"}}', toolCalls: null });
      const messages = [{ role: 'system', content: 's' }];
      const shouldReflect = jest.fn()
        .mockResolvedValueOnce({ prompt: 'Reconsider step 0.' });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages, toolCtx: {}, invCtx: {}, interceptors: { shouldReflect },
      });
      expect(res.ok).toBe(true);
      expect(messages.some((m) => m.content === 'Reconsider step 0.')).toBe(true);
    });

    test('shouldReflect returning falsy / no prompt injects nothing', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{"spaceId":"a"}}', toolCalls: null })
        .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"r2"}}', toolCalls: null });
      const messages = [{ role: 'system', content: 's' }];
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages, toolCtx: {}, invCtx: {},
        interceptors: { shouldReflect: async () => ({ prompt: '' }) },
      });
      expect(res.ok).toBe(true);
      // Only system + the json-mode turns; no reflect user message added.
      expect(messages.filter((m) => m.role === 'user' && /Reconsider/.test(m.content || ''))).toHaveLength(0);
    });

    test('shouldReflect throwing is caught and the loop proceeds', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{"spaceId":"a"}}', toolCalls: null })
        .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"ok3"}}', toolCalls: null });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
        interceptors: { shouldReflect: async () => { throw new Error('reflect-bad'); } },
      });
      expect(res).toMatchObject({ ok: true, summary: 'ok3' });
    });
  });

  describe('_askLLM routing + mode detection', () => {
    test('uses chatCompletionRouted when invCtx.routeTag is set and the method exists', async () => {
      const llm = {
        chatCompletion: jest.fn(),
        chatCompletionRouted: jest.fn(async () => ({
          content: '', toolCalls: [{ id: 'c', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"routed"}' } }],
        })),
      };
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
        invCtx: { endpoint: 'e', modelName: 'm', routeTag: 'draft' },
      });
      expect(res).toMatchObject({ ok: true, summary: 'routed' });
      expect(llm.chatCompletionRouted).toHaveBeenCalledWith(
        expect.any(Array), expect.any(Object), { routeTag: 'draft' }
      );
      expect(llm.chatCompletion).not.toHaveBeenCalled();
    });

    test('routeTag set but no chatCompletionRouted method → plain chatCompletion', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValue({ content: '{"tool":"agent.done","args":{"summary":"plain"}}', toolCalls: null });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
        invCtx: { routeTag: 'draft' },
      });
      expect(res).toMatchObject({ ok: true, summary: 'plain' });
    });

    test('forceMode from invCtx skips auto-detection', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValue({ content: '{"tool":"agent.done","args":{"summary":"forced-json"}}', toolCalls: null });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
        invCtx: { forceMode: 'json' },
      });
      expect(res).toMatchObject({ ok: true, summary: 'forced-json', mode: 'json' });
    });

    test('mode cache reused across calls with the same endpoint+model key', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'browser.read_tab', arguments: '{}' } }] })
        .mockResolvedValueOnce({ content: '', toolCalls: [{ id: '2', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"cached"}' } }] });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const inv = { endpoint: 'e1', modelName: 'm1' };
      const r1 = await runtime.run({ task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: inv });
      expect(r1.mode).toBe('tools');
      llm.chatCompletion.mockResolvedValueOnce({ content: '', toolCalls: [{ id: '3', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"again"}' } }] });
      const r2 = await runtime.run({ task: 't2', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: inv });
      expect(r2.mode).toBe('tools');
    });
  });

  describe('_extractCalls tools-mode mapping', () => {
    test('synthesizes ids and filters nameless tool calls', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { function: { name: '', arguments: '{}' } },                 // nameless → filtered
          { function: { name: 'agent.done', arguments: '{"summary":"mapped"}' } }, // no id → synthesized
        ],
      });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
        invCtx: { endpoint: 'e', modelName: 'm', forceMode: 'tools' },
      });
      expect(res).toMatchObject({ ok: true, summary: 'mapped' });
    });

    test('tool call with top-level name + arguments (no .function) is handled', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'x', name: 'agent.done', arguments: '{"summary":"flat"}' }],
      });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
        invCtx: { forceMode: 'tools' },
      });
      expect(res).toMatchObject({ ok: true, summary: 'flat' });
    });
  });

  describe('_appendTurn tools mode', () => {
    test('appends assistant tool_calls then a tool result message per call', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({ content: 'thinking', toolCalls: [{ id: 'r1', type: 'function', function: { name: 'browser.read_tab', arguments: '{"spaceId":"a"}' } }] })
        .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'd', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"x"}' } }] });
      const messages = [{ role: 'system', content: 's' }];
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      await runtime.run({ task: 't', messages, toolCtx: {}, invCtx: { endpoint: 'e', modelName: 'm' } });
      const toolMsg = messages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeTruthy();
      expect(toolMsg.tool_call_id).toBe('r1');
    });
  });

  describe('_forceFinalSummary recovery shapes', () => {
    test('recovers via OpenAI-native tool_calls on the forced attempt', async () => {
      const llm = makeLlm();
      const reasoning = 'I will now compile the final answer for the user. Let me carefully write out the complete summary based on what I have observed so far.';
      for (let i = 0; i < 5; i++) llm.chatCompletion.mockResolvedValueOnce({ content: reasoning, toolCalls: null });
      llm.chatCompletion.mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'f', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"native-forced"}' } }],
      });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({ task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {} });
      expect(res).toMatchObject({ ok: true, reason: 'forced_summary', summary: 'native-forced' });
    });

    test('forced attempt returns plain non-reasoning text → used as the summary', async () => {
      const llm = makeLlm();
      const reasoning = 'I will produce the final answer for the user now. Let me finalize all of my reasoning carefully before responding with the result.';
      for (let i = 0; i < 5; i++) llm.chatCompletion.mockResolvedValueOnce({ content: reasoning, toolCalls: null });
      llm.chatCompletion.mockResolvedValueOnce({ content: 'The capital is Paris.', toolCalls: null });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({ task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {} });
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('The capital is Paris.');
    });

    test('soft-landing summary on max steps when the model never says done', async () => {
      const llm = makeLlm();
      // Always a valid non-terminal tool call → never finishes by itself.
      llm.chatCompletion.mockResolvedValue({ content: '{"tool":"browser.read_tab","args":{"spaceId":"a"}}', toolCalls: null });
      // The final forced-summary call (after the loop) yields a usable answer.
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      // Override _forceFinalSummary indirectly: last call returns done text.
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{"spaceId":"a"}}', toolCalls: null })
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{"spaceId":"a"}}', toolCalls: null })
        .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"soft"}}', toolCalls: null });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {}, maxSteps: 2,
      });
      expect(res.ok).toBe(true);
      expect(res.reason).toBe('maxstepsexceeded_soft');
      expect(res.summary).toBe('soft');
    });

    test('hard max_steps_exceeded when the forced summary also fails', async () => {
      const llm = makeLlm();
      // Every call (loop + forced) throws → _forceFinalSummary swallows, hard fail.
      llm.chatCompletion.mockRejectedValue(new Error('llm-down'));
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      await expect(runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {}, maxSteps: 1,
      })).rejects.toThrow('llm-down');
    });
  });

  describe('_chatStreamingOrPlain', () => {
    test('streams chunks, emits assistant-chunk, and parses the streamed summary', async () => {
      const reasoning = 'I will compile the final answer for the user now. Let me finalize all of the reasoning before I respond with the complete result.';
      const chunks = ['{"tool":"agent', '.done","args"', ':{"summary":"streamed ans"}}', { __final: true, usage: { completion_tokens: 9 } }];
      async function* gen() { for (const c of chunks) yield c; }
      const llm = {
        chatCompletion: jest.fn(async () => ({ content: reasoning, toolCalls: null })),
        chatCompletionStream: jest.fn(() => gen()),
      };
      // 5 reasoning replies trip the cap, then the forced summary streams.
      for (let i = 0; i < 5; i++) llm.chatCompletion.mockResolvedValueOnce({ content: reasoning, toolCalls: null });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const emitted = [];
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: { taskId: 'T1' },
        emit: (c, p) => emitted.push({ c, p }),
      });
      expect(res).toMatchObject({ ok: true, reason: 'forced_summary', summary: 'streamed ans' });
      const chunkEvents = emitted.filter((e) => e.c === 'assistant-chunk');
      expect(chunkEvents.length).toBeGreaterThan(0);
      expect(chunkEvents[0].p.taskId).toBe('T1');
    });

    test('stream failure mid-flight falls back to a fresh non-streaming call', async () => {
      const reasoning = 'I will produce the final answer for the user. Let me put together all of the gathered information into a complete response now.';
      async function* boom() { yield '{"tool":'; throw new Error('stream-broke'); }
      const llm = {
        chatCompletion: jest.fn(),
        chatCompletionStream: jest.fn(() => boom()),
      };
      for (let i = 0; i < 5; i++) llm.chatCompletion.mockResolvedValueOnce({ content: reasoning, toolCalls: null });
      // The fallback non-streaming call recovers a real agent.done.
      llm.chatCompletion.mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"fallback ans"}}', toolCalls: null });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
      });
      expect(res).toMatchObject({ ok: true, summary: 'fallback ans' });
    });

    test('stream chunks delivered as {content} objects are concatenated', async () => {
      const reasoning = 'I will write out the final answer for the user. Let me finalize the whole thing carefully before replying with the complete result.';
      async function* gen() {
        yield { content: '{"tool":"agent.done",' };
        yield { content: '"args":{"summary":"obj chunks"}}' };
      }
      const llm = {
        chatCompletion: jest.fn(),
        chatCompletionStream: jest.fn(() => gen()),
      };
      for (let i = 0; i < 5; i++) llm.chatCompletion.mockResolvedValueOnce({ content: reasoning, toolCalls: null });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
      });
      expect(res).toMatchObject({ ok: true, summary: 'obj chunks' });
    });
  });

  describe('trimTrailingParseRetries via forced summary prompt shaping', () => {
    test('peels retry pushback pairs but keeps successful tool turns', async () => {
      const llm = makeLlm();
      const reasoning = 'I have gathered enough information from the previous turns. I will now call agent.done with a comprehensive summary of all the findings.';
      // First a real tool turn, then 5 reasoning replies trip the cap.
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{"spaceId":"a"}}', toolCalls: null });
      for (let i = 0; i < 5; i++) llm.chatCompletion.mockResolvedValueOnce({ content: reasoning, toolCalls: null });
      // Forced summary: capture the messages it was called with.
      llm.chatCompletion.mockImplementationOnce(async (msgs) => {
        // The trailing retry pushback ("STOP narrating") pairs must be trimmed,
        // and the last appended message is the time-is-up forced prompt.
        expect(msgs[msgs.length - 1].content).toMatch(/Time is up/);
        return { content: '{"tool":"agent.done","args":{"summary":"trimmed-ok"}}', toolCalls: null };
      });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: {},
      });
      expect(res).toMatchObject({ ok: true, summary: 'trimmed-ok' });
    });
  });

  describe('token-budget tracking + compaction', () => {
    test('emits agent-tokens with the running total from usage', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"done"}' } }],
        usage: { prompt_tokens: 40, completion_tokens: 5 },
      });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const emitted = [];
      await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
        invCtx: { endpoint: 'x', modelName: 'm', contextSize: 1000 },
        emit: (c, p) => emitted.push({ c, p }),
      });
      const tokEvents = emitted.filter((e) => e.c === 'agent-tokens');
      expect(tokEvents.length).toBe(1);
      expect(tokEvents[0].p.tokensUsed).toBe(45);
      expect(tokEvents[0].p.contextSize).toBe(1000);
    });

    test('compacts the oldest turns when the running total crosses the threshold', async () => {
      const llm = makeLlm();
      // Three read_tab steps (each json-mode turn appends 2 messages → 7 total after
      // step 2, >= MIN_TURNS_TO_COMPACT=6). The conversation grows toward the window:
      // prompt_tokens 40, 60, 85 — crossing the 80 threshold at step 2, where there
      // are also enough turns. Then a compaction-summary call, then agent.done.
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{}}', toolCalls: null, usage: { prompt_tokens: 40, completion_tokens: 10 } })
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{}}', toolCalls: null, usage: { prompt_tokens: 60, completion_tokens: 10 } })
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{}}', toolCalls: null, usage: { prompt_tokens: 85, completion_tokens: 10 } })
        .mockResolvedValueOnce({ content: 'Compacted recap: found a page about kubernetes.', toolCalls: null, usage: { prompt_tokens: 20, completion_tokens: 5 } }) // compaction summary
        .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"final"}}', toolCalls: null, usage: { prompt_tokens: 30, completion_tokens: 5 } });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const emitted = [];
      const messages = [{ role: 'system', content: 's' }];
      const res = await runtime.run({
        task: 't', messages, toolCtx: {},
        invCtx: { contextSize: 100 }, // threshold = 80; prompts 40, 60, 85 — the conversation itself crosses at step 2
        emit: (c, p) => emitted.push({ c, p }),
      });
      expect(res.ok).toBe(true);
      const compacted = emitted.filter((e) => e.c === 'agent-compacted');
      expect(compacted.length).toBe(1);
      expect(compacted[0].p.before).toBeGreaterThan(compacted[0].p.after);
      // System message survives compaction at the front.
      expect(messages[0].role).toBe('system');
      // With no task message ahead of the tail, the recap is the first user turn and an assistant turn follows it.
      const c = messages.findIndex((m) => /^\[Compacted/.test(m.content || ''));
      expect(c).toBe(1);
      expect(messages[c].role).toBe('user');
      expect(messages[c + 1].role).toBe('assistant');
    });

    test('does not compact a short run that ends before the threshold', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"done"}' } }],
        usage: { prompt_tokens: 40, completion_tokens: 5 }, // 40 < 80 threshold
      });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const emitted = [];
      await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
        invCtx: { contextSize: 100 },
        emit: (c, p) => emitted.push({ c, p }),
      });
      expect(emitted.some((e) => e.c === 'agent-compacted')).toBe(false);
    });

    // Every step re-sends the whole conversation, so the cumulative total passes
    // any context window while the conversation is still small. Compacting on
    // that number throws away history the model still needs, mid-task.
    test('a long run of small prompts never compacts, however large the cumulative total grows', async () => {
      const llm = makeLlm();
      for (let i = 0; i < 8; i++) {
        llm.chatCompletion.mockResolvedValueOnce({
          content: '{"tool":"browser.read_tab","args":{}}', toolCalls: null,
          usage: { prompt_tokens: 30, completion_tokens: 10 }, // cumulative passes 80 at step 2, prompt never does
        });
      }
      llm.chatCompletion.mockResolvedValue({ content: '{"tool":"agent.done","args":{"summary":"done"}}', toolCalls: null, usage: { prompt_tokens: 30, completion_tokens: 5 } });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const emitted = [];
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
        invCtx: { contextSize: 100 }, // threshold 80; cumulative reaches 320+, each prompt stays 30
        emit: (c, p) => emitted.push({ c, p }),
      });
      expect(res.ok).toBe(true);
      expect(emitted.some((e) => e.c === 'agent-compacted')).toBe(false);
      // The cumulative counter still reports real spend — it just does not gate compaction.
      const last = emitted.filter((e) => e.c === 'agent-tokens').pop();
      expect(last.p.tokensUsed).toBeGreaterThan(100);
    });

    // Step replies come from `prompts` in order; a compaction recap request is
    // answered separately so the step sequence does not depend on when it fires.
    function compactionLlm(prompts, { recap = 'Recap of earlier work.' } = {}) {
      const llm = makeLlm();
      let i = 0;
      llm.chatCompletion.mockImplementation(async (msgs) => {
        if (/^Summarize the following agent turns/.test(String(msgs[0].content))) {
          return { content: recap, toolCalls: null, usage: { prompt_tokens: 20, completion_tokens: 5 } };
        }
        const p = prompts[i++];
        if (p === undefined) return { content: '{"tool":"agent.done","args":{"summary":"final"}}', toolCalls: null, usage: { prompt_tokens: 10, completion_tokens: 5 } };
        return { content: '{"tool":"browser.read_tab","args":{}}', toolCalls: null, usage: { prompt_tokens: p, completion_tokens: 10 } };
      });
      return llm;
    }

    async function runCompaction(llm, invCtx) {
      const emitted = [];
      const res = await new AgentRuntime({ registry: registerBasics(), llm }).run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx, maxSteps: 30,
        emit: (c, p) => emitted.push({ c, p }),
      });
      return { res, compactions: emitted.filter((e) => e.c === 'agent-compacted') };
    }

    test('compaction.auto false never compacts, even past the threshold', async () => {
      const { res, compactions } = await runCompaction(compactionLlm([40, 60, 85, 90, 95]), { contextSize: 100, compaction: { auto: false } });
      expect(res.ok).toBe(true);
      expect(compactions).toHaveLength(0);
    });

    test('compaction.threshold moves the trigger point', async () => {
      // 55 of 100 is under the default 0.8 but over a 0.5 threshold.
      const low = await runCompaction(compactionLlm([40, 55, 55]), { contextSize: 100, compaction: { threshold: 0.5 } });
      expect(low.compactions).toHaveLength(1);
      const dflt = await runCompaction(compactionLlm([40, 55, 55]), { contextSize: 100 });
      expect(dflt.compactions).toHaveLength(0);
    });

    test('an out-of-range threshold falls back to the default instead of compacting every step', async () => {
      const { compactions } = await runCompaction(compactionLlm([40, 55, 55]), { contextSize: 100, compaction: { threshold: 0 } });
      expect(compactions).toHaveLength(0);
    });

    test('a long run compacts again once the conversation has regrown, but not on consecutive steps', async () => {
      const { res, compactions } = await runCompaction(compactionLlm(new Array(12).fill(90)), { contextSize: 100 });
      expect(res.ok).toBe(true);
      expect(compactions.length).toBeGreaterThanOrEqual(2);
      for (let k = 1; k < compactions.length; k++) {
        expect(compactions[k].p.step - compactions[k - 1].p.step).toBeGreaterThanOrEqual(3);
      }
    });

    test('an empty recap is not reported as a compaction', async () => {
      const { compactions } = await runCompaction(compactionLlm([40, 60, 85], { recap: '' }), { contextSize: 100 });
      expect(compactions).toHaveLength(0);
    });

    // Every tool message must answer a tool_call of the assistant message that
    // opens its group, and every JSON-mode "Results:" turn must follow the
    // assistant action it reports on. A tail cut between them sends the model
    // results for calls it can no longer see (native APIs reject the request).
    function assertWellFormed(msgs) {
      msgs.forEach((m, i) => {
        if (m.role === 'tool') {
          let j = i - 1;
          while (j >= 0 && msgs[j].role === 'tool') j--;
          expect(msgs[j] && msgs[j].role).toBe('assistant');
          expect((msgs[j].tool_calls || []).map((c) => c.id)).toContain(m.tool_call_id);
        }
        if (m.role === 'user' && /^Results:/.test(String(m.content))) {
          expect(msgs[i - 1].role).toBe('assistant');
          expect(String(msgs[i - 1].content)).toMatch(/"tool":"browser\.read_tab"/);
        }
      });
      // The recap never sits between two turns of its own role (strict templates reject that).
      const c = msgs.findIndex((m) => /^\[Compacted/.test(String(m.content)));
      expect(c).toBeGreaterThan(0);
      if (msgs[c - 1].role === 'system') expect(msgs[c].role).toBe('user');
      else expect(msgs[c - 1].role).not.toBe(msgs[c].role);
      if (msgs[c + 1] && msgs[c + 1].role !== 'tool') expect(msgs[c + 1].role).not.toBe(msgs[c].role);
    }

    function parallelReadLlm(mode, prompts) {
      const llm = makeLlm();
      const sent = [];
      let i = 0;
      llm.chatCompletion.mockImplementation(async (msgs) => {
        if (/^Summarize the following agent turns/.test(String(msgs[0].content))) {
          return { content: 'Recap: both tabs were read.', toolCalls: null, usage: { prompt_tokens: 20, completion_tokens: 5 } };
        }
        sent.push(msgs.map((m) => ({ ...m })));
        const p = prompts[i++];
        if (p === undefined) {
          return mode === 'tools'
            ? { content: '', toolCalls: [{ id: 'done', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"final"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
            : { content: '{"tool":"agent.done","args":{"summary":"final"}}', toolCalls: null, usage: { prompt_tokens: 10, completion_tokens: 5 } };
        }
        if (mode === 'tools') {
          return {
            content: '',
            toolCalls: ['a', 'b'].map((tab) => ({ id: `s${i}${tab}`, type: 'function', function: { name: 'browser.read_tab', arguments: JSON.stringify({ spaceId: tab }) } })),
            usage: { prompt_tokens: p, completion_tokens: 10 },
          };
        }
        return { content: '[{"tool":"browser.read_tab","args":{"spaceId":"a"}},{"tool":"browser.read_tab","args":{"spaceId":"b"}}]', toolCalls: null, usage: { prompt_tokens: p, completion_tokens: 10 } };
      });
      return { llm, sent };
    }

    const TASK = { role: 'user', content: 'Task: compare the two open tabs' };

    test('native mode: parallel tool results are never split from their assistant turn, and the task survives', async () => {
      const { llm, sent } = parallelReadLlm('tools', [40, 85, 50]);
      const emitted = [];
      const res = await new AgentRuntime({ registry: registerBasics(), llm }).run({
        task: 't', messages: [{ role: 'system', content: 's' }, { ...TASK }], toolCtx: {},
        invCtx: { contextSize: 100, forceMode: 'tools' }, emit: (c, p) => emitted.push({ c, p }),
      });
      expect(res.ok).toBe(true);
      expect(emitted.filter((e) => e.c === 'agent-compacted')).toHaveLength(1);
      const after = sent[2];
      expect(after.some((m) => /^\[Compacted/.test(String(m.content)))).toBe(true);
      assertWellFormed(after);
      expect(after[0].role).toBe('system');
      expect(after.filter((m) => m.content === TASK.content)).toHaveLength(1);
    });

    test('JSON mode: a Results turn is never split from its action, and the task survives', async () => {
      const { llm, sent } = parallelReadLlm('json', [40, 85, 50]);
      const emitted = [];
      const res = await new AgentRuntime({ registry: registerBasics(), llm }).run({
        task: 't', messages: [{ role: 'system', content: 's' }, { ...TASK }], toolCtx: {},
        invCtx: { contextSize: 100, forceMode: 'json' }, emit: (c, p) => emitted.push({ c, p }),
        interceptors: { shouldReflect: async () => ({ prompt: 'Reflect briefly, then act.' }) },
      });
      expect(res.ok).toBe(true);
      expect(emitted.filter((e) => e.c === 'agent-compacted')).toHaveLength(1);
      const after = sent[2];
      expect(after.some((m) => /^\[Compacted/.test(String(m.content)))).toBe(true);
      assertWellFormed(after);
      expect(after.filter((m) => m.content === TASK.content)).toHaveLength(1);
    });

    test('a run whose task already sits in the kept tail keeps it once, in place', async () => {
      const { llm, sent } = parallelReadLlm('tools', [85, 50]);
      const history = [];
      for (let k = 0; k < 3; k++) history.push({ role: 'user', content: `earlier question ${k}` }, { role: 'assistant', content: `earlier answer ${k}` });
      const res = await new AgentRuntime({ registry: registerBasics(), llm }).run({
        task: 't', messages: [{ role: 'system', content: 's' }, ...history, { ...TASK }], toolCtx: {},
        invCtx: { contextSize: 100, forceMode: 'tools' },
      });
      expect(res.ok).toBe(true);
      const after = sent[1];
      expect(after.some((m) => /^\[Compacted/.test(String(m.content)))).toBe(true);
      assertWellFormed(after);
      expect(after.filter((m) => m.content === TASK.content)).toHaveLength(1);
      expect(after.some((m) => m.content === 'earlier question 0')).toBe(false);
    });

    test('does not compact when no contextSize is configured', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '{"tool":"browser.read_tab","args":{}}', toolCalls: null, usage: { prompt_tokens: 999, completion_tokens: 999 } })
        .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"done"}}', toolCalls: null, usage: { prompt_tokens: 10, completion_tokens: 5 } });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const emitted = [];
      await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
        invCtx: {}, // no contextSize -> compaction disabled
        emit: (c, p) => emitted.push({ c, p }),
      });
      expect(emitted.some((e) => e.c === 'agent-compacted')).toBe(false);
    });
  });

  // A reasoning model streams chain-of-thought into reasoning_content, which
  // spends the same max_tokens budget as the answer. The step that has to write
  // the final summary is where it runs out — and one empty reply used to kill a
  // run that had already gathered everything it needed.
  describe('reasoning budget exhaustion', () => {
    test('an empty reply that spent its budget thinking is retried with more room', async () => {
      const llm = makeLlm();
      llm.chatCompletion
        .mockResolvedValueOnce({ content: '', toolCalls: null, reasoning: 'thinking about the answer', finishReason: 'length' })
        .mockResolvedValueOnce({ content: '{"tool":"agent.done","args":{"summary":"the funniest posts"}}', toolCalls: null });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const emitted = [];
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
        invCtx: { endpoint: 'x', modelName: 'm', maxTokens: 4096 },
        emit: (c, p) => emitted.push({ c, p }),
      });
      expect(res).toMatchObject({ ok: true, summary: 'the funniest posts' });
      expect(emitted.some((e) => e.c === 'step-parse-retry' && e.p.reason === 'reasoning_budget_exhausted')).toBe(true);
      // The retry must actually get a bigger ceiling, or it just runs out again.
      expect(llm.chatCompletion.mock.calls[1][1].maxTokens).toBeGreaterThan(4096);
    });

    test('a second exhausted reply fails with a reason naming the budget, not a bare empty_response', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValue({ content: '', toolCalls: null, reasoning: 'still thinking', finishReason: 'length' });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: { endpoint: 'x', modelName: 'm' },
      });
      expect(res).toMatchObject({ ok: false, reason: 'reasoning_budget_exhausted' });
      expect(llm.chatCompletion).toHaveBeenCalledTimes(2); // one retry, then stop — never an unbounded loop
    });

    test('an empty reply with no reasoning and no length finish still fails as empty_response immediately', async () => {
      const llm = makeLlm();
      llm.chatCompletion.mockResolvedValue({ content: '', toolCalls: null, reasoning: '', finishReason: 'stop' });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm });
      const res = await runtime.run({
        task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: { endpoint: 'x', modelName: 'm' },
      });
      expect(res).toMatchObject({ ok: false, reason: 'empty_response' });
      expect(llm.chatCompletion).toHaveBeenCalledTimes(1); // a genuinely silent server buys no retry
    });
  });
  describe('run signal (stop/abort)', () => {
    function hangingLlm(seen) {
      const mockLlm = makeLlm();
      mockLlm.chatCompletion.mockImplementation((_msgs, opts = {}) => {
        seen.push(opts);
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      });
      return mockLlm;
    }

    test('aborting the run signal aborts the in-flight chatCompletion and resolves stopped', async () => {
      const seen = [];
      const runtime = new AgentRuntime({ registry: registerBasics(), llm: hangingLlm(seen) });
      const ctrl = new AbortController();
      const p = runtime.run({ task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {}, invCtx: { signal: ctrl.signal } });
      await Promise.resolve();
      expect(seen).toHaveLength(1);
      expect(seen[0].signal).toBeDefined();
      expect(seen[0].signal.aborted).toBe(false);
      ctrl.abort();
      await expect(p).resolves.toEqual({ ok: false, reason: 'stopped' });
      expect(seen[0].signal.aborted).toBe(true);
    });

    test('an LLM error that is not an abort still propagates', async () => {
      const mockLlm = makeLlm();
      mockLlm.chatCompletion.mockRejectedValue(new Error('HTTP 500'));
      const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
      const ctrl = new AbortController();
      await expect(runtime.run({ task: 't', messages: [], toolCtx: {}, invCtx: { signal: ctrl.signal } }))
        .rejects.toThrow('HTTP 500');
    });

    test('an already-aborted signal stops before any LLM call', async () => {
      const mockLlm = makeLlm();
      const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
      const ctrl = new AbortController(); ctrl.abort();
      await expect(runtime.run({ task: 't', messages: [], toolCtx: {}, invCtx: { signal: ctrl.signal } }))
        .resolves.toEqual({ ok: false, reason: 'stopped' });
      expect(mockLlm.chatCompletion).not.toHaveBeenCalled();
    });

    test('the LLM signal also carries a request timeout (a signal disables the client timeout)', async () => {
      const seen = [];
      const runtime = new AgentRuntime({ registry: registerBasics(), llm: hangingLlm(seen) });
      const p = runtime.run({ task: 't', messages: [], toolCtx: {}, invCtx: { signal: new AbortController().signal, llmTimeoutMs: 20 } });
      await expect(p).rejects.toThrow('aborted');
      expect(seen[0].signal.aborted).toBe(true);
      expect(seen[0].signal.reason && seen[0].signal.reason.name).toBe('TimeoutError');
    });

    test('without a run signal, opts carry no signal (client keeps its own timeout)', async () => {
      const mockLlm = makeLlm();
      mockLlm.chatCompletion.mockResolvedValueOnce({
        content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"ok"}' } }],
      });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
      await runtime.run({ task: 't', messages: [], toolCtx: {}, invCtx: {} });
      expect(mockLlm.chatCompletion.mock.calls[0][1]).not.toHaveProperty('signal');
    });

    test('abort during a tool call resolves stopped without another LLM step', async () => {
      const r = registerBasics();
      const ctrl = new AbortController();
      r.register({
        name: 'browser.read_tab', description: 'read', parameters: { type: 'object', properties: {}, required: [] },
        handler: () => { ctrl.abort(); return new Promise(() => {}); },
      });
      const mockLlm = makeLlm();
      mockLlm.chatCompletion.mockResolvedValueOnce({
        content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'browser.read_tab', arguments: '{}' } }],
      });
      const runtime = new AgentRuntime({ registry: r, llm: mockLlm });
      const emitted = [];
      const res = await runtime.run({
        task: 't', messages: [], toolCtx: {}, invCtx: { signal: ctrl.signal, toolTimeoutMs: 60000 },
        emit: (c, pl) => emitted.push({ c, pl }),
      });
      expect(res).toEqual({ ok: false, reason: 'stopped' });
      const acted = emitted.find((e) => e.c === 'step-acted');
      expect(acted.pl.results[0].result).toEqual({ ok: false, error: 'aborted' });
      expect(mockLlm.chatCompletion).toHaveBeenCalledTimes(1);
    });

    test('a stopped run does not fall back to a non-streaming request', async () => {
      const ctrl = new AbortController();
      const mockLlm = makeLlm();
      mockLlm.chatCompletionStream = jest.fn(() => ({
        [Symbol.asyncIterator]() { return { next: () => { ctrl.abort(); return Promise.reject(new Error('stream aborted')); } }; },
      }));
      const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
      const opts = runtime._withSignal({ temperature: 0 }, { signal: ctrl.signal });
      await expect(runtime._chatStreamingOrPlain([{ role: 'user', content: 'x' }], opts, {})).rejects.toThrow('stream aborted');
      expect(mockLlm.chatCompletion).not.toHaveBeenCalled();
    });
  });

  describe('toolFilter', () => {
    test('only filtered tools are offered and a filtered-out call yields tool_not_available without invoking', async () => {
      const r = registerBasics();
      const clickHandler = jest.fn(async () => ({ ok: true }));
      r.register({
        name: 'browser.click', description: 'click', sideEffect: true,
        parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
        handler: clickHandler,
      });
      const mockLlm = makeLlm();
      mockLlm.chatCompletion
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'browser.click', arguments: '{"selector":"#x"}' } },
            { id: 'c2', type: 'function', function: { name: 'browser.read_tab', arguments: '{}' } },
          ],
        })
        .mockResolvedValueOnce({
          content: '', toolCalls: [{ id: 'c3', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"ok"}' } }],
        });
      const runtime = new AgentRuntime({ registry: r, llm: mockLlm });
      const beforeInvoke = jest.fn(async ({ calls }) => ({ allowed: calls, denied: [] }));
      const emitted = [];
      const res = await runtime.run({
        task: 't', messages: [], toolCtx: {},
        invCtx: { toolFilter: (name) => name !== 'browser.click' },
        emit: (c, pl) => emitted.push({ c, pl }),
        interceptors: { beforeInvoke },
      });
      expect(res).toMatchObject({ ok: true, summary: 'ok' });
      const offered = mockLlm.chatCompletion.mock.calls[0][1].tools.map((t) => t.function.name);
      expect(offered).not.toContain('browser.click');
      expect(offered).toEqual(expect.arrayContaining(['browser.read_tab', 'agent.done']));
      expect(clickHandler).not.toHaveBeenCalled();
      expect(beforeInvoke.mock.calls[0][0].calls.map((c) => c.name)).toEqual(['browser.read_tab']);
      const acted = emitted.find((e) => e.c === 'step-acted');
      expect(acted.pl.results[0]).toMatchObject({ id: 'c1', result: { ok: false, error: 'tool_not_available', tool: 'browser.click' } });
      expect(acted.pl.results[1].result).toMatchObject({ ok: true });
    });

    test('an unregistered tool name under a filter is tool_not_available, not unknown_tool', async () => {
      const mockLlm = makeLlm();
      mockLlm.chatCompletion
        .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'fs.write', arguments: '{}' } }] })
        .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c2', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"ok"}' } }] });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
      const emitted = [];
      await runtime.run({ task: 't', messages: [], toolCtx: {}, invCtx: { toolFilter: () => true }, emit: (c, pl) => emitted.push({ c, pl }) });
      expect(emitted.find((e) => e.c === 'step-acted').pl.results[0].result.error).toBe('tool_not_available');
    });
  });

  describe('skill tool narrowing (agent.use_skill)', () => {
    const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

    function skillRegistry(skillTools) {
      const r = registerBasics();
      const handlers = { read: jest.fn(async () => ({ ok: true, text: 'file' })), write: jest.fn(async () => ({ ok: true })) };
      r.register({ name: 'fs.read', description: 'read', parameters: { type: 'object', properties: {} }, handler: handlers.read });
      r.register({ name: 'fs.write', description: 'write', parameters: { type: 'object', properties: {} }, handler: handlers.write });
      r.register({
        name: 'agent.use_skill', description: 'skill', parameters: { type: 'object', properties: { name: { type: 'string' } } },
        handler: async () => ({ ok: true, skill: 'readonly', instructions: 'read only', tools: skillTools }),
      });
      return { r, handlers };
    }

    async function runSkill(skillTools, invCtx = {}) {
      const { r, handlers } = skillRegistry(skillTools);
      const mockLlm = makeLlm();
      mockLlm.chatCompletion
        .mockResolvedValueOnce({ content: '', toolCalls: [call('c1', 'agent.use_skill', { name: 'readonly' })] })
        .mockResolvedValueOnce({ content: '', toolCalls: [call('c2', 'fs.write'), call('c3', 'fs.read')] })
        .mockResolvedValueOnce({ content: '', toolCalls: [call('c4', 'agent.done', { summary: 'finished' })] });
      const runtime = new AgentRuntime({ registry: r, llm: mockLlm });
      const emitted = [];
      const res = await runtime.run({ task: 't', messages: [], toolCtx: {}, invCtx: { endpoint: 'e', modelName: 'm', ...invCtx }, maxSteps: 3, emit: (c, pl) => emitted.push({ c, pl }) });
      const acted = emitted.filter((e) => e.c === 'step-acted').map((e) => e.pl.results);
      const offered = (n) => (mockLlm.chatCompletion.mock.calls[n][1].tools || []).map((t) => t.function.name).sort();
      return { res, acted, handlers, offered };
    }

    test('after use_skill with tools [fs.read], fs.write is tool_not_available and leaves the tool list', async () => {
      const { acted, handlers, offered } = await runSkill(['fs.read']);
      expect(acted[1][0]).toMatchObject({ id: 'c2', result: { ok: false, error: 'tool_not_available', tool: 'fs.write' } });
      expect(acted[1][1].result).toMatchObject({ ok: true });
      expect(handlers.write).not.toHaveBeenCalled();
      expect(handlers.read).toHaveBeenCalledTimes(1);
      expect(offered(0)).toContain('fs.write');
      expect(offered(1)).toEqual(['fs.read']);
    });

    test('a skill never widens an existing filter', async () => {
      const { acted, handlers } = await runSkill(['fs.read', 'fs.write', 'agent.done'], { toolFilter: (name) => name !== 'fs.read' });
      expect(acted[1][1].result).toMatchObject({ ok: false, error: 'tool_not_available', tool: 'fs.read' });
      expect(handlers.read).not.toHaveBeenCalled();
      expect(handlers.write).toHaveBeenCalledTimes(1);
    });

    test('a skill with no tool restriction (tools null) leaves every tool available', async () => {
      const { res, acted, handlers } = await runSkill(null);
      expect(acted[1].map((x) => x.result.ok)).toEqual([true, true]);
      expect(handlers.write).toHaveBeenCalledTimes(1);
      expect(res).toMatchObject({ ok: true, summary: 'finished' });
    });
  });

  describe('generic awaiting terminal', () => {
    test('a tool returning awaiting:<kind> ends the run with that kind and its payload', async () => {
      const r = registerBasics();
      r.register({
        name: 'agent.exit_plan', description: 'exit plan', parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => ({ ok: true, awaiting: 'plan_approval', plan: ['a', 'b'] }),
      });
      const mockLlm = makeLlm();
      mockLlm.chatCompletion.mockResolvedValueOnce({
        content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'agent.exit_plan', arguments: '{}' } }],
      });
      const runtime = new AgentRuntime({ registry: r, llm: mockLlm });
      const res = await runtime.run({ task: 't', messages: [], toolCtx: {}, invCtx: {} });
      expect(res).toEqual({
        ok: false, reason: 'awaiting_plan_approval', awaiting: 'plan_approval',
        result: { ok: true, awaiting: 'plan_approval', plan: ['a', 'b'] }, mode: 'tools',
      });
      expect(mockLlm.chatCompletion).toHaveBeenCalledTimes(1);
    });

    test('a falsy awaiting value does not end the run', async () => {
      const r = registerBasics();
      r.register({
        name: 'browser.read_tab', description: 'read', parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => ({ ok: true, awaiting: '' }),
      });
      const mockLlm = makeLlm();
      mockLlm.chatCompletion
        .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'browser.read_tab', arguments: '{}' } }] })
        .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'c2', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"fine"}' } }] });
      const runtime = new AgentRuntime({ registry: r, llm: mockLlm });
      await expect(runtime.run({ task: 't', messages: [], toolCtx: {}, invCtx: {} })).resolves.toMatchObject({ ok: true, summary: 'fine' });
    });
  });

  test('agent-tokens carries contextTokens = the latest prompt size', async () => {
    const mockLlm = makeLlm();
    mockLlm.chatCompletion
      .mockResolvedValueOnce({
        content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'browser.read_tab', arguments: '{}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      })
      .mockResolvedValueOnce({
        content: '', toolCalls: [{ id: 'c2', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"ok"}' } }],
        usage: { prompt_tokens: 250, completion_tokens: 5 },
      });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
    const emitted = [];
    await runtime.run({ task: 't', messages: [], toolCtx: {}, invCtx: { contextSize: 4096 }, emit: (c, pl) => emitted.push({ c, pl }) });
    const tok = emitted.filter((e) => e.c === 'agent-tokens').map((e) => e.pl);
    expect(tok).toEqual([
      { tokensUsed: 110, contextSize: 4096, contextTokens: 100, step: 0 },
      { tokensUsed: 365, contextSize: 4096, contextTokens: 250, step: 1 },
    ]);
  });
});

describe('AgentRuntime streamed steps', () => {
  // A chatCompletionStream boundary: yields text deltas, then the terminal frame.
  function mockStream(chunks, final) {
    return async function* streamStep() {
      for (const c of chunks) yield c;
      yield { __final: true, ...final };
    };
  }
  const doneCall = (id, summary) => [{ id, type: 'function', function: { name: 'agent.done', arguments: JSON.stringify({ summary }) } }];

  test('streams prose as assistant-chunk and runs the assembled tool calls from the terminal frame', async () => {
    const mockLlm = makeLlm();
    mockLlm.chatCompletionStream = jest.fn()
      .mockImplementationOnce(mockStream(['Reading ', 'the tab.'], {
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'browser.read_tab', arguments: '{"spaceId":"s1"}' } }],
        usage: { prompt_tokens: 50, completion_tokens: 6 }, finishReason: 'tool_calls',
      }))
      .mockImplementationOnce(mockStream(['All done.'], { toolCalls: doneCall('c2', 'read it'), usage: { prompt_tokens: 80, completion_tokens: 4 } }));
    const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
    const emitted = [];
    const res = await runtime.run({
      task: 't', messages: [{ role: 'system', content: 's' }], toolCtx: {},
      invCtx: { endpoint: 'e', modelName: 'm', forceMode: 'tools', streamSteps: true, taskId: 'T1' },
      emit: (c, pl) => emitted.push({ c, pl }),
    });
    expect(res).toMatchObject({ ok: true, summary: 'read it', mode: 'tools' });
    expect(mockLlm.chatCompletion).not.toHaveBeenCalled();
    expect(mockLlm.chatCompletionStream.mock.calls[0][1].tools.map((t) => t.function.name)).toContain('browser.read_tab');
    const acted = emitted.filter((e) => e.c === 'step-acted');
    expect(JSON.stringify(acted)).toContain('T-s1');
    const chunks = emitted.filter((e) => e.c === 'assistant-chunk').map((e) => e.pl);
    expect(chunks.map((p) => p.text)).toEqual(['Reading ', 'the tab.', '\n\nAll done.']);
    expect(chunks[0]).toMatchObject({ taskId: 'T1', step: 0, streamed: true });
    expect(emitted.filter((e) => e.c === 'agent-tokens').map((e) => e.pl.contextTokens)).toEqual([50, 80]);
  });

  test('json mode streams without surfacing the raw JSON as answer text', async () => {
    const mockLlm = makeLlm();
    mockLlm.chatCompletionStream = jest.fn(mockStream(['{"tool":"agent.done",', '"args":{"summary":"j"}}'], {}));
    const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
    const emitted = [];
    const res = await runtime.run({
      task: 't', messages: [], toolCtx: {}, invCtx: { forceMode: 'json', streamSteps: true },
      emit: (c, pl) => emitted.push({ c, pl }),
    });
    expect(res).toMatchObject({ ok: true, summary: 'j', mode: 'json' });
    expect(emitted.filter((e) => e.c === 'assistant-chunk')).toEqual([]);
  });

  test('a stream that throws falls back to one non-streaming request for that step', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mockLlm = makeLlm();
      mockLlm.chatCompletionStream = jest.fn(async function* broken() {
        yield 'part';
        throw new Error('socket hang up');
      });
      mockLlm.chatCompletion.mockResolvedValueOnce({ content: '', toolCalls: doneCall('c1', 'recovered') });
      const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
      const emitted = [];
      const res = await runtime.run({
        task: 't', messages: [{ role: 'user', content: 'go' }], toolCtx: {}, invCtx: { forceMode: 'tools', streamSteps: true },
        emit: (c, pl) => emitted.push({ c, pl }),
      });
      expect(res).toMatchObject({ ok: true, summary: 'recovered' });
      expect(mockLlm.chatCompletion).toHaveBeenCalledTimes(1);
      expect(mockLlm.chatCompletion.mock.calls[0][1].tools).toBeDefined();
      expect(emitted.find((e) => e.c === 'step-stream-fallback').pl).toEqual({ step: 0, error: 'socket hang up', partialChars: 4 });
      expect(errSpy).toHaveBeenCalled();
    } finally { errSpy.mockRestore(); }
  });

  test('a stream aborted by stopping the run does not fall back', async () => {
    const mockLlm = makeLlm();
    const ctrl = new AbortController();
    mockLlm.chatCompletionStream = jest.fn(async function* aborted() {
      ctrl.abort();
      throw new Error('aborted');
    });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
    const res = await runtime.run({
      task: 't', messages: [], toolCtx: {}, invCtx: { forceMode: 'tools', streamSteps: true, signal: ctrl.signal },
    }).catch((err) => ({ thrown: err }));
    expect(mockLlm.chatCompletion).not.toHaveBeenCalled();
    expect(res.ok === true).toBe(false);
  });

  test('streamSteps off keeps the plain request even when the client can stream', async () => {
    const mockLlm = makeLlm();
    mockLlm.chatCompletionStream = jest.fn();
    mockLlm.chatCompletion.mockResolvedValueOnce({ content: '', toolCalls: doneCall('c1', 'plain') });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
    await expect(runtime.run({ task: 't', messages: [], toolCtx: {}, invCtx: { forceMode: 'tools' } })).resolves.toMatchObject({ summary: 'plain' });
    expect(mockLlm.chatCompletionStream).not.toHaveBeenCalled();
  });

  test('profile temperature and systemStyle merge reach the request without mutating the run messages', async () => {
    const mockLlm = makeLlm();
    mockLlm.chatCompletion.mockResolvedValueOnce({ content: '', toolCalls: doneCall('c1', 'ok') });
    const runtime = new AgentRuntime({ registry: registerBasics(), llm: mockLlm });
    const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'task' }];
    await runtime.run({ task: 't', messages, toolCtx: {}, invCtx: { forceMode: 'tools', systemStyle: 'merge', temperature: 0.6 } });
    const [sent, opts] = mockLlm.chatCompletion.mock.calls[0];
    expect(sent[0]).toEqual({ role: 'user', content: 'rules\n\ntask' });
    expect(sent.some((m) => m.role === 'system')).toBe(false);
    expect(opts.temperature).toBe(0.6);
    expect(messages[0]).toEqual({ role: 'system', content: 'rules' });
  });
});

describe('shapeMessages', () => {
  const msgs = [{ role: 'system', content: 'A' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'B' }];

  test('system style (or none) returns the same array', () => {
    expect(shapeMessages(msgs, { systemStyle: 'system' })).toBe(msgs);
    expect(shapeMessages(msgs, null)).toBe(msgs);
  });

  test('merge folds every system message into the first user turn', () => {
    const out = shapeMessages([...msgs, { role: 'system', content: 'C' }], { systemStyle: 'merge' });
    expect(out).toEqual([{ role: 'assistant', content: 'x' }, { role: 'user', content: 'A\n\nC\n\nB' }]);
  });

  test('merge with multimodal content prepends a text part; no user turn adds one', () => {
    const parts = [{ type: 'image_url', image_url: { url: 'data:x' } }];
    expect(shapeMessages([{ role: 'system', content: 'A' }, { role: 'user', content: parts }], { systemStyle: 'merge' })[0].content)
      .toEqual([{ type: 'text', text: 'A' }, ...parts]);
    expect(shapeMessages([{ role: 'system', content: 'A' }], { systemStyle: 'merge' })).toEqual([{ role: 'user', content: 'A' }]);
  });
});
