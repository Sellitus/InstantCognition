const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_LLM_SETTINGS } = require('../../../../../shared/llmDefaults');
const { resolveInside, isProtected, resolveRoot, assertDirInside, compileGlob } = require('../../../../../main/agent/workspace/pathGuard');

let base, root, outside;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pathguard-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
});

afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('resolveInside', () => {
  test('resolves a nested relative path and returns a POSIX rel', () => {
    const r = resolveInside(root, 'src/a.js');
    expect(r).toEqual({ root, abs: path.join(root, 'src', 'a.js'), rel: 'src/a.js' });
    expect(resolveInside(root, '.').rel).toBe('.');
  });

  test('accepts a not-yet-existing file for writes', () => {
    expect(resolveInside(root, 'new/dir/file.txt', { forWrite: true }).rel).toBe('new/dir/file.txt');
  });

  test.each(['..', '../outside/secret.txt', 'src/../../outside', '/etc/passwd'])('rejects escape %p', (rel) => {
    expect(() => resolveInside(root, rel)).toThrow('path_outside_workspace');
  });

  test.each([['a\u0000b'], [''], [undefined], [42]])('rejects invalid path %p', (rel) => {
    expect(() => resolveInside(root, rel)).toThrow('invalid_path');
  });

  test('rejects a symlinked directory that escapes the root, for read AND write', () => {
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    expect(() => resolveInside(root, 'link/secret.txt')).toThrow('path_outside_workspace');
    expect(() => resolveInside(root, 'link/new.txt', { forWrite: true })).toThrow('path_outside_workspace');
    expect(() => resolveInside(root, 'link')).toThrow('path_outside_workspace');
  });

  test('rejects a symlinked file that escapes the root', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
    expect(() => resolveInside(root, 'leak.txt')).toThrow('path_outside_workspace');
  });

  test('a dangling symlink is unresolvable (its target could be created anywhere)', () => {
    fs.symlinkSync(path.join(outside, 'gone', 'x'), path.join(root, 'dangling'));
    expect(() => resolveInside(root, 'dangling', { forWrite: true })).toThrow('path_unresolvable');
    expect(() => resolveInside(root, 'dangling/child', { forWrite: true })).toThrow('path_unresolvable');
  });

  test('an in-root symlink is readable but never a write target', () => {
    fs.symlinkSync(path.join(root, 'src', 'a.js'), path.join(root, 'alias.js'));
    expect(resolveInside(root, 'alias.js').rel).toBe('src/a.js');
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'srclink'), 'dir');
    expect(() => resolveInside(root, 'srclink', { forWrite: true })).toThrow('symlink_target');
  });

  test('a symlink loop is path_unresolvable, not a raw ELOOP', () => {
    fs.symlinkSync('loop.md', path.join(root, 'loop.md'));
    expect(() => resolveInside(root, 'loop.md')).toThrow(/^path_unresolvable$/);
    expect(() => resolveInside(root, 'loop.md/child', { forWrite: true })).toThrow(/^path_unresolvable$/);
  });

  test('a directory without search permission is path_unresolvable', () => {
    fs.mkdirSync(path.join(root, 'locked'));
    fs.writeFileSync(path.join(root, 'locked', 'f.txt'), 'x');
    fs.chmodSync(path.join(root, 'locked'), 0o000);
    try {
      expect(() => resolveInside(root, 'locked/f.txt')).toThrow(/^path_unresolvable$/);
      expect(resolveInside(root, 'src/a.js').rel).toBe('src/a.js');
    } finally { fs.chmodSync(path.join(root, 'locked'), 0o755); }
  });

  test('a root that does not exist or is not absolute is rejected', () => {
    expect(() => resolveInside(path.join(base, 'missing'), 'a')).toThrow('workspace_root_missing');
    expect(() => resolveInside('relative/root', 'a')).toThrow('workspace_root_missing');
  });
});

