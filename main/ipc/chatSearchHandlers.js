// chatSearchHandlers — lets the unified chat surface ground an answer in live
// web results without leaving the single-turn chat path (the agent loop is the
// heavier, multi-step alternative). Renderer invokes 'chat:web-search'
// {query, readTop}; we delegate to SearchService for the ranked result list and,
// when readTop is set, read the top result's body via SearchService.readPage.
//
// The inBrowser provider opens+closes a background agent tab, so the {tabOps,
// resolveWc} ctx is built from the same singletons AgentService.startTask uses
// (AgentTabOpsService + tabRegistry) — one tab-lifecycle contract across the app.
// HTTP providers (searxng/brave/tavily) need no ctx and work regardless.

const { ipcMain, webContents } = require('electron');
const searchService = require('../services/SearchService');
const tabOps = require('../services/AgentTabOpsService');
const tabRegistry = require('../services/tabRegistry');

function register(_mainWindow, _services = {}) {
  // Maps an agent-workspace spaceId to its live webContents, mirroring the
  // resolver AgentService hands its tools. tabRegistry holds the spaceId →
  // webContentsId entries the agent workspace broadcasts as tabs open.
  const resolveWc = (spaceId) => {
    const entry = tabRegistry.get ? tabRegistry.get(spaceId) : null;
    if (!entry || entry.webContentsId == null) return null;
    try { return webContents.fromId(entry.webContentsId); } catch (_) { return null; }
  };

  ipcMain.handle('chat:web-search', async (_e, req = {}) => {
    const query = String((req && req.query) || '').trim();
    if (!query) return { ok: false, error: 'empty_query' };
    const ctx = { tabOps, resolveWc };
    let search;
    try {
      search = await searchService.search(query, { count: req && req.count }, ctx);
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'web_search_failed' };
    }
    if (!search || !search.ok) return search || { ok: false, error: 'web_search_failed' };

    // Best-effort top-page read. A read failure never fails the whole call —
    // the snippets alone still ground the answer; the page text is additive.
    if (req && req.readTop && Array.isArray(search.results) && search.results.length) {
      const top = search.results[0];
      let page;
      try { page = await searchService.readPage(top.url, ctx); } catch (err) { page = { ok: false, error: (err instanceof Error && err.message) || 'read_page_failed' }; }
      return { ok: true, results: search.results, query: search.query, page: page || null };
    }
    return { ok: true, results: search.results, query: search.query, page: null };
  });
}

module.exports = { register };
