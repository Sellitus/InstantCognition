// HistoryService tests — uses an in-memory fake fs.

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
  jest.useFakeTimers();
  svc = require('../../../../main/services/HistoryService');
  svc._setFs(makeMemFs());
  svc._setFilePath('/tmp-mock/history.json');
  svc._loaded = false;
  svc._entries = [];
  svc._saveTimer = null;
});

afterEach(() => { jest.useRealTimers(); });

describe('HistoryService', () => {
  test('addEntry stores url + title with timestamp', () => {
    const e = svc.addEntry({ url: 'https://x.com', title: 'X', spaceId: 'browser' });
    expect(e.url).toBe('https://x.com');
    expect(e.title).toBe('X');
    expect(typeof e.timestamp).toBe('number');
    expect(svc.getRecent().length).toBe(1);
  });

  test('addEntry rejects empty url', () => {
    const before = svc.getRecent().length;
    svc.addEntry({ url: '' });
    svc.addEntry({});
    expect(svc.getRecent().length).toBe(before);
  });

  test('search filters by url and title case-insensitively', () => {
    svc.addEntry({ url: 'https://example.com/page', title: 'Example Page' });
    svc.addEntry({ url: 'https://other.org', title: 'Other site' });
    expect(svc.search('example').length).toBe(1);
    expect(svc.search('OTHER').length).toBe(1);
  });

  test('getRecent returns entries newest-first', () => {
    svc.addEntry({ url: 'https://a.com' });
    svc.addEntry({ url: 'https://b.com' });
    const recent = svc.getRecent();
    expect(recent[0].url).toBe('https://b.com');
    expect(recent[1].url).toBe('https://a.com');
  });

  test('deleteEntry removes by id', () => {
    const e = svc.addEntry({ url: 'https://x.com' });
    expect(svc.deleteEntry(e.id)).toBe(true);
    expect(svc.getRecent().length).toBe(0);
    expect(svc.deleteEntry('nonexistent')).toBe(false);
  });

  test('clearAll empties history', () => {
    svc.addEntry({ url: 'https://x.com' });
    svc.clearAll();
    expect(svc.getRecent().length).toBe(0);
  });

  test('flushSync writes JSON to file', () => {
    svc.addEntry({ url: 'https://x.com', title: 'X' });
    svc.flushSync();
    const content = svc._fs.files.get('/tmp-mock/history.json');
    expect(content).toBeTruthy();
    const parsed = JSON.parse(content);
    expect(parsed[0].url).toBe('https://x.com');
  });

  test('a repeat of the newest visit refreshes it instead of adding a duplicate', () => {
    const first = svc.addEntry({ url: 'https://claude.ai/new', title: '', spaceId: 'custom2' });
    const { id, timestamp } = first;
    jest.setSystemTime(timestamp + 60000);
    const again = svc.addEntry({ url: 'https://claude.ai/new', title: 'Claude', spaceId: 'custom2' });
    expect(svc.getRecent().length).toBe(1);
    expect(again.id).toBe(id);
    expect(again.title).toBe('Claude');
    expect(again.timestamp).toBe(timestamp + 60000);
  });

  test('the same URL in a different space, or after another visit, is a new entry', () => {
    svc.addEntry({ url: 'https://a.com', spaceId: 'custom1' });
    svc.addEntry({ url: 'https://a.com', spaceId: 'custom2' });
    svc.addEntry({ url: 'https://b.com', spaceId: 'custom2' });
    svc.addEntry({ url: 'https://a.com', spaceId: 'custom2' });
    expect(svc.getRecent().length).toBe(4);
  });

  test('a collapsed repeat with an empty title keeps the stored title', () => {
    svc.addEntry({ url: 'https://a.com', title: 'A', spaceId: 's' });
    svc.addEntry({ url: 'https://a.com', title: '', spaceId: 's' });
    expect(svc.getRecent()[0].title).toBe('A');
  });

  test('saves go through a temp file and rename', () => {
    svc.addEntry({ url: 'https://x.com', title: 'X' });
    svc.flushSync();
    const [tmp] = svc._fs.writeFileSync.mock.calls[0];
    expect(tmp).toMatch(/^\/tmp-mock\/history\.json\..+\.tmp$/);
    expect(svc._fs.renameSync).toHaveBeenCalledWith(tmp, '/tmp-mock/history.json');
    expect(svc._fs.files.has(tmp)).toBe(false);
  });

  test('a history file that exists but cannot be read is left in place and never overwritten', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    svc._fs.files.set('/tmp-mock/history.json', '[{"id":"1","url":"https://keep.me"}]');
    svc._fs.readFileSync.mockImplementation(() => { const e = /** @type {any} */ (new Error('EBUSY: resource busy')); e.code = 'EBUSY'; throw e; });
    svc._loaded = false;
    svc.addEntry({ url: 'https://new.com' });
    svc.flushSync();
    expect(svc._fs.files.get('/tmp-mock/history.json')).toBe('[{"id":"1","url":"https://keep.me"}]');
    expect([...svc._fs.files.keys()].some((k) => k.includes('.corrupt-'))).toBe(false);
    err.mockRestore();
  });

  test('an unparseable history file is moved aside, never overwritten', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    svc._fs.files.set('/tmp-mock/history.json', '[{"id":"1","url":"https://trunc');
    svc._loaded = false;
    svc.addEntry({ url: 'https://new.com' });
    svc.flushSync();
    const corrupt = [...svc._fs.files.keys()].find((k) => k.startsWith('/tmp-mock/history.json.corrupt-'));
    expect(corrupt).toBeTruthy();
    expect(svc._fs.files.get(corrupt)).toBe('[{"id":"1","url":"https://trunc');
    expect(JSON.parse(svc._fs.files.get('/tmp-mock/history.json'))[0].url).toBe('https://new.com');
    err.mockRestore();
  });

  test('saving is refused when a corrupt file cannot be moved aside', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    svc._fs.files.set('/tmp-mock/history.json', '{oops');
    svc._fs.renameSync.mockImplementation(() => { throw new Error('EPERM'); });
    svc._loaded = false;
    svc.addEntry({ url: 'https://new.com' });
    svc.flushSync();
    expect(svc._fs.files.get('/tmp-mock/history.json')).toBe('{oops');
    err.mockRestore();
  });

  test('load reads existing JSON file', () => {
    svc._fs.files.set('/tmp-mock/history.json', JSON.stringify([
      { id: '1', url: 'https://prior.com', title: 'Prior', timestamp: Date.now() },
    ]));
    svc._loaded = false;
    svc.load();
    expect(svc.getRecent().length).toBe(1);
    expect(svc.getRecent()[0].url).toBe('https://prior.com');
  });
});

