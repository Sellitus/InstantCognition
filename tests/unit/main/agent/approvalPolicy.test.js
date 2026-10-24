const {
  hostOf, hostMatches, destinationUrl, destinationUrls, egressVerdict, originOf,
} = require('../../../../main/agent/approvalPolicy');

describe('approvalPolicy.hostOf', () => {
  test('lowercases http(s) host, ignores path/port-less', () => {
    expect(hostOf('https://Docs.Python.org/3/')).toBe('docs.python.org');
    expect(hostOf('http://example.com:8080/x?y')).toBe('example.com');
  });
  test('drops the port and a trailing root dot so a host has one spelling', () => {
    expect(hostOf('https://evil.test:8443/')).toBe('evil.test');
    expect(hostOf('https://Evil.Test./')).toBe('evil.test');
    expect(hostOf('https://a.evil.test.:444/x')).toBe('a.evil.test');
  });
  test('non-http(s) and unparseable URLs have no host (never gated)', () => {
    expect(hostOf('about:blank')).toBe('');
    expect(hostOf('ic://llm-chat/')).toBe('');
    expect(hostOf('data:text/html,hi')).toBe('');
    expect(hostOf('not a url')).toBe('');
    expect(hostOf(null)).toBe('');
  });
});

describe('approvalPolicy.originOf', () => {
  test('keeps the port but drops a trailing root dot', () => {
    expect(originOf('https://evil.test./x')).toBe('https://evil.test');
    expect(originOf('https://Evil.test:8443/x')).toBe('https://evil.test:8443');
    expect(originOf('https://evil.test:443/x')).toBe('https://evil.test');
  });
  test('a url without a host has no origin', () => {
    expect(originOf('about:blank')).toBe('');
    expect(originOf('not a url')).toBe('');
  });
});

describe('approvalPolicy.hostMatches', () => {
  test('a pattern covers the exact host and every subdomain', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('a.b.example.com', 'example.com')).toBe(true);
    expect(hostMatches('notexample.com', 'example.com')).toBe(false);
    expect(hostMatches('example.com.evil.com', 'example.com')).toBe(false);
  });
  test('normalizes scheme, leading *., path and dots in the pattern', () => {
    expect(hostMatches('docs.python.org', 'https://python.org/3/')).toBe(true);
    expect(hostMatches('cdn.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '.example.com')).toBe(true);
    expect(hostMatches('good.test', 'good.test:8443')).toBe(true);
    expect(hostMatches('good.test', 'good.test.')).toBe(true);
  });
  test('empty host or pattern never matches', () => {
    expect(hostMatches('', 'example.com')).toBe(false);
    expect(hostMatches('example.com', '')).toBe(false);
    expect(hostMatches('example.com', '   ')).toBe(false);
  });
});

describe('approvalPolicy.destinationUrl', () => {
  test('returns the chosen url for navigate/open_tab only', () => {
    expect(destinationUrl({ name: 'browser.navigate', args: { url: 'https://x.com' } })).toBe('https://x.com');
    expect(destinationUrl({ name: 'browser.open_tab', args: { url: 'https://y.com' } })).toBe('https://y.com');
  });
  test('duplicate/fork/click and missing-url calls are not gated', () => {
    expect(destinationUrl({ name: 'browser.duplicate_tab', args: { spaceId: 's' } })).toBe('');
    expect(destinationUrl({ name: 'browser.click_idx', args: { idx: 1 } })).toBe('');
    expect(destinationUrl({ name: 'browser.navigate', args: {} })).toBe('');
    expect(destinationUrl(null)).toBe('');
  });
});

describe('approvalPolicy.destinationUrls', () => {
  test('lists every research source url, the single url for navigate/open_tab', () => {
    const sources = [{ url: 'https://a.test/1' }, { url: 'https://b.test/2', title: 'B' }, { title: 'no url' }, { url: 7 }];
    expect(destinationUrls({ name: 'browser.open_research_sources', args: { sources } })).toEqual(['https://a.test/1', 'https://b.test/2']);
    expect(destinationUrls({ name: 'browser.navigate', args: { url: 'https://x.com' } })).toEqual(['https://x.com']);
  });
  test('tools without a chosen destination list none', () => {
    expect(destinationUrls({ name: 'browser.open_research_sources', args: { sources: 'https://a.test' } })).toEqual([]);
    expect(destinationUrls({ name: 'browser.click_idx', args: { url: 'https://x.com' } })).toEqual([]);
    expect(destinationUrls(null)).toEqual([]);
  });
});

describe('approvalPolicy.egressVerdict', () => {
  test('null policy or non-web destination is always allowed', () => {
    expect(egressVerdict('https://x.com', null)).toBe('allow');
    expect(egressVerdict('ic://llm-chat/', { mode: 'allowlist', allow: [] })).toBe('allow');
  });

  test('block list is honored in every mode (hard deny)', () => {
    const eg = { mode: 'open', allow: [], block: ['ads.example.com'] };
    expect(egressVerdict('https://ads.example.com/x', eg)).toBe('block');
    expect(egressVerdict('https://safe.com/x', eg)).toBe('allow');
    expect(egressVerdict('https://ads.example.com', { mode: 'allowlist', allow: ['ads.example.com'], block: ['ads.example.com'] })).toBe('block');
  });

  test('a port or trailing dot does not dodge the block list', () => {
    const eg = { mode: 'open', allow: [], block: ['evil.test'] };
    expect(egressVerdict('https://evil.test:8443/', eg)).toBe('block');
    expect(egressVerdict('https://a.evil.test:444/', eg)).toBe('block');
    expect(egressVerdict('https://evil.test./', eg)).toBe('block');
    expect(egressVerdict('https://notevil.test:8443/', eg)).toBe('allow');
  });

  test('an allowlisted host on a non-default port is listed', () => {
    const eg = { mode: 'allowlist', allow: ['good.test'], block: [] };
    expect(egressVerdict('https://good.test:8443/', eg)).toBe('allow');
    expect(egressVerdict('https://other.test:8443/', eg)).toBe('unlisted');
  });

  test('allowlist: only listed domains (and their subdomains) pass', () => {
    const eg = { mode: 'allowlist', allow: ['python.org', 'github.com'], block: [] };
    expect(egressVerdict('https://docs.python.org/3/', eg)).toBe('allow');
    expect(egressVerdict('https://github.com/x', eg)).toBe('allow');
    expect(egressVerdict('https://evil.com/x', eg)).toBe('unlisted');
  });

  test('blocklist / open: everything not blocked passes', () => {
    expect(egressVerdict('https://anywhere.com', { mode: 'blocklist', allow: [], block: ['bad.com'] })).toBe('allow');
    expect(egressVerdict('https://bad.com', { mode: 'blocklist', allow: [], block: ['bad.com'] })).toBe('block');
    expect(egressVerdict('https://anywhere.com', { mode: 'open', allow: [], block: [] })).toBe('allow');
  });
});
