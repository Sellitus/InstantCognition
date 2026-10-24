// SSE parsing for OpenAI-compatible streaming chat completions. parseSseLine
// extracts a `{content?, reasoning?, toolCalls?, finishReason?, usage?}` delta
// from one `data:` line; readSseStream drives a fetch Response body to an async
// generator of content strings, then yields a terminal
// `{__final, usage, elapsedMs, charCount, reasoningCharCount, finishReason,
// toolCalls}` where toolCalls are the streamed `delta.tool_calls` fragments
// assembled into whole OpenAI tool calls (null when the reply had none).

function parseSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const json = JSON.parse(payload);
    const out = {};
    const choice = json.choices && json.choices[0];
    const delta = choice && choice.delta;
    const d = delta && delta.content;
    if (d) out.content = d;
    // Reasoning servers (SGLang/vLLM) stream chain-of-thought in a sibling
    // field that spends the same max_tokens budget as content. It is never
    // part of the answer, but a completion that produced only reasoning has to
    // stay distinguishable from one that produced nothing at all.
    const r = delta && delta.reasoning_content;
    if (r) out.reasoning = r;
    const tc = delta && delta.tool_calls;
    if (Array.isArray(tc) && tc.length) out.toolCalls = tc;
    if (choice && choice.finish_reason) out.finishReason = choice.finish_reason;
    if (json.usage) out.usage = json.usage;
    return (out.content || out.reasoning || out.toolCalls || out.finishReason || out.usage) ? out : null;
  } catch (_) { return null; }
}

// Streamed tool calls arrive as fragments keyed by `index`: the first carries
// id + function.name, later ones append to function.arguments. Some servers
// omit `index`; a fragment without one continues the last call unless it
// brings a new id.
function createToolCallAssembler() {
  /** @type {Array<{ id: string, type: string, function: { name: string, arguments: string } }>} */
  const calls = [];
  /** @type {Map<number, number>} */
  const byIndex = new Map();
  function slotFor(frag) {
    if (Number.isInteger(frag.index)) {
      if (!byIndex.has(frag.index)) { byIndex.set(frag.index, calls.length); calls.push(blank()); }
      return calls[/** @type {number} */ (byIndex.get(frag.index))];
    }
    const last = calls[calls.length - 1];
    if (last && (!frag.id || !last.id || frag.id === last.id)) return last;
    calls.push(blank());
    return calls[calls.length - 1];
  }
  function blank() { return { id: '', type: 'function', function: { name: '', arguments: '' } }; }
  return {
    /** @param {any[]} fragments */
    push(fragments) {
      for (const frag of fragments) {
        if (!frag || typeof frag !== 'object') continue;
        const slot = slotFor(frag);
        if (typeof frag.id === 'string' && frag.id) slot.id = frag.id;
        if (typeof frag.type === 'string' && frag.type) slot.type = frag.type;
        const fn = frag.function && typeof frag.function === 'object' ? frag.function : {};
        // A server that repeats the whole name on every fragment must not double it.
        if (typeof fn.name === 'string' && fn.name && fn.name !== slot.function.name) slot.function.name += fn.name;
        if (typeof fn.arguments === 'string') slot.function.arguments += fn.arguments;
      }
    },
    /** Whole calls with a name; null when the stream carried none. */
    result() {
      const done = calls.filter((c) => c.function.name);
      return done.length ? done.map((c, i) => ({ ...c, id: c.id || `call_stream_${i}`, function: { ...c.function, arguments: c.function.arguments || '{}' } })) : null;
    },
  };
}

// Drive a fetch Response to an async generator. Yields content-delta strings,
// then a terminal `{__final, usage, elapsedMs, charCount, reasoningCharCount,
// finishReason}` so UIs can compute live tokens/sec and callers can tell a
// reasoning-only completion from an empty one. `startedAt` (ms epoch) lets the
// caller include pre-stream latency in elapsedMs.
async function* readSseStream(res, startedAt) {
  let charCount = 0, reasoningCharCount = 0, usage = null, finishReason = null;
  const toolCalls = createToolCallAssembler();
  const consume = function* (lines) {
    for (const line of lines) {
      const p = parseSseLine(line);
      if (!p) continue;
      if (p.usage) usage = p.usage;
      if (p.finishReason) finishReason = p.finishReason;
      if (p.reasoning) reasoningCharCount += p.reasoning.length;
      if (p.toolCalls) toolCalls.push(p.toolCalls);
      if (p.content) { charCount += p.content.length; yield p.content; }
    }
  };
  if (!res.body || typeof res.body.getReader !== 'function') {
    yield* consume((await res.text()).split('\n'));
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        yield* consume(lines);
      }
    } finally { try { reader.cancel(); } catch (_) { /* release on abort/throw — body stays locked otherwise */ } }
    // Flush any trailing partial line the server sent without a final newline.
    // Without this, a server that closes the stream mid-event (notably the
    // terminal usage/[DONE] chunk) drops that event and the caller loses the
    // token count.
    if (buffer.trim()) yield* consume([buffer]);
  }
  yield { __final: true, usage, elapsedMs: Date.now() - startedAt, charCount, reasoningCharCount, finishReason, toolCalls: toolCalls.result() };
}

module.exports = { parseSseLine, readSseStream, createToolCallAssembler };
