// workspace:search-files — file-name search over real temp workspace roots:
// substring and glob matching, ranking, skipped dirs, protected files,
// symlinks never followed, input validation and the registered channel.

jest.mock('electron', () => {
  const handlers = {};
  return { ipcMain: { handle: jest.fn((ch, fn) => { handlers[ch] = fn; }), _handlers: handlers } };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain } = require('electron');
const { register, searchFiles } = require('../../../../main/ipc/workspaceSearchHandlers');

let base, root, other, outside;

const mockConfig = (agent) => ({ get: (k, d) => (k === 'settings.llm.agent' ? agent : d) });
const withRoots = (roots, extra = {}) => mockConfig({ workspace: { roots, ...extra } });
const write = (p, text = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-wssearch-')));
  root = path.join(base, 'proj');
  other = path.join(base, 'notes');
  outside = path.join(base, 'outside');
  write(path.join(root, 'README.md'));
  write(path.join(root, 'src', 'readme-parser.js'));
  write(path.join(root, 'docs', 'guide', 'deep-readme.txt'));
  write(path.join(root, 'node_modules', 'pkg', 'readme.md'));
  write(path.join(root, '.git', 'readme'));
  write(path.join(root, '.env'));
  write(path.join(other, 'journal-readme.md'));
  write(path.join(outside, 'readme-secret.md'));
  fs.symlinkSync(outside, path.join(root, 'linked'));
  fs.symlinkSync(path.join(outside, 'readme-secret.md'), path.join(root, 'readme-link.md'));
});

afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('searchFiles', () => {
  test('substring match ranks basename-prefix hits first and skips node_modules, .git and symlinks', async () => {
    const res = await searchFiles({ query: 'readme' }, withRoots([root]));
    expect(res).toMatchObject({ ok: true, truncated: false, roots: 1 });
    expect(res.results.map((r) => r.path)).toEqual(['README.md', 'src/readme-parser.js', 'docs/guide/deep-readme.txt']);
    expect(res.results[0]).toEqual({ root, rootName: 'proj', path: 'README.md', name: 'README.md' });
  });

  test('a glob query matches the root-relative path', async () => {
    const res = await searchFiles({ query: 'docs/**/*.txt' }, withRoots([root]));
    expect(res.results.map((r) => r.path)).toEqual(['docs/guide/deep-readme.txt']);
  });

  test('protected files never appear, even for an empty query', async () => {
    const res = await searchFiles({}, withRoots([root]));
    const paths = res.results.map((r) => r.path);
    expect(paths).not.toContain('.env');
    expect(paths).toEqual(expect.arrayContaining(['README.md', 'src/readme-parser.js']));
    expect(paths.some((p) => p.startsWith('linked') || p === 'readme-link.md')).toBe(false);
  });

  test('searches every root, or only the selected one', async () => {
    const both = await searchFiles({ query: 'readme' }, withRoots([root, other]));
    expect(both.roots).toBe(2);
    expect(both.results.map((r) => `${r.rootName}:${r.path}`)).toContain('notes:journal-readme.md');
    const one = await searchFiles({ query: 'readme', root: 'notes' }, withRoots([root, other]));
    expect(one.results.map((r) => r.path)).toEqual(['journal-readme.md']);
  });

  test('no configured roots is an empty, successful result', async () => {
    await expect(searchFiles({ query: 'x' }, withRoots([]))).resolves.toEqual({ ok: true, results: [], truncated: false, roots: 0, skipped: 0, rootErrors: [] });
  });

  test('more hits than the result cap are truncated', async () => {
    for (let i = 0; i < 60; i++) write(path.join(other, `f${String(i).padStart(2, '0')}.md`));
    const res = await searchFiles({ query: '.md' }, withRoots([other]));
    expect(res.results).toHaveLength(50);
    expect(res.truncated).toBe(true);
  });

  test('rejects malformed input', async () => {
    const cfg = withRoots([root]);
    await expect(searchFiles({ query: 42 }, cfg)).resolves.toEqual({ ok: false, error: 'invalid_query' });
    await expect(searchFiles({ query: 'a'.repeat(201) }, cfg)).resolves.toEqual({ ok: false, error: 'invalid_query' });
    await expect(searchFiles({ query: 'a\0b' }, cfg)).resolves.toEqual({ ok: false, error: 'invalid_query' });
    await expect(searchFiles({ query: 'a', root: 3 }, cfg)).resolves.toEqual({ ok: false, error: 'invalid_root' });
  });

  test('an unknown root selector throws', async () => {
    await expect(searchFiles({ query: 'a', root: 'nope' }, withRoots([root]))).rejects.toThrow('unknown_workspace_root');
  });

  test('a vanished root is reported per root while the other roots are still searched', async () => {
    const gone = path.join(base, 'gone');
    const res = await searchFiles({ query: 'readme' }, withRoots([gone, other]));
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.path)).toEqual(['journal-readme.md']);
    expect(res.rootErrors).toEqual([{ root: gone, error: 'workspace_root_missing' }]);
  });

  test('when every root fails the search fails with the first root error', async () => {
    const gone = path.join(base, 'gone');
    const res = await searchFiles({ query: 'readme' }, withRoots([gone]));
    expect(res).toEqual({ ok: false, error: 'workspace_root_missing', rootErrors: [{ root: gone, error: 'workspace_root_missing' }] });
  });

  test('an unreadable subdirectory is skipped and counted; its siblings are still found', async () => {
    const locked = path.join(root, 'docs');
    fs.chmodSync(locked, 0o000);
    try {
      const res = await searchFiles({ query: 'readme' }, withRoots([root]));
      expect(res).toMatchObject({ ok: true, skipped: 1, rootErrors: [] });
      expect(res.results.map((r) => r.path)).toEqual(['README.md', 'src/readme-parser.js']);
    } finally { fs.chmodSync(locked, 0o755); }
  });

  test('a pathologically complex glob is refused, not run on the main thread', async () => {
    write(path.join(root, 'a'.repeat(60)));
    const started = Date.now();
    await expect(searchFiles({ query: '*a*a*a*a*a*a*a*ab' }, withRoots([root]))).rejects.toThrow('glob_too_complex');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('register', () => {
  beforeEach(() => { for (const k of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[k]; });

  test('registers workspace:search-files and returns failures as {ok:false}', async () => {
    register(null, { configService: withRoots([root]) });
    const handler = ipcMain._handlers['workspace:search-files'];
    const res = await handler({}, { query: 'README' });
    expect(res.ok).toBe(true);
    expect(res.results[0]).toMatchObject({ path: 'README.md' });
    await expect(handler({}, { query: 'a', root: 'nope' })).resolves.toEqual({ ok: false, error: 'unknown_workspace_root' });
    await expect(handler({}, ['not', 'an', 'object'])).resolves.toMatchObject({ ok: true });
  });

  test('registers nothing without a config service', () => {
    register(null, {});
    expect(ipcMain._handlers['workspace:search-files']).toBeUndefined();
  });
});
