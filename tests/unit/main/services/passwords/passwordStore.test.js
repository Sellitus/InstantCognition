// passwordStore — saved logins on disk. External boundaries substituted: fs
// (in-memory map) and Electron safeStorage (a reversible test cipher that
// never leaves the plaintext readable, so a leak into the file is visible).

const FILE = '/data/passwords.json';

function makeMemFs() {
  const files = new Map();
  return {
    files,
    existsSync: jest.fn((p) => files.has(p) || p === '/data'),
    readFileSync: jest.fn((p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    }),
    writeFileSync: jest.fn((p, content) => { files.set(p, content); }),
    renameSync: jest.fn((from, to) => { files.set(to, files.get(from)); files.delete(from); }),
    mkdirSync: jest.fn(),
  };
}

function makeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
  return {
    isEncryptionAvailable: jest.fn(() => available),
    getSelectedStorageBackend: jest.fn(() => backend),
    encryptString: jest.fn((s) => Buffer.from('ENC:' + Buffer.from(s, 'utf8').reverse().toString('hex'))),
    decryptString: jest.fn((buf) => {
      const text = buf.toString();
      if (!text.startsWith('ENC:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return Buffer.from(text.slice(4), 'hex').reverse().toString('utf8');
    }),
  };
}

let store;
let memFs;
let safe;
let now;

function fresh({ files, safeOpts, platform = 'darwin' } = {}) {
  jest.resetModules();
  store = require('../../../../../main/services/passwords/passwordStore');
  memFs = makeMemFs();
  if (files) for (const [k, v] of Object.entries(files)) memFs.files.set(k, v);
  safe = makeSafeStorage(safeOpts);
  now = 1000;
  store._setFs(memFs);
  store._setFilePath(FILE);
  store._setSafeStorage(safe);
  store._setPlatform(platform);
  store._setNow(() => now);
}

describe('passwordStore', () => {
  beforeEach(() => fresh());

  test('save encrypts the password and the written file never contains the plaintext', () => {
    const entry = store.save({ origin: 'https://a.test', username: 'alice', password: 'hunter2-secret' });
    const raw = memFs.files.get(FILE);
    expect(raw).not.toContain('hunter2-secret');
    const parsed = JSON.parse(raw);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ id: entry.id, origin: 'https://a.test', username: 'alice', createdAt: 1000, updatedAt: 1000, lastUsedAt: null });
    expect(typeof parsed.entries[0].passwordEnc).toBe('string');
    expect(Buffer.from(parsed.entries[0].passwordEnc, 'base64').toString()).toMatch(/^ENC:/);
    expect(safe.encryptString).toHaveBeenCalledWith('hunter2-secret');
  });

  test('roundtrip: a fresh store reads the file back and decrypts the same password', () => {
    const entry = store.save({ origin: 'https://a.test', username: 'alice', password: 'p@ss' });
    const saved = memFs.files.get(FILE);
    fresh({ files: { [FILE]: saved } });
    expect(store.list()).toEqual([{ id: entry.id, origin: 'https://a.test', username: 'alice', createdAt: 1000, updatedAt: 1000, lastUsedAt: null }]);
    expect(store.decrypt(entry.id)).toBe('p@ss');
  });

  test('list and forOrigin never expose passwordEnc', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'x' });
    for (const e of [...store.list(), ...store.forOrigin('https://a.test')]) {
      expect(e).not.toHaveProperty('passwordEnc');
    }
  });

  test('forOrigin is an exact scheme+host+port match', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'x' });
    expect(store.forOrigin('https://a.test')).toHaveLength(1);
    expect(store.forOrigin('https://a.test:8443')).toHaveLength(0);
    expect(store.forOrigin('http://a.test')).toHaveLength(0);
    expect(store.forOrigin('https://sub.a.test')).toHaveLength(0);
  });

  test('saving the same origin+username updates in place', () => {
    const first = store.save({ origin: 'https://a.test', username: 'alice', password: 'old' });
    now = 2000;
    const second = store.save({ origin: 'https://a.test', username: 'alice', password: 'new' });
    expect(second.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ createdAt: 1000, updatedAt: 2000 });
    expect(store.decrypt(first.id)).toBe('new');
  });

  test('matches compares against the decrypted password', () => {
    const e = store.save({ origin: 'https://a.test', username: 'alice', password: 'same' });
    expect(store.matches(e.id, 'same')).toBe(true);
    expect(store.matches(e.id, 'other')).toBe(false);
  });

  test('refuses to save when OS encryption is unavailable, and writes nothing', () => {
    fresh({ safeOpts: { available: false } });
    expect(store.status()).toEqual({ available: false, reason: expect.stringMatching(/secure storage/i) });
    expect(() => store.save({ origin: 'https://a.test', username: 'a', password: 'b' })).toThrow(/secure storage/i);
    expect(memFs.files.has(FILE)).toBe(false);
    expect(safe.encryptString).not.toHaveBeenCalled();
  });

  test('refuses to save on Linux with the basic_text backend', () => {
    fresh({ safeOpts: { backend: 'basic_text' }, platform: 'linux' });
    expect(store.status()).toEqual({ available: false, reason: expect.stringMatching(/keyring/i) });
    expect(() => store.save({ origin: 'https://a.test', username: 'a', password: 'b' })).toThrow(/keyring/i);
    expect(memFs.files.has(FILE)).toBe(false);
  });

  test('a real Linux keyring backend is available', () => {
    fresh({ safeOpts: { backend: 'kwallet6' }, platform: 'linux' });
    expect(store.status().available).toBe(true);
  });

  test('a corrupt file is quarantined, not overwritten, and the quarantine is reported', () => {
    fresh({ files: { [FILE]: '{not json' } });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.list()).toEqual([]);
    const moved = [...memFs.files.keys()].find((k) => k.startsWith(FILE + '.corrupt-'));
    expect(moved).toBeTruthy();
    expect(memFs.files.get(moved)).toBe('{not json');
    expect(store.quarantinedFile()).toBe(moved);
    store.save({ origin: 'https://a.test', username: 'a', password: 'b' });
    expect(memFs.files.get(moved)).toBe('{not json');
    errSpy.mockRestore();
  });

  test('valid JSON of the wrong shape is quarantined too', () => {
    fresh({ files: { [FILE]: '[1,2,3]' } });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.list()).toEqual([]);
    const moved = [...memFs.files.keys()].find((k) => k.startsWith(FILE + '.corrupt-'));
    expect(memFs.files.get(moved)).toBe('[1,2,3]');
    errSpy.mockRestore();
  });

  test('a file from an unknown format version is left in place and saving is refused', () => {
    const newer = JSON.stringify({ version: 2, entries: [{ id: 'x', origin: 'https://a.test', username: 'a', passwordEnc: 'RU5DOg==', extra: 1 }], neverSave: [] });
    fresh({ files: { [FILE]: newer } });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.list()).toEqual([]);
    expect(store.status()).toEqual({ available: false, reason: expect.stringMatching(/version/i) });
    expect(() => store.save({ origin: 'https://a.test', username: 'b', password: 'c' })).toThrow(/version/i);
    expect(() => store.addNeverSave('https://b.test')).toThrow(/version/i);
    expect(memFs.files.get(FILE)).toBe(newer);
    expect([...memFs.files.keys()]).toEqual([FILE]);
    errSpy.mockRestore();
  });

  test.each([
    ['entries is not an array', { version: 1, entries: { a: 1 }, neverSave: [] }],
    ['one entry is malformed', { version: 1, entries: [{ id: 'g', origin: 'https://a.test', username: 'a', passwordEnc: 'RU5DOg==' }, { id: 'bad', origin: 'https://a.test' }], neverSave: [] }],
    ['neverSave holds a non-string', { version: 1, entries: [], neverSave: [42] }],
    ['the version is missing', { entries: [], neverSave: [] }],
  ])('a file where %s is moved aside whole, never filtered and overwritten', (_label, doc) => {
    const raw = JSON.stringify(doc);
    fresh({ files: { [FILE]: raw } });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.list()).toEqual([]);
    const moved = store.quarantinedFile();
    expect(moved).toMatch(/passwords\.json\.corrupt-\d+$/);
    store.save({ origin: 'https://a.test', username: 'new', password: 'pw' });
    expect(memFs.files.get(moved)).toBe(raw);
    expect(JSON.parse(memFs.files.get(FILE)).entries.map((e) => e.username)).toEqual(['new']);
    errSpy.mockRestore();
  });

  test('a well-formed version 1 file loads every entry', () => {
    const doc = { version: 1, entries: [{ id: 'g', origin: 'https://a.test', username: 'a', passwordEnc: 'RU5DOg==', createdAt: 1, updatedAt: 1, lastUsedAt: null }], neverSave: ['https://n.test'] };
    fresh({ files: { [FILE]: JSON.stringify(doc) } });
    expect(store.list().map((e) => e.id)).toEqual(['g']);
    expect(store.neverSaveList()).toEqual(['https://n.test']);
    expect(store.quarantinedFile()).toBeNull();
  });

  test('save with an id updates that entry, even one with no username', () => {
    const blank = store.save({ origin: 'https://a.test', username: '', password: 'old' });
    now = 2000;
    const out = store.save({ origin: 'https://a.test', username: '', password: 'new', id: blank.id });
    expect(out.id).toBe(blank.id);
    expect(store.list()).toHaveLength(1);
    expect(store.decrypt(blank.id)).toBe('new');
  });

  test('save without an id never folds an empty username into an existing entry', () => {
    const first = store.save({ origin: 'https://a.test', username: '', password: 'pw-a' });
    const second = store.save({ origin: 'https://a.test', username: '', password: 'pw-b' });
    expect(second.id).not.toBe(first.id);
    expect(store.decrypt(first.id)).toBe('pw-a');
    expect(store.decrypt(second.id)).toBe('pw-b');
  });

  test('save with an id of another origin does not touch that entry', () => {
    const other = store.save({ origin: 'https://b.test', username: 'alice', password: 'keep' });
    const out = store.save({ origin: 'https://a.test', username: 'alice', password: 'pw', id: other.id });
    expect(out.id).not.toBe(other.id);
    expect(store.decrypt(other.id)).toBe('keep');
  });

  test('when the corrupt file cannot be moved aside, saving is refused', () => {
    fresh({ files: { [FILE]: '{not json' } });
    memFs.renameSync.mockImplementation(() => { throw new Error('EACCES'); });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.status().available).toBe(false);
    expect(() => store.save({ origin: 'https://a.test', username: 'a', password: 'b' })).toThrow(/could not be read/i);
    expect(memFs.files.get(FILE)).toBe('{not json');
    errSpy.mockRestore();
  });

  test('decrypt surfaces a keychain failure instead of returning nothing', () => {
    const e = store.save({ origin: 'https://a.test', username: 'a', password: 'b' });
    safe.decryptString.mockImplementation(() => { throw new Error('keychain locked'); });
    expect(() => store.decrypt(e.id)).toThrow(/keychain locked/);
  });

  test('decrypt of an unknown id throws', () => {
    expect(() => store.decrypt('nope')).toThrow(/not found/i);
  });

  test('remove deletes one entry and persists', () => {
    const a = store.save({ origin: 'https://a.test', username: 'a', password: '1' });
    const b = store.save({ origin: 'https://a.test', username: 'b', password: '2' });
    expect(store.remove(a.id)).toBe(true);
    expect(store.remove(a.id)).toBe(false);
    expect(JSON.parse(memFs.files.get(FILE)).entries.map((e) => e.id)).toEqual([b.id]);
  });

  test('touch records lastUsedAt', () => {
    const a = store.save({ origin: 'https://a.test', username: 'a', password: '1' });
    now = 5000;
    store.touch(a.id);
    expect(store.list()[0].lastUsedAt).toBe(5000);
  });

  test('never-save list: add is idempotent, remove persists, and it survives reload', () => {
    store.addNeverSave('https://a.test');
    store.addNeverSave('https://a.test');
    store.addNeverSave('https://b.test');
    expect(store.neverSaveList()).toEqual(['https://a.test', 'https://b.test']);
    expect(store.isNeverSave('https://a.test')).toBe(true);
    expect(store.removeNeverSave('https://a.test')).toBe(true);
    expect(store.removeNeverSave('https://a.test')).toBe(false);
    const saved = memFs.files.get(FILE);
    fresh({ files: { [FILE]: saved } });
    expect(store.neverSaveList()).toEqual(['https://b.test']);
    expect(store.isNeverSave('https://a.test')).toBe(false);
  });
});
