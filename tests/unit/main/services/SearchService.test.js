const { SearchService } = require('../../../../main/services/SearchService');

function svc(searchCfg) {
  const s = new SearchService();
  s._setConfig({ get: (k, d) => (k === 'settings.search' ? (searchCfg || {}) : d) });
  return s;
}

describe('SearchService.normalize', () => {
  test('drops non-http urls and blank titles, dedupes, clamps, trims', () => {
    const s = svc();
    const out = s.normalize([
      { title: 'A', url: 'https://a.com', snippet: 'sa' },
      { title: '', url: 'https://noTitle.com', snippet: 'x' },
      { title: 'Bad scheme', url: 'ftp://nope.com', snippet: 'x' },
      { title: 'A dup', url: 'https://a.com', snippet: 'dup' },
      { title: 'B', url: 'https://b.com', snippet: 'sb' },
      { title: 'C', url: 'https://c.com', snippet: 'sc' },
    ], 2);
    expect(out).toEqual([
      { title: 'A', url: 'https://a.com', snippet: 'sa' },
      { title: 'B', url: 'https://b.com', snippet: 'sb' },
    ]);
  });

  test('caps title at 300 and snippet at 500 chars', () => {
    const s = svc();
    const [r] = s.normalize([{ title: 'T'.repeat(400), url: 'https://x.com', snippet: 'S'.repeat(900) }], 5);
    expect(r.title).toHaveLength(300);
    expect(r.snippet).toHaveLength(500);
  });
});

describe('SearchService.serpUrl', () => {
  test('builds per-engine query urls and falls back to duckduckgo', () => {
    const s = svc();
    expect(s.serpUrl('duckduckgo', 'a b')).toBe('https://html.duckduckgo.com/html/?q=a%20b');
    expect(s.serpUrl('bing', 'a b')).toContain('bing.com/search?setlang=en&q=a%20b');
    expect(s.serpUrl('startpage', 'a')).toBe('https://www.startpage.com/sp/search?query=a');
    expect(s.serpUrl('unknown-engine', 'a')).toContain('duckduckgo.com/html');
  });
});

describe('SearchService provider + count resolution', () => {
  test('defaults to inBrowser when unset', () => {
    expect(svc({}).getProvider()).toBe('inBrowser');
    expect(svc({ provider: 'brave' }).getProvider()).toBe('brave');
  });

  test('count clamps to 1..10 and honors config default', () => {
    expect(svc({ resultCount: 6 })._count(undefined)).toBe(6);
    expect(svc({ resultCount: 6 })._count(3)).toBe(3);
    expect(svc({ resultCount: 6 })._count(99)).toBe(10);
    expect(svc({ resultCount: 6 })._count(0)).toBe(6);
    expect(svc({})._count(undefined)).toBe(6);
  });
});

describe('SearchService.search dispatch', () => {
  test('empty query short-circuits', async () => {
    expect(await svc({}).search('   ')).toEqual({ ok: false, error: 'empty_query' });
  });

  test('inBrowser provider opens a tab, scrapes it, then closes it', async () => {
    const s = svc({ provider: 'inBrowser', inBrowserEngine: 'duckduckgo', resultCount: 3 });
    const wc = {
      isLoading: () => false,
      executeJavaScript: jest.fn(async () => ([
        { title: 'Result one', url: 'https://one.example', snippet: 'first' },
        { title: 'Result two', url: 'https://two.example', snippet: 'second' },
      ])),
    };
    const tabOps = {
      openTab: jest.fn(async () => ({ ok: true, spaceId: 'tab_s' })),
      closeTab: jest.fn(async () => ({ ok: true })),
    };
    const r = await s.search('cats', {}, { tabOps, resolveWc: () => wc });
    expect(tabOps.openTab).toHaveBeenCalledWith('https://html.duckduckgo.com/html/?q=cats');
    expect(wc.executeJavaScript).toHaveBeenCalled();
    expect(tabOps.closeTab).toHaveBeenCalledWith('tab_s');
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('inBrowser');
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toEqual({ title: 'Result one', url: 'https://one.example', snippet: 'first' });
  });

  test('inBrowser still closes the tab when scraping throws', async () => {
    const s = svc({ provider: 'inBrowser' });
    const wc = { isLoading: () => false, executeJavaScript: jest.fn(async () => { throw new Error('eval boom'); }) };
    const tabOps = {
      openTab: jest.fn(async () => ({ ok: true, spaceId: 'tab_x' })),
      closeTab: jest.fn(async () => ({ ok: true })),
    };
    const r = await s.search('q', {}, { tabOps, resolveWc: () => wc });
    expect(r).toMatchObject({ ok: false, error: 'eval boom' });
    expect(tabOps.closeTab).toHaveBeenCalledWith('tab_x');
  });

  test('inBrowser without tabOps fails loudly', async () => {
    const r = await svc({ provider: 'inBrowser' }).search('q', {}, {});
    expect(r).toEqual({ ok: false, error: 'in_browser_unavailable' });
  });

  test('inBrowser surfaces a hint when zero results parsed', async () => {
    const s = svc({ provider: 'inBrowser' });
    const wc = { isLoading: () => false, executeJavaScript: jest.fn(async () => []) };
    const tabOps = { openTab: jest.fn(async () => ({ ok: true, spaceId: 't' })), closeTab: jest.fn(async () => ({})) };
    const r = await s.search('q', {}, { tabOps, resolveWc: () => wc });
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(0);
    expect(r.hint).toMatch(/challenge page|different query/i);
  });
});

