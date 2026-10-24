const mockApp = {
  isReady: jest.fn(() => true),
  configureHostResolver: jest.fn(),
};

jest.mock('electron', () => ({
  app: mockApp,
}));

let dnsService;
let PROVIDER_CATALOG;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockApp.isReady = jest.fn(() => true);
  mockApp.configureHostResolver = jest.fn();
  jest.mock('electron', () => ({ app: mockApp }));

  dnsService = require('../../../../main/services/DnsService');
  PROVIDER_CATALOG = require('../../../../main/services/DnsService').PROVIDER_CATALOG;
});

describe('DnsService', () => {
  describe('PROVIDER_CATALOG', () => {
    test('exports a non-empty catalog', () => {
      expect(Array.isArray(PROVIDER_CATALOG)).toBe(true);
      expect(PROVIDER_CATALOG.length).toBeGreaterThan(0);
    });

    test('every entry has id, label, url', () => {
      for (const e of PROVIDER_CATALOG) {
        expect(typeof e.id).toBe('string');
        expect(typeof e.label).toBe('string');
        expect(typeof e.url).toBe('string');
      }
    });

    test('includes the well-known providers and a custom slot', () => {
      const ids = PROVIDER_CATALOG.map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining(['cloudflare', 'google', 'quad9', 'custom']));
    });
  });

  describe('applyOptions', () => {
    test('mode=system disables DoH (no servers)', () => {
      dnsService.applyOptions({ mode: 'system' });
      expect(mockApp.configureHostResolver).toHaveBeenCalledWith({
        secureDnsMode: 'off',
        secureDnsServers: [],
      });
    });

    test('mode=automatic with cloudflare picks the catalog URL', () => {
      dnsService.applyOptions({ mode: 'automatic', provider: 'cloudflare' });
      const call = mockApp.configureHostResolver.mock.calls[0][0];
      expect(call.secureDnsMode).toBe('automatic');
      expect(call.secureDnsServers[0]).toMatch(/cloudflare-dns\.com/);
    });

    test('mode=secure with quad9 picks the catalog URL', () => {
      dnsService.applyOptions({ mode: 'secure', provider: 'quad9' });
      const call = mockApp.configureHostResolver.mock.calls[0][0];
      expect(call.secureDnsMode).toBe('secure');
      expect(call.secureDnsServers[0]).toMatch(/quad9/);
    });

    test('provider=custom uses customUrl', () => {
      dnsService.applyOptions({
        mode: 'secure',
        provider: 'custom',
        customUrl: 'https://my.dns.example.com/dns-query',
      });
      const call = mockApp.configureHostResolver.mock.calls[0][0];
      expect(call.secureDnsServers[0]).toBe('https://my.dns.example.com/dns-query');
    });

    test('no-ops (with warn) before app.ready', () => {
      mockApp.isReady = jest.fn(() => false);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      dnsService.applyOptions({ mode: 'automatic', provider: 'cloudflare' });
      expect(mockApp.configureHostResolver).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    test('records last applied config on success', () => {
      dnsService.applyOptions({ mode: 'automatic', provider: 'google' });
      const last = dnsService.getLastApplied();
      expect(last).toMatchObject({ mode: 'automatic', provider: 'google' });
      expect(typeof last.appliedAt).toBe('number');
    });

    test('secure mode with an empty resolved URL downgrades to system DNS + warns', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      dnsService.applyOptions({ mode: 'secure', provider: 'custom', customUrl: '   ' });
      const call = mockApp.configureHostResolver.mock.calls[0][0];
      expect(call.secureDnsMode).toBe('off'); // not 'secure' — would resolve nothing
      expect(call.secureDnsServers).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to system DNS'));
      warn.mockRestore();
    });

    test('automatic mode with an empty resolved URL silently stays on system DNS', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      dnsService.applyOptions({ mode: 'automatic', provider: 'custom', customUrl: '' });
      const call = mockApp.configureHostResolver.mock.calls[0][0];
      expect(call.secureDnsMode).toBe('off');
      expect(call.secureDnsServers).toEqual([]);
      expect(warn).not.toHaveBeenCalled(); // automatic + no URL is fine, no warning
      warn.mockRestore();
    });

    test('an unknown provider resolves to an empty URL (catalog miss)', () => {
      dnsService.applyOptions({ mode: 'automatic', provider: 'not-a-provider' });
      const call = mockApp.configureHostResolver.mock.calls[0][0];
      expect(call.secureDnsMode).toBe('off');
    });

    test('a configureHostResolver throw is caught and logged (no crash)', () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockApp.configureHostResolver = jest.fn(() => { throw new Error('resolver exploded'); });
      dnsService.applyOptions({ mode: 'automatic', provider: 'google' });
      expect(errSpy).toHaveBeenCalledWith('[dns] configureHostResolver failed:', 'resolver exploded');
      expect(dnsService.getLastApplied()).toBeNull(); // not recorded on failure
      errSpy.mockRestore();
    });

    test('no-ops when app lacks configureHostResolver', () => {
      const noFnApp = { isReady: () => true };
      jest.resetModules();
      jest.doMock('electron', () => ({ app: noFnApp }));
      const freshDns = require('../../../../main/services/DnsService');
      expect(() => freshDns.applyOptions({ mode: 'automatic', provider: 'google' })).not.toThrow();
    });

    test('applyFromConfig defaults mode/provider when settings.dns is empty', () => {
      const cfg = { get: jest.fn((path, fb) => (path === 'settings.dns' ? null : fb)) };
      dnsService.bindConfig(cfg);
      dnsService.applyFromConfig();
      const call = mockApp.configureHostResolver.mock.calls[0][0];
      expect(call.secureDnsMode).toBe('off'); // default mode 'system'
    });
  });

  describe('applyFromConfig', () => {
    test('reads from the bound configService', () => {
      const cfg = {
        get: jest.fn((path, fb) => {
          if (path === 'settings.dns') return { mode: 'automatic', provider: 'google', customUrl: '' };
          return fb;
        }),
      };
      dnsService.bindConfig(cfg);
      dnsService.applyFromConfig();
      expect(cfg.get).toHaveBeenCalledWith('settings.dns', null);
      const call = mockApp.configureHostResolver.mock.calls[0][0];
      expect(call.secureDnsMode).toBe('automatic');
      expect(call.secureDnsServers[0]).toMatch(/dns\.google/);
    });

    test('no-ops without a bound config', () => {
      dnsService.bindConfig(null);
      dnsService.applyFromConfig();
      expect(mockApp.configureHostResolver).not.toHaveBeenCalled();
    });
  });

  describe('validateDohUrl', () => {
    test('rejects empty URL', async () => {
      const r = await dnsService.validateDohUrl('');
      expect(r.ok).toBe(false);
    });

    test('rejects http://', async () => {
      const r = await dnsService.validateDohUrl('http://example.com/dns-query');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/https/i);
    });

    test('rejects URL without a path', async () => {
      const r = await dnsService.validateDohUrl('https://example.com/');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/path/i);
    });

    test('accepts a working DoH endpoint', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'application/dns-message' : null },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
      });
      const r = await dnsService.validateDohUrl('https://dns.example.com/dns-query');
      expect(r.ok).toBe(true);
    });

    test('rejects an endpoint that returns non-DoH content-type', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
      });
      const r = await dnsService.validateDohUrl('https://dns.example.com/dns-query');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/DoH/i);
    });

    test('reports HTTP error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: { get: () => null },
      });
      const r = await dnsService.validateDohUrl('https://dns.example.com/dns-query');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/503/);
    });

    test('rejects a string that is not parseable as a URL', async () => {
      const r = await dnsService.validateDohUrl('::: not a url :::');
      expect(r).toEqual({ ok: false, error: 'Not a valid URL.' });
    });

    test('strips a trailing {?dns} template before parsing', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/dns-message' },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
      });
      const r = await dnsService.validateDohUrl('https://dns.example.com/dns-query{?dns}');
      expect(r.ok).toBe(true);
      // The probe URL must not contain the template literal.
      expect(global.fetch.mock.calls[0][0]).not.toMatch(/\{\?dns\}/);
    });

    test('maps an AbortError (timeout) to a 5s timeout message', async () => {
      global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      const r = await dnsService.validateDohUrl('https://dns.example.com/dns-query');
      expect(r).toEqual({ ok: false, error: 'Timed out after 5s.' });
    });

    test('maps a generic network failure to its message', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ENOTFOUND dns.example.com'));
      const r = await dnsService.validateDohUrl('https://dns.example.com/dns-query');
      expect(r).toEqual({ ok: false, error: 'ENOTFOUND dns.example.com' });
    });

    test('falls back to a generic message when the rejection has no message', async () => {
      global.fetch = jest.fn().mockRejectedValue({});
      const r = await dnsService.validateDohUrl('https://dns.example.com/dns-query');
      expect(r).toEqual({ ok: false, error: 'Network error.' });
    });

    test('rejects a DoH response that is too short to be a DNS message', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/dns-message' },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)), // < 12 bytes
      });
      const r = await dnsService.validateDohUrl('https://dns.example.com/dns-query');
      expect(r).toEqual({ ok: false, error: 'DoH response too short to be a DNS message.' });
    });

    test('reports unknown content-type when the header is missing', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null }, // no content-type
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
      });
      const r = await dnsService.validateDohUrl('https://dns.example.com/dns-query');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/content-type: unknown/);
    });
  });
});
