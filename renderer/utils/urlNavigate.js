// Shared URL-vs-search heuristic used by both the Cmd+L omnibar and the
// per-tab URL strip. Given raw user input, returns a navigable URL:
// - If it looks like a URL, normalize the protocol
// - Otherwise, wrap it as a search query for the configured engine
//
// `engine` is settings.defaultSearchEngine (callers pass it from config).
// Defaults to Google so existing behavior is unchanged when omitted. This
// is the human address bar only — the agent's web search is SearchService.

const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  kagi: 'https://kagi.com/search?q=',
  startpage: 'https://www.startpage.com/sp/search?query=',
  ecosia: 'https://www.ecosia.org/search?q=',
  brave: 'https://search.brave.com/search?q=',
};

// Merge user-defined engines onto the built-ins. Each custom engine is
// { id, name, url }; its url is either a `%s`-placeholder template (Chrome
// style) or a bare query-prefix like the built-ins. Returns a flat id→template
// map. Malformed entries (missing id/url) are skipped, never throw.
function buildEngineMap(customEngines) {
  const map = { ...SEARCH_ENGINES };
  if (Array.isArray(customEngines)) {
    for (const e of customEngines) {
      if (e && typeof e.id === 'string' && e.id && typeof e.url === 'string' && e.url) {
        map[e.id] = e.url;
      }
    }
  }
  return map;
}

// Fill a search template with the query: substitute every `%s`, or append the
// encoded query when the template is a bare prefix.
function applyQuery(template, value) {
  const q = encodeURIComponent(value);
  return template.includes('%s') ? template.replace(/%s/g, q) : template + q;
}

const { isLocalHost } = require('../../shared/privateIp');

// Loopback and private-network hosts (dev servers, routers, NAS boxes) rarely
// serve TLS, so a bare one defaults to http:// the way Chrome's omnibox does.
function isLocalAddress(value) {
  return isLocalHost(value.split(/[/?#]/)[0].replace(/:\d+$/, ''));
}

function resolveNavigationUrl(raw, engine, customEngines) {
  const value = (raw || '').trim();
  if (!value) return null;

  const isUrl = /^(https?:\/\/|localhost(?:[:/]|$)|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)|\d{1,3}(?:\.\d{1,3}){3}$|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?(?:\/|$)|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$)/.test(value);
  if (isUrl) {
    if (/^https?:\/\//.test(value)) return value;
    return (isLocalAddress(value) ? 'http://' : 'https://') + value;
  }
  return searchUrlFor(value, engine, customEngines);
}

// The results page for a query on the configured engine, even when the text
// looks like a hostname (a picked search suggestion is always a search).
function searchUrlFor(query, engine, customEngines) {
  const engines = buildEngineMap(customEngines);
  return applyQuery(engines[engine] || SEARCH_ENGINES.google, query);
}

module.exports = { resolveNavigationUrl, searchUrlFor, SEARCH_ENGINES, buildEngineMap };