describe('SearchService HTTP providers', () => {
  test('searxng requires a configured url', async () => {
    const r = await svc({ provider: 'searxng', searxngUrl: '' }).search('q');
    expect(r).toMatchObject({ ok: false, error: 'searxng_not_configured' });
  });

  test('searxng maps results[].content → snippet', async () => {
    const s = svc({ provider: 'searxng', searxngUrl: 'https://searx.test/', resultCount: 5 });
    s._setFetch(jest.fn(async (url) => {
      expect(url).toBe('https://searx.test/search?format=json&safesearch=0&q=q');
      return { ok: true, json: async () => ({ results: [{ title: 'S', url: 'https://s.com', content: 'snip' }] }) };
    }));
    const r = await s.search('q');
    expect(r).toMatchObject({ ok: true, provider: 'searxng' });
    expect(r.results[0]).toEqual({ title: 'S', url: 'https://s.com', snippet: 'snip' });
  });

  test('brave requires a key and sends the subscription header', async () => {
    expect(await svc({ provider: 'brave' }).search('q')).toMatchObject({ ok: false, error: 'brave_not_configured' });
    const s = svc({ provider: 'brave', braveApiKey: 'KEY', resultCount: 4 });
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ web: { results: [{ title: 'B', url: 'https://b.com', description: 'd' }] } }) }));
    s._setFetch(fetchMock);
    const r = await s.search('hello world');
    expect(fetchMock.mock.calls[0][0]).toContain('q=hello%20world');
    expect(fetchMock.mock.calls[0][1].headers['X-Subscription-Token']).toBe('KEY');
    expect(r.results[0]).toEqual({ title: 'B', url: 'https://b.com', snippet: 'd' });
  });

  test('tavily posts the key + query and maps content → snippet', async () => {
    expect(await svc({ provider: 'tavily' }).search('q')).toMatchObject({ ok: false, error: 'tavily_not_configured' });
    const s = svc({ provider: 'tavily', tavilyApiKey: 'tvly', resultCount: 2 });
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ results: [{ title: 'T', url: 'https://t.com', content: 'c' }] }) }));
    s._setFetch(fetchMock);
    const r = await s.search('q');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ api_key: 'tvly', query: 'q', max_results: 2 });
    expect(r.results[0]).toEqual({ title: 'T', url: 'https://t.com', snippet: 'c' });
  });

  test('http error from a provider is surfaced, not swallowed', async () => {
    const s = svc({ provider: 'searxng', searxngUrl: 'https://searx.test' });
    s._setFetch(jest.fn(async () => ({ ok: false, status: 503 })));
    expect(await s.search('q')).toEqual({ ok: false, error: 'http_503' });
  });

  test('an unknown provider name is reported, not silently defaulted', async () => {
    const r = await svc({ provider: 'lycos' }).httpSearch('lycos', 'q', 5);
    expect(r).toEqual({ ok: false, error: 'unknown_provider:lycos' });
  });

  test('_json reports fetch_unavailable when no fetch is wired', async () => {
    const s = svc({ provider: 'searxng', searxngUrl: 'https://searx.test' });
    s._setFetch(null);
    expect(await s.search('q')).toEqual({ ok: false, error: 'fetch_unavailable' });
  });

  test('_json maps an AbortError to search_timeout', async () => {
    const s = svc({ provider: 'brave', braveApiKey: 'K' });
    s._setFetch(jest.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }));
    expect(await s.search('q')).toEqual({ ok: false, error: 'search_timeout' });
  });

  test('_json maps a generic network error to its message', async () => {
    const s = svc({ provider: 'tavily', tavilyApiKey: 'K' });
    s._setFetch(jest.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await s.search('q')).toEqual({ ok: false, error: 'ECONNRESET' });
  });

  test('_json maps a non-Error throw to fetch_failed', async () => {
    const s = svc({ provider: 'tavily', tavilyApiKey: 'K' });
    s._setFetch(jest.fn(async () => { throw 'string blow-up'; }));
    expect(await s.search('q')).toEqual({ ok: false, error: 'fetch_failed' });
  });

  test('_json returns http_error when fetch resolves to no response', async () => {
    const s = svc({ provider: 'searxng', searxngUrl: 'https://searx.test' });
    s._setFetch(jest.fn(async () => null));
    expect(await s.search('q')).toEqual({ ok: false, error: 'http_error' });
  });

  test('searxng tolerates a body with no results array', async () => {
    const s = svc({ provider: 'searxng', searxngUrl: 'https://searx.test', resultCount: 5 });
    s._setFetch(jest.fn(async () => ({ ok: true, json: async () => ({}) })));
    const r = await s.search('q');
    expect(r).toMatchObject({ ok: true, provider: 'searxng', count: 0 });
    expect(r.results).toEqual([]);
  });

  test('brave tolerates a body with no web.results', async () => {
    const s = svc({ provider: 'brave', braveApiKey: 'K' });
    s._setFetch(jest.fn(async () => ({ ok: true, json: async () => ({}) })));
    const r = await s.search('q');
    expect(r).toMatchObject({ ok: true, provider: 'brave', count: 0 });
  });
});

