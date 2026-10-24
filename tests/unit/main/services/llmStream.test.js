const { parseSseLine, readSseStream, createToolCallAssembler } = require('../../../../main/services/llmStream');

describe('llmStream', () => {
  describe('parseSseLine', () => {
    test('extracts a content delta from a data: line', () => {
      expect(parseSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}')).toEqual({ content: 'hi' });
    });

    test('captures usage when present alongside content', () => {
      const line = 'data: {"choices":[{"delta":{"content":"x"}}],"usage":{"total_tokens":3}}';
      expect(parseSseLine(line)).toEqual({ content: 'x', usage: { total_tokens: 3 } });
    });

    test('captures usage-only frames (no content delta)', () => {
      const line = 'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":9}}';
      expect(parseSseLine(line)).toEqual({ usage: { total_tokens: 9 } });
    });

    test('ignores non-data lines', () => {
      expect(parseSseLine('event: chunk')).toBeNull();
      expect(parseSseLine(': heartbeat')).toBeNull();
      expect(parseSseLine('')).toBeNull();
    });

    test('ignores the [DONE] sentinel and empty payloads', () => {
      expect(parseSseLine('data: [DONE]')).toBeNull();
      expect(parseSseLine('data:')).toBeNull();
      expect(parseSseLine('data:   ')).toBeNull();
    });

    test('ignores malformed JSON gracefully', () => {
      expect(parseSseLine('data: {not json')).toBeNull();
    });

    test('ignores frames with neither content nor usage', () => {
      expect(parseSseLine('data: {"choices":[{"delta":{}}]}')).toBeNull();
    });

    test('extracts a reasoning_content delta and a finish_reason', () => {
      expect(parseSseLine('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}')).toEqual({ reasoning: 'thinking' });
      expect(parseSseLine('data: {"choices":[{"delta":{},"finish_reason":"length"}]}')).toEqual({ finishReason: 'length' });
    });

    test('trims whitespace around the payload', () => {
      expect(parseSseLine('  data:   {"choices":[{"delta":{"content":"y"}}]}  ')).toEqual({ content: 'y' });
    });
  });

  describe('readSseStream', () => {
    // Collect content strings + the terminal __final frame from the generator.
    async function drain(gen) {
      const chunks = [];
      let final = null;
      for await (const v of gen) {
        if (v && v.__final) final = v;
        else chunks.push(v);
      }
      return { chunks, final };
    }

    test('streams content deltas and a terminal __final with usage + charCount', async () => {
      const lines = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"usage":{"total_tokens":2}}',
        'data: [DONE]',
      ];
      const res = { body: null, text: async () => lines.join('\n') };
      const { chunks, final } = await drain(readSseStream(res, 1000));
      expect(chunks).toEqual(['Hel', 'lo']);
      expect(final).toMatchObject({ __final: true, usage: { total_tokens: 2 } });
      expect(final.charCount).toBe(5);
      expect(final.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    test('drives a ReadableStream-style body via getReader()', async () => {
      // Build a fake reader that yields chunks encoded as Uint8Arrays, split
      // across two reads so the line-buffer logic is exercised.
      const encoder = new TextEncoder();
      const reads = [
        encoder.encode('data: {"choices":[{"delta":{"content":"A"}}]}\n'),
        encoder.encode('data: {"choices":[{"delta":{"content":"B"}}]}\n'),
      ];
      let i = 0;
      const reader = {
        read: async () => (i < reads.length ? { value: reads[i++], done: false } : { value: undefined, done: true }),
        cancel: jest.fn(),
      };
      const res = { body: { getReader: () => reader } };
      const { chunks, final } = await drain(readSseStream(res, 1000));
      expect(chunks).toEqual(['A', 'B']);
      expect(final.charCount).toBe(2);
      expect(reader.cancel).toHaveBeenCalled();
    });

    test('joins a content delta split across two reader reads (line buffering)', async () => {
      const encoder = new TextEncoder();
      const reads = [
        encoder.encode('data: {"choices":[{"delta":{"content":"par'), // no newline yet
        encoder.encode('tial"}}]}\n'), // completes the line on next read
      ];
      let i = 0;
      const reader = {
        read: async () => (i < reads.length ? { value: reads[i++], done: false } : { value: undefined, done: true }),
        cancel: jest.fn(),
      };
      const res = { body: { getReader: () => reader } };
      const { chunks } = await drain(readSseStream(res, 1000));
      expect(chunks).toEqual(['partial']);
    });

    test('emits a __final even when the stream produces no content', async () => {
      const res = { body: null, text: async () => 'data: [DONE]' };
      const { chunks, final } = await drain(readSseStream(res, 1000));
      expect(chunks).toEqual([]);
      expect(final).toMatchObject({ __final: true, charCount: 0 });
      expect(final.usage).toBeNull();
    });

    test('a reasoning-only completion yields no content but reports the reasoning it burned', async () => {
      // SGLang/vLLM shape: every completion token lands in reasoning_content and
      // the budget runs out before a single visible character is emitted.
      const lines = [
        'data: {"choices":[{"delta":{"reasoning_content":"step one"}}]}',
        'data: {"choices":[{"delta":{"reasoning_content":" step two"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        'data: [DONE]',
      ];
      const res = { body: null, text: async () => lines.join('\n') };
      const { chunks, final } = await drain(readSseStream(res, 1000));
      expect(chunks).toEqual([]);
      expect(final.charCount).toBe(0);
      expect(final.reasoningCharCount).toBe(17);
      expect(final.finishReason).toBe('length');
    });

    test('flushes a trailing data line with no final newline (no dropped final event)', async () => {
      // A server that closes the stream mid-event without a trailing newline.
      // Before the final-buffer flush, this usage frame was silently dropped.
      const encoder = new TextEncoder();
      const reads = [
        encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n'),
        encoder.encode('data: {"usage":{"total_tokens":2}}'), // no trailing newline
      ];
      let i = 0;
      const reader = {
        read: async () => (i < reads.length ? { value: reads[i++], done: false } : { value: undefined, done: true }),
        cancel: jest.fn(),
      };
      const res = { body: { getReader: () => reader } };
      const { chunks, final } = await drain(readSseStream(res, 1000));
      expect(chunks).toEqual(['hi']);
      expect(final).toMatchObject({ __final: true, usage: { total_tokens: 2 } });
    });
  });

  describe('streamed tool calls', () => {
    const frame = (toolCalls, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, ...extra }] })}`;

    test('parseSseLine surfaces delta.tool_calls', () => {
      const frag = [{ index: 0, id: 'c1', function: { name: 'browser.read_tab', arguments: '' } }];
      expect(parseSseLine(frame(frag))).toEqual({ toolCalls: frag });
    });

    test('readSseStream assembles interleaved fragments of two calls by index', async () => {
      const lines = [
        frame([{ index: 0, id: 'c1', type: 'function', function: { name: 'browser.read_tab', arguments: '' } }]),
        frame([{ index: 1, id: 'c2', type: 'function', function: { name: 'fs.read', arguments: '{"pa' } }]),
        frame([{ index: 0, function: { arguments: '{"spaceId":' } }]),
        frame([{ index: 1, function: { arguments: 'th":"a.md"}' } }]),
        frame([{ index: 0, function: { arguments: '"s1"}' } }]),
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ];
      const res = { body: null, text: async () => lines.join('\n') };
      const chunks = [];
      let final = null;
      for await (const v of readSseStream(res, Date.now())) { if (v && v.__final) final = v; else chunks.push(v); }
      expect(chunks).toEqual([]);
      expect(final.finishReason).toBe('tool_calls');
      expect(final.toolCalls).toEqual([
        { id: 'c1', type: 'function', function: { name: 'browser.read_tab', arguments: '{"spaceId":"s1"}' } },
        { id: 'c2', type: 'function', function: { name: 'fs.read', arguments: '{"path":"a.md"}' } },
      ]);
      expect(JSON.parse(final.toolCalls[0].function.arguments)).toEqual({ spaceId: 's1' });
    });

    test('a content-only stream reports toolCalls null', async () => {
      const res = { body: null, text: async () => 'data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]' };
      let final = null;
      for await (const v of readSseStream(res, Date.now())) if (v && v.__final) final = v;
      expect(final.toolCalls).toBeNull();
    });

    test('fragments without index continue the last call unless they carry a new id', () => {
      const a = createToolCallAssembler();
      a.push([{ id: 'x', function: { name: 'agent.done', arguments: '{"sum' } }]);
      a.push([{ function: { arguments: 'mary":"ok"}' } }]);
      a.push([{ id: 'y', function: { name: 'browser.web_search', arguments: '{}' } }]);
      expect(a.result()).toEqual([
        { id: 'x', type: 'function', function: { name: 'agent.done', arguments: '{"summary":"ok"}' } },
        { id: 'y', type: 'function', function: { name: 'browser.web_search', arguments: '{}' } },
      ]);
    });

    test('a name repeated on every fragment is not doubled; missing ids and arguments get defaults', () => {
      const a = createToolCallAssembler();
      a.push([{ index: 0, function: { name: 'agent.done' } }]);
      a.push([{ index: 0, function: { name: 'agent.done' } }]);
      expect(a.result()).toEqual([{ id: 'call_stream_0', type: 'function', function: { name: 'agent.done', arguments: '{}' } }]);
    });

    test('nameless fragments and junk entries yield no calls', () => {
      const a = createToolCallAssembler();
      a.push([null, 'x', { index: 0, function: { arguments: '{"a":1}' } }]);
      expect(a.result()).toBeNull();
    });
  });
});
