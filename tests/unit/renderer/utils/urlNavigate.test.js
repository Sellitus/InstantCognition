const { resolveNavigationUrl, buildEngineMap } = require('../../../../renderer/utils/urlNavigate');

describe('resolveNavigationUrl', () => {
  test('returns null for blank input', () => {
    expect(resolveNavigationUrl('   ')).toBeNull();
  });

  test('normalizes bare domains to https URLs', () => {
    expect(resolveNavigationUrl('example.com')).toBe('https://example.com');
    expect(resolveNavigationUrl('example.com/docs')).toBe('https://example.com/docs');
  });

  test('defaults bare localhost hosts to http, since local dev servers rarely serve TLS', () => {
    expect(resolveNavigationUrl('localhost')).toBe('http://localhost');
    expect(resolveNavigationUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(resolveNavigationUrl('localhost:3000/app')).toBe('http://localhost:3000/app');
  });

  test('defaults loopback and private IPv4 hosts to http', () => {
    expect(resolveNavigationUrl('127.0.0.1')).toBe('http://127.0.0.1');
    expect(resolveNavigationUrl('127.0.0.1:7860')).toBe('http://127.0.0.1:7860');
    expect(resolveNavigationUrl('192.168.1.25/admin')).toBe('http://192.168.1.25/admin');
    expect(resolveNavigationUrl('10.0.0.8:8080')).toBe('http://10.0.0.8:8080');
    expect(resolveNavigationUrl('172.20.1.1')).toBe('http://172.20.1.1');
  });

  test('local-network names and CGNAT addresses default to http', () => {
    expect(resolveNavigationUrl('printer.local')).toBe('http://printer.local');
    expect(resolveNavigationUrl('nas.lan/files')).toBe('http://nas.lan/files');
    expect(resolveNavigationUrl('hub.home.arpa:8123')).toBe('http://hub.home.arpa:8123');
    expect(resolveNavigationUrl('100.101.2.3')).toBe('http://100.101.2.3');
  });

  test('public IPv4 hosts and lookalike names still default to https', () => {
    expect(resolveNavigationUrl('8.8.8.8')).toBe('https://8.8.8.8');
    expect(resolveNavigationUrl('172.32.0.1')).toBe('https://172.32.0.1');
    expect(resolveNavigationUrl('localhost.evil.com')).toBe('https://localhost.evil.com');
  });

  test('preserves explicit http and https URLs', () => {
    expect(resolveNavigationUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(resolveNavigationUrl('https://example.com')).toBe('https://example.com');
  });

  test('falls back to a Google search for plain text', () => {
    expect(resolveNavigationUrl('best local llm ui')).toBe(
      'https://www.google.com/search?q=best%20local%20llm%20ui'
    );
  });

  test('uses the configured search engine for plain-text queries', () => {
    expect(resolveNavigationUrl('cats', 'duckduckgo')).toBe('https://duckduckgo.com/?q=cats');
    expect(resolveNavigationUrl('cats', 'brave')).toBe('https://search.brave.com/search?q=cats');
    expect(resolveNavigationUrl('cats', 'kagi')).toBe('https://kagi.com/search?q=cats');
  });

  test('unknown engine falls back to Google (backward compatible)', () => {
    expect(resolveNavigationUrl('cats', 'no-such-engine')).toBe('https://www.google.com/search?q=cats');
    expect(resolveNavigationUrl('cats')).toBe('https://www.google.com/search?q=cats');
  });

  test('engine does not affect URL inputs', () => {
    expect(resolveNavigationUrl('example.com', 'duckduckgo')).toBe('https://example.com');
  });

  describe('custom engines', () => {
    const custom = [
      { id: 'mysearch', name: 'My Search', url: 'https://s.example.com/q?term=%s' },
      { id: 'prefixy', name: 'Prefixy', url: 'https://p.example.com/find?x=' },
      { id: 'bad', name: 'Missing url' }, // malformed — must be ignored
    ];

    test('a custom engine with %s substitutes the encoded query', () => {
      expect(resolveNavigationUrl('local llm', 'mysearch', custom))
        .toBe('https://s.example.com/q?term=local%20llm');
    });

    test('a custom engine without %s appends the encoded query like the built-ins', () => {
      expect(resolveNavigationUrl('cats', 'prefixy', custom))
        .toBe('https://p.example.com/find?x=cats');
    });

    test('a custom engine overrides a built-in id of the same name', () => {
      const override = [{ id: 'google', name: 'Not Google', url: 'https://ng.example.com/?q=%s' }];
      expect(resolveNavigationUrl('cats', 'google', override)).toBe('https://ng.example.com/?q=cats');
    });

    test('malformed custom entries are skipped and the fallback still works', () => {
      expect(resolveNavigationUrl('cats', 'bad', custom)).toBe('https://www.google.com/search?q=cats');
    });

    test('buildEngineMap merges valid custom engines onto the built-ins', () => {
      const map = buildEngineMap(custom);
      expect(map.google).toBe('https://www.google.com/search?q=');
      expect(map.mysearch).toBe('https://s.example.com/q?term=%s');
      expect(map.bad).toBeUndefined();
    });
  });
});