describe('SearchService inBrowser failure arms', () => {
  test('returns tab_open_failed when openTab yields no spaceId', async () => {
    const s = svc({ provider: 'inBrowser' });
    const tabOps = { openTab: jest.fn(async () => ({ ok: false })), closeTab: jest.fn() };
    const r = await s.search('q', {}, { tabOps, resolveWc: () => ({}) });
    expect(r).toEqual({ ok: false, error: 'tab_open_failed' });
    expect(tabOps.closeTab).not.toHaveBeenCalled(); // no spaceId → nothing to close
  });

  test('returns webcontents_unavailable when resolveWc has no executeJavaScript', async () => {
    const s = svc({ provider: 'inBrowser' });
    const tabOps = { openTab: jest.fn(async () => ({ ok: true, spaceId: 'tab_z' })), closeTab: jest.fn(async () => ({})) };
    const r = await s.search('q', {}, { tabOps, resolveWc: () => null });
    expect(r).toEqual({ ok: false, error: 'webcontents_unavailable' });
    expect(tabOps.closeTab).toHaveBeenCalledWith('tab_z'); // tab was opened → cleaned up
  });

  test('resolveWc not a function fails as in_browser_unavailable', async () => {
    const s = svc({ provider: 'inBrowser' });
    const r = await s.search('q', {}, { tabOps: { openTab: () => {} }, resolveWc: 'nope' });
    expect(r).toEqual({ ok: false, error: 'in_browser_unavailable' });
  });

  test('a non-Error scrape throw degrades to in_browser_search_failed', async () => {
    const s = svc({ provider: 'inBrowser' });
    const wc = { isLoading: () => false, executeJavaScript: jest.fn(async () => { throw 'weird string'; }) };
    const tabOps = { openTab: jest.fn(async () => ({ ok: true, spaceId: 't' })), closeTab: jest.fn(async () => ({})) };
    const r = await s.search('q', {}, { tabOps, resolveWc: () => wc });
    expect(r).toEqual({ ok: false, error: 'in_browser_search_failed' });
  });

  test('a closeTab failure after a successful scrape is non-fatal', async () => {
    const s = svc({ provider: 'inBrowser' });
    const wc = {
      isLoading: () => false,
      executeJavaScript: jest.fn(async () => ([{ title: 'R', url: 'https://r.example', snippet: 's' }])),
    };
    const tabOps = {
      openTab: jest.fn(async () => ({ ok: true, spaceId: 't' })),
      closeTab: jest.fn(async () => { throw new Error('last-tab guard'); }),
    };
    const r = await s.search('cats', {}, { tabOps, resolveWc: () => wc });
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(1);
  });

  test('_waitSettled registers did-finish-load while loading and resolves on the event', async () => {
    jest.useFakeTimers();
    const s = svc({});
    let finishCb;
    const wc = {
      isLoading: jest.fn(() => true),
      once: jest.fn((evt, cb) => { if (evt === 'did-finish-load') finishCb = cb; }),
      executeJavaScript: () => {},
    };
    const settled = s._waitSettled(wc);
    expect(wc.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
    finishCb();                 // page finished → first inner promise resolves
    await Promise.resolve();    // let the awaited first promise settle
    jest.advanceTimersByTime(500); // flush the SETTLE_MS settle delay
    await expect(settled).resolves.toBeUndefined();
    jest.useRealTimers();
  });

  test('_waitSettled tolerates a wc.once that throws (falls back to the timeout)', async () => {
    jest.useFakeTimers();
    const s = svc({});
    const wc = {
      isLoading: jest.fn(() => true),
      once: jest.fn(() => { throw new Error('no once'); }),
      executeJavaScript: () => {},
    };
    const settled = s._waitSettled(wc);
    // wc.once threw → only the LOAD_WAIT_MS fallback timer can resolve the wait.
    jest.advanceTimersByTime(9000);
    await Promise.resolve();
    jest.advanceTimersByTime(500); // then the SETTLE_MS delay
    await expect(settled).resolves.toBeUndefined();
    jest.useRealTimers();
  });

  test('_waitSettled skips the load wait when the page is not loading', async () => {
    jest.useFakeTimers();
    const s = svc({});
    const wc = { isLoading: jest.fn(() => false), once: jest.fn(), executeJavaScript: () => {} };
    const settled = s._waitSettled(wc);
    jest.advanceTimersByTime(500); // only the SETTLE_MS delay applies
    await expect(settled).resolves.toBeUndefined();
    expect(wc.once).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('_waitSettled returns immediately when wc lacks executeJavaScript', async () => {
    const s = svc({});
    await expect(s._waitSettled(null)).resolves.toBeUndefined();
    await expect(s._waitSettled({})).resolves.toBeUndefined();
  });

  test('_count uses the configured default when requested is non-positive', () => {
    expect(svc({ resultCount: 0 })._count(undefined)).toBe(6); // cfgN falls back to 6
    expect(svc({})._count(-5)).toBe(6);
  });

  test('_engine falls back to duckduckgo for an unknown configured engine', () => {
    expect(svc({ inBrowserEngine: 'altavista' })._engine()).toBe('duckduckgo');
    expect(svc({ inBrowserEngine: 'bing' })._engine()).toBe('bing');
  });

  test('_cfg tolerates a config service that returns a non-object', () => {
    const s = new SearchService();
    s._setConfig({ get: () => 'not-an-object' });
    expect(s.getProvider()).toBe('inBrowser');
    const s2 = new SearchService();
    s2._setConfig(null);
    expect(s2.getProvider()).toBe('inBrowser');
  });
});

describe('SearchService inBrowser — registry announce race', () => {
  // Mirrors production: AgentWorkspaceManager replies {ok, spaceId} to openTab
  // before the renderer's async did-attach/space-activity announce lands in
  // tabRegistry, so the early resolveWc polls see null.
  test('polls resolveWc until the tabRegistry entry lands instead of failing once', async () => {
    jest.useFakeTimers();
    const s = svc({ provider: 'inBrowser' });
    const wc = {
      isLoading: () => false,
      executeJavaScript: jest.fn(async () => ([{ title: 'R', url: 'https://r.example', snippet: 's' }])),
    };
    let polls = 0;
    const resolveWc = jest.fn(() => { polls += 1; return polls >= 3 ? wc : null; });
    const tabOps = {
      openTab: jest.fn(async () => ({ ok: true, spaceId: 'tab_r' })),
      closeTab: jest.fn(async () => ({ ok: true })),
    };
    const p = s.search('q', {}, { tabOps, resolveWc });
    await jest.advanceTimersByTimeAsync(4000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(resolveWc.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(tabOps.closeTab).toHaveBeenCalledWith('tab_r');
    jest.useRealTimers();
  });

  test('only reports webcontents_unavailable after the bounded poll times out, tab still closed', async () => {
    jest.useFakeTimers();
    const s = svc({ provider: 'inBrowser' });
    const resolveWc = jest.fn(() => null);
    const tabOps = {
      openTab: jest.fn(async () => ({ ok: true, spaceId: 'tab_n' })),
      closeTab: jest.fn(async () => ({ ok: true })),
    };
    const p = s.search('q', {}, { tabOps, resolveWc });
    await jest.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r).toEqual({ ok: false, error: 'webcontents_unavailable' });
    expect(tabOps.closeTab).toHaveBeenCalledWith('tab_n');
    jest.useRealTimers();
  });

  test('a throwing resolveWc is caught (console.error, not crash) and retried until timeout', async () => {
    jest.useFakeTimers();
    const s = svc({ provider: 'inBrowser' });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const tabOps = {
      openTab: jest.fn(async () => ({ ok: true, spaceId: 'tab_t' })),
      closeTab: jest.fn(async () => ({ ok: true })),
    };
    const p = s.search('q', {}, { tabOps, resolveWc: () => { throw new Error('registry boom'); } });
    await jest.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r).toEqual({ ok: false, error: 'webcontents_unavailable' });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    jest.useRealTimers();
  });

  test('readPage polls resolveWc the same way', async () => {
    jest.useFakeTimers();
    const s = svc();
    const wc = {
      isLoading: () => false,
      executeJavaScript: jest.fn(async () => ({ title: 'P', mainText: 'Body.' })),
    };
    let polls = 0;
    const resolveWc = jest.fn(() => { polls += 1; return polls >= 2 ? wc : null; });
    const tabOps = {
      openTab: jest.fn(async () => ({ ok: true, spaceId: 'tab_p2' })),
      closeTab: jest.fn(async () => ({ ok: true })),
    };
    const p = s.readPage('https://example.com', { tabOps, resolveWc });
    await jest.advanceTimersByTimeAsync(4000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Body.');
    jest.useRealTimers();
  });
});

describe('SearchService.readPage', () => {
  test('rejects a non-http(s) url before opening a tab', async () => {
    const s = svc();
    const tabOps = { openTab: jest.fn(), closeTab: jest.fn() };
    const r = await s.readPage('ftp://nope.example', { tabOps, resolveWc: () => null });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_url');
    expect(tabOps.openTab).not.toHaveBeenCalled();
  });

  test('requires the in-browser tab ops context', async () => {
    const s = svc();
    const r = await s.readPage('https://example.com', {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('in_browser_unavailable');
  });

  test('opens the url, extracts readable text, then closes the tab', async () => {
    const s = svc();
    const wc = {
      isLoading: () => false,
      executeJavaScript: jest.fn(async () => ({ title: 'The Page', mainText: 'Body text here.' })),
    };
    const tabOps = {
      openTab: jest.fn(async () => ({ ok: true, spaceId: 'tab_p' })),
      closeTab: jest.fn(async () => ({ ok: true })),
    };
    const r = await s.readPage('https://example.com/article', { tabOps, resolveWc: () => wc });
    expect(tabOps.openTab).toHaveBeenCalledWith('https://example.com/article');
    expect(wc.executeJavaScript).toHaveBeenCalled();
    expect(tabOps.closeTab).toHaveBeenCalledWith('tab_p');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://example.com/article');
    expect(r.title).toBe('The Page');
    expect(r.text).toBe('Body text here.');
  });

  test('fails gracefully but still closes the tab when extraction yields no body', async () => {
    const s = svc();
    const wc = { isLoading: () => false, executeJavaScript: jest.fn(async () => ({ title: 'Empty', mainText: '   ' })) };
    const tabOps = {
      openTab: jest.fn(async () => ({ ok: true, spaceId: 'tab_e' })),
      closeTab: jest.fn(async () => ({ ok: true })),
    };
    const r = await s.readPage('https://example.com', { tabOps, resolveWc: () => wc });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty_page');
    expect(tabOps.closeTab).toHaveBeenCalledWith('tab_e');
  });

  test('closes the tab even when the webContents throws', async () => {
    const s = svc();
    const wc = { isLoading: () => false, executeJavaScript: jest.fn(async () => { throw new Error('eval boom'); }) };
    const tabOps = {
      openTab: jest.fn(async () => ({ ok: true, spaceId: 'tab_x' })),
      closeTab: jest.fn(async () => ({ ok: true })),
    };
    const r = await s.readPage('https://example.com', { tabOps, resolveWc: () => wc });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('eval boom');
    expect(tabOps.closeTab).toHaveBeenCalledWith('tab_x');
  });
});
