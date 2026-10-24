const { chatCompletionJson } = require('../../../../main/services/llmJson');

// Build a fake LLMClientService whose chatCompletion resolves to scripted
// responses, in order. Each entry is either a string (res.content) or a
// { content, usage, tokens } object. A function entry is called per call to
// support request-inspection.
function makeClient(queue) {
  let i = 0;
  const calls = [];
  const client = {
    calls,
    chatCompletion: jest.fn((messages, opts) => {
      calls.push({ messages, opts });
      const item = queue[i++];
      if (typeof item === 'function') return Promise.resolve(item(messages, opts));
      if (item && item.reject) return Promise.reject(new Error(item.reject));
      const content = typeof item === 'string' ? item : (item && item.content);
      return Promise.resolve({
        content,
        usage: item && item.usage,
        tokens: item && item.tokens,
      });
    }),
  };
  return client;
}

describe('llmJson chatCompletionJson', () => {
  test('parses valid JSON and validates it against the schema (happy path)', async () => {
    const client = makeClient(['{"answer":"yes","count":3}']);
    const res = await chatCompletionJson(
      client,
      [{ role: 'user', content: 'go' }],
      { answer: 'string', count: 'number' }
    );
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ answer: 'yes', count: 3 });
    expect(res.retryUsed).toBe(false);
    expect(client.chatCompletion).toHaveBeenCalledTimes(1);
    // response_format is forced on for JSON mode
    expect(client.calls[0].opts.responseFormat).toEqual({ type: 'json_object' });
  });

  test('passes through caller options merged with responseFormat', async () => {
    const client = makeClient(['{"x":1}']);
    await chatCompletionJson(client, [{ role: 'user', content: 'go' }], null, {
      temperature: 0.2,
      maxTokens: 50,
    });
    expect(client.calls[0].opts).toMatchObject({
      temperature: 0.2,
      maxTokens: 50,
      responseFormat: { type: 'json_object' },
    });
  });

  test('allows extra keys in the model output (additive schema check)', async () => {
    const client = makeClient(['{"answer":"ok","extra":true}']);
    const res = await chatCompletionJson(
      client,
      [{ role: 'user', content: 'go' }],
      { answer: 'string' }
    );
    expect(res.ok).toBe(true);
    expect(res.value.extra).toBe(true);
  });

  test('validates array type with Array.isArray', async () => {
    const client = makeClient(['{"items":[1,2]}']);
    const res = await chatCompletionJson(
      client,
      [{ role: 'user', content: 'go' }],
      { items: 'array' }
    );
    expect(res.ok).toBe(true);
    expect(res.value.items).toEqual([1, 2]);
  });

  test('retries once on malformed JSON, then succeeds on the repair turn', async () => {
    const client = makeClient([
      '```json\n{"answer":"x"}\n```', // not parseable
      '{"answer":"x"}', // valid on retry
    ]);
    const res = await chatCompletionJson(
      client,
      [{ role: 'user', content: 'go' }],
      { answer: 'string' }
    );
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ answer: 'x' });
    expect(res.retryUsed).toBe(true);
    // The retry appends an assistant turn + a repair instruction
    const retryMessages = client.calls[1].messages;
    expect(retryMessages.at(-1).role).toBe('user');
    expect(retryMessages.at(-1).content).toMatch(/valid JSON/i);
  });

  test('returns a parse error after the retry budget is exhausted', async () => {
    const client = makeClient(['{not json', '{also not json']);
    const res = await chatCompletionJson(
      client,
      [{ role: 'user', content: 'go' }],
      { answer: 'string' }
    );
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('parse');
    expect(res.retryUsed).toBe(true);
    expect(res.error).toMatch(/json/i);
    expect(res.raw).toBeDefined();
  });

  test('retries once on schema mismatch, then succeeds', async () => {
    const client = makeClient([
      '{"answer":42}', // wrong type (number, not string)
      '{"answer":"fixed"}',
    ]);
    const res = await chatCompletionJson(
      client,
      [{ role: 'user', content: 'go' }],
      { answer: 'string' }
    );
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ answer: 'fixed' });
    expect(res.retryUsed).toBe(true);
    const retryMsg = client.calls[1].messages.at(-1).content;
    expect(retryMsg).toMatch(/schema/i);
    expect(retryMsg).toMatch(/answer:string|answer/);
  });

  test('reports missing keys in the schema-mismatch error after retry', async () => {
    const client = makeClient(['{"a":1}', '{"a":1}']); // missing "b"
    const res = await chatCompletionJson(
      client,
      [{ role: 'user', content: 'go' }],
      { a: 'number', b: 'string' }
    );
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('schema');
    expect(res.error).toMatch(/missing/);
    expect(res.error).toMatch(/b/);
  });

  test('surfaces a chatCompletion rejection as a request-stage failure', async () => {
    const client = makeClient([{ reject: 'connection refused' }]);
    const res = await chatCompletionJson(
      client,
      [{ role: 'user', content: 'go' }],
      { answer: 'string' }
    );
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('request');
    expect(res.error).toMatch(/connection refused/);
  });

  test('no schema = pure JSON.parse validation only', async () => {
    const client = makeClient(['{"anything":"goes","n":[1,2,3]}']);
    const res = await chatCompletionJson(client, [{ role: 'user', content: 'go' }]);
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ anything: 'goes', n: [1, 2, 3] });
  });
});
