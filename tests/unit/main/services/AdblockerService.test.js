jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
jest.mock('@ghostery/adblocker-electron', () => ({
  ElectronBlocker: { fromLists: jest.fn(), deserialize: jest.fn() },
}));
jest.mock('cross-fetch', () => jest.fn());

// Mock fs to control cache behavior
const mockFs = {
  existsSync: jest.fn(() => false),
  statSync: jest.fn(() => ({ mtimeMs: 0 })),
  writeFileSync: jest.fn(),
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
};
jest.mock('fs', () => mockFs);

let adblockerService;

// An Electron session's webRequest keeps one onHeadersReceived listener; the
// fake records the latest, as Electron would run it.
function fakeSession(name = 'default') {
  const ses = { name, headersListener: null, webRequest: {} };
  ses.webRequest.onHeadersReceived = jest.fn((filter, fn) => {
    ses.headersListener = typeof filter === 'function' ? filter : (fn || null);
  });
  return ses;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
    BrowserWindow: { getAllWindows: jest.fn(() => []) },
  }));
  jest.mock('@ghostery/adblocker-electron', () => ({
    ElectronBlocker: { fromLists: jest.fn(), deserialize: jest.fn() },
  }));
  jest.mock('cross-fetch', () => jest.fn());
  jest.mock('fs', () => ({
    existsSync: jest.fn(() => false),
    statSync: jest.fn(() => ({ mtimeMs: 0 })),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
    readFileSync: jest.fn(() => '{}'),
    promises: {
      readFile: jest.fn(),
      writeFile: jest.fn().mockResolvedValue(undefined),
      rename: jest.fn().mockResolvedValue(undefined),
      unlink: jest.fn().mockResolvedValue(undefined),
    },
  }));

  adblockerService = require('../../../../main/services/AdblockerService');
  adblockerService.blocker = null;
  adblockerService.blockerCache = null;
  if (adblockerService.intervalId) clearInterval(adblockerService.intervalId);
  adblockerService.intervalId = null;
});

afterEach(() => {
  if (adblockerService && adblockerService.intervalId) {
    clearInterval(adblockerService.intervalId);
    adblockerService.intervalId = null;
  }
});

