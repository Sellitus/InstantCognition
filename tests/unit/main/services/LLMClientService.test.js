// LLMClientService tests — inject a fake fetch + LLMService stub.

jest.mock('../../../../main/services/LLMService', () => ({
  getEndpoint: jest.fn(() => 'http://127.0.0.1:8421'),
  getStatus: jest.fn(() => ({ isRemote: false })),
  _remote: null,
}));

const svc = require('../../../../main/services/LLMClientService');
const llmMock = require('../../../../main/services/LLMService');

function fakeOk(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  llmMock.getEndpoint.mockReturnValue('http://127.0.0.1:8421');
  llmMock.getStatus.mockReturnValue({ isRemote: false });
  llmMock._remote = null;
  // svc is a shared singleton — restore the default backing service + a
  // working fetch so a swap in one test never leaks into the next.
  svc._setLLMService(llmMock);
  svc.bindConfig(null);
  // Reset the (endpoint,model) → "rejects temperature" cache so reactive-fix
  // decisions don't leak across tests.
  svc._modelsRejectingTemperature.clear();
  svc._modelsRejectingTools.clear();
});

describe('LLMClientService', () => {
  test('chatCompletion posts to /v1/chat/completions and returns content', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeOk({
      choices: [{ message: { role: 'assistant', content: 'hello world' } }],
    }));
    svc._setFetch(fetchMock);
    const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('hello world');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8421/v1/chat/completions');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.stream).toBe(false);
  });

  // SGLang/vLLM put chain-of-thought in message.reasoning_content, and those
  // tokens spend the same max_tokens budget as content. Without both fields the
  // agent loop cannot tell "ran out of budget thinking" from "server said nothing".
  test('chatCompletion surfaces reasoning_content and finish_reason alongside empty content', async () => {
    svc._setFetch(jest.fn().mockResolvedValue(fakeOk({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'let me think…' }, finish_reason: 'length' }],
    })));
    const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('');
    expect(res.reasoning).toBe('let me think…');
    expect(res.finishReason).toBe('length');
  });

  test('chatCompletion reports empty reasoning and finishReason when the server sends neither', async () => {
    svc._setFetch(jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'plain' } }] })));
    const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(res.reasoning).toBe('');
    expect(res.finishReason).toBe('');
  });

  test('chatCompletion throws when no endpoint', async () => {
    llmMock.getEndpoint.mockReturnValue(null);
    svc._setFetch(jest.fn());
    await expect(svc.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow(/endpoint/i);
  });

  test('chatCompletion throws on non-ok response', async () => {
    svc._setFetch(jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(svc.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow(/500/);
  });

  test('chatCompletion rejects empty messages', async () => {
    svc._setFetch(jest.fn());
    await expect(svc.chatCompletion([])).rejects.toThrow(/non-empty/);
  });

  test('listModels parses {data: [...]}', async () => {
    svc._setFetch(jest.fn().mockResolvedValue(fakeOk({ data: [{ id: 'a' }, { id: 'b' }] })));
    const models = await svc.listModels();
    expect(models).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  test('request to the configured remote target carries its Authorization header', async () => {
    llmMock.getStatus.mockReturnValue({ isRemote: true });
    llmMock._remote = { apiKey: 'sk-test', endpoint: 'https://api.example.com' };
    // The resolved request URL must be the remote itself for the key to attach — target-scoped, not status-inferred.
    llmMock.getEndpoint.mockReturnValue('https://api.example.com');
    const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'ok' } }] }));
    svc._setFetch(fetchMock);
    await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  // Dual state — a local engine running AND a remote endpoint configured at the
  // same time (reachable: Use Remote → switch mode to Local → Start; nothing in
  // llm:start clears the persisted remote). Traffic must not silently leave for
  // the paid endpoint, and draft/verify routing needs explicit targeting.
  describe('dual state — local engine running + remote configured', () => {
    function setDualState() {
      llmMock.getEndpoint.mockReturnValue('http://127.0.0.1:8421'); // live proc wins over _remote in LLMManager (item B)
      llmMock.getStatus.mockReturnValue({ isRemote: false, status: 'running', model: '/models/local.gguf' });
      llmMock._remote = { endpoint: 'https://api.example.com/v1/', apiKey: 'sk-test', model: 'big-model' }; // trailing /v1 as stored pre-normalization in older configs
    }

    test('default chatCompletion stays on the local engine with no Authorization header and local model id', async () => {
      setDualState();
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'local' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8421/v1/chat/completions');
      const opts = fetchMock.mock.calls[0][1];
      // Leaking the remote key to localhost is a credential-scope bug; leaking big-model's id would make llama-server 404/lookup it on HF.
      expect(opts.headers.Authorization).toBeUndefined();
      expect(JSON.parse(opts.body).model).toBe('/models/local.gguf');
    });

    test("'judge' routeTag targets the remote endpoint with its Bearer key and model, while draft stays local", async () => {
      setDualState();
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'remote' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletionRouted([{ role: 'user', content: 'hi' }], {}, { routeTag: 'judge' });
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
      const remoteOpts = fetchMock.mock.calls[0][1];
      expect(remoteOpts.headers.Authorization).toBe('Bearer sk-test'); // key attaches because the TARGET is the remote, not because status.isRemote (which is false here)
      expect(JSON.parse(remoteOpts.body).model).toBe('big-model');

      await svc.chatCompletionRouted([{ role: 'user', content: 'hi' }], {}, { routeTag: 'draft' });
      const draftUrl = fetchMock.mock.calls[1][0];
      expect(draftUrl).toBe('http://127.0.0.1:8421/v1/chat/completions'); // the whole point of routing — cheap model does drafts, quality endpoint judges
    });

    test("'verify' routeTag behaves identically to 'judge'", async () => {
      setDualState();
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'v' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletionRouted([{ role: 'user', content: 'hi' }], {}, { routeTag: 'verify' });
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions'); // verify/judge share the remote-preferred tag semantics per the docstring above chatCompletionRouted
    });

    test("an explicit options.model wins over the routed target's default model", async () => {
      setDualState();
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'm' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletionRouted([{ role: 'user', content: 'hi' }], { model: 'pinned-model' }, { routeTag: 'judge' });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('pinned-model'); // explicit caller choice is never overridden by target defaults (no double-fallback)
    });

    test("a routed call with a remote apiKey but empty key still targets the remote without an Authorization header", async () => {
      setDualState();
      llmMock._remote = { endpoint: 'https://api.example.com', model: 'big-model' }; // no apiKey field at all — open/self-hosted OpenAI-compatible server, no auth expected
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'open' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletionRouted([{ role: 'user', content: 'hi' }], {}, { routeTag: 'judge' });
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions'); // routing must not silently fall back to local just because auth is absent — that would defeat the feature without telling anyone why it "worked locally"
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });
  });

  // Strict chat templates 400 on back-to-back user turns, which a failed or
  // stopped turn leaves behind; every request goes out alternating.
  test('chatCompletion and chatCompletionStream send alternating roles after an unanswered turn', async () => {
    const gap = [{ role: 'system', content: 's' }, { role: 'user', content: 'failed turn' }, { role: 'user', content: 'retry' }];
    const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'ok' } }] }));
    svc._setFetch(fetchMock);
    await svc.chatCompletion(gap);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    const reader = { read: async () => ({ value: undefined, done: true }) };
    const streamFetch = jest.fn().mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } });
    svc._setFetch(streamFetch);
    for await (const d of svc.chatCompletionStream(gap)) void d;
    expect(JSON.parse(streamFetch.mock.calls[0][1].body).messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(gap).toHaveLength(3);
  });

  test('chatCompletionStream yields parsed deltas from SSE body', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    const encoder = new TextEncoder();
    const chunks = [encoder.encode(sse)];
    let i = 0;
    const reader = {
      read: async () => i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true },
    };
    svc._setFetch(jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    }));
    const out = [];
    for await (const d of svc.chatCompletionStream([{ role: 'user', content: 'hi' }])) {
      out.push(d);
    }
    // Stream yields string content deltas then a terminal __final marker with
    // timing + optional usage so callers can compute live tokens/sec.
    expect(out.slice(0, 2)).toEqual(['Hel', 'lo']);
    const terminal = out[out.length - 1];
    expect(terminal && terminal.__final).toBe(true);
    expect(terminal.charCount).toBe(5);
  });

  test('visionCompletion injects image_url parts into last user message', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'seen' } }] }));
    svc._setFetch(fetchMock);
    await svc.visionCompletion(
      [{ role: 'user', content: 'describe' }],
      ['data:image/png;base64,abc'],
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const last = body.messages[body.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content[0]).toEqual({ type: 'text', text: 'describe' });
    expect(last.content[1].type).toBe('image_url');
    expect(last.content[1].image_url.url).toBe('data:image/png;base64,abc');
  });

  describe('chatCompletionJson', () => {
    test('parses a well-formed JSON response and sets response_format', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({
        choices: [{ message: { content: '{"facts":[{"text":"x","category":"pref"}]}' } }],
      }));
      svc._setFetch(fetchMock);
      const res = await svc.chatCompletionJson([{ role: 'user', content: 'extract' }], { facts: 'array' });
      expect(res.ok).toBe(true);
      expect(res.value).toEqual({ facts: [{ text: 'x', category: 'pref' }] });
      expect(res.retryUsed).toBe(false);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.response_format).toEqual({ type: 'json_object' });
    });

    test('retries once on malformed JSON and succeeds on the nudge', async () => {
      const fetchMock = jest.fn()
        .mockResolvedValueOnce(fakeOk({ choices: [{ message: { content: '```json\n{not json' } }] }))
        .mockResolvedValueOnce(fakeOk({ choices: [{ message: { content: '{"facts":[]}' } }] }));
      svc._setFetch(fetchMock);
      const res = await svc.chatCompletionJson([{ role: 'user', content: 'extract' }], { facts: 'array' });
      expect(res.ok).toBe(true);
      expect(res.value).toEqual({ facts: [] });
      expect(res.retryUsed).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The retry carries a repair-nudge assistant + user message pair.
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(secondBody.messages.length).toBe(3);
      expect(secondBody.messages[2].content).toMatch(/valid JSON/i);
    });

    test('returns a structured parse error after the retry cap is exhausted', async () => {
      // Two malformed responses in a row: retry once, then give up.
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({
        choices: [{ message: { content: 'still not json' } }],
      }));
      svc._setFetch(fetchMock);
      const res = await svc.chatCompletionJson([{ role: 'user', content: 'extract' }], { facts: 'array' });
      expect(res.ok).toBe(false);
      expect(res.stage).toBe('parse');
      expect(res.retryUsed).toBe(true);
      expect(res.raw).toBe('still not json');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('returns a structured schema-mismatch error when a key is missing', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({
        choices: [{ message: { content: '{"facts":"not an array"}' } }],
      }));
      svc._setFetch(fetchMock);
      const res = await svc.chatCompletionJson([{ role: 'user', content: 'extract' }], { facts: 'array' });
      expect(res.ok).toBe(false);
      expect(res.stage).toBe('schema');
      expect(res.error).toMatch(/schema_mismatch/);
      expect(res.error).toMatch(/facts/);
      expect(fetchMock).toHaveBeenCalledTimes(2); // retry once, then fail
    });

    test('passes a schema-valid object and keeps extra keys', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({
        choices: [{ message: { content: '{"facts":[],"extra":"kept"}' } }],
      }));
      svc._setFetch(fetchMock);
      const res = await svc.chatCompletionJson([{ role: 'user', content: 'extract' }], { facts: 'array' });
      expect(res.ok).toBe(true);
      expect(res.value).toEqual({ facts: [], extra: 'kept' });
    });

    test('returns a request-stage error when chatCompletion throws', async () => {
      llmMock.getEndpoint.mockReturnValue(null); // no endpoint -> chatCompletion rejects
      svc._setFetch(jest.fn());
      const res = await svc.chatCompletionJson([{ role: 'user', content: 'extract' }], { facts: 'array' });
      expect(res.ok).toBe(false);
      expect(res.stage).toBe('request');
      expect(res.error).toMatch(/endpoint/i);
    });

    test('passes without a schema (no validation, just parse)', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({
        choices: [{ message: { content: '{"anything":"goes","n":42}' } }],
      }));
      svc._setFetch(fetchMock);
      const res = await svc.chatCompletionJson([{ role: 'user', content: 'extract' }]);
      expect(res.ok).toBe(true);
      expect(res.value).toEqual({ anything: 'goes', n: 42 });
    });
  });

  // _friendlyError translates known server quirks to actionable copy. Without
  // these, users see raw HTTP body strings that mention "Stream(gpu,N)" with
  // no hint of how to recover (switch backend or quantization).
  describe('_friendlyError', () => {
    test('rewrites mlx Stream(gpu,0) crash with Settings → LLM hint', () => {
      const msg = svc._friendlyError(500, 'RuntimeError: Stream(gpu, 0) in current thread');
      expect(msg).toMatch(/Stream\(gpu,0\)/);
      expect(msg).toMatch(/Settings → LLM/);
      expect(msg).toMatch(/llama\.cpp/);
    });

    // Stream(gpu,1) is the mlx-openai-server batch scheduler crash that hits
    // even after switching to --model-type lm (e.g. mxfp8 quants). Must be
    // recognized so the user gets actionable copy, not a raw 500 body.
    test('rewrites mlx Stream(gpu,1) crash (lm batch scheduler bug)', () => {
      const msg = svc._friendlyError(500, 'There is no Stream(gpu, 1) in current thread.');
      expect(msg).toMatch(/Stream\(gpu,1\)/);
      expect(msg).toMatch(/auto-recovery exhausted/i);
      expect(msg).toMatch(/llama\.cpp/);
      expect(msg).toMatch(/mxfp8/);
    });

    test('rewrites 503 loading body with "wait" guidance', () => {
      const msg = svc._friendlyError(503, '{"error":"model loading"}');
      expect(msg).toMatch(/still loading/i);
      expect(msg).toMatch(/Wait/i);
    });

    // vLLM wraps every engine-side crash (commonly: prompt > max_model_len after
    // a long agent run) with this generic body. Without translation users see a
    // reference to a server-side stack trace they cannot read.
    test('rewrites vLLM EngineCore 500 with actionable "+ New conversation" guidance', () => {
      const body = '{"error":{"message":"EngineCore encountered an issue. See stack trace (above) for the root cause.","type":"InternalServerError","param":null,"code":500}}';
      const msg = svc._friendlyError(500, body);
      expect(msg).toMatch(/vLLM EngineCore/);
      expect(msg).toMatch(/\+ New conversation/);
      expect(msg).toMatch(/context window/i);
      expect(msg).not.toMatch(/See stack trace/i);
    });

    test('falls through to generic "LLM request failed" with status when body is unrecognized', () => {
      const msg = svc._friendlyError(500, 'something else broke');
      expect(msg).toMatch(/LLM request failed \(500\)/);
      expect(msg).toMatch(/something else broke/);
    });
  });

  // _isMlxStreamCrash drives the chained-recovery path in chatCompletion.
  // Must match any stream number — both the multimodal handler (gpu,0) and
  // the lm batch scheduler (gpu,1+) raise the same threading error.
  describe('_isMlxStreamCrash', () => {
    test('matches Stream(gpu, 0)', () => {
      expect(svc._isMlxStreamCrash(new Error('Stream(gpu, 0) in current thread'))).toBe(true);
    });
    test('matches Stream(gpu, 1)', () => {
      expect(svc._isMlxStreamCrash(new Error('There is no Stream(gpu, 1) in current thread.'))).toBe(true);
    });
    test('matches Stream(gpu, 7)', () => {
      expect(svc._isMlxStreamCrash(new Error('Stream(gpu,7)'))).toBe(true);
    });
    test('does not match unrelated errors', () => {
      expect(svc._isMlxStreamCrash(new Error('connection refused'))).toBe(false);
      expect(svc._isMlxStreamCrash(null)).toBeFalsy();
    });
  });

  // _defaultTimeout reads settings.llmClientTimeoutMs. Without a bound config,
  // or with a non-finite / non-positive value, it must fall back to the 300s
  // default — a 0 or -1 here would abort every request instantly.
  describe('_defaultTimeout', () => {
    test('returns the 300s default when no config is bound', () => {
      svc.bindConfig(null);
      expect(svc._defaultTimeout()).toBe(300000);
    });

    test('uses a finite positive configured value (floored)', () => {
      svc.bindConfig({ get: (k, fb) => (k === 'settings.llmClientTimeoutMs' ? 4200.9 : fb) });
      expect(svc._defaultTimeout()).toBe(4200);
      svc.bindConfig(null);
    });

    test('ignores a non-positive / non-finite configured value', () => {
      svc.bindConfig({ get: () => 0 });
      expect(svc._defaultTimeout()).toBe(300000);
      svc.bindConfig({ get: () => Number.NaN });
      expect(svc._defaultTimeout()).toBe(300000);
      svc.bindConfig(null);
    });

    test('chatCompletion uses the configured timeout to arm the abort timer', async () => {
      jest.useFakeTimers();
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      svc.bindConfig({ get: (k, fb) => (k === 'settings.llmClientTimeoutMs' ? 1234 : fb) });
      svc._setFetch(jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'x' } }] })));
      const p = svc.chatCompletion([{ role: 'user', content: 'hi' }]);
      jest.runOnlyPendingTimers();
      await p;
      const abortTimer = setTimeoutSpy.mock.calls.find((c) => c[1] === 1234);
      expect(abortTimer).toBeTruthy();
      setTimeoutSpy.mockRestore();
      svc.bindConfig(null);
      jest.useRealTimers();
    });
  });

  // _setLLMService swaps the underlying LLMService stub — exercises the
  // injection seam + the getStatus/getEndpoint optional-chaining guards when
  // the swapped service lacks those methods.
  describe('LLMService injection + status guards', () => {
    afterEach(() => { svc._setLLMService(llmMock); });

    test('_setLLMService replaces the backing service', async () => {
      const alt = { getEndpoint: () => 'http://alt:1', getStatus: () => ({ isRemote: false }) };
      svc._setLLMService(alt);
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'alt' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
      expect(fetchMock.mock.calls[0][0]).toBe('http://alt:1/v1/chat/completions');
    });

    test('tolerates an LLMService stub lacking getStatus (no crash, sane defaults)', async () => {
      // Exercises the same code path that used to live in _defaultModel/_authHeaders before target-aware resolution moved it into routeTarget — renamed so the label no longer references internal method names as if they were a stable public surface.
      svc._setLLMService({ getEndpoint: () => 'http://x:2' });
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'y' } }] }));
      svc._setFetch(fetchMock);
      const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('local'); // status null → default model id
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
      expect(res.content).toBe('y');
    });

    test('request targeting the configured remote resolves its default model from _remote.model', async () => {
      // Pure-remote setup — no local proc running, so getEndpoint() returns the remote itself and target-scoped resolution (not status.isRemote) is what picks this model id.
      llmMock.getStatus.mockReturnValue({ isRemote: true });
      llmMock._remote = { endpoint: 'https://api.x', model: 'gpt-remote' };
      llmMock.getEndpoint.mockReturnValue('https://api.x'); // the resolved URL must actually BE that remote for its model to apply — same target-scoping principle as the auth-header test above, applied here instead of leaking into a coincidentally-named local call
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'r' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('gpt-remote');
    });

    test('status.model is used as the model id when present and local', async () => {
      llmMock.getStatus.mockReturnValue({ isRemote: false, model: '/models/qwen.gguf' });
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'q' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('/models/qwen.gguf');
    });
  });

  // _resolveEndpoint strips a trailing /v1 and trailing slashes so callers'
  // /v1/... path suffix never double-prefixes into /v1/v1/... (FastAPI 404).
  describe('_resolveEndpoint normalization', () => {
    test('strips a trailing /v1 and trailing slashes', async () => {
      llmMock.getEndpoint.mockReturnValue('http://127.0.0.1:8421/v1/');
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'ok' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8421/v1/chat/completions');
    });

    test('an explicit endpoint override wins over the LLMService endpoint', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'ov' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }], { endpoint: 'http://override:9/' });
      expect(fetchMock.mock.calls[0][0]).toBe('http://override:9/v1/chat/completions');
    });
  });

  // _post — fetch unavailable, no-response (null) and unreadable error body.
  describe('_post error paths', () => {
    test('throws when fetch is unavailable in this environment', async () => {
      svc._setFetch(null);
      await expect(svc.chatCompletion([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow(/fetch unavailable/i);
    });

    test('throws when fetch resolves to no response object', async () => {
      svc._setFetch(jest.fn().mockResolvedValue(null));
      await expect(svc.chatCompletion([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow(/no-response/);
    });

    test('tolerates an error body whose .text() rejects', async () => {
      svc._setFetch(jest.fn().mockResolvedValue({
        ok: false, status: 502, text: async () => { throw new Error('stream broke'); },
      }));
      await expect(svc.chatCompletion([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow(/502/);
    });
  });

  // listModels — every failure arm plus the bare-array body shape.
  describe('listModels branches', () => {
    test('throws when fetch is unavailable', async () => {
      svc._setFetch(null);
      await expect(svc.listModels()).rejects.toThrow(/fetch unavailable/i);
    });

    test('throws when no endpoint resolves', async () => {
      llmMock.getEndpoint.mockReturnValue(null);
      svc._setFetch(jest.fn());
      await expect(svc.listModels()).rejects.toThrow(/No active LLM endpoint/);
    });

    test('an explicit apiKey opt overrides the auth header', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeOk([{ id: 'm1' }]));
      svc._setFetch(fetchMock);
      const out = await svc.listModels({ apiKey: 'sk-override' });
      expect(out).toEqual([{ id: 'm1' }]); // bare-array body returned as-is
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-override');
    });

    test('surfaces the HTTP status and detail on a failed response', async () => {
      svc._setFetch(jest.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'no models here' }));
      await expect(svc.listModels()).rejects.toThrow(/listModels failed: 404 — no models here/);
    });

    test('reports no-response and tolerates an unreadable error body', async () => {
      svc._setFetch(jest.fn().mockResolvedValue(null));
      await expect(svc.listModels()).rejects.toThrow(/listModels failed: no-response/);
      svc._setFetch(jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => { throw new Error('x'); } }));
      await expect(svc.listModels()).rejects.toThrow(/listModels failed: 500/);
    });

    test('returns [] when the body is neither an array nor {data:[]}', async () => {
      svc._setFetch(jest.fn().mockResolvedValue(fakeOk({ unexpected: true })));
      expect(await svc.listModels()).toEqual([]);
    });
  });

  // chatCompletion option plumbing + the parallel_tool_calls suppression that
  // keeps MLX stderr clean. Each option toggles a distinct body key.
  describe('chatCompletion option branches', () => {
    test('passes responseFormat / stop / tools / toolChoice through', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'c', tool_calls: [{ id: 't' }] } }], usage: { completion_tokens: 9 } }));
      svc._setFetch(fetchMock);
      const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }], {
        responseFormat: { type: 'json_object' },
        stop: ['\n'],
        tools: [{ type: 'function' }],
        toolChoice: 'auto',
        temperature: 0,
        maxTokens: 50,
        parallelToolCalls: true,
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.stop).toEqual(['\n']);
      expect(body.tools).toEqual([{ type: 'function' }]);
      expect(body.tool_choice).toBe('auto');
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBe(50);
      expect(body.parallel_tool_calls).toBe(true);
      expect(res.toolCalls).toEqual([{ id: 't' }]);
      expect(res.tokens).toBe(9);
    });

    test('omits parallel_tool_calls for MLX backends that ignore it', async () => {
      llmMock.getStatus.mockReturnValue({ isRemote: false, backend: 'mlxLm' });
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'c' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }], { parallelToolCalls: true });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).parallel_tool_calls).toBeUndefined();
    });

    test('mlxOpenAi backend also suppresses parallel_tool_calls', async () => {
      llmMock.getStatus.mockReturnValue({ isRemote: false, backend: 'mlxOpenAi' });
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'c' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }], { parallelToolCalls: false });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('parallel_tool_calls');
    });

    test('caller-supplied signal bypasses the internal AbortController/timer', async () => {
      const ac = new AbortController();
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'sig' } }] }));
      svc._setFetch(fetchMock);
      const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }], { signal: ac.signal });
      expect(fetchMock.mock.calls[0][1].signal).toBe(ac.signal);
      expect(res.content).toBe('sig');
    });

    test('a response with no choices yields empty content + null toolCalls', async () => {
      svc._setFetch(jest.fn().mockResolvedValue(fakeOk({})));
      const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
      expect(res).toMatchObject({ content: '', toolCalls: null, usage: null, tokens: 0 });
    });
  });

  // Chained MLX recovery: a Stream(gpu,N) crash triggers restartAsTextOnly and
  // a single retry; hop counter caps recursion; non-MLX errors rethrow.
  describe('chatCompletion MLX recovery', () => {
    afterEach(() => { svc._setLLMService(llmMock); });

    test('recovers once on a Stream(gpu) crash then succeeds on retry', async () => {
      const restart = jest.fn().mockResolvedValue(true);
      svc._setLLMService({
        getEndpoint: () => 'http://r:1', getStatus: () => ({ isRemote: false }),
        restartAsTextOnly: restart,
      });
      let call = 0;
      svc._setFetch(jest.fn(async () => {
        call += 1;
        if (call === 1) return { ok: false, status: 500, text: async () => 'RuntimeError: Stream(gpu, 0) bad' };
        return fakeOk({ choices: [{ message: { content: 'recovered' } }] });
      }));
      const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(res.content).toBe('recovered');
    });

    test('rethrows when recovery is impossible (no restartAsTextOnly)', async () => {
      svc._setLLMService({ getEndpoint: () => 'http://r:2', getStatus: () => ({ isRemote: false }) });
      svc._setFetch(jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'Stream(gpu, 1) crash' }));
      await expect(svc.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Stream\(gpu,1\)/);
    });

    test('rethrows immediately on a non-MLX error (no recovery attempt)', async () => {
      const restart = jest.fn();
      svc._setLLMService({
        getEndpoint: () => 'http://r:3', getStatus: () => ({ isRemote: false }), restartAsTextOnly: restart,
      });
      svc._setFetch(jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'plain old 500' }));
      await expect(svc.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow(/500/);
      expect(restart).not.toHaveBeenCalled();
    });

    test('stops retrying once the hop counter is exhausted', async () => {
      const restart = jest.fn().mockResolvedValue(true);
      svc._setLLMService({
        getEndpoint: () => 'http://r:4', getStatus: () => ({ isRemote: false }), restartAsTextOnly: restart,
      });
      svc._setFetch(jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'Stream(gpu, 2) keeps crashing' }));
      await expect(svc.chatCompletion([{ role: 'user', content: 'hi' }], { _recoverHops: 3 }))
        .rejects.toThrow(/Stream\(gpu,2\)/);
      expect(restart).not.toHaveBeenCalled(); // hops>=3 → no recovery
    });

    test('_tryRecoverMlxTextOnly returns false when restart throws or is absent', async () => {
      svc._setLLMService({});
      expect(await svc._tryRecoverMlxTextOnly()).toBe(false);
      svc._setLLMService({ restartAsTextOnly: async () => { throw new Error('boom'); } });
      expect(await svc._tryRecoverMlxTextOnly()).toBe(false);
      svc._setLLMService({ restartAsTextOnly: async () => 0 });
      expect(await svc._tryRecoverMlxTextOnly()).toBe(false);
    });
  });

  // chatCompletionStream non-streaming fallback (server returned a full body
  // with no readable stream) + the usage-only SSE line branch in parseSseLine.
  describe('chatCompletionStream branches', () => {
    test('falls back to splitting res.text() when the body has no getReader', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"AB"}}]}',
        'data: {"usage":{"completion_tokens":2}}',
        'data: [DONE]',
        '',
      ].join('\n');
      svc._setFetch(jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => sse }));
      const out = [];
      for await (const d of svc.chatCompletionStream([{ role: 'user', content: 'hi' }])) out.push(d);
      expect(out[0]).toBe('AB');
      const terminal = out[out.length - 1];
      expect(terminal.__final).toBe(true);
      expect(terminal.usage).toEqual({ completion_tokens: 2 });
      expect(terminal.charCount).toBe(2);
    });

    test('skips blank / malformed / [DONE] SSE lines without yielding', async () => {
      const sse = [
        '',
        'event: ping',
        'data:',
        'data: not-json{',
        'data: {"choices":[{"delta":{}}]}',
        'data: {"choices":[{"delta":{"content":"X"}}]}',
        'data: [DONE]',
      ].join('\n');
      svc._setFetch(jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => sse }));
      const out = [];
      for await (const d of svc.chatCompletionStream([{ role: 'user', content: 'hi' }])) out.push(d);
      expect(out.filter((x) => typeof x === 'string')).toEqual(['X']);
    });
  });

  // chatCompletionRouted — 'verify'/'judge' tags route to the remote only when
  // a remote is configured and not already active; everything else falls back
  // to a plain chatCompletion.
  describe('chatCompletionRouted', () => {
    test('falls back to plain chatCompletion when no remote is configured', async () => {
      llmMock._remote = null;
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'plain' } }] }));
      svc._setFetch(fetchMock);
      const res = await svc.chatCompletionRouted([{ role: 'user', content: 'hi' }], {}, { routeTag: 'verify' });
      expect(res.content).toBe('plain');
      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8421/v1/chat/completions');
    });

    test("'verify' while local routes explicitly to the remote endpoint", async () => {
      llmMock._remote = { endpoint: 'https://remote.api', model: 'big' };
      llmMock.getStatus.mockReturnValue({ isRemote: false });
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'remote' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletionRouted([{ role: 'user', content: 'hi' }], {}, { routeTag: 'judge' });
      expect(fetchMock.mock.calls[0][0]).toBe('https://remote.api/v1/chat/completions');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('big');
    });

    test("'verify' while already remote-active does not re-route", async () => {
      llmMock._remote = { endpoint: 'https://remote.api', model: 'big' };
      llmMock.getStatus.mockReturnValue({ isRemote: true });
      llmMock.getEndpoint.mockReturnValue('https://remote.api');
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'as-is' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletionRouted([{ role: 'user', content: 'hi' }], {}, { routeTag: 'verify' });
      // No endpoint override injected — the normal endpoint resolution runs.
      expect(fetchMock.mock.calls[0][0]).toBe('https://remote.api/v1/chat/completions');
    });

    test('a non-verify tag with a remote configured stays on the default path', async () => {
      llmMock._remote = { endpoint: 'https://remote.api', model: 'big' };
      llmMock.getStatus.mockReturnValue({ isRemote: false });
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'draft' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletionRouted([{ role: 'user', content: 'hi' }], {}, { routeTag: 'draft' });
      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8421/v1/chat/completions');
    });

    test('no route object at all → plain chatCompletion', async () => {
      llmMock._remote = null;
      svc._setFetch(jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'd' } }] })));
      const res = await svc.chatCompletionRouted([{ role: 'user', content: 'hi' }]);
      expect(res.content).toBe('d');
    });
  });

  // visionCompletion: only the LAST user message is augmented; non-string
  // content and image objects with/without url are handled.
  describe('visionCompletion edge cases', () => {
    test('leaves non-last and non-user messages untouched; skips url-less images', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'v' } }] }));
      svc._setFetch(fetchMock);
      await svc.visionCompletion(
        [
          { role: 'system', content: 'sys' },
          { role: 'assistant', content: 'prior' },
          { role: 'user', content: { complex: true } },
        ],
        [{ url: 'http://img/a.png' }, { noUrl: true }, 'http://img/b.png'],
      );
      const msgs = JSON.parse(fetchMock.mock.calls[0][1].body).messages;
      expect(msgs[0]).toEqual({ role: 'system', content: 'sys' });
      expect(msgs[1]).toEqual({ role: 'assistant', content: 'prior' });
      const last = msgs[2];
      expect(last.content[0]).toEqual({ type: 'text', text: '' }); // non-string → ''
      const urls = last.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url);
      expect(urls).toEqual(['http://img/a.png', 'http://img/b.png']);
    });

    test('a trailing non-user message means no augmentation happens', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'v' } }] }));
      svc._setFetch(fetchMock);
      await svc.visionCompletion(
        [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
        ['http://img/c.png'],
      );
      const msgs = JSON.parse(fetchMock.mock.calls[0][1].body).messages;
      expect(msgs[0]).toEqual({ role: 'user', content: 'q' });
      expect(msgs[1]).toEqual({ role: 'assistant', content: 'a' });
    });

    test('null images list is tolerated (no image parts added)', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'v' } }] }));
      svc._setFetch(fetchMock);
      await svc.visionCompletion([{ role: 'user', content: 'q' }], null);
      const last = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0];
      expect(last.content).toEqual([{ type: 'text', text: 'q' }]);
    });
  });

  // Anthropic Claude 4.5+ and OpenAI o-series / gpt-5+ now reject `temperature`
  // with a 400. LLMClientService handles this two ways: a proactive heuristic
  // skips the parameter for known-bad model ids, and a reactive fallback
  // retries-without-temperature on the rejection error then caches the model.
  describe('temperature rejection handling', () => {
    function tempRejection400(message = "temperature is deprecated for this model.") {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message } }),
      };
    }

    test('heuristic: omits temperature for claude-4.7-opus-anthropic (user-reported case)', async () => {
      llmMock.getStatus.mockReturnValue({ isRemote: true, model: 'claude-4.7-opus-anthropic' });
      llmMock._remote = { endpoint: 'https://litellm.proxy', model: 'claude-4.7-opus-anthropic', apiKey: 'sk' };
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'ok' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }], { temperature: 0.7 });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).not.toHaveProperty('temperature');
      expect(fetchMock).toHaveBeenCalledTimes(1); // no retry, no round-trip wasted
    });

    test('heuristic: covers claude-opus-4-5 / claude-haiku-4-5 / claude-sonnet-4-7 variants', async () => {
      const ids = ['claude-opus-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-7', 'claude-4.5', 'claude-4-5'];
      for (const id of ids) {
        const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: id } }] }));
        svc._setFetch(fetchMock);
        await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: id });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('temperature');
      }
    });

    test('heuristic: covers OpenAI o-series and gpt-5+ (o1, o3-mini, gpt-5)', async () => {
      const ids = ['o1-preview', 'o1-mini', 'o3-mini-2025-01-31', 'gpt-5', 'gpt-5-turbo'];
      for (const id of ids) {
        const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: id } }] }));
        svc._setFetch(fetchMock);
        await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: id });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('temperature');
      }
    });

    test('heuristic: leaves temperature on models that still accept it (claude-3.5, gpt-4o, local)', async () => {
      const ids = ['claude-3-5-sonnet-20241022', 'claude-3-opus', 'gpt-4o-2024-11-20', 'gpt-4-turbo', 'local'];
      for (const id of ids) {
        const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: id } }] }));
        svc._setFetch(fetchMock);
        await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: id, temperature: 0.5 });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.temperature).toBe(0.5);
      }
    });

    test('reactive: 400 with "temperature is deprecated" triggers retry without temperature', async () => {
      let call = 0;
      svc._setFetch(jest.fn(async () => {
        call += 1;
        if (call === 1) return tempRejection400('litellm.BadRequestError: AnthropicException - {"type":"error","error":{"type":"invalidrequesterror","message":"temperature is deprecated for this model."}}');
        return fakeOk({ choices: [{ message: { content: 'recovered' } }] });
      }));
      const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'unknown-future-claude' });
      expect(res.content).toBe('recovered');
      expect(call).toBe(2);
      const firstBody = JSON.parse(svc._fetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(svc._fetch.mock.calls[1][1].body);
      expect(firstBody.temperature).toBe(0.2); // default applied on first attempt
      expect(secondBody).not.toHaveProperty('temperature'); // retry strips it
    });

    test('reactive: also catches OpenAI-style "Unsupported parameter: \'temperature\'"', async () => {
      let call = 0;
      svc._setFetch(jest.fn(async () => {
        call += 1;
        if (call === 1) return tempRejection400("Unsupported parameter: 'temperature' is not supported with this model.");
        return fakeOk({ choices: [{ message: { content: 'ok' } }] });
      }));
      const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'some-new-model' });
      expect(res.content).toBe('ok');
      expect(call).toBe(2);
    });

    test('reactive: caches the rejection — second call to same (endpoint, model) skips temperature on first attempt', async () => {
      let call = 0;
      svc._setFetch(jest.fn(async () => {
        call += 1;
        if (call === 1) return tempRejection400();
        return fakeOk({ choices: [{ message: { content: 'ok' } }] });
      }));
      // First chatCompletion: 400 then retry → 2 fetches
      await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'mystery-model' });
      expect(call).toBe(2);
      // Second chatCompletion to the same model: cache hit, no retry needed
      svc._setFetch(jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'cached' } }] })));
      const res2 = await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'mystery-model' });
      expect(res2.content).toBe('cached');
      expect(svc._fetch).toHaveBeenCalledTimes(1); // single round-trip
      const body = JSON.parse(svc._fetch.mock.calls[0][1].body);
      expect(body).not.toHaveProperty('temperature');
    });

    test('reactive: cache is per (endpoint, model) — a different model still tries temperature', async () => {
      // Prime cache for "model-a" via a rejection cycle.
      let call = 0;
      svc._setFetch(jest.fn(async () => {
        call += 1;
        if (call === 1) return tempRejection400();
        return fakeOk({ choices: [{ message: { content: 'ok' } }] });
      }));
      await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'model-a' });
      // "model-b" is unrelated — temperature should still appear.
      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'b' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'model-b', temperature: 0.3 });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).temperature).toBe(0.3);
    });

    test('reactive: a non-temperature 400 rethrows without retry', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid model id' });
      svc._setFetch(fetchMock);
      await expect(svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'whatever' }))
        .rejects.toThrow(/400/);
      expect(fetchMock).toHaveBeenCalledTimes(1); // one attempt, no retry
    });

    test('chatCompletionStream: same reactive behavior — retries without temperature on rejection', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"S"}}]}',
        'data: [DONE]',
        '',
      ].join('\n');
      let call = 0;
      svc._setFetch(jest.fn(async () => {
        call += 1;
        if (call === 1) return tempRejection400();
        return { ok: true, status: 200, text: async () => sse };
      }));
      const out = [];
      for await (const d of svc.chatCompletionStream([{ role: 'user', content: 'hi' }], { model: 'streaming-model' })) {
        out.push(d);
      }
      expect(out.filter((x) => typeof x === 'string')).toEqual(['S']);
      expect(call).toBe(2);
      const firstBody = JSON.parse(svc._fetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(svc._fetch.mock.calls[1][1].body);
      expect(firstBody.temperature).toBe(0.2);
      expect(secondBody).not.toHaveProperty('temperature');
    });

    test('chatCompletionStream: heuristic-detected model never sends temperature', async () => {
      const sse = [
        'data: {"choices":[{"delta":{"content":"X"}}]}',
        'data: [DONE]',
      ].join('\n');
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => sse });
      svc._setFetch(fetchMock);
      const out = [];
      for await (const d of svc.chatCompletionStream([{ role: 'user', content: 'hi' }], { model: 'claude-opus-4-5' })) {
        out.push(d);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('temperature');
    });

    test('_isTemperatureRejectionError matches the documented error variants', () => {
      const match = (msg) => svc._isTemperatureRejectionError(new Error(msg));
      expect(match('temperature is deprecated for this model')).toBe(true);
      expect(match('temperature is not supported with this model')).toBe(true);
      expect(match("Unsupported parameter: 'temperature' is not supported")).toBe(true);
      expect(match('temperature is no longer supported')).toBe(true);
      expect(match('deprecated parameter temperature')).toBe(true);
      // Negative cases — must NOT trigger retry.
      expect(match('temperature must be between 0 and 2')).toBe(false);
      expect(match('rate limit exceeded')).toBe(false);
      expect(match('')).toBe(false);
    });

    test('reactive: MLX recovery still runs first (temperature retry does not preempt Stream(gpu) recovery)', async () => {
      const restart = jest.fn().mockResolvedValue(true);
      svc._setLLMService({
        getEndpoint: () => 'http://r:1', getStatus: () => ({ isRemote: false }),
        restartAsTextOnly: restart,
      });
      let call = 0;
      svc._setFetch(jest.fn(async () => {
        call += 1;
        if (call === 1) return { ok: false, status: 500, text: async () => 'RuntimeError: Stream(gpu, 0) bad' };
        return fakeOk({ choices: [{ message: { content: 'mlx-recovered' } }] });
      }));
      const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }]);
      expect(restart).toHaveBeenCalledTimes(1); // MLX recovery path engaged
      expect(res.content).toBe('mlx-recovered');
    });
  });

  // The agent sends a native `tools` payload by default. Servers behind a proxy,
  // or models whose chat template has no tool-call section, answer that with a
  // 400 — which would kill the whole agent task instead of letting it fall back
  // to the text-JSON tool protocol.
  describe('tools rejection handling', () => {
    const TOOLS = [{ type: 'function', function: { name: 'browser_open_tab', parameters: { type: 'object' } } }];

    function toolsRejection400(message) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message } }) };
    }

    test('a 400 naming tools retries without the tool payload and returns the answer', async () => {
      let call = 0;
      svc._setFetch(jest.fn(async () => {
        call += 1;
        if (call === 1) return toolsRejection400("Unsupported parameter: 'tools' is not supported with this model.");
        return fakeOk({ choices: [{ message: { content: 'text-protocol answer' } }] });
      }));
      const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }], {
        model: 'no-tool-template', tools: TOOLS, toolChoice: 'auto', parallelToolCalls: false,
      });
      expect(res.content).toBe('text-protocol answer');
      expect(call).toBe(2);
      const firstBody = JSON.parse(svc._fetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(svc._fetch.mock.calls[1][1].body);
      expect(firstBody.tools).toEqual(TOOLS);
      expect(secondBody).not.toHaveProperty('tools');
      expect(secondBody).not.toHaveProperty('tool_choice');
      expect(secondBody).not.toHaveProperty('parallel_tool_calls');
      expect(secondBody.messages).toEqual([{ role: 'user', content: 'hi' }]); // the conversation itself survives the hop
    });

    test('a chat-template rejection is recognized too', async () => {
      let call = 0;
      svc._setFetch(jest.fn(async () => {
        call += 1;
        if (call === 1) return toolsRejection400('This model\'s chat template does not support tool calling.');
        return fakeOk({ choices: [{ message: { content: 'ok' } }] });
      }));
      const res = await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'plain-chat', tools: TOOLS });
      expect(res.content).toBe('ok');
      expect(call).toBe(2);
    });

    test('the rejection is cached per (endpoint, model) — the next call sends no tools at all', async () => {
      let call = 0;
      svc._setFetch(jest.fn(async () => {
        call += 1;
        if (call === 1) return toolsRejection400("Unsupported parameter: 'tools'");
        return fakeOk({ choices: [{ message: { content: 'ok' } }] });
      }));
      await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'no-tools-model', tools: TOOLS });
      expect(call).toBe(2);

      const fetchMock = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'cached' } }] }));
      svc._setFetch(fetchMock);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'no-tools-model', tools: TOOLS });
      expect(fetchMock).toHaveBeenCalledTimes(1); // no second round-trip burned on a known-bad payload
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('tools');

      // A different model is unaffected — the fallback must not disarm native tools globally.
      const other = jest.fn().mockResolvedValue(fakeOk({ choices: [{ message: { content: 'b' } }] }));
      svc._setFetch(other);
      await svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'tool-capable-model', tools: TOOLS });
      expect(JSON.parse(other.mock.calls[0][1].body).tools).toEqual(TOOLS);
    });

    test('a 400 unrelated to tools rethrows without stripping the tool payload', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'context length exceeded' });
      svc._setFetch(fetchMock);
      await expect(svc.chatCompletion([{ role: 'user', content: 'hi' }], { model: 'm', tools: TOOLS }))
        .rejects.toThrow(/400/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(svc._shouldOmitTools('m', undefined)).toBe(false); // a context-length 400 must never mark the model tool-incapable
    });

    test('_isToolsRejectionError matches the rejection variants and not lookalikes', () => {
      const match = (msg) => svc._isToolsRejectionError(new Error(msg));
      expect(match("Unsupported parameter: 'tools' is not supported with this model")).toBe(true);
      expect(match('tools is not supported')).toBe(true);
      expect(match('tool_choice is invalid for this endpoint')).toBe(true);
      expect(match('chat template does not have a tool call section')).toBe(true);
      // Negatives — a failing tool CALL is not a rejected tool PAYLOAD.
      expect(match('tool call failed: browser_open_tab threw')).toBe(false);
      expect(match('rate limit exceeded')).toBe(false);
      expect(match('')).toBe(false);
    });
  });
});

