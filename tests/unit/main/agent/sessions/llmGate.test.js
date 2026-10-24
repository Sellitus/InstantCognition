const { createGate, resolveLimit, REMOTE_AUTO_LIMIT } = require('../../../../../main/agent/sessions/llmGate');

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));

describe('llmGate.resolveLimit', () => {
  test('numbers clamp to 1..16; auto and junk fall back by endpoint locality', () => {
    expect(resolveLimit(3, false)).toBe(3);
    expect(resolveLimit('2', true)).toBe(2);
    expect(resolveLimit(99, false)).toBe(16);
    expect(resolveLimit('auto', true)).toBe(REMOTE_AUTO_LIMIT);
    expect(resolveLimit('auto', false)).toBe(1);
    expect(resolveLimit(0, false)).toBe(1);
    expect(resolveLimit(undefined, true)).toBe(REMOTE_AUTO_LIMIT);
  });
});

describe('llmGate', () => {
  test('tryAcquire honors the limit; release is idempotent', () => {
    const gate = createGate({ limit: () => 1 });
    const r1 = gate.tryAcquire();
    expect(r1).toEqual(expect.any(Function));
    expect(gate.tryAcquire()).toBeNull();
    expect(gate.isSaturated()).toBe(true);
    r1();
    r1();
    expect(gate.stats()).toEqual({ active: 0, waiting: 0, limit: 1 });
  });

  test('wrapped calls never exceed the limit and queue in order', async () => {
    const gate = createGate({ limit: () => 1 });
    let inFlight = 0;
    let peak = 0;
    const order = [];
    const pending = [];
    const mockClient = {
      chatCompletion: async (msgs) => {
        inFlight++; peak = Math.max(peak, inFlight);
        const d = deferred();
        pending.push(d);
        await d.promise;
        inFlight--;
        order.push(msgs);
        return msgs;
      },
    };
    const llm = gate.wrap(mockClient);
    const a = llm.chatCompletion('a');
    const b = llm.chatCompletion('b');
    await tick();
    expect(pending).toHaveLength(1);
    expect(gate.stats()).toMatchObject({ active: 1, waiting: 1 });
    pending[0].resolve();
    await a;
    await tick();
    pending[1].resolve();
    await expect(b).resolves.toBe('b');
    expect(peak).toBe(1);
    expect(order).toEqual(['a', 'b']);
    expect(gate.stats().active).toBe(0);
  });

  test('a stream holds its slot until iteration stops, including early exit', async () => {
    const gate = createGate({ limit: () => 1 });
    const llm = gate.wrap({ async *chatCompletionStream() { yield 'x'; yield 'y'; } });
    for await (const chunk of llm.chatCompletionStream([], {})) {
      expect(chunk).toBe('x');
      expect(gate.stats().active).toBe(1);
      break;
    }
    expect(gate.stats().active).toBe(0);
  });

  test('a thrown request releases its slot and the error reaches the caller', async () => {
    const gate = createGate({ limit: () => 1 });
    const llm = gate.wrap({ chatCompletion: async () => { throw new Error('engine down'); } });
    await expect(llm.chatCompletion([])).rejects.toThrow('engine down');
    expect(gate.stats().active).toBe(0);
  });

  test('an aborted wait leaves the queue and rejects with AbortError', async () => {
    const gate = createGate({ limit: () => 1 });
    const hold = gate.tryAcquire();
    const ac = new AbortController();
    const waiting = gate.acquire(ac.signal);
    expect(gate.stats().waiting).toBe(1);
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(gate.stats().waiting).toBe(0);
    hold();
    await expect(gate.acquire(ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('raising the limit through configure admits waiters', async () => {
    let limit = 1;
    const gate = createGate({ limit: () => limit });
    gate.tryAcquire();
    const waiter = gate.acquire();
    limit = 2;
    gate.configure({ limit: () => limit });
    await expect(waiter).resolves.toEqual(expect.any(Function));
    expect(gate.stats().active).toBe(2);
  });

  test('wrap keeps absent methods absent and passes others through', () => {
    const gate = createGate();
    const llm = gate.wrap({ isRemote: () => true, model: 'm' });
    expect(llm.chatCompletionStream).toBeUndefined();
    expect(llm.isRemote()).toBe(true);
    expect(llm.model).toBe('m');
    expect(() => gate.wrap(null)).toThrow('client required');
  });

  test('a non-numeric limit falls back to 1', () => {
    const gate = createGate({ limit: () => 'many' });
    gate.tryAcquire();
    expect(gate.tryAcquire()).toBeNull();
  });
});
