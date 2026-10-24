// askBrowsingTool.js — agent tool: ask-your-browsing. Relevance search over
// the user's history + bookmarks (lexical always; semantic when the user has
// configured an embeddings endpoint). Use when the user references something
// they read before ("that article about X last week") — then browser.open_tab
// the best result. Distinct from browser.search_history (naive substring) and
// browser.web_search (the live web). Read-only: no tab, no side effect.

const semanticIndex = require('../../services/SemanticIndexService');

const MAX_LIMIT = 25;

const askBrowsing = {
  name: 'browser.ask_browsing',
  description: 'Search the user\'s own browsing history AND bookmarks by meaning/keywords, ranked by relevance. Use this (not browser.search_history) when the user refers to something they previously read or saved but does not give the URL. Returns ranked {url,title,timestamp,source}. Then call browser.open_tab on the best URL.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the user is looking for (natural language or keywords).' },
      limit: { type: 'number', description: 'Max results (default 8, max 25).' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const query = String((args && args.query) || '').trim();
    if (!query) return { ok: false, error: 'empty_query' };
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number((args && args.limit) || 8)));
    try {
      return await semanticIndex.search(query, { limit });
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'ask_browsing_failed' };
    }
  },
};

module.exports = [askBrowsing];
