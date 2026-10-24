// DnsService — configures Chromium's host resolver from user settings.
//
// Electron/Chromium only expose DoH and system DNS via app.configureHostResolver
// (electron.d.ts: ConfigureHostResolverOptions). DoT and plain-IP custom DNS
// servers are not supported by this API; the UI and config reflect that.
//
// Modes:
//   'system'    -> secureDnsMode='off', no servers (system resolver only)
//   'automatic' -> secureDnsMode='automatic' with the chosen DoH server template
//   'secure'    -> secureDnsMode='secure' with the chosen DoH server template

const { errMsg } = require('../../shared/errMsg');
//
// configureHostResolver throws if called before app.ready, so applyFromConfig
// is a no-op (with a warn) when called too early.

const PROVIDER_CATALOG = [
  { id: 'cloudflare', label: 'Cloudflare (1.1.1.1)', url: 'https://cloudflare-dns.com/dns-query{?dns}' },
  { id: 'google', label: 'Google (8.8.8.8)', url: 'https://dns.google/dns-query{?dns}' },
  { id: 'quad9', label: 'Quad9 (9.9.9.9)', url: 'https://dns.quad9.net/dns-query{?dns}' },
  { id: 'nextdns', label: 'NextDNS', url: 'https://dns.nextdns.io/dns-query{?dns}' },
  { id: 'adguard', label: 'AdGuard DNS', url: 'https://dns.adguard-dns.com/dns-query{?dns}' },
  { id: 'opendns', label: 'OpenDNS', url: 'https://doh.opendns.com/dns-query{?dns}' },
  { id: 'custom', label: 'Custom URL…', url: '' },
];

// Wire-format DNS query for example.com IN A. Used as the validation probe.
// Base64url of: 0000 0100 0001 0000 0000 0000 07 'example' 03 'com' 00 0001 0001
const DOH_PROBE_QUERY = 'AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE';

class DnsService {
  constructor() {
    this._configService = null;
    this._lastApplied = null;
  }

  bindConfig(configService) {
    this._configService = configService;
  }

  applyFromConfig() {
    if (!this._configService) return;
    const dns = this._configService.get('settings.dns', null) || {};
    return this.applyOptions({
      mode: dns.mode || 'system',
      provider: dns.provider || 'cloudflare',
      customUrl: dns.customUrl || '',
    });
  }

  /** @param {{ mode?: string, provider?: string, customUrl?: string }} [opts] */
  applyOptions({ mode, provider, customUrl } = {}) {
    let app;
    try { app = require('electron').app; } catch (_) { return; }
    if (!app || typeof app.configureHostResolver !== 'function') return;
    if (typeof app.isReady === 'function' && !app.isReady()) {
      console.warn('[dns] applyOptions called before app.ready — ignoring');
      return;
    }

    /** @type {import('electron').ConfigureHostResolverOptions} */
    const opts = { secureDnsMode: 'off', secureDnsServers: [] };
    if (mode === 'automatic' || mode === 'secure') {
      const url = this._resolveServerUrl(provider, customUrl);
      if (url) {
        opts.secureDnsMode = mode;
        opts.secureDnsServers = [url];
      } else if (mode === 'secure') {
        // DoH-only with no server URL would resolve NOTHING — every lookup
        // fails and the user can't load any sites. Downgrade to system DNS
        // and warn so the misconfiguration is loud, not silent.
        console.warn('[dns] secure mode requested but provider URL is empty — falling back to system DNS to keep page loads working. Pick a provider or set a custom DoH URL in Settings → DNS.');
      } else {
        // 'automatic' with no URL just means "system DNS" — silently fine.
      }
    }

    try {
      app.configureHostResolver(opts);
      this._lastApplied = { mode: opts.secureDnsMode, provider, customUrl, appliedAt: Date.now() };
    } catch (err) {
      console.error('[dns] configureHostResolver failed:', errMsg(err));
    }
  }

  _resolveServerUrl(provider, customUrl) {
    if (provider === 'custom') return (customUrl || '').trim();
    const entry = PROVIDER_CATALOG.find((p) => p.id === provider);
    return entry ? entry.url : '';
  }

  async validateDohUrl(url) {
    const trimmed = (url || '').trim();
    if (!trimmed) return { ok: false, error: 'URL is empty.' };
    let parsed;
    try { parsed = new URL(trimmed.replace(/\{\?dns\}$/, '')); }
    catch (_) { return { ok: false, error: 'Not a valid URL.' }; }
    if (parsed.protocol !== 'https:') return { ok: false, error: 'DoH requires https://.' };
    if (!parsed.pathname || parsed.pathname === '/') {
      return { ok: false, error: 'URL has no path — DoH endpoints always include one (usually /dns-query).' };
    }

    const probeUrl = `${parsed.origin}${parsed.pathname}?dns=${DOH_PROBE_QUERY}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(probeUrl, {
        method: 'GET',
        headers: { Accept: 'application/dns-message' },
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, error: `Server returned HTTP ${res.status}.` };
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/dns-message')) {
        return { ok: false, error: `Endpoint did not respond as DoH (content-type: ${ct || 'unknown'}).` };
      }
      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength < 12) return { ok: false, error: 'DoH response too short to be a DNS message.' };
      return { ok: true };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { ok: false, error: 'Timed out after 5s.' };
      return { ok: false, error: (err instanceof Error && err.message) || 'Network error.' };
    } finally {
      clearTimeout(timer);
    }
  }

  getLastApplied() { return this._lastApplied; }
}

const instance = new DnsService();
module.exports = instance;
module.exports.PROVIDER_CATALOG = PROVIDER_CATALOG;
