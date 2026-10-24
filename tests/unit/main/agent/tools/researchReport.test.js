const researchTools = require('../../../../../main/agent/tools/researchReport');
const { normalizeSources } = researchTools;

const openTool = researchTools[0];

describe('researchReport tool — schema', () => {
  test('exports a single side-effecting tool', () => {
    expect(researchTools.length).toBe(1);
    expect(openTool.name).toBe('browser.open_research_sources');
    expect(openTool.sideEffect).toBe(true);
    expect(openTool.parameters.required).toEqual(['sources']);
  });

  test('description tells the model to cite with the returned indices', () => {
    expect(openTool.description).toMatch(/\[index\]/);
    expect(openTool.description).toMatch(/web_search/);
  });
});

describe('normalizeSources', () => {
  test('keeps only http(s) URLs and defaults the title to the URL', () => {
    const r = normalizeSources([
      { url: 'https://a.com/x', title: 'A' },
      { url: 'ftp://nope.com' },
      { url: 'http://b.org' },
      { url: 'not a url' },
    ]);
    expect(r).toEqual([
      { url: 'https://a.com/x', title: 'A' },
      { url: 'http://b.org', title: 'http://b.org' },
    ]);
  });

  test('drops duplicate URLs case-insensitively', () => {
    const r = normalizeSources([
      { url: 'https://a.com/', title: 'first' },
      { url: 'HTTPS://A.COM/', title: 'dup' },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('first');
  });

  test('caps at 8 sources', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://s${i}.com` }));
    expect(normalizeSources(many)).toHaveLength(8);
  });

  test('returns [] for non-array input', () => {
    expect(normalizeSources(null)).toEqual([]);
    expect(normalizeSources('x')).toEqual([]);
  });
});

describe('researchReport tool — handler', () => {
  test('rejects when no valid sources are given', async () => {
    const res = await openTool.handler({ sources: [{ url: 'mailto:x@y.z' }] }, {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_valid_sources');
  });

  test('opens a pane per source and returns a sequential 1-based citation map', async () => {
    let n = 0;
    const tabOps = { openTab: jest.fn(async () => ({ spaceId: 'agent-tab-' + (++n) })) };
    const res = await openTool.handler({
      sources: [
        { url: 'https://a.com', title: 'Alpha' },
        { url: 'https://b.com', title: 'Beta' },
      ],
    }, { tabOps });
    expect(res.ok).toBe(true);
    expect(tabOps.openTab).toHaveBeenCalledTimes(2);
    expect(res.sources).toEqual([
      { index: 1, spaceId: 'agent-tab-1', url: 'https://a.com', title: 'Alpha' },
      { index: 2, spaceId: 'agent-tab-2', url: 'https://b.com', title: 'Beta' },
    ]);
    expect(res.hint).toMatch(/\[index\]/);
  });

  test('indices stay sequential across a failed open (no gap)', async () => {
    const tabOps = {
      openTab: jest.fn()
        .mockResolvedValueOnce({ spaceId: 'agent-tab-1' })
        .mockResolvedValueOnce({})            // open_failed (no spaceId)
        .mockResolvedValueOnce({ spaceId: 'agent-tab-3' }),
    };
    const res = await openTool.handler({
      sources: [{ url: 'https://a.com' }, { url: 'https://b.com' }, { url: 'https://c.com' }],
    }, { tabOps });
    expect(res.ok).toBe(true);
    expect(res.sources.map((s) => s.index)).toEqual([1, 2]);
    expect(res.sources.map((s) => s.spaceId)).toEqual(['agent-tab-1', 'agent-tab-3']);
    expect(res.errors).toHaveLength(1);
  });

  test('aggregates errors and fails when nothing opens', async () => {
    const tabOps = { openTab: jest.fn(async () => { throw new Error('attach lost'); }) };
    const res = await openTool.handler({ sources: [{ url: 'https://a.com' }] }, { tabOps });
    expect(res.ok).toBe(false);
    expect(res.sources).toEqual([]);
    expect(res.errors[0]).toEqual({ url: 'https://a.com', error: 'attach lost' });
    expect(res.hint).toMatch(/No sources could be opened/);
  });
});
