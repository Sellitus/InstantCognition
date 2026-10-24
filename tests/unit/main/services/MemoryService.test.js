jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
}));

let memoryService;

beforeEach(() => {
  jest.resetModules();
  jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
  }));
  memoryService = require('../../../../main/services/MemoryService');
  memoryService.mainWindow = null;
  memoryService.cleanup();
});

afterEach(() => {
  memoryService.cleanup();
});

describe('MemoryService', () => {
  test('starts monitoring interval on start()', () => {
    const mockWindow = {
      webContents: {
        session: { clearCache: jest.fn(), cookies: { flushStore: jest.fn() } },
        send: jest.fn(),
      },
      isVisible: jest.fn(() => true),
    };

    memoryService.start(mockWindow);

    expect(memoryService.memoryInterval).not.toBeNull();
    expect(memoryService.cookieInterval).not.toBeNull();
  });

  test('stops intervals on cleanup()', () => {
    const mockWindow = {
      webContents: {
        session: { clearCache: jest.fn(), cookies: { flushStore: jest.fn() } },
        send: jest.fn(),
      },
      isVisible: jest.fn(() => true),
    };

    memoryService.start(mockWindow);
    memoryService.cleanup();

    expect(memoryService.memoryInterval).toBeNull();
    expect(memoryService.cookieInterval).toBeNull();
  });

  test('has correct threshold values', () => {
    expect(memoryService.MEMORY_THRESHOLD).toBe(800 * 1024 * 1024);
    expect(memoryService.CRITICAL_THRESHOLD).toBe(1200 * 1024 * 1024);
  });

  test('has correct interval values', () => {
    expect(memoryService.MEMORY_CHECK_INTERVAL).toBe(120000);
    expect(memoryService.COOKIE_FLUSH_INTERVAL).toBe(3600000);
  });

  test('cleanup is safe to call multiple times', () => {
    expect(() => {
      memoryService.cleanup();
      memoryService.cleanup();
    }).not.toThrow();
  });

  test('sets mainWindow reference on start', () => {
    const mockWindow = {
      webContents: {
        session: { clearCache: jest.fn(), cookies: { flushStore: jest.fn() } },
        send: jest.fn(),
      },
    };
    memoryService.start(mockWindow);
    expect(memoryService.mainWindow).toBe(mockWindow);
  });
});

