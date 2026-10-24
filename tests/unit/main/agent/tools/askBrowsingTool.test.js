const askBrowsingTools = require('../../../../../main/agent/tools/askBrowsingTool');
const semanticIndex = require('../../../../../main/services/SemanticIndexService');

const [askBrowsing] = askBrowsingTools;

describe('browser.ask_browsing', () => {
  test('exposes a parameter schema with required query', () => {
    expect(askBrowsing.name).toBe('browser.ask_browsing');
    expect(askBrowsing.parameters.required).toEqual(['query']);
  });

  test('rejects empty query without touching the index', async () => {
    const orig = semanticIndex.search;
    semanticIndex.search = jest.fn();
    try {
      const r = await askBrowsing.handler({ query: '   ' });
      expect(r).toEqual({ ok: false, error: 'empty_query' });
      expect(semanticIndex.search).not.toHaveBeenCalled();
    } finally { semanticIndex.search = orig; }
  });

  test('delegates to SemanticIndexService.search with a default limit of 8', async () => {
    const orig = semanticIndex.search;
    semanticIndex.search = jest.fn(async () => ({
      ok: true, mode: 'lexical', count: 1,
      results: [{ url: 'https://x.com', title: 'X', timestamp: 1, source: 'history', score: 9 }],
      hint: 'Top match is the first result. Open its URL to read it.',
    }));
    try {
      const r = await askBrowsing.handler({ query: 'that rust article' });
      expect(r.ok).toBe(true);
      expect(r.count).toBe(1);
      expect(semanticIndex.search).toHaveBeenCalledWith('that rust article', { limit: 8 });
    } finally { semanticIndex.search = orig; }
  });

  test('clamps limit to the 1..25 range', async () => {
    const orig = semanticIndex.search;
    semanticIndex.search = jest.fn(async () => ({ ok: true, results: [] }));
    try {
      await askBrowsing.handler({ query: 'x', limit: 999 });
      expect(semanticIndex.search).toHaveBeenCalledWith('x', { limit: 25 });
      semanticIndex.search.mockClear();
      await askBrowsing.handler({ query: 'x', limit: 0 });
      expect(semanticIndex.search).toHaveBeenCalledWith('x', { limit: 8 });
    } finally { semanticIndex.search = orig; }
  });

  test('surfaces SemanticIndexService failures as a tool error', async () => {
    const orig = semanticIndex.search;
    semanticIndex.search = jest.fn(async () => { throw new Error('index disk fail'); });
    try {
      const r = await askBrowsing.handler({ query: 'x' });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('index disk fail');
    } finally { semanticIndex.search = orig; }
  });
});
