/**
 * @jest-environment jsdom
 *
 * End-to-end: the real browser.web_search tool → the real SearchService
 * inBrowser provider → the real in-page SERP extractor, against a real DOM.
 *
 * Only the external boundaries are substituted: the config store
 * (SearchService._setConfig) and the browser itself (a fake tabOps + a fake
 * webContents whose executeJavaScript actually evaluates the production
 * extractor script against a jsdom document built from realistic DuckDuckGo
 * HTML). Every line of arg-validation, provider selection, SERP-url building,
 * redirect unwrapping, result filtering/dedupe/clamp and tab teardown is the
 * shipping code — nothing under test is mocked.
 */

const searchTools = require('../../main/agent/tools/searchTool');
const searchService = require('../../main/services/SearchService');

const [webSearch] = searchTools;

// A DuckDuckGo html-endpoint result. Real DDG wraps the target in a
// //duckduckgo.com/l/?uddg=<encoded> redirect — the extractor must unwrap it.
function ddgResult(targetUrl, title, snippet) {
  const href = `//duckduckgo.com/l/?uddg=${encodeURIComponent(targetUrl)}&rut=deadbeef`;
  return `
    <div class="result results_links results_links_deep web-result">
      <div class="result__body">
        <h2 class="result__title">
          <a class="result__a" href="${href}">${title}</a>
        </h2>
        <a class="result__snippet" href="${href}">${snippet}</a>
      </div>
    </div>`;
}

// Fake browser: openTab paints the SERP into the jsdom document, resolveWc
// returns a webContents whose executeJavaScript runs the production extractor
// string against that document (exactly what Electron's executeJavaScript does
// in the real renderer), and closeTab records teardown.
function fakeBrowser(serpHtml) {
  const calls = { openedUrl: null, closedId: null };
  const wc = {
    isLoading: () => false,
    // eslint-disable-next-line no-eval
    executeJavaScript: async (script) => eval(script),
  };
  const tabOps = {
    openTab: jest.fn(async (url) => {
      calls.openedUrl = url;
      document.body.innerHTML = serpHtml;
      return { ok: true, spaceId: 'agent_tab_1' };
    }),
    closeTab: jest.fn(async (id) => { calls.closedId = id; return { ok: true }; }),
  };
  return { tabOps, resolveWc: () => wc, calls };
}

describe('web_search inBrowser — tool → service → extractor (end to end)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    searchService._setConfig({
      get: (k, d) => (k === 'settings.search'
        ? { provider: 'inBrowser', inBrowserEngine: 'duckduckgo', resultCount: 6 }
        : d),
    });
  });

  test('unwraps DDG redirects, filters engine links, dedupes, clamps to count', async () => {
    const serp = [
      ddgResult('https://doc.rust-lang.org/book/', 'The Rust Programming Language',
        '  Rust  is a systems programming language.  '),
      ddgResult('https://www.bing.com/aclk?ad=1', 'Sponsored — Rust course', 'ad'),
      ddgResult('https://tokio.rs/', 'Tokio — an async runtime for Rust', 'Build reliable async apps.'),
      ddgResult('https://doc.rust-lang.org/book/', 'Dup of the book', 'dup snippet'),
      ddgResult('https://www.rust-lang.org/', 'Rust Programming Language', 'A language empowering everyone.'),
    ].join('\n');
    const { tabOps, resolveWc, calls } = fakeBrowser(serp);

    const res = await webSearch.handler(
      { query: 'rust async', count: 3 },
      { tabOps, resolveWc }
    );

    // Tool + service drove a real background SERP tab and tore it down.
    expect(calls.openedUrl).toBe('https://html.duckduckgo.com/html/?q=rust%20async');
    expect(tabOps.closeTab).toHaveBeenCalledWith('agent_tab_1');

    expect(res.ok).toBe(true);
    expect(res.provider).toBe('inBrowser');
    expect(res.engine).toBe('duckduckgo');
    expect(res.query).toBe('rust async');
    expect(res.count).toBe(3);
    // bing.com link filtered out, the book duplicate deduped, clamped at 3.
    expect(res.results).toEqual([
      { title: 'The Rust Programming Language', url: 'https://doc.rust-lang.org/book/', snippet: 'Rust is a systems programming language.' },
      { title: 'Tokio — an async runtime for Rust', url: 'https://tokio.rs/', snippet: 'Build reliable async apps.' },
      { title: 'Rust Programming Language', url: 'https://www.rust-lang.org/', snippet: 'A language empowering everyone.' },
    ]);
    expect(res.hint).toMatch(/open_tab/);
  });

  test('a challenge/empty SERP yields zero results with a recovery hint, tab still closed', async () => {
    const { tabOps, resolveWc, calls } = fakeBrowser(
      '<div class="anomaly"><h1>Please verify you are human</h1></div>'
    );

    const res = await webSearch.handler({ query: 'anything' }, { tabOps, resolveWc });

    expect(res.ok).toBe(true);
    expect(res.results).toEqual([]);
    expect(res.hint).toMatch(/challenge page|different query/i);
    expect(calls.closedId).toBe('agent_tab_1');
  });

  test('empty query is rejected by the tool before any browser tab is opened', async () => {
    const { tabOps, resolveWc } = fakeBrowser('');
    const res = await webSearch.handler({ query: '   ' }, { tabOps, resolveWc });
    expect(res).toEqual({ ok: false, error: 'empty_query' });
    expect(tabOps.openTab).not.toHaveBeenCalled();
  });
});