describe('isProtected', () => {
  const globs = ['.git/**', '**/.env', '**/.env.*'];

  test('matches the shipped protected globs including nested and case variants', () => {
    expect(isProtected('.env', globs)).toBe(true);
    expect(isProtected('pkg/.env.local', globs)).toBe(true);
    expect(isProtected('.git/config', globs)).toBe(true);
    expect(isProtected('.ENV', globs)).toBe(true);
  });

  test('the shipped defaults protect nested repositories too, not just the root .git', () => {
    const shipped = DEFAULT_LLM_SETTINGS.agent.workspace.protectedGlobs;
    expect(isProtected('sub/.git/hooks/pre-commit', shipped)).toBe(true);
    expect(isProtected('a/b/.git/config', shipped)).toBe(true);
    expect(isProtected('.git/hooks/pre-commit', shipped)).toBe(true);
    expect(isProtected('vendor/lib/.git', shipped)).toBe(true);
    expect(isProtected('.github/workflows/ci.yml', shipped)).toBe(false);
    expect(isProtected('src/git/hooks.js', shipped)).toBe(false);
    expect(isProtected('pkg/.env.local', shipped)).toBe(true);
  });

  test('does not match ordinary files and ignores negation patterns', () => {
    expect(isProtected('src/env.js', globs)).toBe(false);
    expect(isProtected('.envrc', globs)).toBe(false);
    expect(isProtected('src/a.js', ['!src/a.js'])).toBe(false);
    expect(isProtected('a', [])).toBe(false);
  });
});

describe('compileGlob', () => {
  const matches = (glob, paths, opts) => compileGlob(glob, opts)(paths, 1000);

  test('ordinary globs match like picomatch', () => {
    expect(matches('**/*.js', ['a.js', 'src/b.js', 'src/b.ts', '.hidden/c.js'], { dot: true })).toEqual([true, true, false, true]);
    expect(matches('src/{a,b}/*.ts', ['src/a/x.ts', 'src/b/y.ts', 'src/c/z.ts', 'src/a/x.js'])).toEqual([true, true, false, false]);
    expect(matches('*.MD', ['readme.md'], { nocase: true })).toEqual([true]);
    expect(matches('*.MD', ['readme.md'])).toEqual([false]);
  });

  test('negation is literal, never an inverted match', () => {
    expect(matches('!a.js', ['a.js', 'b.js'])).toEqual([false, false]);
  });

  test.each([
    ['*a*a*a*a*a*a*a*ab'],
    [`src/${'*x'.repeat(7)}/y.js`],
    ['a'.repeat(257)],
  ])('%p is refused as glob_too_complex', (glob) => {
    expect(() => compileGlob(glob)).toThrow(/^glob_too_complex$/);
  });

  test('six stars per segment across several segments is still accepted', () => {
    const glob = `${'*a'.repeat(6)}/${'*b'.repeat(6)}`;
    expect(matches(glob, ['aaaaaa/bbbbbb', 'x/y'])).toEqual([true, false]);
  });

  test('a match that backtracks past the timeout fails as glob_timeout instead of blocking', () => {
    const match = compileGlob(`${'*a'.repeat(6)}b`);
    const started = Date.now();
    expect(() => match(['a'.repeat(250)], 50)).toThrow(/^glob_timeout$/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('empty and non-string globs are invalid_glob', () => {
    expect(() => compileGlob('')).toThrow(/^invalid_glob$/);
    expect(() => compileGlob(/** @type {any} */ (3))).toThrow(/^invalid_glob$/);
  });
});

describe('resolveRoot and assertDirInside', () => {
  test('selects by index, path or basename; defaults to the first', () => {
    const roots = ['/w/one', '/w/two'];
    expect(resolveRoot(roots)).toBe('/w/one');
    expect(resolveRoot(roots, 1)).toBe('/w/two');
    expect(resolveRoot(roots, '/w/two')).toBe('/w/two');
    expect(resolveRoot(roots, 'two')).toBe('/w/two');
  });

  test('errors on no roots and unknown selectors', () => {
    expect(() => resolveRoot([], undefined)).toThrow('no_workspace_root');
    expect(() => resolveRoot(['/w/one'], 5)).toThrow('unknown_workspace_root');
    expect(() => resolveRoot(['/w/one'], '/elsewhere')).toThrow('unknown_workspace_root');
  });

  test('assertDirInside catches a directory swapped for an escaping symlink', () => {
    expect(assertDirInside(root, path.join(root, 'src'))).toBe(path.join(root, 'src'));
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'src'), 'dir');
    expect(() => assertDirInside(root, path.join(root, 'src'))).toThrow('path_outside_workspace');
  });
});
