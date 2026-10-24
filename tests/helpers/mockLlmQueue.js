// Controllable stand-in for LLMClientService.chatCompletion: every request
// stays pending until the test answers it, so tests can observe how many
// requests are in flight at once. A request rejects with AbortError when its
// opts.signal aborts, as the real HTTP client does.

function createMockLlmQueue(chatCompletionMock) {
  const state = { pending: [], inFlight: 0, peak: 0 };
  chatCompletionMock.mockReset();
  chatCompletionMock.mockImplementation((messages, opts) => new Promise((resolve, reject) => {
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; state.inFlight--; fn(v); };
    const call = { messages, opts, text: JSON.stringify(messages), done: false, resolve: (v) => { call.done = true; finish(resolve, v); } };
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        call.done = true;
        finish(reject, err);
      }, { once: true });
    }
    state.pending.push(call);
  }));
  /** First unanswered request whose messages contain `word`. */
  state.callFor = (word) => state.pending.find((c) => !c.done && c.text.includes(word));
  state.answer = (word, resp) => {
    const c = state.callFor(word);
    if (!c) throw new Error(`no pending LLM request mentions ${word}`);
    c.resolve(resp);
  };
  state.open = () => state.pending.filter((c) => !c.done);
  return state;
}

// Bounded by wall time, not event-loop turns: the turns under test do real fs
// I/O on the libuv threadpool, which a loaded full-suite run slows past any
// fixed turn count.
async function waitFor(cond, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  if (cond()) return;
  throw new Error(`timed out waiting for ${label}`);
}

module.exports = { createMockLlmQueue, waitFor };
