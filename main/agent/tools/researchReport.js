// researchReport.js — agent tool for Research Report Mode. After the agent has
// chosen the sources it will cite (typically from browser.web_search results),
// it calls this ONCE with the final ordered source list. Each source opens as
// its own pane in the agent workspace and a stable 1-based citation index is
// returned. The agent then writes a markdown report citing facts inline as
// [1], [2], … using exactly those indices; the user can click any [N] in the
// rendered report to jump to that live source pane (provenance you can verify).
//
// Distinct from agent.broadcast_to_cognitizers (fans a prompt to AI services)
// and browser.open_tab (a single ad-hoc tab with no citation map).

const tabOps = require('../../services/AgentTabOpsService');

const MAX_SOURCES = 8;

// Drop non-http(s) and duplicate URLs, cap the fan-out, default the title.
function normalizeSources(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    const url = s && typeof s.url === 'string' ? s.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const title = s && typeof s.title === 'string' && s.title.trim() ? s.title.trim() : url;
    out.push({ url, title });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

const openResearchSources = {
  name: 'browser.open_research_sources',
  description: 'Research Report Mode: open the sources you will cite, each in its own visible pane, and get back a numbered citation map. Call this ONCE after you have chosen your final sources (e.g. from browser.web_search results) and BEFORE writing the report. Pass the ordered list of {url,title}. Returns {sources:[{index,spaceId,url,title}]} where index is 1-based and sequential. Then write a structured markdown report and cite every factual claim inline using exactly those [index] numbers (e.g. "...growth slowed in 2023 [2]."). The user can click any [N] in the report to jump to that live source pane, so the citation indices must match the returned numbers exactly. Max 8 sources; duplicate and non-http(s) URLs are dropped.',
  parameters: {
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        description: 'Ordered list of sources to cite. Max 8; duplicates by URL and non-http(s) URLs are dropped.',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Absolute http(s) URL of the source.' },
            title: { type: 'string', description: 'Short human-readable title for the source.' },
          },
          required: ['url'],
        },
      },
    },
    required: ['sources'],
  },
  sideEffect: true,
  targetSpaceKey: '_researchSources',
  handler: async (args, toolCtx) => {
    const sources = normalizeSources(args && args.sources);
    if (sources.length === 0) return { ok: false, error: 'no_valid_sources' };
    const ops = (toolCtx && toolCtx.tabOps) || tabOps;
    const opened = [];
    const errors = [];
    for (const s of sources) {
      try {
        const res = await ops.openTab(s.url);
        const spaceId = res && res.spaceId;
        if (!spaceId) { errors.push({ url: s.url, error: 'open_failed' }); continue; }
        opened.push({ index: opened.length + 1, spaceId, url: s.url, title: s.title });
      } catch (err) {
        errors.push({ url: s.url, error: (err instanceof Error && err.message) || 'open_failed' });
      }
    }
    return {
      ok: opened.length > 0,
      sources: opened,
      errors: errors.length ? errors : undefined,
      hint: opened.length
        ? 'Sources are open as numbered panes. Write the markdown report now and cite every factual claim inline with [index] using exactly the index numbers above. End with a "## Sources" section listing each [index] → title and URL.'
        : 'No sources could be opened. Re-run browser.web_search and retry with valid http(s) URLs.',
    };
  },
};

module.exports = [openResearchSources];
module.exports.normalizeSources = normalizeSources;
