// PersonaRouterService — picks an agent persona for a given user task. Two
// tiers, cheapest first:
//   1. Regex pre-pass (synchronous, ~0ms): explicit `:persona` prefix, lock
//      override, and unambiguous keyword matches go straight to a result.
//   2. LLM classifier (async, ~hundreds of ms): only invoked when the pre-pass
//      can't decide. One short call to the active engine; 1.5s timeout; on
//      timeout or engine-down returns 'default' so the router never blocks
//      task start.
//
// Result: { name, source, cleanedDescription }
//   source ∈ 'lock' | 'prefix' | 'regex' | 'llm' | 'default' | 'disabled'

const ROUTER_TIMEOUT_MS = 1500;
const ROUTER_MAX_TOKENS = 12;
const CACHE_SIZE = 64;

// Built-in regex pattern table. Returns the matched persona name, or null.
// Order matters: more specific patterns come first so they win disambiguation.
const PATTERNS = [
  { name: 'reddit', re: /\br\/[a-z0-9_]{2,}\b|\breddit\b/i },
  { name: 'shop',   re: /\$\s?\d|\b(buy|price|cheap|deal|coupon|under\s+\$?\d|amazon|bestbuy|newegg)\b/i },
  { name: 'code',   re: /\b(stack ?trace|exception|undefined is not|null pointer|regex|leetcode|typescript|javascript|python|rust\b|golang)\b|```/i },
  { name: 'news',   re: /\b(today|latest|breaking|news|happened|update on|right now)\b/i },
  { name: 'research', re: /\b(compare|deep dive|evidence|peer[- ]reviewed|literature|meta[- ]analysis|primary sources?)\b/i },
  { name: 'explore', re: /\b(what's going on|what is going on|explore|show me what|overview of)\b/i },
];

function hashKey(s) {
  // Tiny non-crypto hash; enough to dedupe identical prompts in an LRU.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

class PersonaRouterService {
  constructor() {
    this._personaService = null;
    this._llmClient = null;
    this._lock = null; // session-only persona lock from the renderer
    this._cache = new Map(); // LRU; insertion order = age
  }

  bind({ personaService, llmClient }) {
    this._personaService = personaService;
    this._llmClient = llmClient;
  }

  setLock(name) { this._lock = name && this._isValidName(name) ? name : null; }
  getLock() { return this._lock; }
  clearLock() { this._lock = null; }

  // Drop the LRU classifier cache. Called from settings → Personas →
  // "Reset routing cache" after the user changes router behavior.
  clearCache() { this._cache.clear(); }

  _isValidName(name) {
    if (!this._personaService) return typeof name === 'string';
    return this._personaService.listAll().some((p) => p.name === name);
  }

  // Strip a leading ":persona" prefix from the user's task. Returns
  // { name, cleaned } or null when no prefix present.
  _stripPrefix(text) {
    const m = /^\s*:([a-z][a-z0-9_-]{1,24})\s+(.+)$/is.exec(text || '');
    if (!m) return null;
    const name = m[1].toLowerCase();
    if (!this._isValidName(name)) return null;
    return { name, cleaned: m[2].trim() };
  }

  _regexMatch(text) {
    if (!text) return null;
    const matches = [];
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) matches.push(name);
    }
    if (matches.length === 0) {
      // very short prompts with no question word → 'quick'
      const words = text.trim().split(/\s+/);
      if (words.length <= 5 && !/\b(what|how|why|where|when|who|which|is|are|do|does|did|can|could|should|would)\b/i.test(text)) {
        return 'quick';
      }
      return null;
    }
    if (matches.length === 1) return matches[0];
    return null; // ambiguous → fall through to LLM
  }

  _cacheGet(key) {
    if (!this._cache.has(key)) return null;
    const v = this._cache.get(key);
    this._cache.delete(key); this._cache.set(key, v); // bump to freshest
    return v;
  }

  _cacheSet(key, value) {
    if (this._cache.has(key)) this._cache.delete(key);
    this._cache.set(key, value);
    while (this._cache.size > CACHE_SIZE) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  async _classifyWithLLM(text) {
    if (!this._llmClient || !this._personaService) return null;
    const enabled = this._personaService.listEnabled().map((p) => p.name);
    if (enabled.length === 0) return null;
    const list = enabled.join(', ');
    const messages = [
      { role: 'system', content: `Pick the single best persona for this user task. Reply with only the name, no explanation. Choices: ${list}.` },
      { role: 'user', content: text },
    ];
    try {
      const res = await this._llmClient.chatCompletion(messages, {
        temperature: 0,
        maxTokens: ROUTER_MAX_TOKENS,
        timeoutMs: ROUTER_TIMEOUT_MS,
      });
      const raw = String(res && res.content || '').trim().toLowerCase();
      const cleaned = raw.replace(/[^a-z0-9_-]/g, ' ').split(/\s+/).filter(Boolean);
      for (const tok of cleaned) {
        if (enabled.includes(tok)) return tok;
      }
    } catch (_) {
      // engine down, timeout, network error — fall through to default
    }
    return null;
  }

  // Main entry point. Returns { name, source, cleanedDescription }.
  async route(description) {
    const text = String(description || '').slice(0, 4000);
    if (!this._personaService || !this._personaService.isRouterEnabled || !this._personaService.isRouterEnabled()) {
      return { name: 'default', source: 'disabled', cleanedDescription: text };
    }
    if (this._lock) return { name: this._lock, source: 'lock', cleanedDescription: text };

    const prefix = this._stripPrefix(text);
    if (prefix) return { name: prefix.name, source: 'prefix', cleanedDescription: prefix.cleaned };

    const enabledNames = this._personaService.listEnabled().map((p) => p.name);

    const regexHit = this._regexMatch(text);
    if (regexHit && enabledNames.includes(regexHit)) {
      return { name: regexHit, source: 'regex', cleanedDescription: text };
    }

    if (!this._personaService.isLLMFallbackEnabled()) {
      return { name: 'default', source: 'default', cleanedDescription: text };
    }

    const cacheKey = hashKey(text);
    const cached = this._cacheGet(cacheKey);
    if (cached && enabledNames.includes(cached)) {
      return { name: cached, source: 'llm', cleanedDescription: text };
    }

    const llmHit = await this._classifyWithLLM(text);
    if (llmHit && enabledNames.includes(llmHit)) {
      this._cacheSet(cacheKey, llmHit);
      return { name: llmHit, source: 'llm', cleanedDescription: text };
    }

    return { name: 'default', source: 'default', cleanedDescription: text };
  }

  // Synchronous variant (no LLM). Useful for the settings "Test" button to
  // give immediate feedback without burning an LLM call.
  routeSync(description) {
    const text = String(description || '').slice(0, 4000);
    if (!this._personaService || !this._personaService.isRouterEnabled || !this._personaService.isRouterEnabled()) {
      return { name: 'default', source: 'disabled', cleanedDescription: text };
    }
    if (this._lock) return { name: this._lock, source: 'lock', cleanedDescription: text };
    const prefix = this._stripPrefix(text);
    if (prefix) return { name: prefix.name, source: 'prefix', cleanedDescription: prefix.cleaned };
    const enabledNames = this._personaService ? this._personaService.listEnabled().map((p) => p.name) : [];
    const regexHit = this._regexMatch(text);
    if (regexHit && enabledNames.includes(regexHit)) return { name: regexHit, source: 'regex', cleanedDescription: text };
    return { name: 'default', source: 'default', cleanedDescription: text };
  }
}

const instance = new PersonaRouterService();
module.exports = instance;
module.exports.PersonaRouterService = PersonaRouterService;
module.exports.PATTERNS = PATTERNS;
module.exports.ROUTER_TIMEOUT_MS = ROUTER_TIMEOUT_MS;
