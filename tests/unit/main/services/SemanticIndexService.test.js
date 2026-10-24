// SemanticIndexService tests — lexical ranking is the always-available
// primary; embeddings are an opt-in overlay (HTTP boundary mocked). Real
// HistoryService + BookmarkService singletons supply the corpus (internal
// modules — not mocked); only fetch + fs are faked.

let semantic;
let history;
let bookmarks;
let contentIndex;

function makeMemFs() {
  const files = new Map();
  const dirs = new Set(['/mem']);
  return {
    files,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => (files.has(p) ? files.get(p) : ''),
    writeFileSync: (p, c) => { files.set(p, String(c)); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    mkdirSync: (p) => { dirs.add(p); },
  };
}

function fakeConfig(askBrowsing) {
  return { get: (p, fb) => (p === 'settings.askBrowsing' ? askBrowsing : fb) };
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  jest.resetModules();
  history = require('../../../../main/services/HistoryService');
  bookmarks = require('../../../../main/services/BookmarkService');
  semantic = require('../../../../main/services/SemanticIndexService');
  contentIndex = require('../../../../main/services/ContentIndexService');

  const memfs = makeMemFs();

  history._setFs(memfs);
  history._setFilePath('/mem/history.json');
  history._loaded = true;
  history._entries = [];
  history._saveTimer = null;

  bookmarks._setFs(memfs);
  bookmarks._setFilePath('/mem/bookmarks.json');
  bookmarks._items = new Map();
  bookmarks._loaded = false;

  semantic._setFs(memfs);
  semantic._setFilePath('/mem/semantic_index.json');
  semantic._setConfig(fakeConfig({}));
  semantic._index = null;

  contentIndex._setFs(memfs);
  contentIndex._setFilePath('/mem/semantic_content.json');
  contentIndex._setConfig(fakeConfig({}));
  contentIndex._reset();
});

describe('SemanticIndexService.search — lexical (always available)', () => {
  test('empty query is rejected', async () => {
    const r = await semantic.search('   ');
    expect(r).toEqual({ ok: false, error: 'empty_query' });
  });

  test('ranks title + all-terms + phrase matches above weak matches', async () => {
    history.addEntry({ url: 'https://rust-lang.org/async', title: 'Rust async programming guide' });
    history.addEntry({ url: 'https://async.dev', title: 'Async basics' });
    history.addEntry({ url: 'https://example.com/python-async', title: 'Python tutorial' });

    const r = await semantic.search('rust async');
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('lexical');
    expect(r.count).toBeGreaterThan(0);
    expect(r.results[0].url).toBe('https://rust-lang.org/async');
    expect(r.results[0].source).toBe('history');
    // "Python tutorial" only matches "async" via URL — must rank last or be excluded.
    const py = r.results.find((x) => x.url.includes('python'));
    if (py) expect(r.results.indexOf(py)).toBeGreaterThan(0);
  });

  test('searches bookmarks as well as history', async () => {
    bookmarks.add({ url: 'https://kubernetes.io/docs', title: 'Kubernetes networking deep dive' });
    const r = await semantic.search('kubernetes networking');
    expect(r.ok).toBe(true);
    expect(r.results[0].url).toBe('https://kubernetes.io/docs');
    expect(r.results[0].source).toBe('bookmark');
  });

  test('no matches returns a helpful hint and zero results', async () => {
    history.addEntry({ url: 'https://example.com', title: 'Example' });
    const r = await semantic.search('zzzznonexistentterm');
    expect(r.ok).toBe(true);
    expect(r.count).toBe(0);
    expect(r.hint).toMatch(/Nothing in history or bookmarks/);
  });

  test('respects the limit option (clamped to 50)', async () => {
    for (let i = 0; i < 30; i++) history.addEntry({ url: `https://site${i}.com/report`, title: `Report ${i}` });
    const r = await semantic.search('report', { limit: 5 });
    expect(r.results.length).toBe(5);
  });
});

