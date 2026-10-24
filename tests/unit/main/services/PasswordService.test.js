// PasswordService — capture offers, explicit autofill, settings operations.
// External boundaries substituted: Electron (safeStorage, systemPreferences,
// clipboard, dialog, app events), the guest/shell webContents objects, fs
// (in-memory), the clock and the offer-expiry timer. PasswordService,
// passwordStore, capturePolicy, CertificateService and tabRegistry all run
// for real.

jest.mock('electron', () => ({
  app: { on: jest.fn(), getPath: jest.fn(() => '/mock'), isPackaged: false },
  dialog: { showMessageBox: jest.fn(() => Promise.resolve({ response: 0 })) },
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    getSelectedStorageBackend: jest.fn(() => 'unknown'),
    encryptString: jest.fn((s) => Buffer.from('E' + Buffer.from(s).toString('hex'))),
    decryptString: jest.fn((b) => Buffer.from(b.toString().slice(1), 'hex').toString()),
  },
  systemPreferences: {
    canPromptTouchID: jest.fn(() => true),
    promptTouchID: jest.fn(() => Promise.resolve()),
  },
  clipboard: { writeText: jest.fn(() => Promise.resolve()) },
}));

const FILE = '/data/passwords.json';

let svc;
let store;
let electron;
let files;
let now;
let timers;
let mainWindow;
let cfg;
let certs;
let tabs;

// Lets a connection to `host` through a certificate error the way the app
// does at runtime: a remembered fingerprint answered by the real handler.
function acceptCertError(host) {
  let handler;
  electron.app.on.mockImplementation((ev, fn) => { if (ev === 'certificate-error') handler = fn; });
  certs._registerCertErrorHandler();
  certs.acceptedCertificates[host] = 'fp';
  const cb = jest.fn();
  handler({ preventDefault: () => {} }, null, `https://${host}/`, 'ERR_CERT_AUTHORITY_INVALID', { fingerprint: 'fp' }, cb);
  expect(cb).toHaveBeenCalledWith(true);
}

function guestEvent({ origin = 'https://a.test', type = 'webview', parent = null, persistent = true, frame = 'present', id = 9 } = {}) {
  return {
    sender: { id, getType: () => type, session: { isPersistent: () => persistent } },
    senderFrame: frame === 'present' ? { origin, parent } : null,
  };
}

function guestContents({ origin = 'https://a.test', persistent = true, id = 9 } = {}) {
  return {
    id,
    isDestroyed: () => false,
    session: { isPersistent: () => persistent },
    mainFrame: { origin, send: jest.fn() },
  };
}

const shellSends = (channel) => mainWindow.webContents.send.mock.calls.filter((c) => c[0] === channel).map((c) => c[1]);

beforeEach(() => {
  jest.resetModules();
  electron = require('electron');
  store = require('../../../../main/services/passwords/passwordStore');
  svc = require('../../../../main/services/PasswordService');
  files = new Map();
  store._setFs({
    existsSync: (p) => files.has(p) || p === '/data',
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, c) => files.set(p, c),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    mkdirSync: () => {},
  });
  store._setFilePath(FILE);
  store._setPlatform('darwin');
  now = 1000;
  store._setNow(() => now);
  svc._setNow(() => now);
  timers = [];
  svc._setTimers((fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, (t) => { if (t) t.cleared = true; });
  svc._setPlatform('darwin');
  mainWindow = { isDestroyed: () => false, webContents: { id: 1, send: jest.fn() } };
  cfg = { 'settings.passwords.offerToSave': true };
  certs = require('../../../../main/services/CertificateService');
  tabs = require('../../../../main/services/tabRegistry');
  svc.bind({ mainWindow, configService: { get: (p, d) => (p in cfg ? cfg[p] : d) }, certificateService: certs });
  electron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
  electron.systemPreferences.canPromptTouchID.mockReturnValue(true);
  electron.systemPreferences.promptTouchID.mockResolvedValue(undefined);
  electron.dialog.showMessageBox.mockReset();
  electron.dialog.showMessageBox.mockResolvedValue({ response: 0 });
});

