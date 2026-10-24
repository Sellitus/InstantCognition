// searchTool.js — agent tool for real web search. Closes the single biggest
// gap in the agent: previously it could only reach URLs the user typed or
// read verbatim off a page. browser.web_search turns a query into ranked
// {title,url,snippet} results; the agent then browser.open_tab the best one
// to read it. Delegates to SearchService (provider-pluggable). NOT to be
// confused with browser.search_history (local history only).
//
// Marked sideEffect with targetSpaceKey '_tabOp': the default inBrowser
// provider opens+closes a background agent tab, so this serializes with
// other tab-level ops in the same turn (same convention as tabsTools).

const searchService = require('../../services/SearchService');

const webSearch = {
  name: 'browser.web_search',
  description: 'Search the web for a query and return ranked results [{title,url,snippet}]. Use this whenever you need to FIND a page and do not already have its URL — then call browser.open_tab on the best result to read it. This is a real web search (browser.search_history only searches the user\'s local history).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      count: { type: 'number', description: 'Max results to return (1–10, default from settings, typically 6).' },
    },
    required: ['query'],
  },
  sideEffect: true,
  targetSpaceKey: '_tabOp',
  handler: async (args, toolCtx) => {
    const query = String((args && args.query) || '').trim();
    if (!query) return { ok: false, error: 'empty_query' };
    const ctx = {
      tabOps: toolCtx && toolCtx.tabOps,
      resolveWc: toolCtx && toolCtx.resolveWc,
    };
    try {
      return await searchService.search(query, { count: args && args.count }, ctx);
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'web_search_failed' };
    }
  },
};

module.exports = [webSearch];
