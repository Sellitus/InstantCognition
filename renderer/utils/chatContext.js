// chatContext.js — pure helpers for the unified chat composer: parsing slash
// transform-actions and formatting attached context (page/selection/spaces/
// browsing) into text blocks. No DOM, no IPC, so the assembly is unit-testable
// without mounting the panel or driving a webview.

// summarize/explain/compare resolve to one-shot chat prompts; council/research
// are multi-step actions the panel routes specially (fan-out + synth / agent).
const SLASH_ACTIONS = ['summarize', 'explain', 'compare', 'council', 'research'];
const CONTEXT_KEYS = ['page', 'selection', 'spaces', 'browsing'];

// Chat capability toggles (settings.chat.features), now opt-out in Settings →
// Chat. Grounding is on by default so a plain question gets live results and a
// reasoning instruction with no per-message choice. webSearch grounds the answer
// in live web results; readTopPage only applies when webSearch is on;
// thinkStepByStep prepends a reasoning instruction to the system prompt.
const CHAT_FEATURE_KEYS = ['webSearch', 'readTopPage', 'thinkStepByStep'];
const DEFAULT_CHAT_FEATURES = { webSearch: true, readTopPage: true, thinkStepByStep: true };

// Explicit-action router for auto mode ('agent' | 'chat'). The agent loop takes
// browser-action phrasing, imperative research, a named source to read, and
// recency questions whose answer cannot come from weights; anything that a model
// can answer on its own stays on the fast single-turn path. A misroute to chat
// answers without acting (acceptable); a false positive to agent costs an
// observe-loop round trip, so when in doubt stay 'chat'.

// Imperative navigation at sentence start: "open X", "navigate to Y", "go to Z".
const NAV_ACTION_RE = /^(?:please\s+)?(?:just\s+)?(?:open|launch)\s+\S|\b(?:navigate|go)\s+(?:to\b)/i;
// Multi-step compound actions: a find/summarize/compare step joined with an open.
const MULTI_STEP_ACTION_RE = /\b(?:find|compar\w*|summariz\w*)\s+[^.!?\n]*(?:and|then)[^.!?\n]*\bopen\b/i;
// Imperative research at sentence start, or a search verb aimed at the open web.
const RESEARCH_ACTION_RE = /^(?:please\s+)?(?:just\s+)?(?:search|research|browse|google|look\s+up|find\s+out)\b|\b(?:search|look\s+up)\s+(?:for\s+|through\s+)?(?:the\s+)?(?:web|internet|online|reddit|google)\b/i;
// A named browsable source, or a literal URL: answering means reading a page.
const SOURCE_MENTION_RE = /\b(?:on|from|across|via)\s+(?:reddit|r\/\w+|hacker\s*news|hn|youtube|github|stack\s*overflow|twitter|x\.com)\b|https?:\/\//i;
// Recency paired with a volatile subject — the answer cannot come from weights.
const LIVE_INFO_RE = /\b(?:latest|current|today'?s|this\s+week'?s|right\s+now|up[- ]to[- ]date)\b[^?.!\n]*\b(?:news|price|prices|release|releases|version|score|scores|weather|status|outage|schedule|standings)\b/i;

function routeIntent(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return 'chat';
  if (NAV_ACTION_RE.test(t)) return 'agent';
  if (MULTI_STEP_ACTION_RE.test(t)) return 'agent';
  if (RESEARCH_ACTION_RE.test(t)) return 'agent';
  if (SOURCE_MENTION_RE.test(t)) return 'agent';
  if (LIVE_INFO_RE.test(t)) return 'agent';
  return 'chat';
}

function clip(s, n) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// '/summarize the intro' -> { action: 'summarize', rest: 'the intro' }; returns
// null when the text is not one of the known transform commands.
function parseSlashAction(text) {
  const m = /^\/([a-zA-Z]+)\b\s*([\s\S]*)$/.exec(String(text == null ? '' : text).trim());
  if (!m) return null;
  const action = m[1].toLowerCase();
  if (!SLASH_ACTIONS.includes(action)) return null;
  return { action, rest: (m[2] || '').trim() };
}

// Inline context tokens (@page @selection @spaces @browsing). The composer has no
// chip UI anymore — these stay reachable by typing them into the message. They are
// stripped from what the model sees (it only receives the resolved blocks), so a
// bare '@' in prose that is not one of the known keys passes through untouched.
const INLINE_TOKEN_RE = /(^|\s)@(page|selection|spaces|browsing)\b/gi;

function parseInlineContext(text) {
  const raw = String(text == null ? '' : text);
  const keys = new Set();
  let m;
  while ((m = INLINE_TOKEN_RE.exec(raw)) !== null) {
    if (CONTEXT_KEYS.includes(m[2].toLowerCase())) keys.add(m[2].toLowerCase());
  }
  const cleanText = raw.replace(INLINE_TOKEN_RE, ' ').replace(/ {2,}/g, ' ').trim();
  return { keys: Array.from(keys), text: cleanText };
}

// Active-page auto-attach cap (chars). The full readable body is extracted at a
// larger limit for slash actions; plain chat uses this smaller block so an always-on
// page context stays bounded in the prompt without losing what the user can see.
const ACTIVE_PAGE_AUTO_LIMIT = 3000;

function formatPageBlock(page, limit = 4000) {
  const p = page || {};
  const title = clip(p.title, 200) || 'Untitled';
  const url = clip(p.url, 300);
  const body = clip(p.mainText, limit) || '(no readable text was extracted)';
  return `Title: ${title}\nURL: ${url}\n\n${body}`;
}

// Render the browsing:ask result ({ results:[{title,url}] }) as a short list.
function formatBrowsing(result, limit = 5) {
  const list = result && Array.isArray(result.results) ? result.results.slice(0, limit) : [];
  if (!list.length) return '';
  return list.map((r, i) => `${i + 1}. ${clip(r && r.title, 200) || '(untitled)'} — ${clip(r && r.url, 300)}`).join('\n');
}

// Render chat:web-search output into a context block for the model. Includes
// each result's snippet (DuckDuckGo/Bing/Tavily all populate it) and, when the
// top page was read successfully, its extracted body text. Returns '' only
// when neither results nor a page block are usable.
function formatWebResults(searchResult) {
  const r = searchResult || {};
  const results = Array.isArray(r.results) ? r.results : [];
  const usable = results.filter((x) => x && x.title && x.url);
  const page = r.page && r.page.ok && r.page.text ? r.page.text : '';
  if (!usable.length && !page) return '';
  const lines = usable.map((x, i) => {
    const snip = clip(x.snippet, 400);
    return `${i + 1}. ${clip(x.title, 200)}\n   ${clip(x.url, 300)}${snip ? `\n   ${snip}` : ''}`;
  });
  const header = '--- Web search results (use these to ground your answer; cite source URLs inline) ---';
  const body = lines.length ? header + '\n' + lines.join('\n') : '';
  if (!page) return body;
  const titleFallback = clip(usable[0] ? usable[0].url : (results[0] && results[0].url) || '', 200);
  return `${body}\n\n--- Top result full text: ${clip(r.page.title || titleFallback, 200)} ---\n${clip(page, 4000)}`;
}

module.exports = {
  parseSlashAction,
  routeIntent,
  formatPageBlock,
  formatBrowsing,
  formatWebResults,
  // Panel-internal context assembly helpers (no chip UI — resolved from typed tokens):
  parseInlineContext,
  ACTIVE_PAGE_AUTO_LIMIT,
  SLASH_ACTIONS,
  CONTEXT_KEYS,
  CHAT_FEATURE_KEYS,
  DEFAULT_CHAT_FEATURES,
};
