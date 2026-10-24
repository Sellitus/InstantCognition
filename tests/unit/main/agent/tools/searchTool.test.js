const searchTools = require('../../../../../main/agent/tools/searchTool');
const searchService = require('../../../../../main/services/SearchService');

const [webSearch] = searchTools;

describe('browser.web_search tool', () => {
  test('exposes schema with required query and is serialized as a tab op', () => {
    expect(webSearch.name).toBe('browser.web_search');
    expect(webSearch.parameters.required).toEqual(['query']);
    expect(webSearch.sideEffect).toBe(true);
    expect(webSearch.targetSpaceKey).toBe('_tabOp');
  });

  test('rejects empty query before touching SearchService', async () => {
    const orig = searchService.search;
    searchService.search = jest.fn();
    try {
      const r = await webSearch.handler({ query: '   ' }, {});
      expect(r).toEqual({ ok: false, error: 'empty_query' });
      expect(searchService.search).not.toHaveBeenCalled();
    } finally { searchService.search = orig; }
  });

  test('delegates to SearchService.search with tabOps + resolveWc from toolCtx', async () => {
    const orig = searchService.search;
    searchService.search = jest.fn(async () => ({ ok: true, results: [{ title: 'X', url: 'https://x.com', snippet: 's' }] }));
    try {
      const tabOps = { openTab: jest.fn() };
      const resolveWc = jest.fn();
      const r = await webSearch.handler({ query: 'rust async', count: 4 }, { tabOps, resolveWc });
      expect(searchService.search).toHaveBeenCalledWith('rust async', { count: 4 }, { tabOps, resolveWc });
      expect(r.ok).toBe(true);
      expect(r.results[0].url).toBe('https://x.com');
    } finally { searchService.search = orig; }
  });

  test('surfaces SearchService throw as a structured error (no swallow)', async () => {
    const orig = searchService.search;
    searchService.search = jest.fn(async () => { throw new Error('provider down'); });
    try {
      const r = await webSearch.handler({ query: 'q' }, {});
      expect(r).toEqual({ ok: false, error: 'provider down' });
    } finally { searchService.search = orig; }
  });
});
