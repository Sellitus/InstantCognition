// searchSuggest — live address-bar suggestions from the configured search
// engine. Every built-in endpoint below answers in the OpenSearch suggestions
// format: ["query", ["suggestion", ...], ...]. A custom engine opts in with a
// `suggest` URL template (`%s` marks the query) that returns the same format.
// Requests omit cookies, so suggestions are not tied to the user's account on
// the engine.

const SUGGEST_ENDPOINTS = {
  google: 'https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=%s',
  duckduckgo: 'https://duckduckgo.com/ac/?type=list&q=%s',
  bing: 'https://api.bing.com/osjson.aspx?query=%s',
  brave: 'https://search.brave.com/api/suggest?q=%s',
  kagi: 'https://kagi.com/api/autosuggest?q=%s',
  ecosia: 'https://ac.ecosia.org/autocomplete?type=list&q=%s',
  startpage: 'https://www.startpage.com/osuggestions?q=%s',
};

const SUGGEST_TIMEOUT_MS = 2500;
const MAX_QUERY_LENGTH = 200;
const MAX_SUGGESTIONS = 6;

// The endpoint template for an engine id, or null when it offers none.
function suggestTemplateFor(engine, customEngines) {
  if (Array.isArray(customEngines)) {
    const custom = customEngines.find((e) => e && e.id === engine);
    if (custom) return typeof custom.suggest === 'string' && /^https:\/\//i.test(custom.suggest) ? custom.suggest : null;
  }
  return SUGGEST_ENDPOINTS[engine] || null;
}

function parseSuggestions(body, query) {
  const data = JSON.parse(body);
  if (!Array.isArray(data) || !Array.isArray(data[1])) throw new Error('response is not in the OpenSearch suggestions format');
  const seen = new Set([query.toLowerCase()]);
  const out = [];
  for (const item of data[1]) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, MAX_QUERY_LENGTH);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

/**
 * @param {{ engine: string, customEngines?: any[], query: string,
 *   fetch: (url: string, init: object) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>,
 *   timeoutMs?: number }} opts
 * @returns {Promise<string[]>} rejects on network failure, timeout, HTTP error or a malformed body
 */
async function fetchSuggestions({ engine, customEngines, query, fetch, timeoutMs = SUGGEST_TIMEOUT_MS }) {
  const template = suggestTemplateFor(engine, customEngines);
  const q = String(query || '').trim().slice(0, MAX_QUERY_LENGTH);
  if (!template || !q) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  try {
    const res = await fetch(template.replace(/%s/g, encodeURIComponent(q)), { credentials: 'omit', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseSuggestions(await res.text(), q);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchSuggestions, suggestTemplateFor, parseSuggestions, SUGGEST_ENDPOINTS, SUGGEST_TIMEOUT_MS };
