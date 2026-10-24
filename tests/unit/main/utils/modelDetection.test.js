const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  findMmprojFor, mlxInfo, findShardSiblings, shardGroupInfo,
} = require('../../../../main/utils/modelDetection');

function mk(dir) { fs.mkdirSync(dir, { recursive: true }); }
function touch(p, content) { fs.writeFileSync(p, content || ''); }

describe('modelDetection', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldet-'));
  });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  describe('findMmprojFor', () => {
    test.each([
      ['no sibling returns null', ['model.gguf'], null],
      ['exact token sibling wins over unrelated candidate',
        ['Qwen2-VL-7B.Q4_K_M.gguf', 'mmproj-Qwen2-VL-7B-f16.gguf', 'mmproj-Other-Model-f16.gguf'],
        'mmproj-Qwen2-VL-7B-f16.gguf'],
      ['shard-suffixed model still matches token before shard suffix',
        ['Gemma-3-4B-00001-of-00002.gguf', 'mmproj-Gemma-3-f16.gguf'], 'mmproj-Gemma-3-f16.gguf'],
      ['non-mmproj gguf siblings ignored', ['model.gguf', 'other.gguf'], null],
    ])('%s', (_label, files, expected) => {
      for (const f of files) touch(path.join(root, f));
      const model = files.find((f) => !/^mmproj/i.test(f));
      const got = findMmprojFor(path.join(root, model));
      expect(got).toBe(expected === null ? null : path.join(root, expected));
    });

    test('no token overlap falls back to one of the candidates', () => {
      touch(path.join(root, 'Llama-3.gguf'));
      touch(path.join(root, 'mmproj-Alpha-f16.gguf'));
      touch(path.join(root, 'mmproj-Beta-f16.gguf'));
      const got = findMmprojFor(path.join(root, 'Llama-3.gguf'));
      expect(got === path.join(root, 'mmproj-Alpha-f16.gguf')
        || got === path.join(root, 'mmproj-Beta-f16.gguf')).toBe(true);
    });

    test('non-existent dir returns null', () => {
      expect(findMmprojFor(path.join(root, 'nope', 'model.gguf'))).toBeNull();
    });
  });

  describe('mlxInfo.format (folderFormat)', () => {
    test.each([
      ['npz weights are mlx', { files: ['model.npz'] }, 'mlx'],
      ['mlx-named dir is mlx', { dir: 'Qwen2-VL-MLX', files: ['config.json', 'model.safetensors'], cfg: {} }, 'mlx'],
      ['no config.json is mlx', { files: ['model.safetensors'] }, 'mlx'],
      ['quantization object is mlx', { files: ['config.json'], cfg: { quantization: { bits: 4 } } }, 'mlx'],
      ['string quantization is hf', { files: ['config.json'], cfg: { quantization: '4bit' } }, 'hf'],
      ['plain config is hf', { files: ['config.json'], cfg: { model_type: 'qwen2' } }, 'hf'],
    ])('%s', (_label, spec, expected) => {
      const dir = path.join(root, spec.dir || 'model');
      mk(dir);
      for (const f of spec.files) touch(path.join(dir, f));
      if (spec.cfg) touch(path.join(dir, 'config.json'), JSON.stringify(spec.cfg));
      expect(mlxInfo(dir).format).toBe(expected);
    });

    test('invalid config.json makes mlxInfo skip (returns null)', () => {
      const dir = path.join(root, 'model');
      mk(dir);
      touch(path.join(dir, 'config.json'), '{not json');
      expect(mlxInfo(dir)).toBeNull();
    });
  });

  describe('shardGroupInfo', () => {
    function shardsFor(names) {
      const first = findShardSiblings(root, 'model', 2);
      // filter to requested subset regardless of input order
      return first.filter((s) => names.includes(s.filename));
    }

    beforeEach(() => {
      touch(path.join(root, 'model-00001-of-00002.gguf'), 'a'.repeat(100));
      touch(path.join(root, 'model-00002-of-00002.gguf'), 'b'.repeat(50));
    });
    const refPath = () => path.join(root, 'model-00001-of-00002.gguf');

    test('complete set sums sizes and reports group info', () => {
      const r = shardGroupInfo(shardsFor(['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf']), refPath());
      expect(r).toMatchObject({
        name: 'model.gguf', path: refPath(), size: 150, isMultiPart: true,
        shardCount: 2, shardsPresent: 2, incomplete: false, mmprojPath: null, isMultimodal: false,
      });
    });

    test('complete set with mmproj sibling is multimodal', () => {
      touch(path.join(root, 'mmproj-model-f16.gguf'));
      const r = shardGroupInfo(shardsFor(['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf']), refPath());
      expect(r.isMultimodal).toBe(true);
      expect(r.mmprojPath).toBe(path.join(root, 'mmproj-model-f16.gguf'));
    });

    test('missing shard marks group incomplete', () => {
      const r = shardGroupInfo(shardsFor(['model-00001-of-00002.gguf']), refPath());
      expect(r.incomplete).toBe(true);
      expect(r.shardsPresent).toBe(1);
      expect(r.size).toBe(100);
    });

    test('no index-1 shard falls back to refPath base and total', () => {
      const r = shardGroupInfo(shardsFor(['model-00002-of-00002.gguf']), refPath());
      expect(r.path).toBe(refPath());
      expect(r.name).toBe('model-00001-of-00002.gguf');
      expect(r.total === undefined).toBe(true); // total not exposed; shardCount carries it
      expect(r.shardCount).toBe(2);
      expect(r.incomplete).toBe(true);
    });

    test('empty shards with refPath yields total 0 and incomplete', () => {
      const r = shardGroupInfo([], refPath());
      expect(r).toMatchObject({
        name: 'model-00001-of-00002.gguf', path: refPath(), size: 0, shardCount: 0,
        shardsPresent: 0, incomplete: true,
      });
    });

    test('deleted shard stat failure is ignored and excluded from size', () => {
      const shards = shardsFor(['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf']);
      fs.rmSync(path.join(root, 'model-00002-of-00002.gguf'));
      const r = shardGroupInfo(shards, refPath());
      expect(r.size).toBe(100);
      expect(r.shardsPresent).toBe(2);
    });
  });
});
