// searchSuggest — endpoint choice, OpenSearch parsing and failure surfacing.
// The network boundary is the injected `fetch`.
const {
  fetchSuggestions, suggestTemplateFor, parseSuggestions, SUGGEST_ENDPOINTS,
} = require('../../../../main/services/searchSuggest');

function respond(body, { ok = true, status = 200 } = {}) {
  return jest.fn(() => Promise.resolve({ ok, status, text: () => Promise.resolve(body) }));
}

describe('suggestTemplateFor', () => {
  test('built-in engines map to their endpoint; engines without one get none', () => {
    expect(suggestTemplateFor('duckduckgo', [])).toBe(SUGGEST_ENDPOINTS.duckduckgo);
    expect(suggestTemplateFor('nope', undefined)).toBeNull();
  });

  // Documented at help.kagi.com/kagi/getting-started/setting-default.html and
  // answers without a session cookie, so it works with credentials omitted.
  test('kagi uses its documented autosuggest endpoint', async () => {
    expect(suggestTemplateFor('kagi', [])).toBe('https://kagi.com/api/autosuggest?q=%s');
    const fetch = respond(JSON.stringify(['cat', ['cat facts']]));
    await expect(fetchSuggestions({ engine: 'kagi', query: 'cat', fetch })).resolves.toEqual(['cat facts']);
    expect(fetch.mock.calls[0][0]).toBe('https://kagi.com/api/autosuggest?q=cat');
  });

  test('a custom engine uses its own https suggest URL, and only that', () => {
    const custom = [{ id: 'mine', url: 'https://s.example/?q=%s', suggest: 'https://s.example/ac?q=%s' }];
    expect(suggestTemplateFor('mine', custom)).toBe('https://s.example/ac?q=%s');
    expect(suggestTemplateFor('mine', [{ id: 'mine', url: 'x' }])).toBeNull();
    expect(suggestTemplateFor('mine', [{ id: 'mine', url: 'x', suggest: 'http://s.example/ac?q=%s' }])).toBeNull();
    // A custom engine that reuses a built-in id replaces it, endpoint included.
    expect(suggestTemplateFor('google', [{ id: 'google', url: 'x' }])).toBeNull();
  });
});

describe('parseSuggestions', () => {
  test('returns trimmed, de-duplicated strings without the query itself, capped at 6', () => {
    const body = JSON.stringify(['cat', ['cat', ' cats ', 'Cats', 42, '', 'a', 'b', 'c', 'd', 'e', 'f']]);
    expect(parseSuggestions(body, 'cat')).toEqual(['cats', 'a', 'b', 'c', 'd', 'e']);
  });

  test('a body in any other shape is an error, not an empty list', () => {
    expect(() => parseSuggestions('{"q":1}', 'q')).toThrow(/OpenSearch/);
    expect(() => parseSuggestions('<html>', 'q')).toThrow(SyntaxError);
  });
});

describe('fetchSuggestions', () => {
  test('requests the engine endpoint with the query encoded and cookies omitted', async () => {
    const fetch = respond(JSON.stringify(['a b', ['a b c']]));
    await expect(fetchSuggestions({ engine: 'brave', query: ' a b&c ', fetch })).resolves.toEqual(['a b c']);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://search.brave.com/api/suggest?q=a%20b%26c');
    expect(init.credentials).toBe('omit');
    expect(init.signal).toBeDefined();
  });

  test('no endpoint or an empty query makes no request', async () => {
    const fetch = respond('[]');
    await expect(fetchSuggestions({ engine: 'nope', query: 'x', fetch })).resolves.toEqual([]);
    await expect(fetchSuggestions({ engine: 'google', query: '   ', fetch })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an HTTP error rejects', async () => {
    await expect(fetchSuggestions({ engine: 'google', query: 'x', fetch: respond('', { ok: false, status: 429 }) }))
      .rejects.toThrow('HTTP 429');
  });

  test('a request that never answers is aborted at the timeout', async () => {
    jest.useFakeTimers();
    const fetch = jest.fn((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    const pending = fetchSuggestions({ engine: 'google', query: 'x', fetch, timeoutMs: 1000 });
    jest.advanceTimersByTime(1000);
    await expect(pending).rejects.toThrow('no answer within 1000 ms');
    jest.useRealTimers();
  });
});
