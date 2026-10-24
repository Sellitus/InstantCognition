// Detects which "private" range a hostname falls into, used by
// CertificateService to auto-accept certs from LAN/loopback addresses
// when the user has opted into that range. Pure functions, no I/O.

const PRIVATE_IP_RANGES = ['loopback', 'rfc1918', 'linkLocal', 'cgnat', 'ipv6Loopback', 'ipv6Ula', 'ipv6LinkLocal'];

const RANGE_LABELS = {
  loopback: 'IPv4 loopback (127.0.0.0/8)',
  rfc1918: 'RFC1918 private (10/8, 172.16/12, 192.168/16)',
  linkLocal: 'IPv4 link-local (169.254.0.0/16)',
  cgnat: 'Carrier-grade NAT (100.64.0.0/10)',
  ipv6Loopback: 'IPv6 loopback (::1)',
  ipv6Ula: 'IPv6 unique local (fc00::/7)',
  ipv6LinkLocal: 'IPv6 link-local (fe80::/10)',
};

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const num = Number(p);
    if (num < 0 || num > 255) return null;
    n = (n * 256) + num;
  }
  return n >>> 0;
}

function stripIpv6Brackets(host) {
  if (typeof host !== 'string') return '';
  let h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // Strip zone id (e.g. fe80::1%eth0)
  const pct = h.indexOf('%');
  if (pct !== -1) h = h.slice(0, pct);
  return h;
}

// Returns one of PRIVATE_IP_RANGES or null. Does NOT consider whether the
// range is enabled — that's the caller's job.
function detectPrivateIpRange(rawHost) {
  if (!rawHost || typeof rawHost !== 'string') return null;
  const host = stripIpv6Brackets(rawHost);

  // IPv4 dotted quad
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    const n = ipv4ToInt(host);
    if (n === null) return null;
    // 127.0.0.0/8 — loopback
    if ((n >>> 24) === 127) return 'loopback';
    // 10.0.0.0/8
    if ((n >>> 24) === 10) return 'rfc1918';
    // 172.16.0.0/12 — top 12 bits = 0xAC1. Use `>>> 0` so the bitmask
    // result is treated as an unsigned 32-bit value (>= 0x80000000 would
    // otherwise compare as negative in JS).
    if (((n & 0xFFF00000) >>> 0) === 0xAC100000) return 'rfc1918';
    // 192.168.0.0/16
    if ((n >>> 16) === 0xC0A8) return 'rfc1918';
    // 169.254.0.0/16 — link-local
    if ((n >>> 16) === 0xA9FE) return 'linkLocal';
    // 100.64.0.0/10 — CGNAT
    if (((n & 0xFFC00000) >>> 0) === 0x64400000) return 'cgnat';
    return null;
  }

  // IPv6
  if (host.includes(':')) {
    const lower = host.toLowerCase();
    if (lower === '::1') return 'ipv6Loopback';
    // fe80::/10 — first 10 bits = 1111 1110 10
    // i.e. first hextet starts with fe8, fe9, fea, feb (10-bit prefix)
    if (/^fe[89ab][0-9a-f]?:/i.test(lower) || /^fe[89ab][0-9a-f]?$/i.test(lower.split(':')[0])) {
      const first = lower.split(':')[0];
      // first hextet must be fe80..febf
      const v = parseInt(first, 16);
      if (!Number.isNaN(v) && v >= 0xfe80 && v <= 0xfebf) return 'ipv6LinkLocal';
    }
    // fc00::/7 — first 7 bits = 1111 110, i.e. first byte = 0xFC or 0xFD
    const firstHex = lower.split(':')[0];
    if (/^f[cd][0-9a-f]{0,2}$/i.test(firstHex)) {
      const v = parseInt(firstHex.padEnd(4, '0'), 16);
      if (!Number.isNaN(v) && v >= 0xfc00 && v <= 0xfdff) return 'ipv6Ula';
    }
    return null;
  }

  return null;
}

// Given a host and a settings object like { loopback: true, rfc1918: false, ... },
// returns the matched range name if the host is in an enabled range, else null.
function matchedEnabledRange(host, enabledRanges) {
  if (!enabledRanges || typeof enabledRanges !== 'object') return null;
  const range = detectPrivateIpRange(host);
  if (!range) return null;
  return enabledRanges[range] ? range : null;
}

// Name suffixes that only resolve on a local network (RFC 6762, 8375, 6761, and
// the common router default ".lan").
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home.arpa', '.internal'];

// Hosts that rarely have certificates: loopback and private addresses,
// localhost, and intranet names (single-label or a local-only suffix).
function isLocalHost(rawHost) {
  const host = stripIpv6Brackets(rawHost).toLowerCase();
  if (!host) return false;
  if (detectPrivateIpRange(host)) return true;
  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return !host.includes('.') && !host.includes(':');
}

module.exports = {
  PRIVATE_IP_RANGES,
  RANGE_LABELS,
  detectPrivateIpRange,
  matchedEnabledRange,
  isLocalHost,
  ipv4ToInt,
  stripIpv6Brackets,
};
