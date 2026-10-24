// BookmarkService tests — uses an in-memory fake fs.

let svc;

function makeMemFs() {
  const files = new Map();
  return {
    files,
    existsSync: jest.fn((p) => files.has(p) || p === '/tmp-mock'),
    readFileSync: jest.fn((p) => files.get(p) || ''),
    writeFileSync: jest.fn((p, content) => { files.set(p, content); }),
    renameSync: jest.fn((from, to) => { files.set(to, files.get(from)); files.delete(from); }),
    mkdirSync: jest.fn(),
  };
}

beforeEach(() => {
  jest.resetModules();
  svc = require('../../../../main/services/BookmarkService');
  svc._setFs(makeMemFs());
  svc._setFilePath('/tmp-mock/bookmarks.json');
  svc._items = new Map();
  svc._loaded = false;
});

describe('BookmarkService', () => {
  test('add creates a bookmark under root by default', () => {
    const bm = svc.add({ url: 'https://x.com', title: 'X' });
    expect(bm.url).toBe('https://x.com');
    expect(bm.parentId).toBe(svc.ROOT_ID);
    expect(bm.type).toBe('bookmark');
  });

  test('add throws when url missing', () => {
    expect(() => svc.add({})).toThrow(/url required/);
  });

  test('addFolder creates a folder', () => {
    const f = svc.addFolder({ name: 'Work' });
    expect(f.type).toBe('folder');
    expect(f.name).toBe('Work');
  });

  test('add into a folder respects parentId', () => {
    const f = svc.addFolder({ name: 'AI' });
    const bm = svc.add({ url: 'https://x.com', parentId: f.id });
    expect(bm.parentId).toBe(f.id);
  });

  test('remove cascades to descendants', () => {
    const folder = svc.addFolder({ name: 'Work' });
    svc.add({ url: 'https://a.com', parentId: folder.id });
    svc.add({ url: 'https://b.com', parentId: folder.id });
    expect(svc.remove(folder.id)).toBe(true);
    const tree = svc.getTree();
    const found = (tree.children || []).find((c) => c.id === folder.id);
    expect(found).toBeUndefined();
  });

  test('remove root is rejected', () => {
    expect(svc.remove(svc.ROOT_ID)).toBe(false);
  });

  test('move changes parentId', () => {
    const f = svc.addFolder({ name: 'Work' });
    const bm = svc.add({ url: 'https://x.com' });
    expect(svc.move(bm.id, f.id)).toBe(true);
    const tree = svc.getTree();
    const work = tree.children.find((c) => c.id === f.id);
    expect(work.children.some((c) => c.id === bm.id)).toBe(true);
  });

  test('search finds bookmarks by name or url', () => {
    svc.add({ url: 'https://example.com', title: 'Example' });
    svc.add({ url: 'https://other.org', title: 'Other' });
    expect(svc.search('example').length).toBe(1);
    expect(svc.search('other.org').length).toBe(1);
    expect(svc.search('').length).toBe(0);
  });

  test('findByUrl matches the exact URL and ignores folders', () => {
    svc.addFolder({ name: 'https://example.com' });
    const bm = svc.add({ url: 'https://example.com', title: 'Example' });
    expect(svc.findByUrl('https://example.com').id).toBe(bm.id);
    // A prefix must not match: the star toggle would otherwise remove the
    // wrong bookmark.
    expect(svc.findByUrl('https://example.com/page')).toBeNull();
    expect(svc.findByUrl('')).toBeNull();
  });

  test('getTree returns nested folders', () => {
    const work = svc.addFolder({ name: 'Work' });
    svc.add({ url: 'https://x.com', parentId: work.id });
    const tree = svc.getTree();
    expect(tree.id).toBe(svc.ROOT_ID);
    const workNode = tree.children.find((c) => c.id === work.id);
    expect(workNode.children.length).toBe(1);
  });
});

describe('BookmarkService persistence safety', () => {
  test('a truncated bookmarks file is moved aside and never overwritten by the next add', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const truncated = '[{"id":"root","type":"folder"},{"id":"b1","url":"https://keep.me","tit';
    svc._fs.files.set('/tmp-mock/bookmarks.json', truncated);
    svc.add({ url: 'https://new.com', title: 'New' });
    const corrupt = [...svc._fs.files.keys()].find((k) => k.startsWith('/tmp-mock/bookmarks.json.corrupt-'));
    expect(svc._fs.files.get(corrupt)).toBe(truncated);
    err.mockRestore();
  });

  test('saves write a temp file then rename it over bookmarks.json', () => {
    svc.add({ url: 'https://x.com', title: 'X' });
    const [tmp] = svc._fs.writeFileSync.mock.calls[0];
    expect(tmp).toMatch(/^\/tmp-mock\/bookmarks\.json\..+\.tmp$/);
    expect(svc._fs.renameSync).toHaveBeenCalledWith(tmp, '/tmp-mock/bookmarks.json');
    expect(svc._fs.files.has(tmp)).toBe(false);
  });
});