describe('chatCompletionStream with tools', () => {
  const TOOLS = [{ type: 'function', function: { name: 'agent_done', parameters: { type: 'object' } } }];
  const sseRes = (lines) => ({ ok: true, status: 200, text: async () => lines.join('\n') });
  const drain = async (gen) => { const out = []; for await (const d of gen) out.push(d); return out; };

  test('sends tools and returns the assembled tool calls on the terminal frame', async () => {
    const fetchMock = jest.fn().mockResolvedValue(sseRes([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"agent_done","arguments":"{\\"summary\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ok\\"}"}}]}}]}',
      'data: [DONE]',
    ]));
    svc._setFetch(fetchMock);
    const out = await drain(svc.chatCompletionStream([{ role: 'user', content: 'hi' }], { model: 'm', tools: TOOLS, toolChoice: 'auto', parallelToolCalls: true }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ stream: true, tools: TOOLS, tool_choice: 'auto', parallel_tool_calls: true });
    expect(out[out.length - 1].toolCalls).toEqual([{ id: 'c1', type: 'function', function: { name: 'agent_done', arguments: '{"summary":"ok"}' } }]);
  });

  test('a tools rejection before any token retries the stream without the tool payload', async () => {
    let call = 0;
    svc._setFetch(jest.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "Unsupported parameter: 'tools'" } }) };
      return sseRes(['data: {"choices":[{"delta":{"content":"plain"}}]}', 'data: [DONE]']);
    }));
    const out = await drain(svc.chatCompletionStream([{ role: 'user', content: 'hi' }], { model: 'no-tools', tools: TOOLS }));
    expect(call).toBe(2);
    expect(JSON.parse(svc._fetch.mock.calls[1][1].body)).not.toHaveProperty('tools');
    expect(out[0]).toBe('plain');
    expect(svc._shouldOmitTools('no-tools', undefined)).toBe(true);
  });

  test('without tools the request carries no tool fields; an unrelated 400 rethrows', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'context length exceeded' });
    svc._setFetch(fetchMock);
    await expect(drain(svc.chatCompletionStream([{ role: 'user', content: 'hi' }], { model: 'm' }))).rejects.toThrow(/400/);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
