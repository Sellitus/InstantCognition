const {
  detectPrivateIpRange,
  matchedEnabledRange,
  stripIpv6Brackets,
} = require('../../../shared/privateIp');

describe('detectPrivateIpRange', () => {
  test('returns null for non-IP hostnames', () => {
    expect(detectPrivateIpRange('example.com')).toBeNull();
    expect(detectPrivateIpRange('')).toBeNull();
    expect(detectPrivateIpRange(null)).toBeNull();
    expect(detectPrivateIpRange('not-an-ip-at-all')).toBeNull();
  });

  describe('IPv4', () => {
    test('detects loopback 127.0.0.0/8', () => {
      expect(detectPrivateIpRange('127.0.0.1')).toBe('loopback');
      expect(detectPrivateIpRange('127.255.255.255')).toBe('loopback');
      expect(detectPrivateIpRange('127.10.20.30')).toBe('loopback');
    });

    test('detects RFC1918 10.0.0.0/8', () => {
      expect(detectPrivateIpRange('10.0.0.1')).toBe('rfc1918');
      expect(detectPrivateIpRange('10.255.255.255')).toBe('rfc1918');
    });

    test('detects RFC1918 172.16.0.0/12', () => {
      expect(detectPrivateIpRange('172.16.0.0')).toBe('rfc1918');
      expect(detectPrivateIpRange('172.20.5.5')).toBe('rfc1918');
      expect(detectPrivateIpRange('172.31.255.255')).toBe('rfc1918');
      // 172.32.0.0 is NOT in 172.16/12
      expect(detectPrivateIpRange('172.32.0.0')).toBeNull();
      // 172.15.255.255 is NOT in 172.16/12
      expect(detectPrivateIpRange('172.15.255.255')).toBeNull();
    });

    test('detects RFC1918 192.168.0.0/16', () => {
      expect(detectPrivateIpRange('192.168.0.1')).toBe('rfc1918');
      expect(detectPrivateIpRange('192.168.255.255')).toBe('rfc1918');
      expect(detectPrivateIpRange('192.169.0.0')).toBeNull();
    });

    test('detects link-local 169.254.0.0/16', () => {
      expect(detectPrivateIpRange('169.254.1.1')).toBe('linkLocal');
      expect(detectPrivateIpRange('169.253.1.1')).toBeNull();
    });

    test('detects CGNAT 100.64.0.0/10', () => {
      expect(detectPrivateIpRange('100.64.0.1')).toBe('cgnat');
      expect(detectPrivateIpRange('100.127.255.255')).toBe('cgnat');
      // 100.63 and 100.128 are NOT in CGNAT
      expect(detectPrivateIpRange('100.63.255.255')).toBeNull();
      expect(detectPrivateIpRange('100.128.0.0')).toBeNull();
    });

    test('returns null for public IPv4', () => {
      expect(detectPrivateIpRange('8.8.8.8')).toBeNull();
      expect(detectPrivateIpRange('1.1.1.1')).toBeNull();
      expect(detectPrivateIpRange('200.0.0.1')).toBeNull();
    });
  });

  describe('IPv6', () => {
    test('detects loopback ::1', () => {
      expect(detectPrivateIpRange('::1')).toBe('ipv6Loopback');
      expect(detectPrivateIpRange('[::1]')).toBe('ipv6Loopback');
    });

    test('detects ULA fc00::/7', () => {
      expect(detectPrivateIpRange('fc00::1')).toBe('ipv6Ula');
      expect(detectPrivateIpRange('fd12:3456::1')).toBe('ipv6Ula');
      expect(detectPrivateIpRange('[fd00::1]')).toBe('ipv6Ula');
    });

    test('detects link-local fe80::/10', () => {
      expect(detectPrivateIpRange('fe80::1')).toBe('ipv6LinkLocal');
      expect(detectPrivateIpRange('febf::1')).toBe('ipv6LinkLocal');
      // fec0:: is NOT link-local (deprecated site-local), don't match
      expect(detectPrivateIpRange('fec0::1')).toBeNull();
    });

    test('returns null for global IPv6', () => {
      expect(detectPrivateIpRange('2001:db8::1')).toBeNull();
      expect(detectPrivateIpRange('2606:4700::1')).toBeNull();
    });

    test('strips IPv6 zone identifiers', () => {
      expect(detectPrivateIpRange('fe80::1%eth0')).toBe('ipv6LinkLocal');
    });
  });
});

describe('matchedEnabledRange', () => {
  test('returns range name only when that range is enabled', () => {
    const ranges = { loopback: true, rfc1918: false, linkLocal: true };
    expect(matchedEnabledRange('127.0.0.1', ranges)).toBe('loopback');
    expect(matchedEnabledRange('10.0.0.1', ranges)).toBeNull();
    expect(matchedEnabledRange('169.254.1.1', ranges)).toBe('linkLocal');
    expect(matchedEnabledRange('8.8.8.8', ranges)).toBeNull();
  });

  test('returns null when ranges is missing or invalid', () => {
    expect(matchedEnabledRange('127.0.0.1', null)).toBeNull();
    expect(matchedEnabledRange('127.0.0.1', undefined)).toBeNull();
    expect(matchedEnabledRange('127.0.0.1', {})).toBeNull();
  });

  test('returns null for non-private hosts even with all ranges enabled', () => {
    const ranges = { loopback: true, rfc1918: true, linkLocal: true, cgnat: true };
    expect(matchedEnabledRange('example.com', ranges)).toBeNull();
    expect(matchedEnabledRange('8.8.8.8', ranges)).toBeNull();
  });
});

describe('stripIpv6Brackets', () => {
  test('removes wrapping brackets', () => {
    expect(stripIpv6Brackets('[::1]')).toBe('::1');
    expect(stripIpv6Brackets('::1')).toBe('::1');
  });

  test('strips zone identifier', () => {
    expect(stripIpv6Brackets('fe80::1%eth0')).toBe('fe80::1');
  });

  test('returns empty string for non-strings', () => {
    expect(stripIpv6Brackets(null)).toBe('');
    expect(stripIpv6Brackets(undefined)).toBe('');
  });
});