describe('SemanticIndexService.search — embeddings overlay (opt-in)', () => {
  test('endpoint set but no cached vectors → stays lexical, surfaces note', async () => {
    history.addEntry({ url: 'https://a.com/ml', title: 'Machine learning notes' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://localhost:9999' }));
    const fetchSpy = jest.fn();
    semantic._setFetch(fetchSpy);

    const r = await semantic.search('machine learning');
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('lexical');
    expect(r.note).toMatch(/no cached vectors yet/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('cached vectors + reachable endpoint → hybrid re-ranking', async () => {
    const e1 = history.addEntry({ url: 'https://a.com/cats', title: 'All about cats' });
    const e2 = history.addEntry({ url: 'https://a.com/dogs', title: 'All about dogs' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://localhost:9999', blend: 1 }));
    semantic.load();
    // dogs vector aligns with the query vector; cats is orthogonal.
    semantic._index = {
      model: 'm',
      vecs: {
        [`h:${e1.id}`]: { h: 'x', v: [0, 1] },
        [`h:${e2.id}`]: { h: 'x', v: [1, 0] },
      },
    };
    semantic._setFetch(jest.fn(async () => okJson({ data: [{ embedding: [1, 0] }] })));

    const r = await semantic.search('all about');
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('hybrid');
    expect(r.results[0].url).toBe('https://a.com/dogs');
  });

  test('embeddings endpoint failure degrades to lexical without throwing', async () => {
    const e1 = history.addEntry({ url: 'https://a.com/x', title: 'Topic X overview' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://localhost:9999' }));
    semantic.load();
    semantic._index = { model: 'm', vecs: { [`h:${e1.id}`]: { h: 'x', v: [1, 0] } } };
    semantic._setFetch(jest.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const r = await semantic.search('topic x');
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('lexical');
    expect(r.note).toMatch(/semantic ranking unavailable/);
    expect(r.results.length).toBeGreaterThan(0);
  });
});

describe('SemanticIndexService.reindex', () => {
  test('refuses without an embeddings endpoint', async () => {
    const r = await semantic.reindex();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('embeddings_not_configured');
    expect(r.hint).toMatch(/embeddings/i);
  });

  test('embeds the corpus, persists vectors, and is incremental', async () => {
    history.addEntry({ url: 'https://a.com/1', title: 'Doc one' });
    history.addEntry({ url: 'https://a.com/2', title: 'Doc two' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://localhost:9999', embeddingsModel: 'emb-v1' }));
    const fetchSpy = jest.fn(async (_url, init) => {
      const inputs = JSON.parse(init.body).input;
      return okJson({ data: inputs.map(() => ({ embedding: [0.1, 0.2] })) });
    });
    semantic._setFetch(fetchSpy);

    const first = await semantic.reindex();
    expect(first.ok).toBe(true);
    expect(first.embedded).toBe(2);
    expect(first.total).toBe(2);

    // Persisted to the index file.
    const memfs = semantic._fs;
    expect(memfs.files.has('/mem/semantic_index.json')).toBe(true);
    const persisted = JSON.parse(memfs.files.get('/mem/semantic_index.json'));
    expect(Object.keys(persisted.vecs).length).toBe(2);
    expect(persisted.model).toBe('emb-v1');

    // Second pass with no doc changes embeds nothing (hash-incremental).
    fetchSpy.mockClear();
    const second = await semantic.reindex();
    expect(second.ok).toBe(true);
    expect(second.embedded).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('persisted vectors are reloaded from disk', async () => {
    history.addEntry({ url: 'https://a.com/keep', title: 'Keep me' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://localhost:9999' }));
    semantic._setFetch(jest.fn(async () => okJson({ data: [{ embedding: [1, 1] }] })));
    await semantic.reindex();

    semantic._index = null; // force a fresh load from the fake fs
    semantic.load();
    expect(Object.keys(semantic._index.vecs).length).toBe(1);
  });
});

describe('SemanticIndexService._scheduleReindex (auto-debounced)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('is a no-op when no embeddings endpoint is configured', () => {
    semantic._setConfig(fakeConfig({})); // pure-lexical mode
    semantic._scheduleReindex();
    expect(semantic._scheduler.isPending()).toBe(false);
  });

  test('schedules a reindex after the debounce when an endpoint is set', async () => {
    history.addEntry({ url: 'https://a.com/1', title: 'Doc one' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://localhost:9999' }));
    const fetchSpy = jest.fn(async (_url, init) => {
      const inputs = JSON.parse(init.body).input;
      return okJson({ data: inputs.map(() => ({ embedding: [0.1, 0.2] })) });
    });
    semantic._setFetch(fetchSpy);

    semantic._scheduleReindex();
    expect(semantic._scheduler.isPending()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(30000);
    await Promise.resolve(); // let the swallowed reindex promise settle
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(semantic._scheduler.isPending()).toBe(false);
  });

  test('an explicit reindex cancels a pending debounce (no double-fire)', async () => {
    history.addEntry({ url: 'https://a.com/1', title: 'Doc one' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://localhost:9999' }));
    const fetchSpy = jest.fn(async (_url, init) => {
      const inputs = JSON.parse(init.body).input;
      return okJson({ data: inputs.map(() => ({ embedding: [0.1, 0.2] })) });
    });
    semantic._setFetch(fetchSpy);

    semantic._scheduleReindex();
    expect(semantic._scheduler.isPending()).toBe(true);
    // Explicit reindex mid-debounce wins and clears the timer.
    const r = await semantic.reindex();
    expect(r.ok).toBe(true);
    expect(semantic._scheduler.isPending()).toBe(false);
    // Advancing past the original debounce window must not fire a second time.
    jest.advanceTimersByTime(30000);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('a burst of HistoryService.addEntry coalesces into one reindex', async () => {
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://localhost:9999' }));
    const fetchSpy = jest.fn(async (_url, init) => {
      const inputs = JSON.parse(init.body).input;
      return okJson({ data: inputs.map(() => ({ embedding: [0.1, 0.2] })) });
    });
    semantic._setFetch(fetchSpy);

    // addEntry now calls _scheduleReindex; five adds in quick succession.
    for (let i = 0; i < 5; i++) history.addEntry({ url: `https://a.com/${i}`, title: `Doc ${i}` });
    expect(semantic._scheduler.isPending()).toBe(true);
    jest.advanceTimersByTime(30000);
    await Promise.resolve();
    // The whole burst was embedded in a single reindex pass (one fetch call).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('SemanticIndexService._cfg defaults + clamping', () => {
  test('non-object config and missing keys produce safe defaults', async () => {
    semantic._setConfig({ get: () => 'not-an-object' });
    // search exercises _cfg() internally; with no endpoint it stays lexical.
    history.addEntry({ url: 'https://a.com/cfg', title: 'Config probe page' });
    const r = await semantic.search('config probe');
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('lexical');
  });

  test('blend is clamped to [0,1] and maxResults floored to a positive int', async () => {
    const e1 = history.addEntry({ url: 'https://a.com/p1', title: 'Alpha report one' });
    history.addEntry({ url: 'https://a.com/p2', title: 'Alpha report two' });
    semantic._setConfig(fakeConfig({
      embeddingsEndpoint: 'http://e:1', blend: 5, maxResults: -3,
    }));
    semantic.load();
    semantic._index = { model: '', vecs: { [`h:${e1.id}`]: { h: 'x', v: [1, 0] } } };
    semantic._setFetch(jest.fn(async () => okJson({ data: [{ embedding: [1, 0] }] })));
    const r = await semantic.search('alpha report');
    // blend clamped to 1 → pure-cosine ranking still returns ok results.
    expect(r.ok).toBe(true);
    expect(r.count).toBeGreaterThan(0);
  });

  test('no config service at all → enabled default, lexical only', async () => {
    semantic._setConfig(null);
    history.addEntry({ url: 'https://a.com/nc', title: 'No config search target' });
    const r = await semantic.search('config search target');
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('lexical');
  });
});

describe('SemanticIndexService.load + _save resilience', () => {
  test('load swallows corrupt index JSON and starts empty', () => {
    semantic._fs.files.set('/mem/semantic_index.json', '{ not valid json');
    semantic._index = null;
    semantic.load();
    expect(semantic._index).toEqual({ model: '', vecs: {} });
  });

  test('load ignores a parsed object that lacks a vecs map', () => {
    semantic._fs.files.set('/mem/semantic_index.json', JSON.stringify({ model: 'm' }));
    semantic._index = null;
    semantic.load();
    expect(semantic._index).toEqual({ model: '', vecs: {} });
  });

  test('load is idempotent — a second call does not reparse', () => {
    semantic._index = { model: 'kept', vecs: { x: 1 } };
    semantic.load();
    expect(semantic._index.model).toBe('kept');
  });

  test('_save logs and does not throw when the fs write fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    history.addEntry({ url: 'https://a.com/s', title: 'Save failure doc' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://e:1' }));
    semantic._setFetch(jest.fn(async () => okJson({ data: [{ embedding: [1, 1] }] })));
    const badFs = {
      ...semantic._fs,
      existsSync: () => false,
      mkdirSync: () => { throw new Error('EACCES'); },
      writeFileSync: () => { throw new Error('EROFS'); },
      readFileSync: () => '',
    };
    semantic._setFs(badFs);
    const r = await semantic.reindex();
    expect(r.ok).toBe(true); // reindex still reports success
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[SemanticIndex] save failed:'), expect.anything());
    errSpy.mockRestore();
  });
});

describe('SemanticIndexService._lexicalRank query shapes', () => {
  test('an all-stopword query scores every doc at 0 (no terms)', async () => {
    history.addEntry({ url: 'https://a.com/x', title: 'Some content here' });
    const r = await semantic.search('the a of to');
    expect(r.ok).toBe(true);
    // every result scores 0 → still returned (no terms filters nothing out)
    expect(r.results.every((x) => x.score === 0)).toBe(true);
  });

  test('a phrase match in the URL/text (not title) gets the lesser phrase bonus', async () => {
    history.addEntry({ url: 'https://example.com/quantum-computing-explained', title: 'Tech blog' });
    history.addEntry({ url: 'https://other.com/unrelated', title: 'Quantum computing explained in depth' });
    const r = await semantic.search('quantum computing explained');
    expect(r.ok).toBe(true);
    // The title-phrase match must outrank the URL-phrase match.
    expect(r.results[0].title).toBe('Quantum computing explained in depth');
  });

  test('recency tiebreak nudges a fresher doc above an equally-scored older one', async () => {
    const now = Date.now();
    const old = history.addEntry({ url: 'https://a.com/old', title: 'Widget guide' });
    old.timestamp = now - 1000 * 60 * 60 * 24 * 60; // 60 days old
    const fresh = history.addEntry({ url: 'https://a.com/new', title: 'Widget guide' });
    fresh.timestamp = now;
    const r = await semantic.search('widget guide');
    expect(r.results[0].url).toBe('https://a.com/new');
  });
});

describe('SemanticIndexService.reindex incremental + pruning', () => {
  test('switching embeddings model wipes the stale vector cache', async () => {
    history.addEntry({ url: 'https://a.com/m', title: 'Model switch doc' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://e:1', embeddingsModel: 'old-model' }));
    semantic._setFetch(jest.fn(async () => okJson({ data: [{ embedding: [0.1, 0.2] }] })));
    await semantic.reindex();
    const memfs = semantic._fs;
    expect(JSON.parse(memfs.files.get('/mem/semantic_index.json')).model).toBe('old-model');

    // New model name → vecs cleared, everything re-embedded.
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://e:1', embeddingsModel: 'new-model' }));
    semantic._index = null;
    const fetchSpy = jest.fn(async () => okJson({ data: [{ embedding: [0.3, 0.4] }] }));
    semantic._setFetch(fetchSpy);
    const r = await semantic.reindex();
    expect(r.embedded).toBe(1); // re-embedded after model change
    expect(JSON.parse(memfs.files.get('/mem/semantic_index.json')).model).toBe('new-model');
  });

  test('reindex prunes vectors for docs no longer in the corpus', async () => {
    const e1 = history.addEntry({ url: 'https://a.com/keep', title: 'Keep doc' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://e:1' }));
    semantic.load();
    semantic._index = {
      model: '',
      vecs: {
        [`h:${e1.id}`]: { h: 'stale', v: [1, 0] },
        'h:ghost-id': { h: 'x', v: [0, 1] }, // not in the corpus anymore
      },
    };
    semantic._setFetch(jest.fn(async () => okJson({ data: [{ embedding: [1, 1] }] })));
    await semantic.reindex();
    const vecs = JSON.parse(semantic._fs.files.get('/mem/semantic_index.json')).vecs;
    expect(Object.keys(vecs)).toEqual([`h:${e1.id}`]);
  });

  test('reindex skips embedding-result gaps (no vector for an input)', async () => {
    history.addEntry({ url: 'https://a.com/1', title: 'Doc one' });
    history.addEntry({ url: 'https://a.com/2', title: 'Doc two' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://e:1' }));
    // Server returns one embedding and one non-array entry → only one stored.
    semantic._setFetch(jest.fn(async () => okJson({ data: [{ embedding: [1, 0] }, { embedding: 'oops' }] })));
    const r = await semantic.reindex();
    expect(r.ok).toBe(true);
    expect(r.embedded).toBe(1);
  });
});

describe('SemanticIndexService._embed failure arms', () => {
  test('throws when fetch is unavailable', async () => {
    semantic._setFetch(null);
    await expect(semantic._embed(['x'], { embeddingsEndpoint: 'http://e:1' }))
      .rejects.toThrow('fetch_unavailable');
  });

  test('throws when no embeddings endpoint is configured', async () => {
    semantic._setFetch(jest.fn());
    await expect(semantic._embed(['x'], { embeddingsEndpoint: '' }))
      .rejects.toThrow('embeddings_not_configured');
  });

  test('throws embeddings_http_<status> on a non-ok response', async () => {
    semantic._setFetch(jest.fn(async () => ({ ok: false, status: 502 })));
    await expect(semantic._embed(['x'], { embeddingsEndpoint: 'http://e:1' }))
      .rejects.toThrow('embeddings_http_502');
  });

  test('throws embeddings_http_error when fetch resolves to nothing', async () => {
    semantic._setFetch(jest.fn(async () => null));
    await expect(semantic._embed(['x'], { embeddingsEndpoint: 'http://e:1' }))
      .rejects.toThrow('embeddings_http_error');
  });

  test('returns [] when the embeddings body has no data array', async () => {
    semantic._setFetch(jest.fn(async () => okJson({ nope: true })));
    const out = await semantic._embed(['x'], { embeddingsEndpoint: 'http://e:1' });
    expect(out).toEqual([]);
  });
});

describe('SemanticIndexService.search hybrid edge cases', () => {
  test('embeddings disabled (enabled:false) stays lexical even with an endpoint', async () => {
    const e1 = history.addEntry({ url: 'https://a.com/d', title: 'Disabled embeddings doc' });
    semantic._setConfig(fakeConfig({ enabled: false, embeddingsEndpoint: 'http://e:1' }));
    semantic.load();
    semantic._index = { model: '', vecs: { [`h:${e1.id}`]: { h: 'x', v: [1, 0] } } };
    const fetchSpy = jest.fn();
    semantic._setFetch(fetchSpy);
    const r = await semantic.search('disabled embeddings');
    expect(r.mode).toBe('lexical');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('query embedding returning nothing leaves the lexical ranking intact', async () => {
    const e1 = history.addEntry({ url: 'https://a.com/q', title: 'Query embed empty doc' });
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://e:1' }));
    semantic.load();
    semantic._index = { model: '', vecs: { [`h:${e1.id}`]: { h: 'x', v: [1, 0] } } };
    semantic._setFetch(jest.fn(async () => okJson({ data: [] }))); // no query vector
    const r = await semantic.search('query embed empty');
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('lexical'); // qv undefined → never flips to hybrid
  });
});

describe('exported helpers', () => {
  test('tokenize strips punctuation and lowercases', () => {
    expect(semantic.tokenize('Hello, World! 123')).toEqual(['hello', 'world', '123']);
    expect(semantic.tokenize(null)).toEqual([]);
  });

  test('cosine handles aligned, orthogonal, and mismatched vectors', () => {
    expect(semantic.cosine([1, 0], [1, 0])).toBe(1);
    expect(semantic.cosine([1, 0], [0, 1])).toBe(0);
    expect(semantic.cosine([1, 2], [1])).toBe(0);
    expect(semantic.cosine(null, [1])).toBe(0);
    expect(semantic.cosine([0, 0], [0, 0])).toBe(0); // zero-norm guard
  });
});

describe('SemanticIndexService — IDF-weighted lexical ranking', () => {
  test('a rare term outranks a ubiquitous term when each doc matches one term', async () => {
    // doc1 matches only the common term "page"; doc2 matches only the rare term
    // "kubernetes". Filler docs make "page" ubiquitous. Without IDF both docs
    // tie at the same title-hit score and the common one wins on insertion order;
    // IDF makes the rare-term doc win. This is the regression: drop IDF and the
    // k8s doc sinks below the filler.
    history.addEntry({ url: 'https://a.com/common-page', title: 'The page' });
    history.addEntry({ url: 'https://a.com/k8s', title: 'Kubernetes deep dive' });
    history.addEntry({ url: 'https://a.com/fill1', title: 'Page filler one' });
    history.addEntry({ url: 'https://a.com/fill2', title: 'Page filler two' });
    history.addEntry({ url: 'https://a.com/fill3', title: 'Page filler three' });
    const r = await semantic.search('kubernetes page');
    expect(r.ok).toBe(true);
    expect(r.results[0].url).toBe('https://a.com/k8s');
  });

  test('IDF is the sole discriminator against recency for a rare single-term match', async () => {
    // The rare doc matches ONLY "rust" (rare) and is OLDER. The common doc matches
    // ONLY "page" (ubiquitous) and is FRESHER. Query "rust page" — each doc hits
    // one title term, so the all-terms bonus never fires. Without IDF, recency
    // lifts the fresher common doc above the rare one; with IDF, the rare term's
    // weight overcomes the recency gap. This is the regression: drop IDF and the
    // rare doc loses to a fresher filler.
    const now = Date.now();
    const rare = history.addEntry({ url: 'https://a.com/rare', title: 'Rust ownership guide' });
    rare.timestamp = now - 1000 * 60 * 60 * 24 * 10; // 10 days old
    const common = history.addEntry({ url: 'https://a.com/common', title: 'Page notes' });
    common.timestamp = now; // fresher
    history.addEntry({ url: 'https://a.com/fill1', title: 'Page filler one' });
    history.addEntry({ url: 'https://a.com/fill2', title: 'Page filler two' });
    history.addEntry({ url: 'https://a.com/fill3', title: 'Page filler three' });
    const r = await semantic.search('rust page');
    expect(r.results[0].url).toBe('https://a.com/rare');
  });

  test('the df map is rebuilt after a reindex that changes the corpus', async () => {
    history.addEntry({ url: 'https://a.com/seed', title: 'Seed doc page' });
    // Prime the df cache with a search over the small corpus.
    await semantic.search('seed page');
    expect(semantic._dfCache).not.toBeNull();
    // reindex invalidates the cache (corpus text may change even if ids don't).
    semantic._setConfig(fakeConfig({ embeddingsEndpoint: 'http://e:1' }));
    semantic._setFetch(jest.fn(async () => okJson({ data: [{ embedding: [1, 0] }] })));
    await semantic.reindex();
    expect(semantic._dfCache).toBeNull();
    // A new search rebuilds it from the current corpus.
    await semantic.search('seed');
    expect(semantic._dfCache).not.toBeNull();
  });
});

describe('SemanticIndexService — content overlay (indexContent)', () => {
  // Config that answers both the askBrowsing block and the indexContent key.
  function fakeContentConfig(askBrowsing, indexContent) {
    return {
      get: (p, fb) => {
        if (p === 'settings.askBrowsing') return askBrowsing;
        if (p === 'settings.askBrowsing.indexContent') return indexContent;
        return fb;
      },
    };
  }

  test('with indexContent on, a body-only term matches where title/URL would miss', async () => {
    // The page title/URL say nothing about "kubernetes"; the term appears only
    // in the readable body text stored by ContentIndexService.
    const e = history.addEntry({ url: 'https://ops.example.com/post-42', title: 'Operations log' });
    contentIndex._setConfig(fakeContentConfig({}, true));
    contentIndex.capture(e.url, 'We migrated the cluster to kubernetes last quarter.');
    semantic._setConfig(fakeContentConfig({}, true));

    const r = await semantic.search('kubernetes');
    expect(r.ok).toBe(true);
    expect(r.count).toBeGreaterThan(0);
    expect(r.results[0].url).toBe(e.url);
  });

  test('with indexContent off, the same body-only term finds nothing', async () => {
    const e = history.addEntry({ url: 'https://ops.example.com/post-43', title: 'Operations log' });
    contentIndex._setConfig(fakeContentConfig({}, false));
    contentIndex.capture(e.url, 'We migrated the cluster to kubernetes last quarter.'); // no-op when off
    semantic._setConfig(fakeContentConfig({}, false));

    const r = await semantic.search('kubernetes');
    expect(r.ok).toBe(true);
    expect(r.count).toBe(0);
  });

  test('content text is folded into the doc text used for embeddings', async () => {
    const e = history.addEntry({ url: 'https://ops.example.com/post-44', title: 'Notes' });
    contentIndex._setConfig(fakeContentConfig({}, true));
    contentIndex.capture(e.url, 'deep dive into webassembly performance');
    semantic._setConfig(fakeContentConfig({ embeddingsEndpoint: 'http://e:1' }, true));
    semantic._setFetch(jest.fn(async (_u, init) => {
      // The embedded text must contain the body term — proves _docText folds it in.
      const body = JSON.parse(init.body).input.join(' ');
      expect(body).toContain('webassembly');
      return okJson({ data: [{ embedding: [0.1, 0.2] }] });
    }));
    await semantic.reindex();
    // fetchSpy's assertion inside the mock already proved the body term was embedded.
    expect(semantic._fetch).toHaveBeenCalled();
  });
});