// setInterval is stubbed per-test to return 1 without invoking the callback, so
// we capture the registered callbacks and drive them manually to exercise the
// monitoring/flush bodies and their branches.
describe('MemoryService — interval callbacks', () => {
  let intervals;
  let realSetInterval;
  beforeEach(() => {
    intervals = [];
    realSetInterval = global.setInterval;
    global.setInterval = jest.fn((cb, ms) => { intervals.push({ cb, ms }); return intervals.length; });
  });
  afterEach(() => {
    global.setInterval = realSetInterval;
  });

  function memCb() { return intervals.find((i) => i.ms === memoryService.MEMORY_CHECK_INTERVAL).cb; }
  function cookieCb() { return intervals.find((i) => i.ms === memoryService.COOKIE_FLUSH_INTERVAL).cb; }

  function makeWindow(extra = {}) {
    return {
      isDestroyed: jest.fn(() => false),
      webContents: {
        session: {
          clearCache: jest.fn(() => Promise.resolve()),
          clearStorageData: jest.fn(() => Promise.resolve()),
          cookies: { flushStore: jest.fn(() => Promise.resolve()) },
        },
        send: jest.fn(),
      },
      ...extra,
    };
  }

  test('memory monitor below threshold does not clear cache or storage', async () => {
    const win = makeWindow();
    jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 1 * 1024 * 1024 });
    memoryService.start(win);
    await memCb()();
    expect(win.webContents.session.clearCache).not.toHaveBeenCalled();
    expect(win.webContents.session.clearStorageData).not.toHaveBeenCalled();
    process.memoryUsage.mockRestore();
  });

  test('memory monitor above memory threshold clears cache only', async () => {
    const win = makeWindow();
    jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 900 * 1024 * 1024 });
    memoryService.start(win);
    await memCb()();
    expect(win.webContents.session.clearCache).toHaveBeenCalled();
    expect(win.webContents.session.clearStorageData).not.toHaveBeenCalled();
    process.memoryUsage.mockRestore();
  });

  test('memory monitor above critical threshold also clears storage data', async () => {
    const win = makeWindow();
    jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 1300 * 1024 * 1024 });
    memoryService.start(win);
    await memCb()();
    expect(win.webContents.session.clearCache).toHaveBeenCalled();
    // Service workers stay registered: deregistering one out from under an
    // already-loaded SPA breaks that tab until it is reloaded by hand.
    expect(win.webContents.session.clearStorageData).toHaveBeenCalledWith({
      storages: ['appcache', 'shadercache'],
    });
    process.memoryUsage.mockRestore();
  });

  test('memory monitor returns early when window is destroyed', async () => {
    const win = makeWindow({ isDestroyed: jest.fn(() => true) });
    jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 1300 * 1024 * 1024 });
    memoryService.start(win);
    await memCb()();
    expect(win.webContents.session.clearCache).not.toHaveBeenCalled();
    process.memoryUsage.mockRestore();
  });

  test('memory monitor returns early when there is no window', async () => {
    memoryService.start(makeWindow());
    memoryService.mainWindow = null;
    await expect(memCb()()).resolves.toBeUndefined();
  });

  test('memory monitor swallows clearCache failure but still continues', async () => {
    const win = makeWindow();
    win.webContents.session.clearCache = jest.fn(() => Promise.reject(new Error('cache boom')));
    jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 1300 * 1024 * 1024 });
    memoryService.start(win);
    await expect(memCb()()).resolves.toBeUndefined();
    // Cache failed, but the critical branch still cleared storage.
    expect(win.webContents.session.clearStorageData).toHaveBeenCalled();
    process.memoryUsage.mockRestore();
  });

  test('memory monitor swallows clearStorageData failure', async () => {
    const win = makeWindow();
    win.webContents.session.clearStorageData = jest.fn(() => Promise.reject(new Error('storage boom')));
    jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 1300 * 1024 * 1024 });
    memoryService.start(win);
    await expect(memCb()()).resolves.toBeUndefined();
    process.memoryUsage.mockRestore();
  });

  test('memory monitor invokes global.gc when present and above threshold', async () => {
    const win = makeWindow();
    const gc = jest.fn();
    global.gc = gc;
    jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 900 * 1024 * 1024 });
    memoryService.start(win);
    await memCb()();
    expect(gc).toHaveBeenCalled();
    delete global.gc;
    process.memoryUsage.mockRestore();
  });

  test('cookie flush calls flushStore when window is alive', async () => {
    const win = makeWindow();
    memoryService.start(win);
    await cookieCb()();
    expect(win.webContents.session.cookies.flushStore).toHaveBeenCalled();
  });

  test('cookie flush is skipped when window is destroyed', async () => {
    const win = makeWindow({ isDestroyed: jest.fn(() => true) });
    memoryService.start(win);
    await cookieCb()();
    expect(win.webContents.session.cookies.flushStore).not.toHaveBeenCalled();
  });

  test('cookie flush swallows flushStore errors', async () => {
    const win = makeWindow();
    win.webContents.session.cookies.flushStore = jest.fn(() => Promise.reject(new Error('flush boom')));
    memoryService.start(win);
    await expect(cookieCb()()).resolves.toBeUndefined();
  });
});

describe('MemoryService — config-driven thresholds', () => {
  function fakeCs(map) {
    return { get: (k, fb) => (map.has(k) ? map.get(k) : fb) };
  }

  test('uses static defaults when no config service is bound', () => {
    memoryService._configService = null;
    expect(memoryService._memoryThreshold()).toBe(memoryService.MEMORY_THRESHOLD);
    expect(memoryService._criticalThreshold()).toBe(memoryService.CRITICAL_THRESHOLD);
  });

  test('uses static defaults when config service lacks a get function', () => {
    memoryService.bindConfig({});
    expect(memoryService._memoryThreshold()).toBe(memoryService.MEMORY_THRESHOLD);
    expect(memoryService._criticalThreshold()).toBe(memoryService.CRITICAL_THRESHOLD);
  });

  test('honors a valid configured threshold (MB -> bytes, floored)', () => {
    const map = new Map([
      ['settings.memorySaverThresholdMB', 500.7],
      ['settings.memoryCriticalThresholdMB', 1000],
    ]);
    memoryService.bindConfig(fakeCs(map));
    expect(memoryService._memoryThreshold()).toBe(500 * 1024 * 1024);
    expect(memoryService._criticalThreshold()).toBe(1000 * 1024 * 1024);
  });

  test('falls back to static default for non-finite or non-positive config values', () => {
    const map = new Map([
      ['settings.memorySaverThresholdMB', 0],
      ['settings.memoryCriticalThresholdMB', NaN],
    ]);
    memoryService.bindConfig(fakeCs(map));
    expect(memoryService._memoryThreshold()).toBe(memoryService.MEMORY_THRESHOLD);
    expect(memoryService._criticalThreshold()).toBe(memoryService.CRITICAL_THRESHOLD);
  });
});
