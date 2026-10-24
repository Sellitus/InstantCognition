// settingsV2Handlers — IPC channels behind the v2 settings UI side effects.
//
// Each test re-isolates the module so ipcMain.on/handle calls don't leak.
// All cross-mock variables are prefixed with `mock` per Jest's hoisting rules.

const mockHandlers = new Map();
const mockInvokeHandlers = new Map();
const mockSetProtocol = jest.fn();
const mockSetSpellEnabled = jest.fn();
const mockSetSpellLangs = jest.fn();
const mockSetUserAgent = jest.fn();
const mockShowOpenDialog = jest.fn();
const mockOpenExternal = jest.fn(() => Promise.resolve());
const mockLoggerSetLevel = jest.fn();

jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn((channel, fn) => { mockHandlers.set(channel, fn); }),
    handle: jest.fn((channel, fn) => { mockInvokeHandlers.set(channel, fn); }),
  },
  dialog: { showOpenDialog: (...a) => mockShowOpenDialog(...a) },
  app: { setAsDefaultProtocolClient: (...a) => mockSetProtocol(...a), getVersion: () => '1.6.2' },
  shell: { openExternal: (...a) => mockOpenExternal(...a) },
  session: {
    defaultSession: {
      setSpellCheckerEnabled: (...a) => mockSetSpellEnabled(...a),
      setSpellCheckerLanguages: (...a) => mockSetSpellLangs(...a),
      setUserAgent: (...a) => mockSetUserAgent(...a),
      getUserAgent: () => 'Mozilla/5.0',
    },
  },
}));

jest.mock('../../../../main/utils/logger', () => ({ setLevel: (...a) => mockLoggerSetLevel(...a) }));

const fakeMainWindow = () => ({
  isDestroyed: () => false,
  webContents: { send: jest.fn() },
});

function fakeConfigService(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial));
  return {
    get: jest.fn((path, fb) => {
      const parts = String(path).split('.');
      let cur = store;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return fb;
        cur = cur[p];
      }
      return cur === undefined ? fb : cur;
    }),
    set: jest.fn((path, value) => {
      const parts = String(path).split('.');
      let cur = store;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }),
    replaceAll: jest.fn(),
  };
}

function loadHandlers(mainWindow, configService) {
  mockHandlers.clear();
  mockInvokeHandlers.clear();
  jest.isolateModules(() => {
    const mod = require('../../../../main/ipc/settingsV2Handlers');
    mod.register(mainWindow, { configService });
  });
}

describe('settingsV2Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/picked'] });
  });

  test('dialog:choose-directory returns the chosen path', async () => {
    loadHandlers(fakeMainWindow(), fakeConfigService());
    const fn = mockInvokeHandlers.get('dialog:choose-directory');
    expect(typeof fn).toBe('function');
    const r = await fn({}, { title: 'Pick a folder' });
    expect(r).toBe('/tmp/picked');
    expect(mockShowOpenDialog).toHaveBeenCalled();
  });

  test('dialog:choose-directory returns null on cancel', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true });
    loadHandlers(fakeMainWindow(), fakeConfigService());
    const r = await mockInvokeHandlers.get('dialog:choose-directory')({}, {});
    expect(r).toBeNull();
  });

  test('settings:apply-spellcheck pushes enabled + langs to default session', () => {
    const cs = fakeConfigService({ settings: { spellCheck: { enabled: true, languages: ['en-US', 'fr'] } } });
    loadHandlers(fakeMainWindow(), cs);
    mockHandlers.get('settings:apply-spellcheck')({});
    expect(mockSetSpellEnabled).toHaveBeenCalledWith(true);
    expect(mockSetSpellLangs).toHaveBeenCalledWith(['en-US', 'fr']);
  });

  test('settings:apply-spellcheck does not push langs when disabled', () => {
    const cs = fakeConfigService({ settings: { spellCheck: { enabled: false, languages: ['en-US'] } } });
    loadHandlers(fakeMainWindow(), cs);
    mockHandlers.get('settings:apply-spellcheck')({});
    expect(mockSetSpellEnabled).toHaveBeenCalledWith(false);
    expect(mockSetSpellLangs).not.toHaveBeenCalled();
  });

  test('settings:apply-accept-languages re-sets the session UA suffix', () => {
    const cs = fakeConfigService({ settings: { acceptLanguages: ['en-US', 'fr', 'de'] } });
    loadHandlers(fakeMainWindow(), cs);
    mockHandlers.get('settings:apply-accept-languages')({});
    expect(mockSetUserAgent).toHaveBeenCalledWith('Mozilla/5.0', 'en-US,fr,de');
  });

  test('settings:set-log-level forwards to logger.setLevel', () => {
    loadHandlers(fakeMainWindow(), fakeConfigService());
    mockHandlers.get('settings:set-log-level')({}, 'debug');
    expect(mockLoggerSetLevel).toHaveBeenCalledWith('debug');
  });

  test('settings:set-log-level falls back to "info" when called with no value', () => {
    loadHandlers(fakeMainWindow(), fakeConfigService());
    mockHandlers.get('settings:set-log-level')({}, undefined);
    expect(mockLoggerSetLevel).toHaveBeenCalledWith('info');
  });

  test('settings:set-default-browser registers http + https protocols', () => {
    loadHandlers(fakeMainWindow(), fakeConfigService());
    mockHandlers.get('settings:set-default-browser')({});
    expect(mockSetProtocol).toHaveBeenCalledWith('http');
    expect(mockSetProtocol).toHaveBeenCalledWith('https');
  });

  test('settings:reset-all preserves spaces+state and broadcasts replace', () => {
    const cs = fakeConfigService({ spaces: { keep: { name: 'mine' } }, state: { saved: true }, settings: { theme: 'light' } });
    const mw = fakeMainWindow();
    loadHandlers(mw, cs);
    mockHandlers.get('settings:reset-all')({});
    expect(cs.replaceAll).toHaveBeenCalled();
    const passed = cs.replaceAll.mock.calls[0][0];
    expect(passed.spaces).toEqual({ keep: { name: 'mine' } });
    expect(passed.state).toEqual({ saved: true });
    expect(mw.webContents.send).toHaveBeenCalledWith('config:changed', { kind: 'replace' });
  });

  test('open-external-url opens https URLs via shell.openExternal', () => {
    loadHandlers(fakeMainWindow(), fakeConfigService());
    mockHandlers.get('open-external-url')({}, 'https://example.com');
    expect(mockOpenExternal).toHaveBeenCalledWith('https://example.com');
  });

  test('open-external-url rejects non-http(s) URLs', () => {
    loadHandlers(fakeMainWindow(), fakeConfigService());
    mockHandlers.get('open-external-url')({}, 'file:///etc/passwd');
    mockHandlers.get('open-external-url')({}, 'javascript:alert(1)');
    mockHandlers.get('open-external-url')({}, 12345);
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  test('webviews:set-zoom-default forwards Number factor to the renderer', () => {
    const mw = fakeMainWindow();
    loadHandlers(mw, fakeConfigService());
    mockHandlers.get('webviews:set-zoom-default')({}, 1.25);
    expect(mw.webContents.send).toHaveBeenCalledWith('webviews:set-zoom-default', 1.25);
  });

  test('webviews:set-zoom-default ignores non-finite factors', () => {
    const mw = fakeMainWindow();
    loadHandlers(mw, fakeConfigService());
    mockHandlers.get('webviews:set-zoom-default')({}, 'not a number');
    expect(mw.webContents.send).not.toHaveBeenCalled();
  });
});