// addEntry notifies the semantic index so it can debounce an auto-reindex.
// The hook uses a lazy require, so this module-level mock intercepts it.
jest.mock('../../../../main/services/SemanticIndexService', () => ({
  _scheduleReindex: jest.fn(),
}));

describe('HistoryService → SemanticIndexService hook', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    svc = require('../../../../main/services/HistoryService');
    svc._setFs(makeMemFs());
    svc._setFilePath('/tmp-mock/history.json');
    svc._loaded = false;
    svc._entries = [];
    svc._saveTimer = null;
    require('../../../../main/services/SemanticIndexService')._scheduleReindex.mockClear();
  });
  afterEach(() => { jest.useRealTimers(); });

  test('addEntry calls SemanticIndexService._scheduleReindex', () => {
    const sem = require('../../../../main/services/SemanticIndexService');
    svc.addEntry({ url: 'https://x.com', title: 'X' });
    expect(sem._scheduleReindex).toHaveBeenCalledTimes(1);
  });

  test('addEntry still succeeds if the semantic index is unavailable', () => {
    // A throwing _scheduleReindex must not break history recording.
    const sem = require('../../../../main/services/SemanticIndexService');
    sem._scheduleReindex.mockImplementation(() => { throw new Error('boom'); });
    expect(() => svc.addEntry({ url: 'https://x.com', title: 'X' })).not.toThrow();
    expect(svc.getRecent().length).toBe(1);
  });
});
