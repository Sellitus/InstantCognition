// tabRegistry — in-memory spaceId -> webContents metadata map. No external
// deps; the only "boundary" is a fake webContents EventEmitter for attach().

const { EventEmitter } = require('events');
const reg = require('../../../../main/services/tabRegistry');

function fakeWc(id, { url = 'https://a.com', title = 'A' } = {}) {
  const ee = new EventEmitter();
  ee.id = id;
  ee.getURL = jest.fn(() => url);
  ee.getTitle = jest.fn(() => title);
  return ee;
}

beforeEach(() => { reg.clear(); });

describe('tabRegistry set / get / remove', () => {
  test('set ignores a falsy spaceId', () => {
    reg.set('', 1, true);
    expect(reg.list()).toEqual([]);
  });

  test('set stores webContentsId + coerced isActive and merges existing meta', () => {
    reg.setMeta('s1', { title: 'Hello', url: 'https://x' });
    reg.set('s1', 42, 1); // truthy -> true
    const e = reg.get('s1');
    expect(e).toEqual({ title: 'Hello', url: 'https://x', webContentsId: 42, isActive: true });
  });

  test('set with falsy isActive stores false', () => {
    reg.set('s2', 7, 0);
    expect(reg.get('s2').isActive).toBe(false);
  });

  test('get returns null for an unknown spaceId', () => {
    expect(reg.get('nope')).toBeNull();
  });

  test('remove deletes the entry', () => {
    reg.set('s3', 1, true);
    reg.remove('s3');
    expect(reg.get('s3')).toBeNull();
  });
});

describe('tabRegistry setMeta', () => {
  test('ignores a falsy spaceId', () => {
    reg.setMeta(null, { url: 'x' });
    expect(reg.list()).toEqual([]);
  });

  test('merges into an existing entry without dropping prior keys', () => {
    reg.set('s1', 9, true);
    reg.setMeta('s1', { kind: 'agent' });
    expect(reg.get('s1')).toEqual({ webContentsId: 9, isActive: true, kind: 'agent' });
  });
});

describe('tabRegistry list / findBySpaceId', () => {
  test('list projects entries with spaceId merged in', () => {
    reg.set('a', 1, true);
    reg.set('b', 2, false);
    const list = reg.list();
    expect(list).toEqual(expect.arrayContaining([
      { spaceId: 'a', webContentsId: 1, isActive: true },
      { spaceId: 'b', webContentsId: 2, isActive: false },
    ]));
  });

  test('findBySpaceId returns the spaceId owning a webContentsId', () => {
    reg.set('a', 11, true);
    reg.set('b', 22, false);
    expect(reg.findBySpaceId(22)).toBe('b');
  });

  test('findBySpaceId returns null when no entry matches', () => {
    reg.set('a', 11, true);
    expect(reg.findBySpaceId(999)).toBeNull();
  });
});

describe('tabRegistry attach', () => {
  test('no-ops for a missing webContents, missing .on, or missing spaceId', () => {
    expect(() => reg.attach(null, 's1')).not.toThrow();
    expect(() => reg.attach({}, 's1')).not.toThrow();
    expect(() => reg.attach(fakeWc(1), '')).not.toThrow();
    expect(reg.list()).toEqual([]);
  });

  test('seeds url/title immediately from the webContents', () => {
    const wc = fakeWc(5, { url: 'https://seed', title: 'Seed' });
    reg.set('s1', 5, true);
    reg.attach(wc, 's1');
    expect(reg.get('s1')).toMatchObject({ url: 'https://seed', title: 'Seed' });
  });

  test('tolerates getURL/getTitle throwing during the initial seed', () => {
    const wc = new EventEmitter();
    wc.id = 6;
    wc.getURL = () => { throw new Error('not loaded'); };
    wc.getTitle = () => { throw new Error('not loaded'); };
    reg.set('s1', 6, true);
    expect(() => reg.attach(wc, 's1')).not.toThrow();
  });

  test('did-navigate / page-title-updated refresh the matching entry', () => {
    let url = 'https://before';
    let title = 'Before';
    const wc = new EventEmitter();
    wc.id = 8;
    wc.getURL = () => url;
    wc.getTitle = () => title;
    reg.set('s1', 8, true);
    reg.attach(wc, 's1');
    expect(reg.get('s1')).toMatchObject({ url: 'https://before', title: 'Before' });

    url = 'https://after';
    title = 'After';
    wc.emit('did-navigate');
    expect(reg.get('s1')).toMatchObject({ url: 'https://after', title: 'After' });

    url = 'https://hash#x';
    wc.emit('did-navigate-in-page');
    expect(reg.get('s1').url).toBe('https://hash#x');

    title = 'Renamed';
    wc.emit('page-title-updated');
    expect(reg.get('s1').title).toBe('Renamed');
  });

  test('is idempotent — listeners are only wired once per webContents', () => {
    const wc = fakeWc(9);
    reg.set('s1', 9, true);
    reg.attach(wc, 's1');
    reg.attach(wc, 's1'); // second call returns early via the WeakSet guard
    expect(wc.listenerCount('did-navigate')).toBe(1);
  });

  test('update handler is a no-op when the webContents no longer maps to a space', () => {
    const wc = fakeWc(10);
    reg.set('s1', 10, true);
    reg.attach(wc, 's1');
    reg.remove('s1'); // findBySpaceId(10) now returns null
    expect(() => wc.emit('did-navigate')).not.toThrow();
  });

  test('update handler swallows getURL errors after navigation', () => {
    const wc = new EventEmitter();
    wc.id = 12;
    wc.getURL = jest.fn(() => 'https://ok');
    wc.getTitle = jest.fn(() => 'ok');
    reg.set('s1', 12, true);
    reg.attach(wc, 's1');
    wc.getURL = () => { throw new Error('detached'); };
    expect(() => wc.emit('did-navigate')).not.toThrow();
  });

  test('webContents destroyed event drops the entry and removes navigation listeners', () => {
    const wc = fakeWc(14);
    reg.set('s1', 14, true);
    reg.attach(wc, 's1');
    expect(wc.listenerCount('did-navigate')).toBe(1);
    expect(wc.listenerCount('did-navigate-in-page')).toBe(1);
    expect(wc.listenerCount('page-title-updated')).toBe(1);
    expect(reg.get('s1')).not.toBeNull();
    wc.emit('destroyed');
    expect(reg.get('s1')).toBeNull();
    expect(wc.listenerCount('did-navigate')).toBe(0);
    expect(wc.listenerCount('did-navigate-in-page')).toBe(0);
    expect(wc.listenerCount('page-title-updated')).toBe(0);
  });
});

describe('tabRegistry clear', () => {
  test('empties the registry', () => {
    reg.set('a', 1, true);
    reg.set('b', 2, false);
    reg.clear();
    expect(reg.list()).toEqual([]);
  });
});

describe('private tabs', () => {
  test('a session view never lists, returns or finds a private tab', () => {
    reg.set('pub', 1, false);
    reg.set('priv', 2, true);
    reg.setMeta('priv', { private: true, url: 'https://bank.example' });
    const view = reg.forSession(null);
    expect(view.list().map((t) => t.spaceId)).toEqual(['pub']);
    expect(view.get('priv')).toBeNull();
    expect(view.findBySpaceId(2)).toBeNull();
    expect(view.get('pub')).toMatchObject({ webContentsId: 1 });
  });

  test('a session that tagged a tab still cannot see it once it is private', () => {
    reg.set('t', 3, true);
    reg.setMeta('t', { sessionId: 's_1', private: true });
    expect(reg.forSession('s_1').get('t')).toBeNull();
  });
});
