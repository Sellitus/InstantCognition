const fs = require('fs');
const os = require('os');
const path = require('path');
const fsTools = require('../../../../../main/agent/tools/fsTools');

const tool = (name) => fsTools.find((t) => t.name === name);
const run = (name, args, extra) => tool(name).handler(args, { agentSettings: settings, ...(extra || {}) }, {});

let base, root, outside, settings;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-fstools-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  settings = { workspace: { roots: [root], maxReadBytes: 1 << 20, maxWriteBytes: 1 << 20 } };
});

afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('confinement', () => {
  test('a symlinked directory escaping the root is rejected for read AND write', async () => {
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    expect(await run('fs.read', { path: 'link/secret.txt' })).toEqual({ ok: false, error: 'path_outside_workspace' });
    expect(await run('fs.write', { path: 'link/pwned.txt', content: 'x' })).toEqual({ ok: false, error: 'path_outside_workspace' });
    expect(fs.existsSync(path.join(outside, 'pwned.txt'))).toBe(false);
  });

  test.each(['../outside/secret.txt', 'src/../../outside/secret.txt'])('".." escape %p is rejected', async (p) => {
    expect(await run('fs.read', { path: p })).toEqual({ ok: false, error: 'path_outside_workspace' });
    expect(await run('fs.write', { path: p, content: 'x' })).toEqual({ ok: false, error: 'path_outside_workspace' });
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  test('a NUL byte in the path is rejected', async () => {
    expect(await run('fs.read', { path: 'src/a.js\u0000.txt' })).toEqual({ ok: false, error: 'invalid_path' });
    expect(await run('fs.write', { path: 'x\u0000y', content: '' })).toEqual({ ok: false, error: 'invalid_path' });
  });

  test('writing through an in-root symlink is refused', async () => {
    fs.symlinkSync(path.join(root, 'src', 'a.js'), path.join(root, 'alias.js'));
    expect(await run('fs.write', { path: 'alias.js', content: 'x' })).toEqual({ ok: false, error: 'symlink_target' });
    expect(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  test('no workspace root configured is an error, not a fallback to cwd', async () => {
    settings.workspace.roots = [];
    expect(await run('fs.read', { path: 'src/a.js' })).toEqual({ ok: false, error: 'no_workspace_root' });
  });
});

describe('fs.write', () => {
  test('writes atomically: content lands, parents are created, no temp file is left', async () => {
    const res = await run('fs.write', { path: 'new/deep/file.txt', content: 'hello' });
    expect(res).toEqual({ ok: true, path: 'new/deep/file.txt', bytes: 5, created: true });
    expect(fs.readFileSync(path.join(root, 'new', 'deep', 'file.txt'), 'utf8')).toBe('hello');
    expect(fs.readdirSync(path.join(root, 'new', 'deep'))).toEqual(['file.txt']);
  });

  test('overwrite preserves file mode and reports created:false', async () => {
    fs.chmodSync(path.join(root, 'src', 'a.js'), 0o640);
    expect(await run('fs.write', { path: 'src/a.js', content: 'z' })).toMatchObject({ ok: true, created: false });
    expect(fs.statSync(path.join(root, 'src', 'a.js')).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(path.join(root, 'src'))).toEqual(['a.js']);
  });

  test('calls checkpoints.beforeMutate with the destination before writing', async () => {
    const seen = [];
    const checkpoints = { beforeMutate: jest.fn(async (p) => { seen.push(fs.readFileSync(p, 'utf8')); }) };
    await run('fs.write', { path: 'src/a.js', content: 'after' }, { checkpoints });
    expect(checkpoints.beforeMutate).toHaveBeenCalledWith(path.join(root, 'src', 'a.js'));
    expect(seen).toEqual(['one\ntwo\nthree\n']);
  });

  test('a failing checkpoint aborts the write', async () => {
    const checkpoints = { beforeMutate: async () => { throw new Error('checkpoint_failed'); } };
    expect(await run('fs.write', { path: 'src/a.js', content: 'after' }, { checkpoints })).toEqual({ ok: false, error: 'checkpoint_failed' });
    expect(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  test('rejects oversize content, non-string content and directory targets', async () => {
    settings.workspace.maxWriteBytes = 4;
    expect(await run('fs.write', { path: 'b.txt', content: 'too long' })).toMatchObject({ ok: false, error: 'content_too_large' });
    expect(await run('fs.write', { path: 'b.txt', content: 5 })).toEqual({ ok: false, error: 'content_must_be_string' });
    expect(await run('fs.write', { path: 'src', content: 'x' })).toEqual({ ok: false, error: 'is_directory' });
    expect(fs.existsSync(path.join(root, 'b.txt'))).toBe(false);
  });
});

describe('fs.edit', () => {
  test('replaces a unique occurrence literally (no $& expansion)', async () => {
    expect(await run('fs.edit', { path: 'src/a.js', old_string: 'two', new_string: '$&-2' })).toEqual({ ok: true, path: 'src/a.js', replacements: 1 });
    expect(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8')).toBe('one\n$&-2\nthree\n');
  });

  test('a non-unique old_string is an error with the occurrence count; replace_all fixes it', async () => {
    fs.writeFileSync(path.join(root, 'dup.txt'), 'x x x');
    expect(await run('fs.edit', { path: 'dup.txt', old_string: 'x', new_string: 'y' })).toEqual({ ok: false, error: 'edit_not_unique', occurrences: 3 });
    expect(fs.readFileSync(path.join(root, 'dup.txt'), 'utf8')).toBe('x x x');
    expect(await run('fs.edit', { path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true })).toMatchObject({ ok: true, replacements: 3 });
    expect(fs.readFileSync(path.join(root, 'dup.txt'), 'utf8')).toBe('y y y');
  });

  test('no match, no-op and missing file are distinct errors', async () => {
    expect(await run('fs.edit', { path: 'src/a.js', old_string: 'nine', new_string: 'x' })).toEqual({ ok: false, error: 'edit_no_match' });
    expect(await run('fs.edit', { path: 'src/a.js', old_string: 'one', new_string: 'one' })).toEqual({ ok: false, error: 'edit_noop' });
    expect(await run('fs.edit', { path: 'nope.txt', old_string: 'a', new_string: 'b' })).toEqual({ ok: false, error: 'file_not_found' });
  });

  test('refuses to edit a non-UTF-8 file', async () => {
    fs.writeFileSync(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await run('fs.edit', { path: 'latin1.txt', old_string: 'ca', new_string: 'x' })).toEqual({ ok: false, error: 'not_utf8' });
  });
});

describe('previewMutation', () => {
  test('fs.edit preview returns a unified diff without touching the file', () => {
    const p = tool('fs.edit').previewMutation({ path: 'src/a.js', old_string: 'two', new_string: 'TWO' }, { agentSettings: settings });
    expect(p.path).toBe('src/a.js');
    expect(p.diff).toContain('-two');
    expect(p.diff).toContain('+TWO');
    expect(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  test('preview of an escaping or failing edit reports the error and no diff', () => {
    expect(tool('fs.write').previewMutation({ path: '../outside/secret.txt', content: 'x' }, { agentSettings: settings }))
      .toEqual({ path: '../outside/secret.txt', diff: null, error: 'path_outside_workspace' });
    expect(tool('fs.edit').previewMutation({ path: 'src/a.js', old_string: 'zzz', new_string: 'x' }, { agentSettings: settings }))
      .toEqual({ path: 'src/a.js', diff: null, error: 'edit_no_match' });
  });
});

describe('read-side tools', () => {
  test('fs.read returns a line window and flags more content', async () => {
    const r = await run('fs.read', { path: 'src/a.js', offset: 2, limit: 1 });
    expect(r).toMatchObject({ ok: true, content: 'two', startLine: 2, endLine: 2, hasMore: true });
  });

  test('fs.read refuses binary files and directories', async () => {
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
    expect(await run('fs.read', { path: 'bin.dat' })).toEqual({ ok: false, error: 'binary_file' });
    expect(await run('fs.read', { path: 'src' })).toEqual({ ok: false, error: 'is_directory' });
  });

  test('fs.list reports symlinks without following them', async () => {
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    const r = await run('fs.list', { depth: 3 });
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual(expect.arrayContaining([{ path: 'link', type: 'symlink' }, { path: 'src/a.js', type: 'file', size: 14 }]));
    expect(r.entries.some((e) => e.path.includes('secret'))).toBe(false);
  });

  test('fs.search finds literal matches, skips .git, and times out a catastrophic regex', async () => {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'three');
    const lit = await run('fs.search', { pattern: 'three' });
    expect(lit.results).toEqual([{ path: 'src/a.js', line: 3, text: 'three' }]);
    fs.writeFileSync(path.join(root, 'redos.txt'), `${'a'.repeat(40)}!`);
    const started = Date.now();
    expect(await run('fs.search', { pattern: '^(a+)+$', regex: true })).toEqual({ ok: false, error: 'regex_timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('fs.search requires a glob or pattern and validates regexes', async () => {
    expect(await run('fs.search', {})).toEqual({ ok: false, error: 'glob_or_pattern_required' });
    expect(await run('fs.search', { pattern: '(', regex: true })).toMatchObject({ ok: false, error: 'invalid_regex' });
  });
});

describe('fs.search globs', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'b'));
    fs.mkdirSync(path.join(root, 'src', 'c'));
    for (const f of ['src/a/x.ts', 'src/b/y.ts', 'src/c/z.ts', 'src/a/w.js']) fs.writeFileSync(path.join(root, f), 'x');
  });
  const paths = (r) => r.results.map((x) => x.path).sort();

  test('ordinary globs still work', async () => {
    expect(paths(await run('fs.search', { glob: '**/*.js' }))).toEqual(['src/a.js', 'src/a/w.js']);
    expect(paths(await run('fs.search', { glob: 'src/{a,b}/*.ts' }))).toEqual(['src/a/x.ts', 'src/b/y.ts']);
    const content = await run('fs.search', { glob: '**/*.js', pattern: 'two' });
    expect(content.results).toEqual([{ path: 'src/a.js', line: 2, text: 'two' }]);
  });

  test('a glob with more than six stars in a segment is refused before any match runs', async () => {
    fs.writeFileSync(path.join(root, 'a'.repeat(60)), 'x');
    const started = Date.now();
    expect(await run('fs.search', { glob: '*a*a*a*a*a*a*a*ab' })).toEqual({ ok: false, error: 'glob_too_complex' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('an accepted glob that backtracks catastrophically times out instead of freezing main', async () => {
    fs.writeFileSync(path.join(root, 'a'.repeat(250)), 'x');
    const started = Date.now();
    expect(await run('fs.search', { glob: `${'*a'.repeat(6)}b` })).toEqual({ ok: false, error: 'glob_timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('walk errors on single entries', () => {
  let locked;
  beforeEach(() => {
    locked = path.join(root, 'src', 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'hidden.js'), 'three');
    fs.chmodSync(locked, 0o000);
  });
  afterEach(() => { fs.chmodSync(locked, 0o755); });

  test('fs.search skips an unreadable subdirectory, counts it, and still returns the other hits', async () => {
    const r = await run('fs.search', { pattern: 'three' });
    expect(r).toMatchObject({ ok: true, skipped: 1, results: [{ path: 'src/a.js', line: 3, text: 'three' }] });
    const g = await run('fs.search', { glob: '**/*.js' });
    expect(g).toMatchObject({ ok: true, skipped: 1, results: [{ path: 'src/a.js' }] });
  });

  test('fs.list descending into an unreadable directory lists it but does not fail on it', async () => {
    const r = await run('fs.list', { depth: 3 });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(1);
    expect(r.entries).toEqual(expect.arrayContaining([{ path: 'src/locked', type: 'dir' }, { path: 'src/a.js', type: 'file', size: 14 }]));
  });

  test('an unreadable starting directory is still an error, not an empty listing', async () => {
    expect(await run('fs.list', { path: 'src/locked' })).toMatchObject({ ok: false });
    expect(await run('fs.search', { path: 'src/locked', pattern: 'three' })).toMatchObject({ ok: false });
  });

  test('a clean walk reports skipped: 0', async () => {
    fs.chmodSync(locked, 0o755);
    expect(await run('fs.search', { pattern: 'three' })).toMatchObject({ ok: true, skipped: 0 });
    expect(await run('fs.list', { depth: 3 })).toMatchObject({ ok: true, skipped: 0 });
  });
});
