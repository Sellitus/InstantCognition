// capturePolicy — the decision table for whether a reported login submit
// becomes a save offer. Runs against the real passwordStore with fs and
// safeStorage substituted at the boundary.

const FILE = '/data/passwords.json';

function setup({ available = true, decrypt = (b) => b.toString().slice(1) } = {}) {
  jest.resetModules();
  const store = require('../../../../../main/services/passwords/passwordStore');
  const { decideCapture, loginOrigin } = require('../../../../../main/services/passwords/capturePolicy');
  const files = new Map();
  store._setFs({
    existsSync: (p) => files.has(p) || p === '/data',
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, c) => files.set(p, c),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    mkdirSync: () => {},
  });
  store._setFilePath(FILE);
  store._setPlatform('darwin');
  store._setSafeStorage({
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => 'unknown',
    encryptString: (s) => Buffer.from('E' + s),
    decryptString: decrypt,
  });
  return { store, decideCapture, loginOrigin };
}

const base = (over = {}) => ({
  origin: 'https://a.test', persistent: true, offerEnabled: true, username: 'alice', password: 'pw1', ...over,
});

describe('loginOrigin', () => {
  const { loginOrigin } = setup();
  test.each([
    ['https://a.test', 'https://a.test'],
    ['https://a.test:8443', 'https://a.test:8443'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://[::1]:5000', 'http://[::1]:5000'],
    ['http://app.localhost', 'http://app.localhost'],
  ])('%s is allowed', (input, out) => expect(loginOrigin(input)).toBe(out));

  test.each([
    ['http://a.test'],
    ['http://192.168.1.10'],
    ['file://'],
    ['null'],
    [''],
    ['https://a.test/login'],
    ['ftp://a.test'],
    [undefined],
  ])('%s is refused', (input) => expect(loginOrigin(input)).toBeNull());
});

describe('decideCapture', () => {
  test('https login with no saved entry offers save', () => {
    const { store, decideCapture } = setup();
    expect(decideCapture(base(), store)).toEqual({ action: 'save' });
  });

  test('http on a non-loopback host is refused', () => {
    const { store, decideCapture } = setup();
    expect(decideCapture(base({ origin: 'http://a.test' }), store)).toEqual({ action: 'skip', reason: 'insecure-origin' });
  });

  test('http on loopback is allowed', () => {
    const { store, decideCapture } = setup();
    expect(decideCapture(base({ origin: 'http://localhost:3000' }), store)).toEqual({ action: 'save' });
  });

  test('the private (non-persistent) session is refused', () => {
    const { store, decideCapture } = setup();
    expect(decideCapture(base({ persistent: false }), store)).toEqual({ action: 'skip', reason: 'private' });
  });

  test('the "Offer to save passwords" setting off is refused', () => {
    const { store, decideCapture } = setup();
    expect(decideCapture(base({ offerEnabled: false }), store)).toEqual({ action: 'skip', reason: 'disabled' });
  });

  test('an origin on the never-save list is refused', () => {
    const { store, decideCapture } = setup();
    store.addNeverSave('https://a.test');
    expect(decideCapture(base(), store)).toEqual({ action: 'skip', reason: 'never-save' });
    expect(decideCapture(base({ origin: 'https://b.test' }), store)).toEqual({ action: 'save' });
  });

  test('the same credential already saved gives no offer', () => {
    const { store, decideCapture } = setup();
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pw1' });
    expect(decideCapture(base(), store)).toEqual({ action: 'skip', reason: 'unchanged' });
  });

  test('a changed password for the same origin+username offers an update', () => {
    const { store, decideCapture } = setup();
    const e = store.save({ origin: 'https://a.test', username: 'alice', password: 'pw1' });
    expect(decideCapture(base({ password: 'pw2' }), store)).toEqual({ action: 'update', existingId: e.id });
  });

  test('a different username on the same origin offers a new save', () => {
    const { store, decideCapture } = setup();
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pw1' });
    expect(decideCapture(base({ username: 'bob' }), store)).toEqual({ action: 'save' });
  });

  test('an empty or non-string password, or an oversized field, is invalid', () => {
    const { store, decideCapture } = setup();
    expect(decideCapture(base({ password: '' }), store)).toEqual({ action: 'skip', reason: 'invalid' });
    expect(decideCapture(base({ password: 42 }), store)).toEqual({ action: 'skip', reason: 'invalid' });
    expect(decideCapture(base({ username: { x: 1 } }), store)).toEqual({ action: 'skip', reason: 'invalid' });
    expect(decideCapture(base({ password: 'x'.repeat(5000) }), store)).toEqual({ action: 'skip', reason: 'invalid' });
  });

  test('unavailable secure storage reports the reason instead of offering', () => {
    const { store, decideCapture } = setup({ available: false });
    expect(decideCapture(base(), store)).toEqual({ action: 'unavailable', reason: expect.stringMatching(/secure storage/i) });
  });

  test('a page reached through an accepted certificate error never gets an offer', () => {
    const { store, decideCapture } = setup();
    expect(decideCapture(base({ certificateError: true }), store)).toEqual({ action: 'skip', reason: 'certificate-error' });
    expect(decideCapture(base({ certificateError: false }), store)).toEqual({ action: 'save' });
  });

  describe('a login with no username (two-step sign-in)', () => {
    test('a password that a saved login on the origin already has gives no offer', () => {
      const { store, decideCapture } = setup();
      store.save({ origin: 'https://a.test', username: 'alice', password: 'pw-alice' });
      expect(decideCapture(base({ username: '', password: 'pw-alice' }), store)).toEqual({ action: 'skip', reason: 'unchanged' });
    });

    test('with named logins on the origin, a new password is a new entry, never an update of the unnamed one', () => {
      const { store, decideCapture } = setup();
      store.save({ origin: 'https://a.test', username: 'alice', password: 'pw-alice' });
      store.save({ origin: 'https://a.test', username: '', password: 'pw-earlier' });
      expect(decideCapture(base({ username: '', password: 'pw-bob' }), store)).toEqual({ action: 'save' });
    });

    test('with only one unnamed login on the origin, a changed password updates it', () => {
      const { store, decideCapture } = setup();
      const blank = store.save({ origin: 'https://a.test', username: '', password: 'old' });
      expect(decideCapture(base({ username: '', password: 'new' }), store)).toEqual({ action: 'update', existingId: blank.id });
    });

    test('a named capture is never matched to the unnamed login', () => {
      const { store, decideCapture } = setup();
      store.save({ origin: 'https://a.test', username: '', password: 'pw' });
      expect(decideCapture(base({ username: 'alice', password: 'pw2' }), store)).toEqual({ action: 'save' });
    });
  });

  describe('a saved login that cannot be decrypted', () => {
    const broken = (b) => {
      const s = b.toString().slice(1);
      if (s === 'unreadable') throw new Error('Error while decrypting the ciphertext');
      return s;
    };

    test('is treated as differing: the capture offers to update it and the failure is logged', () => {
      const { store, decideCapture } = setup({ decrypt: broken });
      const e = store.save({ origin: 'https://a.test', username: 'alice', password: 'unreadable' });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      expect(decideCapture(base({ password: 'pw-new' }), store)).toEqual({ action: 'update', existingId: e.id });
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/could not decrypt/i), expect.stringMatching(/decrypting/));
      errSpy.mockRestore();
    });

    test('does not stop an unnamed capture from being checked against the other logins', () => {
      const { store, decideCapture } = setup({ decrypt: broken });
      store.save({ origin: 'https://a.test', username: 'alice', password: 'unreadable' });
      store.save({ origin: 'https://a.test', username: 'bob', password: 'pw-bob' });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      expect(decideCapture(base({ username: '', password: 'pw-bob' }), store)).toEqual({ action: 'skip', reason: 'unchanged' });
      expect(decideCapture(base({ username: '', password: 'pw-carol' }), store)).toEqual({ action: 'save' });
      errSpy.mockRestore();
    });
  });
});
