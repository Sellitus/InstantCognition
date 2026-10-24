const ruleMatch = require('../../../../../main/agent/permissions/ruleMatch');

const { parse, tryParse, compileList, matches, suggest, hostFor } = ruleMatch;
const m = (rule, name, facts, lenient) => matches(parse(rule), name, facts || {}, { lenient: !!lenient });
const deny = (rule, argv, platform) => matches(parse(rule), 'shell.run', { argv }, { lenient: true, platform });

describe('ruleMatch.parse', () => {
  test('splits tool and spec on the first colon and normalizes whitespace', () => {
    const r = parse('  shell.run:git  status ');
    expect(r.tool).toBe('shell.run');
    expect(r.spec).toBe('git  status');
    expect(r.tokens).toEqual(['git', 'status']);
    expect(parse('mcp.github.*').spec).toBeNull();
  });

  test.each([
    [42, 'not_a_string'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['fs.write:', 'empty_spec'],
    ['fs..write', 'tool_part'],
    ['fs/write', 'tool_part'],
    ['fs.write:/etc/**', 'path_spec_must_be_relative'],
    ['fs.write:../x', 'path_spec_must_be_relative'],
    ['fs.*:/etc/**', 'path_spec_must_be_relative'],
    ['fs.{read,list}:../secret/**', 'path_spec_must_be_relative'],
    ['**:/etc/passwd', 'path_spec_must_be_relative'],
    ['fs.*:a\\b', 'path_spec_must_be_relative'],
    ['agent.done:x', 'spec_not_supported'],
    ['shell.run:a\u0000b', 'control_char'],
    [`x${'a'.repeat(600)}`, 'too_long'],
  ])('rejects %p (%s)', (input, why) => {
    expect(() => parse(input)).toThrow(`invalid_rule:${why}`);
  });

  test('a tool glob that cannot reach an fs tool keeps its non-path spec', () => {
    expect(parse('shell.*:/usr/bin/sudo *').spec).toBe('/usr/bin/sudo *');
    expect(parse('browser.{navigate,open_tab}:evil.test').spec).toBe('evil.test');
    expect(parse('fs.*:secret/**').spec).toBe('secret/**');
  });

  test('tryParse and compileList report invalid entries instead of dropping them', () => {
    expect(tryParse('fs.write:/abs')).toEqual({ ok: false, error: 'invalid_rule:path_spec_must_be_relative' });
    const c = compileList(['fs.read', 7, 'shell.run:']);
    expect(c.rules.map((r) => r.raw)).toEqual(['fs.read']);
    expect(c.invalid.map((x) => x.rule)).toEqual(['7', 'shell.run:']);
  });
});

describe('ruleMatch tool part', () => {
  test('* stays inside one dot segment; ** spans segments', () => {
    expect(m('mcp.github.*', 'mcp.github.create_issue')).toBe(true);
    expect(m('mcp.*', 'mcp.github.create_issue')).toBe(false);
    expect(m('mcp.**', 'mcp.github.create_issue')).toBe(true);
    expect(m('fs.*', 'fs.write')).toBe(true);
    expect(m('fs.*', 'fsx.write')).toBe(false);
    expect(m('fs.{read,list}', 'fs.list')).toBe(true);
    expect(m('fs.{read,list}', 'fs.write')).toBe(false);
  });

  test('! is literal, never a negation', () => {
    expect(m('!fs.write', 'fs.read')).toBe(false);
  });
});

describe('ruleMatch shell.run argv spec', () => {
  test('strict: exact length unless the last token is a lone *', () => {
    expect(m('shell.run:git status', 'shell.run', { argv: ['git', 'status'] })).toBe(true);
    expect(m('shell.run:git status', 'shell.run', { argv: ['git', 'status', '--short'] })).toBe(false);
    expect(m('shell.run:git *', 'shell.run', { argv: ['git'] })).toBe(true);
    expect(m('shell.run:git *', 'shell.run', { argv: ['git', 'push', '--force'] })).toBe(true);
    expect(m('shell.run:git push*', 'shell.run', { argv: ['git', 'push-all'] })).toBe(true);
    expect(m('shell.run:git push*', 'shell.run', { argv: ['git', 'push', '--force'] })).toBe(false);
  });

  test('never matches a joined string: one argv element holding "git status" is not two tokens (strict)', () => {
    expect(m('shell.run:git status', 'shell.run', { argv: ['git status'] })).toBe(false);
  });

  test('strict allow rules do not match by basename (a workspace ./git is not git)', () => {
    expect(m('shell.run:git status', 'shell.run', { argv: ['./git', 'status'] })).toBe(false);
  });

  test('lenient (deny/ask) catches wrappers, absolute paths and sh -c strings', () => {
    expect(m('shell.run:sudo *', 'shell.run', { argv: ['/usr/bin/sudo', 'ls'] }, true)).toBe(true);
    expect(m('shell.run:sudo *', 'shell.run', { argv: ['env', 'sudo', 'ls'] }, true)).toBe(true);
    expect(m('shell.run:git push', 'shell.run', { argv: ['sh', '-c', 'git push --force'] }, true)).toBe(true);
    expect(m('shell.run:sudo *', 'shell.run', { argv: ['ls', '-la'] }, true)).toBe(false);
  });

  test('lenient: the command name ignores case on case-insensitive platforms only', () => {
    expect(deny('shell.run:sudo *', ['SUDO', 'rm', '-rf', '/'], 'darwin')).toBe(true);
    expect(deny('shell.run:sudo *', ['/usr/bin/Sudo', 'ls'], 'win32')).toBe(true);
    expect(deny('shell.run:sudo *', ['SUDO', 'rm'], 'linux')).toBe(false);
    expect(deny('shell.run:rm -rf *', ['rm', '-RF', '/'], 'darwin')).toBe(false);
  });

  test('lenient: shell payloads are split on command separators and substitutions', () => {
    expect(deny('shell.run:sudo *', ['sh', '-c', 'x;sudo y'], 'linux')).toBe(true);
    expect(deny('shell.run:sudo *', ['bash', '-c', 'echo $(sudo y)'], 'linux')).toBe(true);
    expect(deny('shell.run:sudo *', ['zsh', '-c', 'true&&sudo y'], 'linux')).toBe(true);
    expect(deny('shell.run:sudo *', ['sh', '-c', 'echo `sudo y`'], 'linux')).toBe(true);
    expect(deny('shell.run:sudo *', ['sh', '-c', 'true|sudo y'], 'linux')).toBe(true);
    expect(deny('shell.run:sudo *', ['sh', '-c', 'true\nsudo y'], 'linux')).toBe(true);
    expect(deny('shell.run:sudo *', ['sh', '-c', "'sudo' y"], 'linux')).toBe(true);
    expect(deny('shell.run:sudo *', ['sh', '-c', 's""udo y'], 'linux')).toBe(true);
    expect(deny('shell.run:sudo *', ['cmd', '/c', 'dir&SUDO y'], 'win32')).toBe(true);
    expect(deny('shell.run:sudo *', ['sh', '-c', 'echo pseudo;ls'], 'linux')).toBe(false);
  });

  test('strict allow rules stay case- and split-exact', () => {
    expect(m('shell.run:git status', 'shell.run', { argv: ['GIT', 'status'] })).toBe(false);
    expect(m('shell.run:sh *', 'shell.run', { argv: ['sh', '-c', 'x;sudo y'] })).toBe(true);
  });

  test('argv facts that are missing or malformed never match', () => {
    expect(m('shell.run:*', 'shell.run', { argv: null })).toBe(false);
    expect(m('shell.run:git *', 'shell.run', { argv: ['git', 3] })).toBe(false);
    expect(m('shell.run', 'shell.run', {})).toBe(true);
  });
});

describe('ruleMatch fs path and browser host specs', () => {
  test('path globs are workspace-relative and include dot files', () => {
    expect(m('fs.write:src/**', 'fs.write', { path: 'src/a/b.js' })).toBe(true);
    expect(m('fs.write:src/**', 'fs.write', { path: 'lib/a.js' })).toBe(false);
    expect(m('fs.write:**/.env', 'fs.write', { path: 'a/.env' })).toBe(true);
    expect(m('fs.write:src/**', 'fs.write', {})).toBe(false);
  });

  test('lenient path matching ignores case (case-insensitive volumes)', () => {
    expect(m('fs.write:secrets/**', 'fs.write', { path: 'SECRETS/k' })).toBe(false);
    expect(m('fs.write:secrets/**', 'fs.write', { path: 'SECRETS/k' }, true)).toBe(true);
  });

  test('host globs match hostname; lenient literal hosts cover subdomains', () => {
    expect(m('browser.navigate:*.github.com', 'browser.navigate', { host: 'api.github.com' })).toBe(true);
    expect(m('browser.navigate:github.com', 'browser.navigate', { host: 'gist.github.com' })).toBe(false);
    expect(m('browser.navigate:github.com', 'browser.navigate', { host: 'gist.github.com' }, true)).toBe(true);
    expect(m('browser.navigate:github.com', 'browser.navigate', { host: 'evilgithub.com' }, true)).toBe(false);
  });

  test('hostFor prefers args.url, falls back to the page, ignores non-http', () => {
    expect(hostFor({ url: 'https://A.example.com:8443/x' }, 'https://page.com')).toBe('a.example.com');
    expect(hostFor({}, 'https://page.com/x')).toBe('page.com');
    expect(hostFor({ url: 'about:blank' }, 'not a url')).toBe('');
    expect(hostFor({ url: 'https://Evil.Test.:8443/' }, '')).toBe('evil.test');
  });

  test('a trailing-dot host still meets a lenient host deny', () => {
    const host = hostFor({ url: 'https://evil.test./' }, '');
    expect(m('browser.navigate:evil.test', 'browser.navigate', { host }, true)).toBe(true);
  });
});

describe('ruleMatch.suggest', () => {
  test('mcp tools suggest the exact tool, never the whole server', () => {
    expect(suggest('mcp.github.create_issue', {})).toBe('mcp.github.create_issue');
    expect(matches(parse(suggest('mcp.github.create_issue', {})), 'mcp.github.delete_repo', {}, { lenient: false })).toBe(false);
  });

  test('shell suggests only an exact, fully plain argv', () => {
    expect(suggest('shell.run', { argv: ['git', 'status'] })).toBe('shell.run:git status');
    expect(suggest('shell.run', { argv: ['git', 'commit', '-m', 'fix bug'] })).toBeNull();
    expect(suggest('shell.run', { argv: ['python3', '-c', 'print(1)'] })).toBeNull();
    expect(suggest('shell.run', { argv: ['rm', '-rf', '*'] })).toBeNull();
    expect(suggest('shell.run', { argv: ['rm', '*.js'] })).toBeNull();
    expect(suggest('shell.run', { argv: ['my tool'] })).toBeNull();
  });

  test('a browser call without a host suggests nothing', () => {
    expect(suggest('browser.close_tab', { host: '' })).toBeNull();
    expect(suggest('browser.close_tab', {})).toBeNull();
    expect(suggest('browser.close_tab', { host: 'example.com' })).toBe('browser.close_tab:example.com');
  });

  test('fs suggests the parent directory, or the file at the root', () => {
    expect(suggest('fs.write', { path: 'src/a/b.js' })).toBe('fs.write:src/a/**');
    expect(suggest('fs.write', { path: 'README.md' })).toBe('fs.write:README.md');
    expect(suggest('fs.write', { path: 'dir with space/x' })).toBeNull();
  });

  test('every suggestion round-trips through parse and matches its own call', () => {
    const cases = [
      ['shell.run', { argv: ['git', 'status'] }],
      ['shell.run', { argv: ['npm', 'run', 'build'] }],
      ['fs.edit', { path: 'src/x.js' }],
      ['browser.click', { host: 'example.com' }],
      ['mcp.fs.read', {}],
    ];
    for (const [name, facts] of cases) {
      const rule = suggest(name, facts);
      expect(rule).toEqual(expect.any(String));
      expect(matches(parse(rule), name, facts, { lenient: false })).toBe(true);
    }
  });
});