// Captures from one tab arrive at least a second apart unless a test says otherwise.
const later = () => { now += 1500; };

describe('capture → offer', () => {
  test('a top-frame https login sends an offer carrying origin and username but never the password', () => {
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw-secret-1' });
    const offers = shellSends('passwords:offer');
    expect(offers).toEqual([{ id: expect.any(String), origin: 'https://a.test', host: 'a.test', username: 'alice', kind: 'save' }]);
    expect(JSON.stringify(mainWindow.webContents.send.mock.calls)).not.toContain('pw-secret-1');
  });

  test('the origin comes from the sender frame; an origin in the payload is ignored', () => {
    svc.handleCaptured(guestEvent({ origin: 'https://real.test' }), { origin: 'https://bank.test', username: 'alice', password: 'pw' });
    const [offer] = shellSends('passwords:offer');
    expect(offer.origin).toBe('https://real.test');
    svc.resolveOffer(offer.id, 'save');
    expect(store.forOrigin('https://bank.test')).toEqual([]);
    expect(store.forOrigin('https://real.test')).toHaveLength(1);
  });

  test('a plain-http page cannot get an offer by claiming an https origin', () => {
    svc.handleCaptured(guestEvent({ origin: 'http://a.test' }), { origin: 'https://a.test', username: 'alice', password: 'pw' });
    expect(shellSends('passwords:offer')).toEqual([]);
  });

  test.each([
    ['the shell window', { type: 'window' }],
    ['a subframe', { parent: { origin: 'https://top.test' } }],
    ['a frame that is already gone', { frame: null }],
    ['the private session', { persistent: false }],
    ['a plain-http site', { origin: 'http://a.test' }],
  ])('no offer from %s', (_label, opts) => {
    svc.handleCaptured(guestEvent(opts), { username: 'alice', password: 'pw' });
    expect(shellSends('passwords:offer')).toEqual([]);
  });

  test('a second capture from the same tab within a second is dropped', () => {
    expect(svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw1' }).action).toBe('save');
    now += 400;
    expect(svc.handleCaptured(guestEvent(), { username: 'bob', password: 'pw2' })).toEqual({ action: 'skip', reason: 'rate-limited' });
    expect(shellSends('passwords:offer').map((o) => o.username)).toEqual(['alice']);
    expect(svc.handleCaptured(guestEvent({ id: 10 }), { username: 'carol', password: 'pw3' }).action).toBe('save');
    now += 1500;
    expect(svc.handleCaptured(guestEvent(), { username: 'dave', password: 'pw4' }).action).toBe('save');
  });

  test('no offer on a host this run let through a certificate error', () => {
    acceptCertError('a.test');
    expect(svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw' })).toEqual({ action: 'skip', reason: 'certificate-error' });
    expect(svc.handleCaptured(guestEvent({ origin: 'https://b.test', id: 10 }), { username: 'alice', password: 'pw' }).action).toBe('save');
    expect(shellSends('passwords:offer').map((o) => o.origin)).toEqual(['https://b.test']);
  });

  test('no offer from an agent tab; a user tab still gets one', () => {
    tabs.set('agent-tab-1', 9, false);
    tabs.setMeta('agent-tab-1', { kind: 'agent' });
    tabs.set('user-tab-1', 10, true);
    tabs.setMeta('user-tab-1', { kind: 'user' });
    expect(svc.handleCaptured(guestEvent({ id: 9 }), { username: 'agent', password: 'typed' })).toEqual({ action: 'skip', reason: 'agent-tab' });
    expect(svc.handleCaptured(guestEvent({ id: 10 }), { username: 'alice', password: 'pw' }).action).toBe('save');
    expect(shellSends('passwords:offer').map((o) => o.username)).toEqual(['alice']);
  });

  test('no offer when the setting is off', () => {
    cfg['settings.passwords.offerToSave'] = false;
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw' });
    expect(shellSends('passwords:offer')).toEqual([]);
  });

  test('a changed password for a saved login is offered as an update', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'old' });
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'new' });
    expect(shellSends('passwords:offer')[0]).toMatchObject({ kind: 'update', username: 'alice' });
  });

  test('unavailable secure storage warns the user once and offers nothing', () => {
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw' });
    later();
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw' });
    expect(shellSends('passwords:offer')).toEqual([]);
    expect(shellSends('passwords:notice')).toEqual([{ kind: 'warn', message: expect.stringMatching(/secure storage/i) }]);
  });
});

