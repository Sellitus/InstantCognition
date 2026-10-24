// dnsHandlers — IPC channels behind the v2 settings DNS UI.

const mockOnHandlers = new Map();
const mockInvokeHandlers = new Map();

jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn((channel, fn) => { mockOnHandlers.set(channel, fn); }),
    handle: jest.fn((channel, fn) => { mockInvokeHandlers.set(channel, fn); }),
  },
}));

const fakeMainWindow = () => ({
  isDestroyed: () => false,
  webContents: { send: jest.fn() },
});

function loadHandlers(mainWindow, dnsService) {
  mockOnHandlers.clear();
  mockInvokeHandlers.clear();
  jest.isolateModules(() => {
    const mod = require('../../../../main/ipc/dnsHandlers');
    mod.register(mainWindow, { dnsService });
  });
}

describe('dnsHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does nothing if dnsService is missing', () => {
    expect(() => loadHandlers(fakeMainWindow(), null)).not.toThrow();
    expect(mockOnHandlers.size).toBe(0);
    expect(mockInvokeHandlers.size).toBe(0);
  });

  test('dns:apply calls applyFromConfig and broadcasts config:changed', () => {
    const dns = { applyFromConfig: jest.fn() };
    const mw = fakeMainWindow();
    loadHandlers(mw, dns);
    mockOnHandlers.get('dns:apply')({});
    expect(dns.applyFromConfig).toHaveBeenCalled();
    expect(mw.webContents.send).toHaveBeenCalledWith('config:changed', { kind: 'dns-applied' });
  });

  test('dns:apply swallows errors from applyFromConfig', () => {
    const dns = { applyFromConfig: jest.fn(() => { throw new Error('boom'); }) };
    loadHandlers(fakeMainWindow(), dns);
    expect(() => mockOnHandlers.get('dns:apply')({})).not.toThrow();
  });

  test('dns:validate forwards to dnsService.validateDohUrl', async () => {
    const dns = { validateDohUrl: jest.fn().mockResolvedValue({ ok: true }) };
    loadHandlers(fakeMainWindow(), dns);
    const r = await mockInvokeHandlers.get('dns:validate')({}, 'https://x/dns-query');
    expect(dns.validateDohUrl).toHaveBeenCalledWith('https://x/dns-query');
    expect(r.ok).toBe(true);
  });

  test('dns:validate returns error shape on rejection', async () => {
    const dns = { validateDohUrl: jest.fn().mockRejectedValue(new Error('nope')) };
    loadHandlers(fakeMainWindow(), dns);
    const r = await mockInvokeHandlers.get('dns:validate')({}, 'https://x/dns-query');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nope/);
  });

  
});
