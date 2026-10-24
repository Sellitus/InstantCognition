const path = require('path');
const fs = require('fs');
const os = require('os');

const mockElectron = { app: { getPath: jest.fn(() => '/unused'), isPackaged: false } };
jest.mock('electron', () => mockElectron);

let tmpDir;
let svc;

beforeEach(() => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-models-test-'));
  mockElectron.app.getPath = jest.fn(() => tmpDir);
  jest.doMock('electron', () => mockElectron);
  svc = require('../../../../main/services/ModelManagerService');
  svc.removeAllListeners();
  svc.setModelsDir(path.join(tmpDir, 'models'));
  svc._registry = null;
  svc._migrated = false;
});

afterEach(() => {
  // Watcher lifecycle tests start a real fs.watch — always tear it down so a
  // dangling watch handle can't leak into the next test or the full run.
  try { svc.stopWatching(); } catch (_) {}
  svc._watcher = null;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('ModelManagerService', () => {
  test('getModelsDir returns the custom dir when set', () => {
    expect(svc.getModelsDir()).toBe(path.join(tmpDir, 'models'));
  });

  test('setModelsDir overrides any default', () => {
    svc.setModelsDir('/custom/path');
    expect(svc.getModelsDir()).toBe('/custom/path');
  });

  test('listModels returns empty array when registry and dir are empty', () => {
    expect(svc.listModels()).toEqual([]);
  });

  test('listModels auto-registers legacy files in the managed dir', () => {
    const dir = svc.ensureModelsDir();
    const file = path.join(dir, 'test-model.Q4_K_M.gguf');
    fs.writeFileSync(file, 'fake');

    const models = svc.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('test-model.Q4_K_M.gguf');
    expect(models[0].format).toBe('gguf');
    expect(models[0].quantization).toBe('Q4_K_M');
  });

  function writeModelFolder(dir, config, weight = 'model.safetensors') {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(dir, 'tokenizer.json'), '{}');
    fs.writeFileSync(path.join(dir, weight), 'x');
  }

  test('listModels detects MLX-quantized directories as format mlx', () => {
    const dir = svc.ensureModelsDir();
    writeModelFolder(path.join(dir, 'Qwen3-8B-4bit'), { model_type: 'qwen3', quantization: { group_size: 64, bits: 4 } });

    const models = svc.listModels();
    const mlx = models.find((m) => m.format === 'mlx');
    expect(mlx).toBeTruthy();
    expect(mlx.name).toBe('Qwen3-8B-4bit');
    expect(mlx.isMultimodal).toBe(false);
  });

  // vLLM loads plain Hugging Face folders but not MLX-quantized ones, so the
  // library must tell the two apart.
  test('a plain Hugging Face safetensors folder is format hf', () => {
    const dir = svc.ensureModelsDir();
    const hfDir = path.join(dir, 'Qwen3-8B');
    writeModelFolder(hfDir, { model_type: 'qwen3', torch_dtype: 'bfloat16' });

    const info = svc.resolveModelInfo(hfDir);
    expect(info.format).toBe('hf');
    expect(svc.listModels().find((m) => m.path === hfDir).format).toBe('hf');
  });

  test('a quantization value that is not an object does not make a folder mlx', () => {
    const dir = svc.ensureModelsDir();
    const hfDir = path.join(dir, 'Llama-3-8B-awq');
    writeModelFolder(hfDir, { model_type: 'llama', quantization: 'awq' });
    expect(svc.resolveModelInfo(hfDir).format).toBe('hf');
  });

  test('.npz weights mark a folder mlx', () => {
    const dir = svc.ensureModelsDir();
    const d = path.join(dir, 'Phi-3-mini');
    writeModelFolder(d, { model_type: 'phi3' }, 'weights.npz');
    expect(svc.resolveModelInfo(d).format).toBe('mlx');
  });

  test('an mlx-named conversion without a quantization block is mlx', () => {
    const dir = svc.ensureModelsDir();
    const d = path.join(dir, 'Llama-3.2-1B-Instruct-MLX-bf16');
    writeModelFolder(d, { model_type: 'llama' });
    expect(svc.resolveModelInfo(d).format).toBe('mlx');
  });

  test('a folder whose config.json is unreadable is skipped, not mislabelled', () => {
    const dir = svc.ensureModelsDir();
    const d = path.join(dir, 'Broken-Model');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'config.json'), '{ not json');
    fs.writeFileSync(path.join(d, 'tokenizer.json'), '{}');
    fs.writeFileSync(path.join(d, 'model.safetensors'), 'x');
    expect(svc.resolveModelInfo(d)).toBeNull();
  });

  test('GGUF info attaches mmprojPath and sets isMultimodal when a sibling mmproj exists', () => {
    const dir = svc.ensureModelsDir();
    fs.writeFileSync(path.join(dir, 'Qwen2-VL-7B.Q4_K_M.gguf'), 'model');
    fs.writeFileSync(path.join(dir, 'mmproj-Qwen2-VL-7B-f16.gguf'), 'proj');

    const info = svc.resolveModelInfo(path.join(dir, 'Qwen2-VL-7B.Q4_K_M.gguf'));
    expect(info).toBeTruthy();
    expect(info.isMultimodal).toBe(true);
    expect(info.mmprojPath).toBe(path.join(dir, 'mmproj-Qwen2-VL-7B-f16.gguf'));
  });

  test('GGUF info reports isMultimodal=false when no sibling mmproj exists', () => {
    const dir = svc.ensureModelsDir();
    fs.writeFileSync(path.join(dir, 'plain-model.Q4_K_M.gguf'), 'model');

    const info = svc.resolveModelInfo(path.join(dir, 'plain-model.Q4_K_M.gguf'));
    expect(info).toBeTruthy();
    expect(info.isMultimodal).toBe(false);
    expect(info.mmprojPath).toBeNull();
  });

  test('sharded GGUF info attaches mmprojPath when sibling mmproj exists', () => {
    const dir = svc.ensureModelsDir();
    fs.writeFileSync(path.join(dir, 'big-vl-00001-of-00002.gguf'), 'a');
    fs.writeFileSync(path.join(dir, 'big-vl-00002-of-00002.gguf'), 'bb');
    fs.writeFileSync(path.join(dir, 'mmproj-big-vl-f16.gguf'), 'proj');

    const info = svc.resolveModelInfo(path.join(dir, 'big-vl-00001-of-00002.gguf'));
    expect(info).toBeTruthy();
    expect(info.isMultiPart).toBe(true);
    expect(info.isMultimodal).toBe(true);
    expect(info.mmprojPath).toBe(path.join(dir, 'mmproj-big-vl-f16.gguf'));
  });

  test('MLX info reports isMultimodal=true when config.json has vision_config', () => {
    const dir = svc.ensureModelsDir();
    const mlxDir = path.join(dir, 'qwen2-vl-mlx');
    fs.mkdirSync(mlxDir);
    fs.writeFileSync(path.join(mlxDir, 'config.json'), JSON.stringify({
      model_type: 'qwen2_vl',
      vision_config: { hidden_size: 1280 },
    }));
    fs.writeFileSync(path.join(mlxDir, 'tokenizer.json'), '{}');
    fs.writeFileSync(path.join(mlxDir, 'model.safetensors'), 'x');

    const info = svc.resolveModelInfo(mlxDir);
    expect(info).toBeTruthy();
    expect(info.format).toBe('mlx');
    expect(info.isMultimodal).toBe(true);
  });

  test('MLX info reports isMultimodal=true when model_type matches a known vision family', () => {
    const dir = svc.ensureModelsDir();
    const mlxDir = path.join(dir, 'llava-mlx');
    fs.mkdirSync(mlxDir);
    fs.writeFileSync(path.join(mlxDir, 'config.json'), JSON.stringify({ model_type: 'llava' }));
    fs.writeFileSync(path.join(mlxDir, 'tokenizer.json'), '{}');
    fs.writeFileSync(path.join(mlxDir, 'model.safetensors'), 'x');

    const info = svc.resolveModelInfo(mlxDir);
    expect(info.isMultimodal).toBe(true);
  });

  test('listModels groups legacy multi-part shards in managed dir', () => {
    const dir = svc.ensureModelsDir();
    fs.writeFileSync(path.join(dir, 'big-model-00001-of-00003.gguf'), 'a');
    fs.writeFileSync(path.join(dir, 'big-model-00002-of-00003.gguf'), 'bb');
    fs.writeFileSync(path.join(dir, 'big-model-00003-of-00003.gguf'), 'ccc');
    fs.writeFileSync(path.join(dir, 'single.Q4_K_M.gguf'), 'z');

    const models = svc.listModels();
    expect(models).toHaveLength(2);
    const shardGroup = models.find((m) => m.isMultiPart);
    expect(shardGroup).toBeTruthy();
    expect(shardGroup.shardCount).toBe(3);
    expect(shardGroup.incomplete).toBe(false);
    expect(shardGroup.path).toMatch(/-00001-of-00003\.gguf$/);
    expect(shardGroup.size).toBe(6);
  });

  test('importModel registers a single gguf in place without copying', () => {
    const src = path.join(tmpDir, 'elsewhere', 'source.gguf');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'data');
    const info = svc.importModel(src);
    expect(info).toBeTruthy();
    expect(info.path).toBe(src);
    // Not copied into models dir
    expect(fs.existsSync(path.join(svc.getModelsDir(), 'source.gguf'))).toBe(false);
    // Present in registry and listModels
    expect(svc.listModels().map((m) => m.path)).toContain(src);
  });

  test('importModel of shard 1 registers in place (no copy), validates completeness', () => {
    const srcDir = path.join(tmpDir, 'downloaded-model');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'big-00001-of-00002.gguf'), 'a');
    fs.writeFileSync(path.join(srcDir, 'big-00002-of-00002.gguf'), 'bb');
    const info = svc.importModel(path.join(srcDir, 'big-00001-of-00002.gguf'));
    expect(info).toBeTruthy();
    expect(info.isMultiPart).toBe(true);
    expect(info.shardCount).toBe(2);
    expect(info.path).toBe(path.join(srcDir, 'big-00001-of-00002.gguf'));
    // Source files untouched
    expect(fs.existsSync(path.join(srcDir, 'big-00001-of-00002.gguf'))).toBe(true);
    // NOT copied into models dir
    expect(fs.existsSync(path.join(svc.getModelsDir(), 'big-00001-of-00002.gguf'))).toBe(false);
  });

  test('importModel throws for incomplete shard set at source', () => {
    const srcDir = path.join(tmpDir, 'partial');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'x-00001-of-00003.gguf'), 'a');
    fs.writeFileSync(path.join(srcDir, 'x-00002-of-00003.gguf'), 'bb');
    expect(() => svc.importModel(path.join(srcDir, 'x-00001-of-00003.gguf')))
      .toThrow(/Incomplete shard set/);
  });

  test('importModel registers an MLX directory in place (no copy)', () => {
    const srcDir = path.join(tmpDir, 'model-src-4bit');
    writeModelFolder(srcDir, { quantization: { group_size: 64, bits: 4 } });
    const info = svc.importModel(srcDir);
    expect(info).toBeTruthy();
    expect(info.format).toBe('mlx');
    expect(info.path).toBe(srcDir);
    expect(fs.existsSync(path.join(svc.getModelsDir(), 'model-src-4bit'))).toBe(false);
  });

  test('importModel registers a Hugging Face folder in place as format hf', () => {
    const srcDir = path.join(tmpDir, 'hf-src');
    writeModelFolder(srcDir, { model_type: 'mistral' });
    const info = svc.importModel(srcDir);
    expect(info.format).toBe('hf');
    expect(info.path).toBe(srcDir);
    expect(svc._reg()).toContain(srcDir);
  });

  test('importModel emits models-changed', () => {
    const listener = jest.fn();
    svc.on('models-changed', listener);
    const src = path.join(tmpDir, 'src.gguf');
    fs.writeFileSync(src, 'data');
    svc.importModel(src);
    expect(listener).toHaveBeenCalled();
  });

  test('importModel rejects non-existent source', () => {
    expect(() => svc.importModel('/no/such/path.gguf')).toThrow();
  });

  test('deleteModel unregisters but does NOT delete sources outside managed dir', () => {
    const src = path.join(tmpDir, 'external', 'keep-me.gguf');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'data');
    svc.importModel(src);
    expect(svc.deleteModel(src)).toBe(true);
    expect(fs.existsSync(src)).toBe(true); // still on disk
    expect(svc.listModels().map((m) => m.path)).not.toContain(src);
  });

  test('deleteModel deletes sources inside managed dir', () => {
    const dir = svc.ensureModelsDir();
    const file = path.join(dir, 'doomed.gguf');
    fs.writeFileSync(file, 'x');
    svc.listModels(); // triggers migration → registry
    expect(svc.deleteModel(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('listModels drops paths whose file no longer exists instead of surfacing MISSING entries', () => {
    const src = path.join(tmpDir, 'gone.gguf');
    fs.writeFileSync(src, 'data');
    svc.importModel(src);
    fs.unlinkSync(src);
    const models = svc.listModels();
    expect(models).toEqual([]);
  });

  test('listModels auto-prunes entries whose files were deleted from disk', () => {
    const dir = svc.ensureModelsDir();
    const a = path.join(dir, 'alive.gguf');
    const b = path.join(dir, 'dead.gguf');
    fs.writeFileSync(a, 'x');
    fs.writeFileSync(b, 'x');
    svc.listModels(); // register both via legacy migration
    fs.unlinkSync(b); // simulate user deleting from disk behind our back
    const listener = jest.fn();
    svc.on('models-changed', listener);
    const models = svc.listModels();
    expect(models.map((m) => m.path)).toEqual([a]);
    expect(svc._reg()).toEqual([a]);
    expect(listener).toHaveBeenCalled();
  });

  test('listModels auto-prunes incomplete shard sets', () => {
    const dir = path.join(tmpDir, 'elsewhere');
    fs.mkdirSync(dir, { recursive: true });
    // Create all three, import, then delete one to make the set incomplete.
    fs.writeFileSync(path.join(dir, 'm-00001-of-00003.gguf'), 'a');
    fs.writeFileSync(path.join(dir, 'm-00002-of-00003.gguf'), 'b');
    fs.writeFileSync(path.join(dir, 'm-00003-of-00003.gguf'), 'c');
    svc.importModel(path.join(dir, 'm-00001-of-00003.gguf'));
    fs.unlinkSync(path.join(dir, 'm-00002-of-00003.gguf'));
    const models = svc.listModels();
    expect(models).toEqual([]);
    expect(svc._reg()).toEqual([]);
  });

  test('listModels prunes imported entries that were moved away too', () => {
    const src = path.join(tmpDir, 'external', 'orphan.gguf');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'x');
    svc.importModel(src);
    fs.unlinkSync(src);
    expect(svc.listModels()).toEqual([]);
    expect(svc._reg()).toEqual([]);
  });

  test('listModels keeps valid entries even when others are pruned', () => {
    const dir = svc.ensureModelsDir();
    const live = path.join(dir, 'live.gguf');
    const ghost = path.join(dir, 'ghost.gguf');
    fs.writeFileSync(live, 'x');
    fs.writeFileSync(ghost, 'x');
    svc.listModels();
    fs.unlinkSync(ghost);
    const models = svc.listModels();
    expect(models.map((m) => m.path)).toEqual([live]);
  });

  test('quantization detection covers Q4_K_M, Q5_0, F16', () => {
    const dir = svc.ensureModelsDir();
    fs.writeFileSync(path.join(dir, 'a.Q4_K_M.gguf'), 'x');
    fs.writeFileSync(path.join(dir, 'b.Q5_0.gguf'), 'x');
    fs.writeFileSync(path.join(dir, 'c.F16.gguf'), 'x');
    const models = svc.listModels();
    const quants = models.map((m) => m.quantization).sort();
    expect(quants).toEqual(['F16', 'Q4_K_M', 'Q5_0']);
  });

  describe('isMlxDir negative branches', () => {
    test('a directory without config.json is not an MLX dir', () => {
      const dir = svc.ensureModelsDir();
      const d = path.join(dir, 'no-config');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'tokenizer.json'), '{}');
      fs.writeFileSync(path.join(d, 'model.safetensors'), 'x');
      // resolveModelInfo on a non-MLX directory returns null.
      expect(svc.resolveModelInfo(d)).toBeNull();
    });

    test('a directory with config but no tokenizer is not an MLX dir', () => {
      const dir = svc.ensureModelsDir();
      const d = path.join(dir, 'no-tokenizer');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'config.json'), '{}');
      fs.writeFileSync(path.join(d, 'model.safetensors'), 'x');
      expect(svc.resolveModelInfo(d)).toBeNull();
    });

    test('a directory with config + tokenizer but no weights is not an MLX dir', () => {
      const dir = svc.ensureModelsDir();
      const d = path.join(dir, 'no-weights');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'config.json'), '{}');
      fs.writeFileSync(path.join(d, 'tokenizer.json'), '{}');
      expect(svc.resolveModelInfo(d)).toBeNull();
    });
  });

  describe('getModelsDir fallbacks', () => {
    test('setModelsDir(null) clears the override → falls back to userData/models', () => {
      svc.setModelsDir(null);
      expect(svc.getModelsDir()).toBe(path.join(tmpDir, 'models'));
    });

    test('getModelsDir falls back to cwd/models when app.getPath throws', () => {
      svc.setModelsDir(null);
      mockElectron.app.getPath = jest.fn(() => { throw new Error('no userData'); });
      expect(svc.getModelsDir()).toBe(path.join(process.cwd(), 'models'));
    });
  });

  describe('_infoForPath non-model branches', () => {
    test('a non-gguf regular file resolves to null', () => {
      const dir = svc.ensureModelsDir();
      const f = path.join(dir, 'README.txt');
      fs.writeFileSync(f, 'hi');
      expect(svc.resolveModelInfo(f)).toBeNull();
    });

    test('a path that does not exist resolves to a missing-marked entry', () => {
      const info = svc.resolveModelInfo(path.join(tmpDir, 'ghost.gguf'));
      expect(info).toMatchObject({ missing: true, format: 'gguf', size: 0 });
    });

    test('listModels drops duplicate registry entries (dedupe + prune)', () => {
      const dir = svc.ensureModelsDir();
      const f = path.join(dir, 'dup.Q4_K_M.gguf');
      fs.writeFileSync(f, 'x');
      svc._registry = [f, f, f]; // same path three times
      const models = svc.listModels();
      expect(models).toHaveLength(1);
      expect(svc._reg()).toEqual([f]); // duplicates pruned
    });
  });

  describe('deleteModel managed-dir variants', () => {
    test('deletes an MLX directory tree inside the managed dir', () => {
      const dir = svc.ensureModelsDir();
      const mlxDir = path.join(dir, 'doomed-mlx');
      fs.mkdirSync(mlxDir);
      fs.writeFileSync(path.join(mlxDir, 'config.json'), '{}');
      fs.writeFileSync(path.join(mlxDir, 'tokenizer.json'), '{}');
      fs.writeFileSync(path.join(mlxDir, 'model.safetensors'), 'x');
      svc.listModels(); // migrate → registry
      expect(svc.deleteModel(mlxDir)).toBe(true);
      expect(fs.existsSync(mlxDir)).toBe(false);
    });

    test('deletes the whole shard set when a managed shard member is removed', () => {
      const dir = svc.ensureModelsDir();
      const a = path.join(dir, 'shard-00001-of-00002.gguf');
      const b = path.join(dir, 'shard-00002-of-00002.gguf');
      fs.writeFileSync(a, 'a');
      fs.writeFileSync(b, 'bb');
      svc.listModels(); // registers shard 1
      expect(svc.deleteModel(a)).toBe(true);
      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(b)).toBe(false); // sibling removed too
    });

    test('deleteModel of an unregistered path still emits and returns true', () => {
      const listener = jest.fn();
      svc.on('models-changed', listener);
      expect(svc.deleteModel('/not/in/registry.gguf')).toBe(true);
      expect(listener).toHaveBeenCalled();
    });

    test('deleteModel surfaces a filesystem failure on a managed path', () => {
      const dir = svc.ensureModelsDir();
      const f = path.join(dir, 'racey.gguf');
      fs.writeFileSync(f, 'x');
      svc.listModels();
      const listener = jest.fn();
      svc.on('models-changed', listener);
      const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('ENOENT race'); });
      // The caller must hear that the file survived — a swallowed error here made
      // the settings UI report a delete that never happened.
      expect(() => svc.deleteModel(f)).toThrow(/ENOENT race/);
      statSpy.mockRestore();
      // The registry entry is already gone, so listeners still refresh.
      expect(listener).toHaveBeenCalled();
      expect(fs.existsSync(f)).toBe(true);
    });
  });

  describe('importModel rejection branches', () => {
    test('rejects a directory that is not a valid model folder', () => {
      const d = path.join(tmpDir, 'bad-mlx');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'config.json'), '{}'); // no tokenizer/weights
      expect(() => svc.importModel(d)).toThrow(/Not a recognized model folder \(needs config\.json, a tokenizer and safetensors weights\)/);
      expect(svc._reg()).not.toContain(d);
    });

    test('rejects an unsupported non-gguf file', () => {
      const f = path.join(tmpDir, 'model.bin');
      fs.writeFileSync(f, 'x');
      expect(() => svc.importModel(f)).toThrow(/Unsupported file \(expected a \.gguf file or a model folder\)/);
    });

    test('importing a non-first shard registers shard 1, not the supplied member', () => {
      const d = path.join(tmpDir, 'shards-import');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'm-00001-of-00002.gguf'), 'a');
      fs.writeFileSync(path.join(d, 'm-00002-of-00002.gguf'), 'bb');
      svc.importModel(path.join(d, 'm-00002-of-00002.gguf')); // import member #2
      expect(svc._reg()).toContain(path.join(d, 'm-00001-of-00002.gguf'));
    });
  });

  describe('scanDirs', () => {
    test('returns zeroed summary when no roots resolve', () => {
      expect(svc.scanDirs({ combined: null, mlx: null, gguf: null }))
        .toEqual({ mlx: 0, gguf: 0, added: 0, skipped: 0, found: { mlx: [], gguf: [] } });
      expect(svc.scanDirs(undefined))
        .toEqual({ mlx: 0, gguf: 0, added: 0, skipped: 0, found: { mlx: [], gguf: [] } });
    });

    test('registers found gguf + mlx and counts skipped duplicates', () => {
      const root = path.join(tmpDir, 'scanroot');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'found.Q4_K_M.gguf'), 'x');
      const mlxDir = path.join(root, 'found-mlx');
      fs.mkdirSync(mlxDir);
      fs.writeFileSync(path.join(mlxDir, 'config.json'), '{}');
      fs.writeFileSync(path.join(mlxDir, 'tokenizer.json'), '{}');
      fs.writeFileSync(path.join(mlxDir, 'model.safetensors'), 'w');

      const listener = jest.fn();
      svc.on('models-changed', listener);
      const r1 = svc.scanDirs({ combined: root });
      expect(r1.added).toBeGreaterThan(0);
      expect(listener).toHaveBeenCalled();

      // A second scan with the same root finds the same paths → all skipped.
      const r2 = svc.scanDirs({ combined: root });
      expect(r2.added).toBe(0);
      expect(r2.skipped).toBe(r2.mlx + r2.gguf);
    });
  });

  describe('watcher lifecycle', () => {
    test('startWatching creates a watcher; setModelsDir restarts an existing one', () => {
      svc.startWatching({ combined: null, mlx: null, gguf: null });
      expect(svc._watcher).toBeTruthy();
      const startSpy = jest.spyOn(svc._watcher, 'start');
      svc.setModelsDir(path.join(tmpDir, 'models2')); // existing watcher → restart
      expect(startSpy).toHaveBeenCalled();
      startSpy.mockRestore();
    });

    test('startWatching defaults the config when none is given', () => {
      svc.startWatching();
      expect(svc._lastWatchCfg).toEqual({ combined: null, mlx: null, gguf: null });
    });

    test('stopWatching is a no-op before a watcher exists, stops it after', () => {
      svc._watcher = null;
      expect(() => svc.stopWatching()).not.toThrow();
      svc.startWatching();
      const stopSpy = jest.spyOn(svc._watcher, 'stop');
      svc.stopWatching();
      expect(stopSpy).toHaveBeenCalled();
      stopSpy.mockRestore();
    });

    test('setModelsDir is a no-op on the watcher when none exists yet', () => {
      svc._watcher = null;
      expect(() => svc.setModelsDir('/x')).not.toThrow();
      expect(svc._watcher).toBeNull();
    });
  });

  test('getModelInfo delegates to ggufInfo for a plain gguf path', () => {
    const dir = svc.ensureModelsDir();
    const f = path.join(dir, 'gi.Q4_K_M.gguf');
    fs.writeFileSync(f, 'data');
    const info = svc.getModelInfo(f);
    expect(info).toBeTruthy();
    expect(info.quantization).toBe('Q4_K_M');
  });
});
