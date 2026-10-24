const fs = require('fs');
const os = require('os');
const path = require('path');
const modelScanner = require('../../../../main/utils/modelScanner');

function mk(dir) { fs.mkdirSync(dir, { recursive: true }); }
function touch(p, content) { fs.writeFileSync(p, content || ''); }

function makeMlxDir(dir) {
  mk(dir);
  touch(path.join(dir, 'config.json'), '{}');
  touch(path.join(dir, 'tokenizer.json'), '{}');
  touch(path.join(dir, 'model.safetensors'), 'x');
}

describe('modelScanner', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  test('finds GGUF files recursively, skipping shards past the first', () => {
    mk(path.join(root, 'a/b'));
    touch(path.join(root, 'top.gguf'));
    touch(path.join(root, 'a/middle.gguf'));
    touch(path.join(root, 'a/b/deep.gguf'));
    // Shard set — only first should be registered
    touch(path.join(root, 'a/b/model-00001-of-00003.gguf'));
    touch(path.join(root, 'a/b/model-00002-of-00003.gguf'));
    touch(path.join(root, 'a/b/model-00003-of-00003.gguf'));
    const r = modelScanner.scan({ mlxRoots: [], ggufRoots: [root] });
    expect(r.gguf).toEqual(expect.arrayContaining([
      path.join(root, 'top.gguf'),
      path.join(root, 'a/middle.gguf'),
      path.join(root, 'a/b/deep.gguf'),
      path.join(root, 'a/b/model-00001-of-00003.gguf'),
    ]));
    expect(r.gguf).not.toEqual(expect.arrayContaining([
      path.join(root, 'a/b/model-00002-of-00003.gguf'),
      path.join(root, 'a/b/model-00003-of-00003.gguf'),
    ]));
  });

  test('finds MLX directories and does not recurse into them', () => {
    makeMlxDir(path.join(root, 'modelA'));
    makeMlxDir(path.join(root, 'nested/deep/modelB'));
    // A real MLX dir often contains weight files that look like subdirs only
    // if the model is sharded. We should not descend past a recognized MLX dir.
    mk(path.join(root, 'modelA/weights-shard-that-should-be-ignored'));
    makeMlxDir(path.join(root, 'modelA/weights-shard-that-should-be-ignored'));
    const r = modelScanner.scan({ mlxRoots: [root], ggufRoots: [] });
    expect(r.mlx).toEqual(expect.arrayContaining([
      path.join(root, 'modelA'),
      path.join(root, 'nested/deep/modelB'),
    ]));
    expect(r.mlx).not.toContain(path.join(root, 'modelA/weights-shard-that-should-be-ignored'));
  });

  test('skips hidden dirs, node_modules, and .git', () => {
    makeMlxDir(path.join(root, '.hidden/model'));
    makeMlxDir(path.join(root, 'node_modules/m'));
    makeMlxDir(path.join(root, '.git/m'));
    makeMlxDir(path.join(root, 'visible'));
    const r = modelScanner.scan({ mlxRoots: [root], ggufRoots: [] });
    expect(r.mlx).toEqual([path.join(root, 'visible')]);
  });

  test('resolveRoots merges combined with type-specific dirs', () => {
    const r = modelScanner.resolveRoots({ combined: '/c', mlx: '/m', gguf: '/g' });
    expect(r.mlxRoots).toEqual(['/m', '/c']);
    expect(r.ggufRoots).toEqual(['/g', '/c']);
  });

  test('scan returns empty when no roots exist', () => {
    const r = modelScanner.scan({ mlxRoots: ['/definitely/not/real'], ggufRoots: [] });
    expect(r).toEqual({ mlx: [], gguf: [] });
  });

  test('dedupes across multiple roots', () => {
    makeMlxDir(path.join(root, 'shared'));
    const r = modelScanner.scan({ mlxRoots: [root, root], ggufRoots: [] });
    expect(r.mlx).toEqual([path.join(root, 'shared')]);
  });
});
