jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    webContents: { fromId: jest.fn() },
  };
});

jest.mock('../../../../main/services/ConfigService', () => ({ get: jest.fn() }));

const { ipcMain, webContents } = require('electron');
const { register, normalizeHostname } = require('../../../../main/ipc/siteBlockedHandlers');
const browsingPrivacy = require('../../../../main/services/BrowsingPrivacyService');

describe('normalizeHostname', () => {
  test('returns null for empty / non-string', () => {
    expect(normalizeHostname('')).toBeNull();
    expect(normalizeHostname(null)).toBeNull();
    expect(normalizeHostname(undefined)).toBeNull();
    expect(normalizeHostname(42)).toBeNull();
  });

  test('returns null for whitespace-only input', () => {
    expect(normalizeHostname('   ')).toBeNull();
  });

  test('lowercases bare hostnames', () => {
    expect(normalizeHostname('Example.COM')).toBe('example.com');
  });

  test('extracts hostname from a URL', () => {
    expect(normalizeHostname('https://Example.com/path?q=1')).toBe('example.com');
    expect(normalizeHostname('http://10.0.0.5:8080/api')).toBe('10.0.0.5');
  });

  test('falls through to direct use when URL parse throws', () => {
    // 'http://' matches the scheme regex but `new URL()` throws → catch block
    // swallows it and the raw (lowercased) string is used directly.
    expect(normalizeHostname('http://')).toBe('http://');
  });

  test('strips a leading wildcard so "*.example.com" works', () => {
    expect(normalizeHostname('*.example.com')).toBe('example.com');
  });

  test('strips IPv6 brackets', () => {
    expect(normalizeHostname('[::1]')).toBe('::1');
  });

  test('rejects hostnames with whitespace', () => {
    expect(normalizeHostname('exa mple.com')).toBeNull();
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeHostname('  example.com  ')).toBe('example.com');
  });
});