describe('resolving an offer', () => {
  const offerId = () => shellSends('passwords:offer').slice(-1)[0].id;

  test('save stores the encrypted login', () => {
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw1' });
    expect(svc.resolveOffer(offerId(), 'save')).toEqual({ ok: true });
    const [entry] = store.forOrigin('https://a.test');
    expect(entry.username).toBe('alice');
    expect(store.decrypt(entry.id)).toBe('pw1');
  });

  test('an update offer replaces the stored password', () => {
    const e = store.save({ origin: 'https://a.test', username: 'alice', password: 'old' });
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'new' });
    svc.resolveOffer(offerId(), 'save');
    expect(store.decrypt(e.id)).toBe('new');
    expect(store.list()).toHaveLength(1);
  });

  test('never adds the origin to the never-save list and stores nothing', () => {
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw1' });
    expect(svc.resolveOffer(offerId(), 'never')).toEqual({ ok: true });
    expect(store.list()).toEqual([]);
    expect(store.neverSaveList()).toEqual(['https://a.test']);
  });

  test('dismiss stores nothing and the offer is consumed', () => {
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw1' });
    const id = offerId();
    expect(svc.resolveOffer(id, 'dismiss')).toEqual({ ok: true });
    expect(store.list()).toEqual([]);
    expect(svc.resolveOffer(id, 'save')).toEqual({ ok: false, error: expect.stringMatching(/no longer available/i) });
    expect(store.list()).toEqual([]);
  });

  test('an unknown action is rejected and leaves the offer pending', () => {
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw1' });
    const id = offerId();
    expect(svc.resolveOffer(id, 'steal')).toEqual({ ok: false, error: expect.stringMatching(/unknown/i) });
    expect(svc.resolveOffer(id, 'save')).toEqual({ ok: true });
  });

  test('a pending offer past its TTL cannot be saved', () => {
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw1' });
    now += svc.OFFER_TTL_MS + 1;
    expect(svc.resolveOffer(offerId(), 'save')).toEqual({ ok: false, error: expect.stringMatching(/expired/i) });
    expect(store.list()).toEqual([]);
  });

  test('the expiry timer drops the pending credential and tells the shell', () => {
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw1' });
    const id = offerId();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(svc.OFFER_TTL_MS);
    timers[0].fn();
    expect(shellSends('passwords:offer-expired')).toEqual([{ id }]);
    expect(svc.resolveOffer(id, 'save').ok).toBe(false);
  });

  test('a newer login in the same tab replaces that tab\'s offer and tells the shell', () => {
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw1' });
    const first = offerId();
    later();
    svc.handleCaptured(guestEvent({ origin: 'https://b.test' }), { username: 'bob', password: 'pw2' });
    expect(timers[0].cleared).toBe(true);
    expect(shellSends('passwords:offer-expired')).toEqual([{ id: first }]);
    expect(svc.resolveOffer(first, 'save').ok).toBe(false);
    expect(svc.resolveOffer(offerId(), 'save').ok).toBe(true);
    expect(store.list().map((e) => e.origin)).toEqual(['https://b.test']);
  });

  test('a login in another tab leaves the first tab\'s offer pending', () => {
    svc.handleCaptured(guestEvent({ id: 9 }), { username: 'alice', password: 'pw1' });
    const first = offerId();
    svc.handleCaptured(guestEvent({ id: 10, origin: 'https://b.test' }), { username: 'bob', password: 'pw2' });
    const second = offerId();
    expect(shellSends('passwords:offer-expired')).toEqual([]);
    expect(svc.resolveOffer(first, 'save')).toEqual({ ok: true });
    expect(svc.resolveOffer(second, 'save')).toEqual({ ok: true });
    expect(store.list().map((e) => e.origin).sort()).toEqual(['https://a.test', 'https://b.test']);
  });

  test('a storage failure on save reaches the caller and keeps the offer so it can be retried', () => {
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw1' });
    const id = offerId();
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(svc.resolveOffer(id, 'save')).toEqual({ ok: false, error: expect.stringMatching(/secure storage/i), retryable: true });
    errSpy.mockRestore();
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    expect(svc.resolveOffer(id, 'save')).toEqual({ ok: true });
    expect(store.decrypt(store.list()[0].id)).toBe('pw1');
    expect(svc.resolveOffer(id, 'save').ok).toBe(false);
  });

  test('an update offer for an unnamed login updates that entry, not a new one', () => {
    const blank = store.save({ origin: 'https://a.test', username: '', password: 'old' });
    svc.handleCaptured(guestEvent(), { username: '', password: 'new' });
    expect(shellSends('passwords:offer')[0]).toMatchObject({ kind: 'update', username: '' });
    expect(svc.resolveOffer(offerId(), 'save')).toEqual({ ok: true });
    expect(store.list().map((e) => e.id)).toEqual([blank.id]);
    expect(store.decrypt(blank.id)).toBe('new');
  });
});

