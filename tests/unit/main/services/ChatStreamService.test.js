// ChatStreamService tests — inject a fake streaming LLM client via _setClient.

const svc = require('../../../../main/services/ChatStreamService');

// Streams the given chunks, then a terminal __final marker. When `hang` is set
// it blocks after the chunks until the request's AbortSignal fires (so a second
// request observes the first as in-flight), rejecting on abort.
function fakeClient(chunks, { hang = false, throws = null } = {}) {
  return {
    chatCompletionStream: async function* (_messages, opts) {
      if (throws) throw throws;
      for (const c of chunks) yield c;
      if (hang) {
        await new Promise((_resolve, reject) => {
          if (opts.signal && opts.signal.aborted) return reject(new Error('aborted'));
          if (opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      yield { __final: true, elapsedMs: 7 };
    },
  };
}

describe('ChatStreamService', () => {
  beforeEach(() => {
    svc.cancelAll();
  });

  test('rejects a request with no id', async () => {
    expect(await svc.ask({ messages: [{ role: 'user', content: 'hi' }] })).toEqual({ ok: false, error: 'missing_request_id' });
  });

  test('rejects an empty message list', async () => {
    expect(await svc.ask({ id: 'a', messages: [] })).toEqual({ ok: false, error: 'empty_messages' });
  });

  test('streams token deltas and reports char count + elapsed', async () => {
    svc._setClient(fakeClient(['Hel', 'lo']));
    const tokens = [];
    const res = await svc.ask({ id: 'r1', messages: [{ role: 'user', content: 'hi' }] }, (d) => tokens.push(d));
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(res).toEqual({ ok: true, elapsedMs: 7, charCount: 5 });
  });

  test('a reasoning-only stream fails instead of resolving as an empty success', async () => {
    svc._setClient({
      chatCompletionStream: async function* () {
        yield { __final: true, elapsedMs: 5, charCount: 0, reasoningCharCount: 3300, finishReason: 'length' };
      },
    });
    expect(await svc.ask({ id: 'r-reason', messages: [{ role: 'user', content: 'hi' }] }))
      .toEqual({ ok: false, error: 'reasoning_budget_exhausted' });
  });

  test('a stream with no text at all fails as empty_response', async () => {
    svc._setClient(fakeClient([]));
    expect(await svc.ask({ id: 'r-empty', messages: [{ role: 'user', content: 'hi' }] }))
      .toEqual({ ok: false, error: 'empty_response' });
  });

  test('defaults the token budget above the reasoning-only failure threshold', async () => {
    let seen = null;
    svc._setClient({
      chatCompletionStream: async function* (_m, opts) { seen = opts.maxTokens; yield 'ok'; yield { __final: true, elapsedMs: 1 }; },
    });
    await svc.ask({ id: 'r-budget', messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toBeGreaterThan(1024);
  });

  test('passes provider errors through to the caller', async () => {
    svc._setClient(fakeClient([], { throws: new Error('engine spawn failed') }));
    expect(await svc.ask({ id: 'r2', messages: [{ role: 'user', content: 'hi' }] })).toEqual({ ok: false, error: 'engine spawn failed' });
  });

  test('single-flight: a second request rejects with engine_busy while one is in-flight', async () => {
    svc._setClient(fakeClient(['x'], { hang: true }));
    const first = svc.ask({ id: 'busy1', messages: [{ role: 'user', content: 'go' }] });
    // Let the first stream start and register itself as in-flight.
    await new Promise((r) => setImmediate(r));
    expect(svc.isBusy()).toBe(true);
    expect(await svc.ask({ id: 'busy2', messages: [{ role: 'user', content: 'go' }] })).toEqual({ ok: false, error: 'engine_busy' });
    svc.cancel('busy1');
    expect(await first).toEqual({ ok: false, error: 'cancelled' });
  });

  test('an agent request holding every gate slot rejects chat with nothing of its own in flight', async () => {
    const { gate } = require('../../../../main/agent/sessions/llmGate');
    gate.configure({ limit: () => 1 });
    const client = fakeClient(['x']);
    const stream = jest.spyOn(client, 'chatCompletionStream');
    svc._setClient(client);
    const release = gate.tryAcquire();
    try {
      expect(svc.isBusy()).toBe(true);
      expect(await svc.ask({ id: 'r3', messages: [{ role: 'user', content: 'hi' }] })).toEqual({ ok: false, error: 'engine_busy' });
      expect(stream).not.toHaveBeenCalled();
    } finally { release(); }
    // With the slot back, the same request streams.
    expect(svc.isBusy()).toBe(false);
    expect(await svc.ask({ id: 'r4', messages: [{ role: 'user', content: 'hi' }] })).toMatchObject({ ok: true, charCount: 1 });
  });

  test('cancel(id) aborts the in-flight stream and resolves as cancelled', async () => {
    svc._setClient(fakeClient(['x'], { hang: true }));
    const p = svc.ask({ id: 'c1', messages: [{ role: 'user', content: 'go' }] });
    await new Promise((r) => setImmediate(r));
    expect(svc.cancel('c1')).toBe(true);
    expect(await p).toEqual({ ok: false, error: 'cancelled' });
  });

  test('cancel(id) returns false for an unknown request', () => {
    expect(svc.cancel('nope')).toBe(false);
  });

  test('fires user-memory auto-capture after a successful stream', async () => {
    const capture = jest.fn().mockResolvedValue([]);
    jest.resetModules();
    jest.doMock('../../../../main/services/UserMemoryService', () => ({ capture }));
    const freshSvc = require('../../../../main/services/ChatStreamService');
    freshSvc._setClient(fakeClient(['Hel', 'lo']));
    const res = await freshSvc.ask({ id: 'cap1', messages: [{ role: 'user', content: 'I am a React developer' }] });
    expect(res).toEqual({ ok: true, elapsedMs: 7, charCount: 5 });
    // capture runs fire-and-forget; let the microtask queue drain.
    await new Promise((r) => setImmediate(r));
    expect(capture).toHaveBeenCalledTimes(1);
    const arg = capture.mock.calls[0][0];
    expect(arg.answer).toBe('Hello');
    expect(Array.isArray(arg.messages)).toBe(true);
    jest.dontMock('../../../../main/services/UserMemoryService');
    jest.resetModules();
  });
});
