// SearchService — backs the agent's browser.web_search tool and chat web-grounding.
// Providers (settings.search): inBrowser (default) scrapes a SERP in a background agent tab; searxng/brave/tavily query APIs.

const configService = require('./ConfigService');
const { buildReadableScript } = require('../agent/readableExtractor');

const MAX_RESULTS = 10;
const LOAD_WAIT_MS = 9000;
const SETTLE_MS = 450;
// Cap on the readable body text returned to chat so a grounded turn never eats the whole context.
const MAX_PAGE_TEXT = 4000;
// Bounded poll: the renderer writes the tabRegistry entry after the openTab reply.
const WC_RESOLVE_TIMEOUT_MS = 1500;
const WC_RESOLVE_POLL_MS = 50;

// Per-engine SERP url builder + in-page selector set. Selectors are applied
// inside the loaded page by _extractScript.
const ENGINES = {
  duckduckgo: {
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    sel: { item: '.result.results_links, .web-result, .result', link: 'a.result__a', title: 'a.result__a, h2', snippet: '.result__snippet' },
  },
  bing: {
    url: (q) => `https://www.bing.com/search?setlang=en&q=${encodeURIComponent(q)}`,
    sel: { item: 'li.b_algo', link: 'h2 a', title: 'h2 a', snippet: '.b_caption p, .b_algoSlug, p' },
  },
  startpage: {
    url: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}`,
    sel: { item: '.w-gl__result, .result', link: 'a.w-gl__result-title, a.result-link, a.result-title', title: 'a.w-gl__result-title, .result-title, h3', snippet: '.w-gl__description, .description, p' },
  },
};

class SearchService {
  constructor() {
    this._fetch = (typeof fetch === 'function') ? fetch.bind(globalThis) : null;
    this._config = configService;
  }

  _setFetch(fn) { this._fetch = fn; }
  _setConfig(c) { this._config = c; }

  _cfg() {
    const c = this._config && typeof this._config.get === 'function'
      ? this._config.get('settings.search', {}) : {};
    return c && typeof c === 'object' ? c : {};
  }

  getProvider() { return this._cfg().provider || 'inBrowser'; }

  _engine() {
    const e = this._cfg().inBrowserEngine || 'duckduckgo';
    return ENGINES[e] ? e : 'duckduckgo';
  }

  _count(requested) {
    const cfgN = Number(this._cfg().resultCount) || 6;
    const n = Number(requested) > 0 ? Number(requested) : cfgN;
    return Math.max(1, Math.min(MAX_RESULTS, Math.floor(n)));
  }

  serpUrl(engine, query) {
    const e = ENGINES[engine] || ENGINES.duckduckgo;
    return e.url(query);
  }

  // Trim, drop blanks, dedupe by URL, clamp to count.
  normalize(list, count) {
    const seen = new Set();
    const out = [];
    for (const r of Array.isArray(list) ? list : []) {
      const url = String((r && r.url) || '').trim();
      const title = String((r && r.title) || '').trim();
      if (!/^https?:\/\//i.test(url) || !title) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ title: title.slice(0, 300), url, snippet: String((r && r.snippet) || '').trim().slice(0, 500) });
      if (out.length >= count) break;
    }
    return out;
  }

  // IIFE evaluated inside the loaded SERP page. Returns raw [{title,url,snippet}].
  _extractScript(engine, count) {
    const sel = (ENGINES[engine] || ENGINES.duckduckgo).sel;
    return `(function(){
      function txt(n){return n?(n.textContent||'').trim().replace(/\\s+/g,' '):'';}
      function abs(h){try{if(!h)return '';if(h.indexOf('/l/?')>-1||h.indexOf('duckduckgo.com/l/')>-1){var u=new URL(h,location.origin);var d=u.searchParams.get('uddg');if(d)return decodeURIComponent(d);}return new URL(h,location.origin).href;}catch(e){return h||'';}}
      var S=${JSON.stringify(sel)},N=${count},out=[],seen={};
      var items=document.querySelectorAll(S.item);
      for(var i=0;i<items.length&&out.length<N;i++){
        var it=items[i],a=it.querySelector(S.link);if(!a)continue;
        var url=abs(a.getAttribute('href')||a.href||'');
        if(!/^https?:\\/\\//.test(url))continue;
        if(/(^|\\.)(duckduckgo|bing|startpage)\\.com|google\\.[a-z.]+\\/search/.test(url))continue;
        var title=txt(a)||txt(it.querySelector(S.title));if(!title)continue;
        if(seen[url])continue;seen[url]=1;
        out.push({title:title,url:url,snippet:txt(it.querySelector(S.snippet))});
      }
      return out;
    })();`;
  }

  // The tabRegistry entry lands via the renderer's async did-attach/space-activity
  // announce, AFTER the openTab IPC reply — poll so a fresh tab is not misread
  // as webcontents_unavailable; give up after WC_RESOLVE_TIMEOUT_MS.
  async _waitForWc(resolveWc, spaceId) {
    const deadline = Date.now() + WC_RESOLVE_TIMEOUT_MS;
    do {
      let wc = null;
      try { wc = resolveWc(spaceId); } catch (err) {
        console.error('[SearchService] resolveWc failed:', (err instanceof Error && err.message) || err);
      }
      if (wc && typeof wc.executeJavaScript === 'function') return wc;
      await new Promise((r) => setTimeout(r, WC_RESOLVE_POLL_MS));
    } while (Date.now() < deadline);
    return null;
  }

  async _waitSettled(wc) {
    if (!wc || typeof wc.executeJavaScript !== 'function') return;
    const deadline = Date.now() + LOAD_WAIT_MS;
    if (typeof wc.isLoading === 'function' && wc.isLoading()) {
      await new Promise((resolve) => {
        // clearTimeout on load: resolve() is idempotent, so a late timer is a no-op.
        const timer = setTimeout(resolve, Math.max(250, deadline - Date.now()));
        try { wc.once('did-finish-load', () => { clearTimeout(timer); resolve(); }); } catch (_) { /* ignore */ }
      });
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }

  // Provider: inBrowser. Opens a background agent tab, scrapes the SERP DOM,
  // then closes it (best-effort — the workspace refuses to close its last tab).
  async collectInBrowser(query, count, ctx) {
    const tabOps = ctx && ctx.tabOps;
    const resolveWc = ctx && ctx.resolveWc;
    if (!tabOps || typeof tabOps.openTab !== 'function' || typeof resolveWc !== 'function') {
      return { ok: false, error: 'in_browser_unavailable' };
    }
    const engine = this._engine();
    const url = this.serpUrl(engine, query);
    let spaceId = null;
    try {
      const opened = await tabOps.openTab(url);
      spaceId = opened && opened.spaceId;
      if (!spaceId) return { ok: false, error: 'tab_open_failed' };
      const wc = await this._waitForWc(resolveWc, spaceId);
      if (!wc) return { ok: false, error: 'webcontents_unavailable' };
      await this._waitSettled(wc);
      const raw = await wc.executeJavaScript(this._extractScript(engine, count), true);
      const results = this.normalize(raw, count);
      return {
        ok: true, provider: 'inBrowser', engine, query, count: results.length, results,
        hint: results.length === 0
          ? 'No results parsed. The SERP may have served a challenge page — try a different query or switch settings.search.inBrowserEngine.'
          : 'Call browser.open_tab on the best result URL to read the page.',
      };
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'in_browser_search_failed' };
    } finally {
      if (spaceId && tabOps && typeof tabOps.closeTab === 'function') {
        try { await tabOps.closeTab(spaceId); } catch (_) { /* last-tab guard / non-fatal */ }
      }
    }
  }

  // Open a URL in a background agent tab, extract its readable body text (same
  // extractor the agent uses), then close the tab. Backs chat's "read the top
  // result" grounding; shares collectInBrowser's wait/close contract.
  async readPage(url, ctx) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'invalid_url' };
    const tabOps = ctx && ctx.tabOps;
    const resolveWc = ctx && ctx.resolveWc;
    if (!tabOps || typeof tabOps.openTab !== 'function' || typeof resolveWc !== 'function') {
      return { ok: false, error: 'in_browser_unavailable' };
    }
    let spaceId = null;
    try {
      const opened = await tabOps.openTab(target);
      spaceId = opened && opened.spaceId;
      if (!spaceId) return { ok: false, error: 'tab_open_failed' };
      const wc = await this._waitForWc(resolveWc, spaceId);
      if (!wc) return { ok: false, error: 'webcontents_unavailable' };
      await this._waitSettled(wc);
      const page = await wc.executeJavaScript(buildReadableScript({ maxMainText: MAX_PAGE_TEXT }), true);
      const mainText = page && typeof page.mainText === 'string' ? page.mainText.trim() : '';
      const title = page && typeof page.title === 'string' ? page.title.trim() : '';
      if (!mainText) {
        return { ok: false, error: 'empty_page', hint: 'The page had no extractable body text (it may be JS-rendered, paywalled, or a challenge).' };
      }
      return { ok: true, url: target, title, text: mainText };
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'read_page_failed' };
    } finally {
      if (spaceId && tabOps && typeof tabOps.closeTab === 'function') {
        try { await tabOps.closeTab(spaceId); } catch (_) { /* last-tab guard / non-fatal */ }
      }
    }
  }

  async _json(url, opts) {
    if (!this._fetch) return { ok: false, error: 'fetch_unavailable' };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
    try {
      const res = await this._fetch(url, { ...(opts || {}), signal: ctrl ? ctrl.signal : undefined });
      if (!res || !res.ok) return { ok: false, error: `http_${res ? res.status : 'error'}` };
      return { ok: true, body: await res.json() };
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.name === 'AbortError') ? 'search_timeout' : ((err instanceof Error && err.message) || 'fetch_failed') };
    } finally { if (timer) clearTimeout(timer); }
  }

  // Providers: searxng / brave / tavily. Each maps its native shape into the
  // common {title,url,snippet} list, then normalize() dedupes + clamps.
  async httpSearch(provider, query, count) {
    const cfg = this._cfg();
    if (provider === 'searxng') {
      const base = String(cfg.searxngUrl || '').replace(/\/+$/, '');
      if (!base) return { ok: false, error: 'searxng_not_configured', hint: 'Set settings.search.searxngUrl to a SearXNG instance.' };
      const r = await this._json(`${base}/search?format=json&safesearch=0&q=${encodeURIComponent(query)}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) return r;
      const list = (r.body && r.body.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '' }));
      return { ok: true, provider, query, count: this.normalize(list, count).length, results: this.normalize(list, count) };
    }
    if (provider === 'brave') {
      const key = String(cfg.braveApiKey || '').trim();
      if (!key) return { ok: false, error: 'brave_not_configured', hint: 'Set settings.search.braveApiKey.' };
      const r = await this._json(`https://api.search.brave.com/res/v1/web/search?count=${count}&q=${encodeURIComponent(query)}`, { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
      if (!r.ok) return r;
      const list = (r.body && r.body.web && r.body.web.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.description || '' }));
      return { ok: true, provider, query, count: this.normalize(list, count).length, results: this.normalize(list, count) };
    }
    if (provider === 'tavily') {
      const key = String(cfg.tavilyApiKey || '').trim();
      if (!key) return { ok: false, error: 'tavily_not_configured', hint: 'Set settings.search.tavilyApiKey.' };
      const r = await this._json('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: count }),
      });
      if (!r.ok) return r;
      const list = (r.body && r.body.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '' }));
      return { ok: true, provider, query, count: this.normalize(list, count).length, results: this.normalize(list, count) };
    }
    return { ok: false, error: `unknown_provider:${provider}` };
  }

  // Main entry used by the browser.web_search tool.
  async search(query, opts, ctx) {
    const q = String((query == null ? '' : query)).trim();
    if (!q) return { ok: false, error: 'empty_query' };
    const count = this._count(opts && opts.count);
    const provider = this.getProvider();
    if (provider === 'inBrowser') return this.collectInBrowser(q, count, ctx);
    return this.httpSearch(provider, q, count);
  }
}

const instance = new SearchService();
module.exports = instance;
module.exports.SearchService = SearchService;
