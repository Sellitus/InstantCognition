const historyTools = require('../../../../../main/agent/tools/historyTool');
const historyService = require('../../../../../main/services/HistoryService');

const [searchTool, recentTool] = historyTools;

describe('browser.search_history', () => {
  test('exposes a parameter schema with required query', () => {
    expect(searchTool.name).toBe('browser.search_history');
    expect(searchTool.parameters.required).toEqual(['query']);
  });

  test('rejects empty query', async () => {
    const r = await searchTool.handler({ query: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty_query');
  });

  test('returns matches via HistoryService.search', async () => {
    const orig = historyService.search;
    historyService.search = jest.fn(() => [
      { id: '1', url: 'https://example.com/a', title: 'A page', timestamp: 100, spaceId: 'browser' },
      { id: '2', url: 'https://example.com/b', title: 'B page', timestamp: 200, spaceId: 'custom1' },
    ]);
    try {
      const r = await searchTool.handler({ query: 'example' });
      expect(r.ok).toBe(true);
      expect(r.count).toBe(2);
      expect(r.results[0]).toEqual({ url: 'https://example.com/a', title: 'A page', timestamp: 100, spaceId: 'browser' });
      expect(historyService.search).toHaveBeenCalledWith('example', { limit: 10 });
    } finally { historyService.search = orig; }
  });

  test('clamps limit to 25', async () => {
    const orig = historyService.search;
    historyService.search = jest.fn(() => []);
    try {
      await searchTool.handler({ query: 'x', limit: 999 });
      expect(historyService.search).toHaveBeenCalledWith('x', { limit: 25 });
    } finally { historyService.search = orig; }
  });

  test('reports no-matches helpfully', async () => {
    const orig = historyService.search;
    historyService.search = jest.fn(() => []);
    try {
      const r = await searchTool.handler({ query: 'nothing' });
      expect(r.ok).toBe(true);
      expect(r.count).toBe(0);
      expect(r.hint).toMatch(/No matches/);
    } finally { historyService.search = orig; }
  });

  test('catches HistoryService errors', async () => {
    const orig = historyService.search;
    historyService.search = jest.fn(() => { throw new Error('disk fail'); });
    try {
      const r = await searchTool.handler({ query: 'x' });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('disk fail');
    } finally { historyService.search = orig; }
  });
});

describe('browser.recent_history', () => {
  test('returns recent entries', async () => {
    const orig = historyService.getRecent;
    historyService.getRecent = jest.fn(() => [
      { url: 'https://a.com', title: 'A', timestamp: 1, spaceId: 'browser' },
    ]);
    try {
      const r = await recentTool.handler({ limit: 5 });
      expect(r.ok).toBe(true);
      expect(r.count).toBe(1);
      expect(historyService.getRecent).toHaveBeenCalledWith(5);
    } finally { historyService.getRecent = orig; }
  });

  test('default limit is 10', async () => {
    const orig = historyService.getRecent;
    historyService.getRecent = jest.fn(() => []);
    try {
      await recentTool.handler({});
      expect(historyService.getRecent).toHaveBeenCalledWith(10);
    } finally { historyService.getRecent = orig; }
  });
});
