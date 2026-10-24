// historyTool.js — agent tool for searching the user's browsing history.
// Useful when the user references something they read earlier ("the article
// I was reading yesterday about X"). The agent can then browser.open_tab
// the matching URL and read it.

const historyService = require('../../services/HistoryService');

const MAX_LIMIT = 25;

const searchHistory = {
  name: 'browser.search_history',
  description: 'Search the user\'s past browsing history by keyword. Returns up to 25 matches with {url, title, timestamp}. Use when the user references a page they visited earlier — then call browser.open_tab on the URL to read it. NOT a web search.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword to match against URL or page title (case-insensitive substring).' },
      limit: { type: 'number', description: 'Max results (default 10, max 25).' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const query = String((args && args.query) || '').trim();
    if (!query) return { ok: false, error: 'empty_query' };
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number((args && args.limit) || 10)));
    try {
      const rows = historyService.search(query, { limit });
      const results = (rows || []).map((e) => ({
        url: e.url,
        title: e.title || '',
        timestamp: e.timestamp || null,
        spaceId: e.spaceId || null,
      }));
      return {
        ok: true,
        count: results.length,
        results,
        hint: results.length === 0
          ? 'No matches in history. The user may not have visited that page in this app.'
          : 'Top match is the first result. Call browser.open_tab with its URL to read it.',
      };
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'search_failed' };
    }
  },
};

const recentHistory = {
  name: 'browser.recent_history',
  description: 'Return the most-recently-visited URLs from the user\'s history. Useful when the user says "the page I was just on" without naming it. Returns up to 10 entries with {url, title, timestamp}.',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'number' } },
    required: [],
  },
  handler: async (args) => {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number((args && args.limit) || 10)));
    try {
      const rows = historyService.getRecent(limit);
      const results = (rows || []).map((e) => ({
        url: e.url,
        title: e.title || '',
        timestamp: e.timestamp || null,
        spaceId: e.spaceId || null,
      }));
      return { ok: true, count: results.length, results };
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'recent_failed' };
    }
  },
};

module.exports = [searchHistory, recentHistory];