describe('context menu autofill', () => {
  test('no menu entry without saved logins for the exact origin', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
    expect(svc.contextMenuItems(guestContents({ origin: 'https://a.test:444' }))).toEqual([]);
    expect(svc.contextMenuItems(guestContents({ origin: 'https://b.test' }))).toEqual([]);
    expect(svc.contextMenuItems({ id: 3 })).toEqual([]);
  });

  test('one saved login: a single entry that fills it into the top frame', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
    const contents = guestContents();
    const items = svc.contextMenuItems(contents);
    expect(items[0].label).toBe('Fill saved password (alice)');
    now = 7000;
    items[0].click();
    expect(contents.mainFrame.send).toHaveBeenCalledWith('passwords:fill', { origin: 'https://a.test', username: 'alice', password: 'pw' });
  });

  test('last use is recorded only once the page confirms the fill', () => {
    const e = store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
    svc.contextMenuItems(guestContents())[0].click();
    expect(store.get(e.id).lastUsedAt).toBeNull();
    now = 7000;
    svc.handleFillResult(guestEvent(), { ok: true });
    expect(store.get(e.id).lastUsedAt).toBe(7000);
  });

  test('a failed fill, or a success report with no fill sent, records no use', () => {
    const e = store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
    svc.contextMenuItems(guestContents())[0].click();
    svc.handleFillResult(guestEvent(), { ok: false, reason: 'no-form' });
    svc.handleFillResult(guestEvent(), { ok: true });
    svc.handleFillResult(guestEvent({ id: 10 }), { ok: true });
    expect(store.get(e.id).lastUsedAt).toBeNull();
  });

  test('a host this run let through a certificate error gets no fill entry and no fill', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
    const contents = guestContents();
    const [item] = svc.contextMenuItems(contents);
    acceptCertError('a.test');
    expect(svc.contextMenuItems(contents)).toEqual([]);
    item.click();
    expect(contents.mainFrame.send).not.toHaveBeenCalled();
    expect(shellSends('passwords:notice')).toEqual([{ kind: 'warn', message: expect.stringMatching(/certificate/i) }]);
    store.save({ origin: 'https://b.test', username: 'bob', password: 'pb' });
    expect(svc.contextMenuItems(guestContents({ origin: 'https://b.test' }))).toHaveLength(1);
  });

  test('without a certificate service bound, nothing is filled or offered', () => {
    svc.bind({ mainWindow, configService: { get: (p, d) => d } });
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
    expect(svc.contextMenuItems(guestContents())).toEqual([]);
    expect(svc.handleCaptured(guestEvent(), { username: 'bob', password: 'pw2' })).toEqual({ action: 'skip', reason: 'certificate-error' });
  });

  test('several saved logins: a submenu per username', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pa' });
    store.save({ origin: 'https://a.test', username: 'bob', password: 'pb' });
    const contents = guestContents();
    const [item] = svc.contextMenuItems(contents);
    expect(item.label).toBe('Fill saved password');
    expect(item.submenu.map((s) => s.label)).toEqual(['alice', 'bob']);
    item.submenu[1].click();
    expect(contents.mainFrame.send).toHaveBeenCalledWith('passwords:fill', { origin: 'https://a.test', username: 'bob', password: 'pb' });
  });

  test('navigated away before the click: nothing is sent and the user is told', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
    const contents = guestContents();
    const [item] = svc.contextMenuItems(contents);
    contents.mainFrame.origin = 'https://evil.test';
    item.click();
    expect(contents.mainFrame.send).not.toHaveBeenCalled();
    expect(shellSends('passwords:notice')).toEqual([{ kind: 'warn', message: expect.stringMatching(/page changed/i) }]);
  });

  test('a fill in the private session does not record last use', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
    const contents = guestContents({ persistent: false });
    svc.contextMenuItems(contents)[0].click();
    expect(contents.mainFrame.send).toHaveBeenCalled();
    svc.handleFillResult(guestEvent({ persistent: false }), { ok: true });
    expect(store.list()[0].lastUsedAt).toBeNull();
  });

  test('a decrypt failure sends nothing and is shown to the user', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
    const contents = guestContents();
    electron.safeStorage.decryptString.mockImplementationOnce(() => { throw new Error('keychain locked'); });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    svc.contextMenuItems(contents)[0].click();
    expect(contents.mainFrame.send).not.toHaveBeenCalled();
    expect(shellSends('passwords:notice')).toEqual([{ kind: 'error', message: expect.stringMatching(/keychain locked/) }]);
    errSpy.mockRestore();
  });

  test('a failed fill reported by the page is shown; reports from non-guests are ignored', () => {
    svc.handleFillResult({ sender: { getType: () => 'window' } }, { ok: false, reason: 'no-form' });
    expect(shellSends('passwords:notice')).toEqual([]);
    svc.handleFillResult({ sender: { getType: () => 'webview' } }, { ok: false, reason: 'no-form' });
    expect(shellSends('passwords:notice')).toEqual([{ kind: 'warn', message: expect.stringMatching(/no login form/i) }]);
    svc.handleFillResult({ sender: { getType: () => 'webview' } }, { ok: true });
    expect(shellSends('passwords:notice')).toHaveLength(1);
  });
});

