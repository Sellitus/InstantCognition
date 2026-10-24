// ContentIndexService tests — sidecar store for visited-page readable body
// text. fs + config are faked; the service is pure storage, no webview spawning.

let content;
let memfs;

function makeMemFs() {
  const files = new Map();
  const dirs = new Set(['/mem']);
  return {
    files,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => (files.has(p) ? files.get(p) : ''),
    writeFileSync: (p, c) => { files.set(p, String(c)); },
    mkdirSync: (p) => { dirs.add(p); },
  };
}

function fakeConfig(indexContent) {
  return { get: (p, fb) => (p === 'settings.askBrowsing.indexContent' ? indexContent : fb) };
}

beforeEach(() => {
  jest.resetModules();
  content = require('../../../../main/services/ContentIndexService');
  memfs = makeMemFs();
  content._setFs(memfs);
  content._setFilePath('/mem/semantic_content.json');
  content._setConfig(fakeConfig(true));
  content._reset();
});

describe('ContentIndexService.capture', () => {
  test('stores readable text for an http URL and persists to disk', () => {
    const changed = content.capture('https://example.com/a', 'Kubernetes deployment guide body text');
    expect(changed).toBe(true);
    expect(content.getText('https://example.com/a')).toBe('Kubernetes deployment guide body text');
    expect(memfs.files.has('/mem/semantic_content.json')).toBe(true);
    const persisted = JSON.parse(memfs.files.get('/mem/semantic_content.json'));
    expect(persisted['https://example.com/a'].text).toBe('Kubernetes deployment guide body text');
    expect(persisted['https://example.com/a'].hash).toBeTruthy();
  });

  test('a second capture of identical text is a no-op (hash-stable)', () => {
    content.capture('https://example.com/b', 'same body');
    const changed = content.capture('https://example.com/b', 'same body');
    expect(changed).toBe(false);
  });

  test('a changed body updates the stored text and hash', () => {
    content.capture('https://example.com/c', 'first version');
    const changed = content.capture('https://example.com/c', 'second version');
    expect(changed).toBe(true);
    expect(content.getText('https://example.com/c')).toBe('second version');
  });

  test('rejects non-http(s) URLs and empty text', () => {
    expect(content.capture('file:///etc/passwd', 'x')).toBe(false);
    expect(content.capture('chrome://settings', 'x')).toBe(false);
    expect(content.capture('https://example.com/d', '')).toBe(false);
    expect(content.capture('https://example.com/d', null)).toBe(false);
  });

  test('caps body text to MAX_BODY_CHARS', () => {
    const huge = 'a'.repeat(90000);
    content.capture('https://example.com/big', huge);
    const stored = content.getText('https://example.com/big');
    expect(stored.length).toBe(8000);
  });

  test('is a no-op when indexContent is off', () => {
    content._setConfig(fakeConfig(false));
    expect(content.capture('https://example.com/off', 'text')).toBe(false);
    expect(content.getText('https://example.com/off')).toBe('');
  });
});

describe('ContentIndexService.prune', () => {
  test('drops entries for URLs no longer in the live set', () => {
    content.capture('https://keep.com', 'keep');
    content.capture('https://gone.com', 'gone');
    const removed = content.prune(['https://keep.com']);
    expect(removed).toBe(1);
    expect(content.getText('https://keep.com')).toBe('keep');
    expect(content.getText('https://gone.com')).toBe('');
  });

  test('prune with no removals does not write', () => {
    content.capture('https://keep.com', 'keep');
    memfs.files.delete('/mem/semantic_content.json');
    content.prune(['https://keep.com']);
    expect(memfs.files.has('/mem/semantic_content.json')).toBe(false);
  });
});

describe('ContentIndexService.load resilience', () => {
  test('corrupt JSON starts with an empty store', () => {
    memfs.files.set('/mem/semantic_content.json', '{ not valid');
    content._reset();
    content.load();
    expect(content.getText('https://anything.com')).toBe('');
  });

  test('load is idempotent — a second call does not reparse', () => {
    content.capture('https://example.com/x', 'first');
    const storeRef = content._store;
    content.load();
    expect(content._store).toBe(storeRef);
  });
});
