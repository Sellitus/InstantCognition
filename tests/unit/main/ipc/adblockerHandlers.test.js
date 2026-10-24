// adblockerHandlers — IPC channels behind the v2 settings adblocker UI.

const mockOnHandlers = new Map();
const mockInvokeHandlers = new Map();

jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn((channel, fn) => { mockOnHandlers.set(channel, fn); }),
    handle: jest.fn((channel, fn) => { mockInvokeHandlers.set(channel, fn); }),
  },
}));

function fakeAdblocker(overrides = {}) {
  return {
    enable: jest.fn().mockResolvedValue({}),
    disable: jest.fn(),
    setupAutoUpdate: jest.fn(),
    reload: jest.fn().mockResolvedValue({}),
    validateBlocklistUrl: jest.fn().mockResolvedValue({ ok: true, filterCount: 12 }),
    getCatalog: jest.fn(() => [{ id: 'a', label: 'A', url: 'https://a/', defaultOn: true }]),
    getStats: jest.fn(() => ({ enabled: true, activeListCount: 1, filterCount: 100, lastReloadAt: 0 })),
    ...overrides,
  };
}

function loadHandlers(adblockerService) {
  mockOnHandlers.clear();
  mockInvokeHandlers.clear();
  jest.isolateModules(() => {
    const mod = require('../../../../main/ipc/adblockerHandlers');
    mod.register({ isDestroyed: () => false }, { adblockerService });
  });
}

describe('adblockerHandlers', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('no-op when adblockerService is missing', () => {
    expect(() => loadHandlers(null)).not.toThrow();
    expect(mockOnHandlers.size).toBe(0);
    expect(mockInvokeHandlers.size).toBe(0);
  });

  test('call-createAndUpdateaAblocker enables and starts auto-update', async () => {
    const ab = fakeAdblocker();
    loadHandlers(ab);
    mockOnHandlers.get('call-createAndUpdateaAblocker')({});
    await Promise.resolve();
    await Promise.resolve();
    expect(ab.enable).toHaveBeenCalled();
    expect(ab.setupAutoUpdate).toHaveBeenCalled();
  });

  test('call-disableAdblocker disables', () => {
    const ab = fakeAdblocker();
    loadHandlers(ab);
    mockOnHandlers.get('call-disableAdblocker')({});
    expect(ab.disable).toHaveBeenCalled();
  });

  test('adblocker:reload calls reload()', () => {
    const ab = fakeAdblocker();
    loadHandlers(ab);
    mockOnHandlers.get('adblocker:reload')({});
    expect(ab.reload).toHaveBeenCalled();
  });

  test('adblocker:reload swallows errors', () => {
    const ab = fakeAdblocker({ reload: jest.fn().mockRejectedValue(new Error('boom')) });
    loadHandlers(ab);
    expect(() => mockOnHandlers.get('adblocker:reload')({})).not.toThrow();
  });

  test('adblocker:validate returns the service result', async () => {
    const ab = fakeAdblocker();
    loadHandlers(ab);
    const r = await mockInvokeHandlers.get('adblocker:validate')({}, 'https://x.txt');
    expect(ab.validateBlocklistUrl).toHaveBeenCalledWith('https://x.txt');
    expect(r.ok).toBe(true);
  });

  test('adblocker:validate returns an error envelope on rejection', async () => {
    const ab = fakeAdblocker({ validateBlocklistUrl: jest.fn().mockRejectedValue(new Error('net')) });
    loadHandlers(ab);
    const r = await mockInvokeHandlers.get('adblocker:validate')({}, 'https://x.txt');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/net/);
  });

  test('adblocker:get-catalog forwards', async () => {
    const ab = fakeAdblocker();
    loadHandlers(ab);
    const cat = await mockInvokeHandlers.get('adblocker:get-catalog')({});
    expect(Array.isArray(cat)).toBe(true);
    expect(cat[0].id).toBe('a');
  });

  test('adblocker:get-catalog returns [] when service lacks getCatalog', async () => {
    const ab = fakeAdblocker({ getCatalog: undefined });
    loadHandlers(ab);
    const cat = await mockInvokeHandlers.get('adblocker:get-catalog')({});
    expect(cat).toEqual([]);
  });

  test('adblocker:get-stats returns shape', async () => {
    const ab = fakeAdblocker();
    loadHandlers(ab);
    const s = await mockInvokeHandlers.get('adblocker:get-stats')({});
    expect(s).toMatchObject({ enabled: true, activeListCount: 1, filterCount: 100 });
  });

  test('adblocker:get-stats returns disabled shape when service lacks getStats', async () => {
    const ab = fakeAdblocker({ getStats: undefined });
    loadHandlers(ab);
    const s = await mockInvokeHandlers.get('adblocker:get-stats')({});
    expect(s.enabled).toBe(false);
  });
});
