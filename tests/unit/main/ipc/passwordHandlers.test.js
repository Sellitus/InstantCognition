// passwordHandlers — guest channels feed PasswordService; shell channels
// refuse every sender except the main window. External boundaries: ipcMain,
// app events, dialog, safeStorage, systemPreferences, clipboard and fs.
// PasswordService and CertificateService run for real.

const handlers = {};

jest.mock('electron', () => ({
  app: { on: jest.fn(), getPath: jest.fn(() => '/mock'), isPackaged: false },
  dialog: { showMessageBox: jest.fn(() => Promise.resolve({ response: 1 })) },
  ipcMain: {
    on: jest.fn((ch, fn) => { handlers[ch] = fn; }),
    handle: jest.fn((ch, fn) => { handlers[ch] = fn; }),
  },
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    getSelectedStorageBackend: jest.fn(() => 'unknown'),
    encryptString: jest.fn((s) => Buffer.from('E' + s)),
    decryptString: jest.fn((b) => b.toString().slice(1)),
  },
  systemPreferences: {
    canPromptTouchID: jest.fn(() => false),
    promptTouchID: jest.fn(() => Promise.resolve()),
  },
  clipboard: { writeText: jest.fn(() => Promise.resolve()) },
}));

const FILE = '/data/passwords.json';
let mainWindow;
let store;
let files;
let certService;

const shellEvent = () => ({ sender: { id: 1 } });
const guestEvent = () => ({ sender: { id: 9, getType: () => 'webview', session: { isPersistent: () => true } }, senderFrame: { origin: 'https://a.test', parent: null } });

beforeEach(() => {
  jest.resetModules();
  Object.keys(handlers).forEach((k) => delete handlers[k]);
  store = require('../../../../main/services/passwords/passwordStore');
  files = new Map();
  store._setFs({
    existsSync: (p) => files.has(p) || p === '/data',
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, c) => files.set(p, c),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    mkdirSync: () => {},
  });
  store._setFilePath(FILE);
  store._setPlatform('linux');
  require('../../../../main/services/PasswordService')._setPlatform('linux');
  mainWindow = { isDestroyed: () => false, webContents: { id: 1, send: jest.fn() } };
  certService = require('../../../../main/services/CertificateService');
  require('../../../../main/ipc/passwordHandlers').register(mainWindow, { configService: { get: (_p, d) => d }, certService });
});

describe('passwordHandlers', () => {
  test('registers the guest and shell channels', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'passwords:captured', 'passwords:copy', 'passwords:delete', 'passwords:fill-result',
      'passwords:list', 'passwords:never-save-remove', 'passwords:resolve-offer', 'passwords:reveal',
    ]);
  });

  test('a guest capture reaches the shell as an offer that the shell can save', async () => {
    handlers['passwords:captured'](guestEvent(), { username: 'alice', password: 'pw' });
    const offer = mainWindow.webContents.send.mock.calls.find((c) => c[0] === 'passwords:offer')[1];
    await expect(handlers['passwords:resolve-offer'](shellEvent(), { id: offer.id, action: 'save' })).resolves.toEqual({ ok: true });
    const res = await handlers['passwords:list'](shellEvent());
    expect(res.entries.map((e) => e.username)).toEqual(['alice']);
  });

  test('App\'s certificate service reaches PasswordService: a host let through a certificate error gets no offer', () => {
    let onCertError;
    require('electron').app.on.mockImplementation((ev, fn) => { if (ev === 'certificate-error') onCertError = fn; });
    certService._registerCertErrorHandler();
    certService.acceptedCertificates['a.test'] = 'fp';
    onCertError({ preventDefault: () => {} }, null, 'https://a.test/', 'ERR_CERT_DATE_INVALID', { fingerprint: 'fp' }, () => {});
    handlers['passwords:captured'](guestEvent(), { username: 'alice', password: 'pw' });
    expect(mainWindow.webContents.send.mock.calls.filter((c) => c[0] === 'passwords:offer')).toEqual([]);
  });

  test.each(['passwords:list', 'passwords:reveal', 'passwords:copy', 'passwords:delete', 'passwords:never-save-remove', 'passwords:resolve-offer'])(
    '%s refuses a guest page as the sender',
    async (channel) => {
      const e = store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
      const res = await handlers[channel](guestEvent(), e.id);
      expect(res).toEqual({ ok: false, error: expect.stringMatching(/not allowed/i) });
      expect(JSON.stringify(res)).not.toContain('pw');
    },
  );

  test('reveal from the shell returns the password for that id', async () => {
    const e = store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
    await expect(handlers['passwords:reveal'](shellEvent(), e.id)).resolves.toEqual({ ok: true, password: 'pw' });
  });

  test('a thrown service error comes back as { ok: false, error }', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handlers['passwords:reveal'](shellEvent(), 'missing')).resolves.toEqual({ ok: false, error: expect.stringMatching(/not found/i) });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
