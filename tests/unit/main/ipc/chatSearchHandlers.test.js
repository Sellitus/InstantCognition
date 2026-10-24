// chatSearchHandlers — 'chat:web-search' is the grounding path behind the
// unified chat. Its contract: never throw at the renderer, and never let a
// failed page read discard the search results it already has.

const handlers = {};

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn((channel, handler) => { handlers[channel] = handler; }) },
  webContents: { fromId: jest.fn() },
}));

jest.mock('../../../../main/services/SearchService', () => ({
  search: jest.fn(),
  readPage: jest.fn(),
}));

jest.mock('../../../../main/services/AgentTabOpsService', () => ({ openTab: jest.fn() }));
jest.mock('../../../../main/services/tabRegistry', () => ({ get: jest.fn() }));

const { webContents } = require('electron');
const searchService = require('../../../../main/services/SearchService');
const tabRegistry = require('../../../../main/services/tabRegistry');
const { register } = require('../../../../main/ipc/chatSearchHandlers');

const RESULTS = [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/b', title: 'B' }];

describe('chatSearchHandlers', () => {
  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete handlers[key];
    searchService.search.mockReset();
    searchService.readPage.mockReset();
    tabRegistry.get.mockReset();
    webContents.fromId.mockReset();
    register({}, {});
  });

  const call = (req) => handlers['chat:web-search']({}, req);

  test('an empty query is rejected before any provider is touched', async () => {
    expect(await call({ query: '   ' })).toEqual({ ok: false, error: 'empty_query' });
    expect(searchService.search).not.toHaveBeenCalled();
  });

  test('a plain search returns the ranked results and no page body', async () => {
    searchService.search.mockResolvedValue({ ok: true, results: RESULTS, query: 'cats' });
    expect(await call({ query: 'cats' })).toEqual({ ok: true, results: RESULTS, query: 'cats', page: null });
    expect(searchService.readPage).not.toHaveBeenCalled();
  });

  test('readTop reads the first result and returns it alongside the results', async () => {
    searchService.search.mockResolvedValue({ ok: true, results: RESULTS, query: 'cats' });
    searchService.readPage.mockResolvedValue({ ok: true, text: 'body' });

    const res = await call({ query: 'cats', readTop: true });

    expect(searchService.readPage).toHaveBeenCalledWith('https://example.com/a', expect.any(Object));
    expect(res.page).toEqual({ ok: true, text: 'body' });
    expect(res.results).toEqual(RESULTS);
  });

  test('a failed page read still returns the search results', async () => {
    searchService.search.mockResolvedValue({ ok: true, results: RESULTS, query: 'cats' });
    searchService.readPage.mockRejectedValue(new Error('timeout'));

    const res = await call({ query: 'cats', readTop: true });

    expect(res.ok).toBe(true);
    expect(res.results).toEqual(RESULTS);
    expect(res.page).toEqual({ ok: false, error: 'timeout' });
  });

  test('readTop with zero results skips the read instead of indexing undefined', async () => {
    searchService.search.mockResolvedValue({ ok: true, results: [], query: 'cats' });
    const res = await call({ query: 'cats', readTop: true });
    expect(searchService.readPage).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, results: [], query: 'cats', page: null });
  });

  test('a throwing provider becomes an error result, not a rejected invoke', async () => {
    searchService.search.mockRejectedValue(new Error('provider down'));
    expect(await call({ query: 'cats' })).toEqual({ ok: false, error: 'provider down' });
  });

  test('a provider that reports failure is passed through verbatim', async () => {
    searchService.search.mockResolvedValue({ ok: false, error: 'no_provider' });
    expect(await call({ query: 'cats' })).toEqual({ ok: false, error: 'no_provider' });
  });

  test('a provider returning nothing still yields a shaped failure', async () => {
    searchService.search.mockResolvedValue(undefined);
    expect(await call({ query: 'cats' })).toEqual({ ok: false, error: 'web_search_failed' });
  });

  test('the search context resolves agent tabs through the tab registry', async () => {
    const wc = { id: 7 };
    tabRegistry.get.mockReturnValue({ webContentsId: 7 });
    webContents.fromId.mockReturnValue(wc);
    searchService.search.mockResolvedValue({ ok: true, results: [], query: 'cats' });

    await call({ query: 'cats' });

    const ctx = searchService.search.mock.calls[0][2];
    expect(ctx.resolveWc('space-1')).toBe(wc);
    expect(ctx.tabOps).toBeDefined();
  });

  test('an unknown space resolves to null rather than throwing', async () => {
    tabRegistry.get.mockReturnValue(null);
    searchService.search.mockResolvedValue({ ok: true, results: [], query: 'cats' });

    await call({ query: 'cats' });

    const ctx = searchService.search.mock.calls[0][2];
    expect(ctx.resolveWc('missing')).toBeNull();
    expect(webContents.fromId).not.toHaveBeenCalled();
  });

  test('a dead webContents id resolves to null', async () => {
    tabRegistry.get.mockReturnValue({ webContentsId: 99 });
    webContents.fromId.mockImplementation(() => { throw new Error('gone'); });
    searchService.search.mockResolvedValue({ ok: true, results: [], query: 'cats' });

    await call({ query: 'cats' });

    const ctx = searchService.search.mock.calls[0][2];
    expect(ctx.resolveWc('space-1')).toBeNull();
  });
});