describe('AdblockerService', () => {
  describe('Initialization', () => {
    test('starts with blocker disabled', () => {
      expect(adblockerService.isEnabled).toBe(false);
      expect(adblockerService.blocker).toBeNull();
    });
  });

  describe('Enable', () => {
    test('creates blocker from filter lists when no cache exists', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const mockBlocker = {
        enableBlockingInSession: jest.fn(),
        serialize: jest.fn().mockResolvedValue(Buffer.from('test')),
      };
      ElectronBlocker.fromLists.mockResolvedValue(mockBlocker);

      await adblockerService.enable();

      expect(ElectronBlocker.fromLists).toHaveBeenCalled();
      expect(adblockerService.isEnabled).toBe(true);
    });

    test('enables blocking on all BrowserWindow sessions', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const { BrowserWindow } = require('electron');
      const mockSession = fakeSession();
      const mockBlocker = {
        enableBlockingInSession: jest.fn(),
        serialize: jest.fn().mockResolvedValue(Buffer.from('test')),
      };
      ElectronBlocker.fromLists.mockResolvedValue(mockBlocker);
      BrowserWindow.getAllWindows.mockReturnValue([
        { webContents: { session: mockSession } },
      ]);

      await adblockerService.enable();
      expect(mockBlocker.enableBlockingInSession).toHaveBeenCalledWith(mockSession);
    });

    test('returns cached blocker on subsequent calls', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const mockBlocker = {
        enableBlockingInSession: jest.fn(),
        serialize: jest.fn().mockResolvedValue(Buffer.from('test')),
      };
      ElectronBlocker.fromLists.mockResolvedValue(mockBlocker);

      const first = await adblockerService.enable();
      const second = await adblockerService.enable();

      expect(first).toBe(second);
      expect(ElectronBlocker.fromLists).toHaveBeenCalledTimes(1);
    });

    test('uses cached blocker when cache is fresh', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const fs = require('fs');
      const mockBlocker = { enableBlockingInSession: jest.fn() };

      // Cache exists and is fresh
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: Date.now() }); // recent
      fs.promises.readFile.mockResolvedValue(Buffer.from('cached'));
      ElectronBlocker.deserialize.mockResolvedValue(mockBlocker);

      await adblockerService.enable();

      expect(ElectronBlocker.deserialize).toHaveBeenCalled();
      expect(ElectronBlocker.fromLists).not.toHaveBeenCalled();
    });
  });

  describe('Disable', () => {
    test('clears blocker and blockerCache', () => {
      const { BrowserWindow } = require('electron');
      adblockerService.blocker = { disableBlockingInSession: jest.fn() };
      adblockerService.blockerCache = {};
      BrowserWindow.getAllWindows.mockReturnValue([{ webContents: { session: {} } }]);

      adblockerService.disable();

      expect(adblockerService.isEnabled).toBe(false);
      expect(adblockerService.blocker).toBeNull();
      expect(adblockerService.blockerCache).toBeNull();
    });

    test('clears update interval', () => {
      const { BrowserWindow } = require('electron');
      adblockerService.intervalId = setInterval(() => {}, 10000);
      adblockerService.blocker = { disableBlockingInSession: jest.fn() };
      BrowserWindow.getAllWindows.mockReturnValue([]);

      adblockerService.disable();
      expect(adblockerService.intervalId).toBeNull();
    });

    test('does nothing if blocker is already null', () => {
      expect(() => adblockerService.disable()).not.toThrow();
    });
  });

  describe('Auto-update', () => {
    test('setupAutoUpdate creates interval', () => {
      adblockerService.setupAutoUpdate();
      expect(adblockerService.intervalId).not.toBeNull();
    });

    test('setupAutoUpdate clears previous interval', () => {
      const oldInterval = setInterval(() => {}, 10000);
      adblockerService.intervalId = oldInterval;
      adblockerService.setupAutoUpdate();
      expect(adblockerService.intervalId).not.toBe(oldInterval);
      clearInterval(oldInterval);
    });

    test('window resume revives the hourly timer while the service stays enabled', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      ElectronBlocker.fromLists.mockResolvedValue({
        enableBlockingInSession: jest.fn(),
        serialize: jest.fn().mockResolvedValue(Buffer.from('x')),
      });
      await adblockerService.enable();
      adblockerService.setupAutoUpdate();
      expect(adblockerService.intervalId).not.toBeNull();
      const vis = require('../../../../main/services/visibilityThrottling');
      for (const fn of [...vis._suspendSubs]) fn(); // window hidden
      expect(adblockerService.intervalId).toBeNull();
      for (const fn of [...vis._resumeSubs]) fn(); // window shown
      expect(adblockerService.intervalId).not.toBeNull();
    });

    test('window resume does NOT revive auto-update after the service was disabled', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      ElectronBlocker.fromLists.mockResolvedValue({
        enableBlockingInSession: jest.fn(),
        serialize: jest.fn().mockResolvedValue(Buffer.from('x')),
      });
      await adblockerService.enable();
      adblockerService.setupAutoUpdate();
      adblockerService.disable();
      expect(adblockerService.intervalId).toBeNull();
      expect(adblockerService.isEnabled).toBe(false);
      const vis = require('../../../../main/services/visibilityThrottling');
      // disable() clears blocker/interval but leaves the resume hook
      // subscribed; re-showing the window must keep the adblocker off.
      for (const fn of [...vis._resumeSubs]) fn();
      expect(adblockerService.intervalId).toBeNull();
      expect(adblockerService.isEnabled).toBe(false);
    });
  });

  describe('Catalog & resolution', () => {
    test('getCatalog returns the built-in catalog with default-on lists', () => {
      const cat = adblockerService.getCatalog();
      expect(Array.isArray(cat)).toBe(true);
      expect(cat.length).toBeGreaterThan(0);
      expect(cat[0]).toHaveProperty('id');
      expect(cat[0]).toHaveProperty('label');
      expect(cat[0]).toHaveProperty('url');
      expect(cat.filter((e) => e.defaultOn).length).toBe(cat.length);
    });

    test('_resolveActiveLists with no config returns default-on built-ins', () => {
      const lists = adblockerService._resolveActiveLists();
      expect(Array.isArray(lists)).toBe(true);
      expect(lists.length).toBeGreaterThan(0);
      expect(lists.every((u) => /^https?:\/\//.test(u))).toBe(true);
    });
  });

  describe('enableForSession', () => {
    test('no-ops when no blockerCache', () => {
      adblockerService.blockerCache = null;
      expect(() => adblockerService.enableForSession(fakeSession())).not.toThrow();
    });

    test('calls enableBlockingInSession on the running engine', () => {
      const spy = jest.fn();
      adblockerService.blocker = { enableBlockingInSession: spy };
      const sess = fakeSession();
      adblockerService.enableForSession(sess);
      expect(spy).toHaveBeenCalledWith(sess);
    });
  });

  describe('getStats', () => {
    test('reports disabled when blocker is null', () => {
      adblockerService.blocker = null;
      const stats = adblockerService.getStats();
      expect(stats.enabled).toBe(false);
      expect(stats.activeListCount).toBe(0);
      expect(stats.filterCount).toBe(0);
    });
  });

  describe('validateBlocklistUrl', () => {
    test('rejects empty URL', async () => {
      const r = await adblockerService.validateBlocklistUrl('');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/empty/i);
    });

    test('rejects malformed URL', async () => {
      const r = await adblockerService.validateBlocklistUrl('not a url');
      expect(r.ok).toBe(false);
    });

    test('rejects non-http(s) protocol', async () => {
      const r = await adblockerService.validateBlocklistUrl('ftp://example.com/list.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/http/i);
    });

    test('rejects HTML response', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => '0' },
        text: () => Promise.resolve('<!DOCTYPE html><html><body></body></html>'),
      });
      global.fetch = fetchMock;
      const r = await adblockerService.validateBlocklistUrl('https://example.com/');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/html/i);
    });

    test('rejects content that parses to zero filters', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      ElectronBlocker.parse = jest.fn(() => ({
        getFilters: () => ({ networkFilters: [], cosmeticFilters: [] }),
      }));
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => '0' },
        text: () => Promise.resolve('# Just a comment\n\n'),
      });
      global.fetch = fetchMock;
      const r = await adblockerService.validateBlocklistUrl('https://example.com/x.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/0 filters|recognized/i);
    });

    test('accepts valid filter list', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      ElectronBlocker.parse = jest.fn(() => ({
        getFilters: () => ({
          networkFilters: [{ id: 1 }, { id: 2 }, { id: 3 }],
          cosmeticFilters: [],
        }),
      }));
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => '0' },
        text: () => Promise.resolve('||doubleclick.net^\n||ads.example.com^'),
      });
      global.fetch = fetchMock;
      const r = await adblockerService.validateBlocklistUrl('https://example.com/list.txt');
      expect(r.ok).toBe(true);
      expect(r.filterCount).toBe(3);
    });

    test('reports HTTP errors', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { get: () => null },
      });
      global.fetch = fetchMock;
      const r = await adblockerService.validateBlocklistUrl('https://example.com/missing.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/404/);
    });

    test('rejects when content-length header exceeds the max', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => String(10 * 1024 * 1024) },
        text: () => Promise.resolve(''),
      });
      const r = await adblockerService.validateBlocklistUrl('https://example.com/big.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/too large/i);
    });

    test('rejects when the downloaded body exceeds the max', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => '0' },
        text: () => Promise.resolve('x'.repeat(5 * 1024 * 1024 + 1)),
      });
      const r = await adblockerService.validateBlocklistUrl('https://example.com/x.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/too large/i);
    });

    test('reports a parse error when ElectronBlocker.parse throws', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      ElectronBlocker.parse = jest.fn(() => { throw new Error('bad rule'); });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => '0' },
        text: () => Promise.resolve('||ads.com^'),
      });
      const r = await adblockerService.validateBlocklistUrl('https://example.com/x.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Parse error: bad rule/);
    });

    test('maps an AbortError to a timed-out message', async () => {
      global.fetch = jest.fn(() => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        return Promise.reject(e);
      });
      const r = await adblockerService.validateBlocklistUrl('https://example.com/slow.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toBe('Timed out.');
    });

    test('maps a generic network failure to its message', async () => {
      global.fetch = jest.fn(() => Promise.reject(new Error('ENOTFOUND')));
      const r = await adblockerService.validateBlocklistUrl('https://example.com/x.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toBe('ENOTFOUND');
    });

    test('counts cosmetic filters too when the engine exposes none on getFilters', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      ElectronBlocker.parse = jest.fn(() => ({})); // no getFilters -> treated as 0 filters
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => '0' },
        text: () => Promise.resolve('||ads.com^'),
      });
      const r = await adblockerService.validateBlocklistUrl('https://example.com/x.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/0 filters|recognized/i);
    });
  });

  describe('applyAllowlist', () => {
    test('stores the desired list verbatim when no cache supports updateFromDiff', async () => {
      adblockerService.blockerCache = null;
      await adblockerService.applyAllowlist(['a.com', 'b.com', 5, null]);
      expect(adblockerService._appliedAllowlist).toEqual(['a.com', 'b.com']);
    });

    test('applies only the delta via updateFromDiff and refreshes stats', async () => {
      const updateFromDiff = jest.fn();
      adblockerService.blockerCache = {
        updateFromDiff,
        getFilters: () => ({ networkFilters: [1, 2], cosmeticFilters: [3] }),
      };
      adblockerService._appliedAllowlist = ['old.com'];
      await adblockerService.applyAllowlist(['new.com']);
      expect(updateFromDiff).toHaveBeenCalledWith({ added: ['@@||new.com^'], removed: ['@@||old.com^'] });
      expect(adblockerService._appliedAllowlist).toEqual(['new.com']);
      expect(adblockerService._filterCount).toBe(3);
    });

    test('is a no-op when there is no delta', async () => {
      const updateFromDiff = jest.fn();
      adblockerService.blockerCache = { updateFromDiff };
      adblockerService._appliedAllowlist = ['same.com'];
      await adblockerService.applyAllowlist(['same.com']);
      expect(updateFromDiff).not.toHaveBeenCalled();
    });

    test('an engine that rejects the diff throws, and the applied list stays as it was', async () => {
      adblockerService.blockerCache = { updateFromDiff: () => { throw new Error('engine busy'); } };
      adblockerService._appliedAllowlist = ['old.com'];
      await expect(adblockerService.applyAllowlist(['old.com', 'x.com'])).rejects.toThrow('engine busy');
      expect(adblockerService._appliedAllowlist).toEqual(['old.com']);
    });

    test('treats a non-array argument as an empty desired list', async () => {
      adblockerService.blockerCache = null;
      await adblockerService.applyAllowlist('not-an-array');
      expect(adblockerService._appliedAllowlist).toEqual([]);
    });
  });

  describe('_captureStats', () => {
    test('sets filterCount to 0 when there is no cache', () => {
      adblockerService.blockerCache = null;
      adblockerService._captureStats();
      expect(adblockerService._filterCount).toBe(0);
    });

    test('sums network + cosmetic filter counts', () => {
      adblockerService.blockerCache = {
        getFilters: () => ({ networkFilters: [1, 2, 3], cosmeticFilters: [4] }),
      };
      adblockerService._captureStats();
      expect(adblockerService._filterCount).toBe(4);
    });

    test('falls back to 0 when getFilters throws', () => {
      adblockerService.blockerCache = { getFilters: () => { throw new Error('x'); } };
      adblockerService._captureStats();
      expect(adblockerService._filterCount).toBe(0);
    });
  });

  describe('enable — cache paths', () => {
    let warnSpy;
    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    test('forces an update when the on-disk cache is stale', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const fs = require('fs');
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: 0 }); // ancient -> stale
      const mockBlocker = {
        enableBlockingInSession: jest.fn(),
        serialize: jest.fn().mockResolvedValue(Buffer.from('x')),
        getFilters: () => ({ networkFilters: [1], cosmeticFilters: [] }),
      };
      ElectronBlocker.fromLists.mockResolvedValue(mockBlocker);
      await adblockerService.enable();
      expect(ElectronBlocker.fromLists).toHaveBeenCalled();
      expect(adblockerService.isEnabled).toBe(true);
    });

    test('forces fromLists when cached deserialize fails', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const fs = require('fs');
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: Date.now() }); // fresh
      fs.promises.readFile.mockResolvedValue(Buffer.from('corrupt'));
      ElectronBlocker.deserialize.mockRejectedValue(new Error('bad cache'));
      const mockBlocker = {
        enableBlockingInSession: jest.fn(),
        serialize: jest.fn().mockResolvedValue(Buffer.from('x')),
      };
      ElectronBlocker.fromLists.mockResolvedValue(mockBlocker);
      await adblockerService.enable();
      expect(ElectronBlocker.deserialize).toHaveBeenCalled();
      expect(ElectronBlocker.fromLists).toHaveBeenCalled();
    });

    test('rethrows on a critical error', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      ElectronBlocker.fromLists.mockRejectedValue(new Error('fatal'));
      await expect(adblockerService.enable()).rejects.toThrow(/fatal/);
    });

    test('falls back to the stale on-disk cache when the list update fails', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const fs = require('fs');
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: 0 }); // ancient -> stale
      fs.promises.readFile.mockResolvedValue(Buffer.from('stale-but-valid'));
      ElectronBlocker.fromLists.mockRejectedValue(new Error('offline'));
      const staleBlocker = {
        enableBlockingInSession: jest.fn(),
        getFilters: () => ({ networkFilters: [1, 2], cosmeticFilters: [] }),
      };
      ElectronBlocker.deserialize.mockResolvedValue(staleBlocker);

      await expect(adblockerService.enable()).resolves.toBe(staleBlocker);
      expect(ElectronBlocker.deserialize).toHaveBeenCalled();
      expect(adblockerService.isEnabled).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/stale|fallback|offline/i));
    });

    test('rethrows the fromLists error when the stale cache itself fails to deserialize', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const fs = require('fs');
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: 0 }); // ancient -> stale
      fs.promises.readFile.mockResolvedValue(Buffer.from('corrupt'));
      ElectronBlocker.fromLists.mockRejectedValue(new Error('offline'));
      ElectronBlocker.deserialize.mockRejectedValue(new Error('bad cache'));

      await expect(adblockerService.enable()).rejects.toThrow(/offline/);
    });

    test('rethrows the fromLists error when the stale cache deserializes to nothing', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const fs = require('fs');
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: 0 }); // ancient -> stale
      fs.promises.readFile.mockResolvedValue(Buffer.from('stale'));
      ElectronBlocker.fromLists.mockRejectedValue(new Error('offline'));
      ElectronBlocker.deserialize.mockResolvedValue(null);

      // A falsy deserialize result must not reach the caller as "success"
      // while isEnabled stays false.
      await expect(adblockerService.enable()).rejects.toThrow(/offline/);
      expect(adblockerService.isEnabled).toBe(false);
    });

    test('propagates the write failure and does not cache the unattached blocker', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const fs = require('fs');
      fs.existsSync.mockReturnValue(false);
      const freshBlocker = {
        enableBlockingInSession: jest.fn(),
        serialize: jest.fn().mockResolvedValue(Buffer.from('x')),
      };
      ElectronBlocker.fromLists.mockResolvedValue(freshBlocker);
      fs.promises.writeFile.mockRejectedValue(new Error('ENOSPC'));

      await expect(adblockerService.enable()).rejects.toThrow(/ENOSPC/);
      // The blocker was never attached to a session, so it must not linger:
      // a later enable() would early-return it with blocking still off.
      expect(adblockerService.blockerCache).toBeNull();
      expect(adblockerService.isEnabled).toBe(false);
    });

    test('does not rewrite the cache file when falling back to it', async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const fs = require('fs');
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: 0 });
      fs.promises.readFile.mockResolvedValue(Buffer.from('stale-but-valid'));
      ElectronBlocker.fromLists.mockRejectedValue(new Error('offline'));
      ElectronBlocker.deserialize.mockResolvedValue({
        enableBlockingInSession: jest.fn(),
        getFilters: () => ({ networkFilters: [1], cosmeticFilters: [] }),
      });

      await adblockerService.enable();
      // A write would reset the mtime and mask the outage for another 24h.
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('engine replacement', () => {
    const session = fakeSession();
    function engine(name, order) {
      return {
        name,
        enableBlockingInSession: jest.fn(() => order.push(name + ':on')),
        disableBlockingInSession: jest.fn(() => order.push(name + ':off')),
        serialize: jest.fn().mockResolvedValue(Buffer.from(name)),
        updateFromDiff: jest.fn(),
      };
    }
    async function startWith(first, fs) {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const { BrowserWindow } = require('electron');
      BrowserWindow.getAllWindows.mockReturnValue([{ webContents: { session } }]);
      fs.existsSync.mockReturnValue(false);
      ElectronBlocker.fromLists.mockResolvedValueOnce(first);
      await adblockerService.enable();
      return ElectronBlocker;
    }

    test('the hourly refresh detaches the old engine before the new one attaches', async () => {
      const fs = require('fs');
      const order = [];
      const a = engine('a', order);
      const b = engine('b', order);
      const ElectronBlocker = await startWith(a, fs);
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: 0 });
      ElectronBlocker.fromLists.mockResolvedValueOnce(b);
      await adblockerService.refresh();
      expect(order).toEqual(['a:on', 'a:off', 'b:on']);
      expect(adblockerService.blocker).toBe(b);
      expect(adblockerService.blockerCache).toBe(b);
      expect(fs.promises.rename).toHaveBeenLastCalledWith(expect.stringMatching(/\.tmp$/), expect.not.stringMatching(/\.tmp$/));
    });

    test('an allowlist added after a refresh reaches the engine that is blocking', async () => {
      const fs = require('fs');
      const order = [];
      const a = engine('a', order);
      const b = engine('b', order);
      const ElectronBlocker = await startWith(a, fs);
      fs.existsSync.mockReturnValue(true);
      ElectronBlocker.fromLists.mockResolvedValueOnce(b);
      await adblockerService.refresh();
      await adblockerService.applyAllowlist(['news.example']);
      expect(b.updateFromDiff).toHaveBeenCalledWith({ added: ['@@||news.example^'], removed: [] });
      expect(adblockerService.blocker).toBe(b);
    });

    test('a refresh inside the cache window keeps the running engine', async () => {
      const fs = require('fs');
      const order = [];
      const a = engine('a', order);
      const ElectronBlocker = await startWith(a, fs);
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: Date.now() });
      await adblockerService.refresh();
      expect(ElectronBlocker.fromLists).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['a:on']);
    });

    test('a failed refresh or reload keeps blocking with the old engine and reports the error', async () => {
      const fs = require('fs');
      const order = [];
      const a = engine('a', order);
      const ElectronBlocker = await startWith(a, fs);
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: 0 });
      ElectronBlocker.fromLists.mockRejectedValue(new Error('offline'));
      await expect(adblockerService.refresh()).rejects.toThrow('offline');
      await expect(adblockerService.reload()).rejects.toThrow('offline');
      expect(adblockerService.blocker).toBe(a);
      expect(order).toEqual(['a:on']);
      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });

    test('an offline start blocks with the stale cache instead of turning blocking off', async () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      const fs = require('fs');
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const { BrowserWindow } = require('electron');
      BrowserWindow.getAllWindows.mockReturnValue([{ webContents: { session } }]);
      const stale = engine('stale', []);
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: 0 });
      fs.promises.readFile.mockResolvedValue(Buffer.from('cache'));
      ElectronBlocker.deserialize.mockResolvedValue(stale);
      ElectronBlocker.fromLists.mockRejectedValue(new Error('offline'));
      await expect(adblockerService.enable()).resolves.toBe(stale);
      expect(adblockerService.isEnabled).toBe(true);
      expect(stale.enableBlockingInSession).toHaveBeenCalledWith(session);
      err.mockRestore();
    });

    test('the hourly timer runs refresh and survives a failure', async () => {
      jest.useFakeTimers();
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const refresh = jest.spyOn(adblockerService, 'refresh').mockRejectedValue(new Error('offline'));
        adblockerService.setupAutoUpdate();
        jest.advanceTimersByTime(60 * 60 * 1000);
        await Promise.resolve();
        await Promise.resolve();
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(err).toHaveBeenCalledWith('Adblocker auto-update failed; the current lists stay active:', expect.any(Error));
        refresh.mockRestore();
      } finally {
        err.mockRestore();
        jest.useRealTimers();
      }
    });

    test('reload refetches and swaps engines without deleting the cache first', async () => {
      const fs = require('fs');
      const order = [];
      const a = engine('a', order);
      const b = engine('b', order);
      const ElectronBlocker = await startWith(a, fs);
      ElectronBlocker.fromLists.mockResolvedValueOnce(b);
      await adblockerService.reload();
      expect(order).toEqual(['a:on', 'a:off', 'b:on']);
      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });
  });

  describe('enableForSession error handling', () => {
    test('swallows enableBlockingInSession errors', () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      adblockerService.blocker = {
        enableBlockingInSession: () => { throw new Error('session gone'); },
      };
      expect(() => adblockerService.enableForSession(fakeSession())).not.toThrow();
      expect(err).toHaveBeenCalledWith('Adblocker: could not attach to a session:', 'session gone');
    });

    test('no-ops when session is falsy', () => {
      const spy = jest.fn();
      adblockerService.blocker = { enableBlockingInSession: spy };
      adblockerService.enableForSession(null);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('composed response listener and registered sessions', () => {
    const THIRD_PARTY = {
      url: 'https://ads.tracker.example/p.gif',
      resourceType: 'image',
      webContents: { isDestroyed: () => false, getType: () => 'webview', getURL: () => 'https://news.example/' },
      responseHeaders: { 'Set-Cookie': ['uid=1'], 'Content-Type': ['image/gif'] },
    };

    // Mirrors Ghostery's BlockingContext: enable installs the engine's own
    // onHeadersReceived listener, disable clears the slot.
    function ghosteryEngine(name, order = []) {
      const engine = {
        name,
        onHeadersReceived: jest.fn((details, cb) => cb({})),
        enableBlockingInSession: jest.fn((ses) => {
          order.push(`${name}:on:${ses.name}`);
          ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => engine.onHeadersReceived(d, cb));
        }),
        disableBlockingInSession: jest.fn((ses) => {
          order.push(`${name}:off:${ses.name}`);
          ses.webRequest.onHeadersReceived(null);
        }),
        serialize: jest.fn().mockResolvedValue(Buffer.from(name)),
      };
      return engine;
    }

    function blockThirdPartyCookies() {
      const privacy = require('../../../../main/services/BrowsingPrivacyService');
      const config = { get: (path, fallback) => (path === 'settings.blockThirdPartyCookies' ? true : fallback) };
      const unused = fakeSession('unused');
      unused.webRequest.onBeforeSendHeaders = jest.fn();
      privacy.initialize(config, { app: { on: jest.fn() }, session: { defaultSession: unused } });
    }

    function respond(ses) {
      let result;
      ses.headersListener({ ...THIRD_PARTY }, (r) => { result = r; });
      return result;
    }

    async function startWith(engine, windowSession) {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const { BrowserWindow } = require('electron');
      BrowserWindow.getAllWindows.mockReturnValue([{ webContents: { session: windowSession } }]);
      ElectronBlocker.fromLists.mockResolvedValueOnce(engine);
      await adblockerService.enable();
      return ElectronBlocker;
    }

    test('enable puts the composed listener back after the engine installs its own', async () => {
      blockThirdPartyCookies();
      const ses = fakeSession();
      const a = ghosteryEngine('a');
      await startWith(a, ses);
      expect(respond(ses)).toEqual({ responseHeaders: { 'Content-Type': ['image/gif'] } });
      expect(a.onHeadersReceived).toHaveBeenCalledTimes(1);
    });

    test('disable leaves a Set-Cookie-stripping listener that no longer calls the engine', async () => {
      blockThirdPartyCookies();
      const ses = fakeSession();
      const a = ghosteryEngine('a');
      await startWith(a, ses);
      adblockerService.disable();
      expect(ses.headersListener).toEqual(expect.any(Function));
      expect(respond(ses)).toEqual({ responseHeaders: { 'Content-Type': ['image/gif'] } });
      expect(a.onHeadersReceived).not.toHaveBeenCalled();
    });

    test('an engine swap routes responses through the new engine only', async () => {
      blockThirdPartyCookies();
      const ses = fakeSession();
      const a = ghosteryEngine('a');
      const b = ghosteryEngine('b');
      const ElectronBlocker = await startWith(a, ses);
      ElectronBlocker.fromLists.mockResolvedValueOnce(b);
      await adblockerService.reload();
      respond(ses);
      expect(b.onHeadersReceived).toHaveBeenCalledTimes(1);
      expect(a.onHeadersReceived).not.toHaveBeenCalled();
    });

    test('a session registered before blocking starts is blocked, swapped and detached with the windows', async () => {
      const order = [];
      const win = fakeSession('window');
      const priv = fakeSession('private');
      adblockerService.enableForSession(priv);
      expect(order).toEqual([]);
      const a = ghosteryEngine('a', order);
      const b = ghosteryEngine('b', order);
      const ElectronBlocker = await startWith(a, win);
      ElectronBlocker.fromLists.mockResolvedValueOnce(b);
      await adblockerService.reload();
      adblockerService.disable();
      expect(order).toEqual([
        'a:on:window', 'a:on:private',
        'a:off:window', 'a:off:private', 'b:on:window', 'b:on:private',
        'b:off:window', 'b:off:private',
      ]);
      expect(priv.headersListener).toEqual(expect.any(Function));
    });

    test('a session registered while blocking is attached at once; a missing session registers nothing', async () => {
      const order = [];
      const a = ghosteryEngine('a', order);
      await startWith(a, fakeSession('window'));
      adblockerService.enableForSession(null);
      adblockerService.enableForSession(fakeSession('private'));
      adblockerService.disable();
      expect(order).toEqual(['a:on:window', 'a:on:private', 'a:off:window', 'a:off:private']);
    });
  });
});