describe('settings operations', () => {
  test('listForSettings returns metadata only, storage status and auth mode', () => {
    store.save({ origin: 'https://a.test', username: 'alice', password: 'pw-hidden' });
    store.addNeverSave('https://never.test');
    const res = svc.listForSettings();
    expect(res).toEqual({
      ok: true,
      entries: [{ id: expect.any(String), origin: 'https://a.test', username: 'alice', createdAt: 1000, updatedAt: 1000, lastUsedAt: null }],
      neverSave: ['https://never.test'],
      status: { available: true, reason: '' },
      authMode: 'touchid',
      quarantined: null,
    });
    expect(JSON.stringify(res)).not.toContain('pw-hidden');
  });

  test('auth mode is a native dialog off macOS and on a Mac without Touch ID', () => {
    electron.systemPreferences.canPromptTouchID.mockReturnValue(false);
    expect(svc.listForSettings().authMode).toBe('dialog');
    electron.systemPreferences.canPromptTouchID.mockReturnValue(true);
    svc._setPlatform('linux');
    expect(svc.listForSettings().authMode).toBe('dialog');
  });

  test('reveal on macOS asks Touch ID and returns only that entry\'s password', async () => {
    const a = store.save({ origin: 'https://a.test', username: 'alice', password: 'pa' });
    store.save({ origin: 'https://a.test', username: 'bob', password: 'pb' });
    await expect(svc.reveal(a.id)).resolves.toEqual({ ok: true, password: 'pa' });
    expect(electron.systemPreferences.promptTouchID).toHaveBeenCalledWith('reveal a saved password');
  });

  test('a failed or cancelled Touch ID prompt reveals nothing', async () => {
    const a = store.save({ origin: 'https://a.test', username: 'alice', password: 'pa' });
    electron.systemPreferences.promptTouchID.mockRejectedValueOnce(new Error('User canceled'));
    await expect(svc.reveal(a.id)).rejects.toThrow(/User canceled/);
  });

  test('reveal off macOS asks in a native dialog on the main window, defaulting to Cancel', async () => {
    svc._setPlatform('win32');
    const a = store.save({ origin: 'https://a.test', username: 'alice', password: 'pa' });
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(svc.reveal(a.id)).resolves.toEqual({ ok: true, password: 'pa' });
    expect(electron.systemPreferences.promptTouchID).not.toHaveBeenCalled();
    const [win, opts] = electron.dialog.showMessageBox.mock.calls[0];
    expect(win).toBe(mainWindow);
    expect(opts).toMatchObject({ defaultId: 0, cancelId: 0 });
    expect(opts.buttons[0]).toBe('Cancel');
    expect(opts.message).toContain('alice');
    expect(opts.message).toContain('a.test');
  });

  test('a cancelled native dialog reveals and copies nothing and never decrypts', async () => {
    svc._setPlatform('linux');
    const a = store.save({ origin: 'https://a.test', username: 'alice', password: 'pa' });
    electron.safeStorage.decryptString.mockClear();
    await expect(svc.reveal(a.id)).rejects.toThrow(/cancel/i);
    await expect(svc.copy(a.id)).rejects.toThrow(/cancel/i);
    expect(electron.safeStorage.decryptString).not.toHaveBeenCalled();
    expect(electron.clipboard.writeText).not.toHaveBeenCalled();
  });

  test('a Mac without Touch ID also confirms in the native dialog before copying', async () => {
    electron.systemPreferences.canPromptTouchID.mockReturnValue(false);
    const a = store.save({ origin: 'https://a.test', username: 'alice', password: 'pa' });
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(svc.copy(a.id)).resolves.toEqual({ ok: true });
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(electron.clipboard.writeText).toHaveBeenCalledWith('pa');
  });

  test('copy writes the password through the main clipboard after Touch ID', async () => {
    const a = store.save({ origin: 'https://a.test', username: 'alice', password: 'pa' });
    await expect(svc.copy(a.id)).resolves.toEqual({ ok: true });
    expect(electron.systemPreferences.promptTouchID).toHaveBeenCalledWith('copy a saved password');
    expect(electron.clipboard.writeText).toHaveBeenCalledWith('pa');
  });

  test('copy after a failed Touch ID writes nothing', async () => {
    const a = store.save({ origin: 'https://a.test', username: 'alice', password: 'pa' });
    electron.systemPreferences.promptTouchID.mockRejectedValueOnce(new Error('denied'));
    await expect(svc.copy(a.id)).rejects.toThrow(/denied/);
    expect(electron.clipboard.writeText).not.toHaveBeenCalled();
  });

  test('remove deletes the login; an unknown id fails', () => {
    const a = store.save({ origin: 'https://a.test', username: 'alice', password: 'pa' });
    expect(svc.remove(a.id)).toEqual({ ok: true });
    expect(store.list()).toEqual([]);
    expect(svc.remove(a.id)).toEqual({ ok: false, error: expect.stringMatching(/not found/i) });
  });

  test('removeNeverSave lets the origin be offered again', () => {
    store.addNeverSave('https://a.test');
    expect(svc.removeNeverSave('https://a.test')).toEqual({ ok: true, neverSave: [] });
    svc.handleCaptured(guestEvent(), { username: 'alice', password: 'pw' });
    expect(shellSends('passwords:offer')).toHaveLength(1);
  });
});