describe('siteBlockedHandlers register', () => {
  let configService;
  let adblockerService;
  let store;

  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    webContents.fromId.mockReturnValue(null);

    store = {};
    configService = {
      get: jest.fn((k, d) => (k in store ? store[k] : d)),
      set: jest.fn((k, v) => { store[k] = v; }),
    };
    adblockerService = { applyAllowlist: jest.fn(async () => {}) };
    register(null, { configService, adblockerService });
  });

  test('no-ops when configService missing', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(null, { adblockerService });
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('no-ops when services arg omitted', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(null);
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  describe('site-allowlist:add', () => {
    test('rejects invalid hostname', async () => {
      const r = await ipcMain._handlers['site-allowlist:add']({}, 'bad host');
      expect(r).toEqual({ ok: false, error: 'Invalid hostname' });
      expect(configService.set).not.toHaveBeenCalled();
    });

    test('adds normalized host and applies to live adblocker', async () => {
      const r = await ipcMain._handlers['site-allowlist:add']({}, 'https://Example.com/x');
      expect(configService.set).toHaveBeenCalledWith('settings.siteAllowlist', ['example.com']);
      expect(adblockerService.applyAllowlist).toHaveBeenCalledWith(['example.com']);
      expect(r).toEqual({ ok: true, hostname: 'example.com', list: ['example.com'] });
    });

    test('does not duplicate an already-present host', async () => {
      store['settings.siteAllowlist'] = ['example.com'];
      const r = await ipcMain._handlers['site-allowlist:add']({}, 'example.com');
      expect(configService.set).not.toHaveBeenCalled();
      expect(adblockerService.applyAllowlist).not.toHaveBeenCalled();
      expect(r).toEqual({ ok: true, hostname: 'example.com', list: ['example.com'] });
    });

    test('handles non-array stored list', async () => {
      store['settings.siteAllowlist'] = null;
      const r = await ipcMain._handlers['site-allowlist:add']({}, 'x.com');
      expect(r.list).toEqual(['x.com']);
    });

    test('an engine that rejects the host reports failure and restores the saved list', async () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      store['settings.siteAllowlist'] = ['keep.com'];
      adblockerService.applyAllowlist.mockRejectedValue(new Error('engine down'));
      const r = await ipcMain._handlers['site-allowlist:add']({}, 'y.com');
      expect(r).toEqual({ ok: false, error: 'The ad blocker could not apply the change: engine down' });
      expect(store['settings.siteAllowlist']).toEqual(['keep.com']);
      err.mockRestore();
    });

    test('works without adblockerService', async () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(null, { configService });
      const r = await ipcMain._handlers['site-allowlist:add']({}, 'z.com');
      expect(r).toEqual({ ok: true, hostname: 'z.com', list: ['z.com'] });
    });
  });

  describe('site-allowlist:remove', () => {
    test('rejects invalid hostname', async () => {
      const r = await ipcMain._handlers['site-allowlist:remove']({}, 'bad host');
      expect(r).toEqual({ ok: false, error: 'Invalid hostname' });
    });

    test('removes the host and applies filtered list', async () => {
      store['settings.siteAllowlist'] = ['keep.com', 'drop.com'];
      const r = await ipcMain._handlers['site-allowlist:remove']({}, 'drop.com');
      expect(configService.set).toHaveBeenCalledWith('settings.siteAllowlist', ['keep.com']);
      expect(adblockerService.applyAllowlist).toHaveBeenCalledWith(['keep.com']);
      expect(r).toEqual({ ok: true, list: ['keep.com'] });
    });

    test('handles non-array stored list', async () => {
      store['settings.siteAllowlist'] = undefined;
      const r = await ipcMain._handlers['site-allowlist:remove']({}, 'x.com');
      expect(r).toEqual({ ok: true, list: [] });
    });

    test('an engine failure on remove reports it and keeps the host listed', async () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      store['settings.siteAllowlist'] = ['a.com'];
      adblockerService.applyAllowlist.mockRejectedValue(new Error('boom'));
      const r = await ipcMain._handlers['site-allowlist:remove']({}, 'a.com');
      expect(r).toEqual({ ok: false, error: 'The ad blocker could not apply the change: boom' });
      expect(store['settings.siteAllowlist']).toEqual(['a.com']);
      err.mockRestore();
    });

    test('works without adblockerService', async () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(null, { configService });
      store['settings.siteAllowlist'] = ['a.com'];
      const r = await ipcMain._handlers['site-allowlist:remove']({}, 'a.com');
      expect(r).toEqual({ ok: true, list: [] });
    });
  });

  describe('site-blocked:retry', () => {
    test('ignores non-integer webContentsId', () => {
      ipcMain._handlers['site-blocked:retry']({}, { webContentsId: 'nope' });
      expect(webContents.fromId).not.toHaveBeenCalled();
    });

    test('ignores when payload omitted (defaults to {})', () => {
      ipcMain._handlers['site-blocked:retry']({});
      expect(webContents.fromId).not.toHaveBeenCalled();
    });

    test('reloads the targeted webContents', () => {
      const wc = { isDestroyed: () => false, reload: jest.fn() };
      webContents.fromId.mockReturnValue(wc);
      ipcMain._handlers['site-blocked:retry']({}, { webContentsId: 12 });
      expect(webContents.fromId).toHaveBeenCalledWith(12);
      expect(wc.reload).toHaveBeenCalled();
    });

    test('does not reload a destroyed webContents', () => {
      const wc = { isDestroyed: () => true, reload: jest.fn() };
      webContents.fromId.mockReturnValue(wc);
      ipcMain._handlers['site-blocked:retry']({}, { webContentsId: 12 });
      expect(wc.reload).not.toHaveBeenCalled();
    });

    test('does nothing when webContents not found', () => {
      webContents.fromId.mockReturnValue(null);
      expect(() => ipcMain._handlers['site-blocked:retry']({}, { webContentsId: 12 })).not.toThrow();
    });

    test('swallows errors from fromId', () => {
      webContents.fromId.mockImplementation(() => { throw new Error('boom'); });
      expect(() => ipcMain._handlers['site-blocked:retry']({}, { webContentsId: 12 })).not.toThrow();
    });
  });

  describe('site-blocked:continue-http', () => {
    function upgradedWebview() {
      const listeners = {};
      const app = { on: jest.fn(), quit: jest.fn() };
      const session = { defaultSession: { webRequest: { onBeforeSendHeaders: (fn) => { listeners.send = fn; }, onHeadersReceived: jest.fn() } } };
      browsingPrivacy.initialize({ get: (p, d) => (p === 'settings.httpsOnly' ? true : d) }, { app, session });
      const wc = { getType: () => 'webview', getURL: () => '', isDestroyed: () => false, loadURL: jest.fn(() => Promise.resolve()) };
      listeners.send({ url: 'http://plain.example/', method: 'GET', resourceType: 'mainFrame', webContents: wc, requestHeaders: {} }, () => {});
      return wc;
    }

    test('loads the HTTP URL main recorded for the failed upgrade', () => {
      const wc = upgradedWebview();
      webContents.fromId.mockReturnValue(wc);
      ipcMain._handlers['site-blocked:continue-http']({}, { webContentsId: 9 });
      expect(webContents.fromId).toHaveBeenCalledWith(9);
      expect(wc.loadURL).toHaveBeenLastCalledWith('http://plain.example/');
    });

    test('a view with no pending upgrade loads nothing and logs', () => {
      const wc = { getType: () => 'webview', isDestroyed: () => false, loadURL: jest.fn() };
      webContents.fromId.mockReturnValue(wc);
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      ipcMain._handlers['site-blocked:continue-http']({}, { webContentsId: 9 });
      expect(wc.loadURL).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });
  });
});
