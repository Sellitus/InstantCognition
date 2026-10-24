const {
  LLM_BACKENDS,
  MLX_BACKENDS,
  BACKEND_COMMAND_BUILDERS,
  buildMlxOpenAiCommand,
  buildOmlxCommand,
  buildVllmCommand,
  isMlxBackend,
  isPythonBackend,
  isHfRepoId,
  mergeStartOpts,
  resolvePerModelOverride,
  applyOverrideToCfg,
  persistResolvedEnginePath,
  DEFAULT_LLM_SETTINGS,
} = require('../../../shared/llmDefaults');

describe('shared/llmDefaults', () => {
  test('LLM_BACKENDS lists the four local runtimes plus remote; MLX_BACKENDS the two MLX ones', () => {
    expect(LLM_BACKENDS).toEqual(['llamaCpp', 'mlxOpenAi', 'omlx', 'vllm', 'remote']);
    expect(MLX_BACKENDS).toEqual(['mlxOpenAi', 'omlx']);
  });

  test('BACKEND_COMMAND_BUILDERS has a builder per local runtime', () => {
    expect(BACKEND_COMMAND_BUILDERS.mlxOpenAi).toBe(buildMlxOpenAiCommand);
    expect(BACKEND_COMMAND_BUILDERS.omlx).toBe(buildOmlxCommand);
    expect(BACKEND_COMMAND_BUILDERS.vllm).toBe(buildVllmCommand);
    expect(BACKEND_COMMAND_BUILDERS.mlxLm).toBeUndefined();
    // The legacy umbrella id MUST NOT be a registered builder anymore — callers
    // must reach mlxOpenAi via mergeStartOpts normalization first.
    expect(BACKEND_COMMAND_BUILDERS.mlx).toBeUndefined();
  });

  test('isMlxBackend recognizes both MLX runtimes and rejects the legacy umbrella and retired mlxLm', () => {
    expect(isMlxBackend('mlxOpenAi')).toBe(true);
    expect(isMlxBackend('omlx')).toBe(true);
    expect(isMlxBackend('mlxLm')).toBe(false);
    expect(isMlxBackend('mlx')).toBe(false);
    expect(isMlxBackend('llamaCpp')).toBe(false);
    expect(isMlxBackend('vllm')).toBe(false);
  });

  test('isPythonBackend covers the MLX runtimes and vLLM only', () => {
    expect(isPythonBackend('mlxOpenAi')).toBe(true);
    expect(isPythonBackend('omlx')).toBe(true);
    expect(isPythonBackend('vllm')).toBe(true);
    expect(isPythonBackend('llamaCpp')).toBe(false);
    expect(isPythonBackend('remote')).toBe(false);
  });

  test('DEFAULT_LLM_SETTINGS has shared mlx + per-runtime sub-blocks', () => {
    expect(DEFAULT_LLM_SETTINGS.mlx).toEqual({ fallbackEnabled: true });
    expect(DEFAULT_LLM_SETTINGS.mlxOpenAi).toEqual(expect.objectContaining({ pythonPath: null, contextLength: 65536, enableAutoToolChoice: true, forceTextOnly: false }));
    expect(DEFAULT_LLM_SETTINGS.omlx).toEqual({ pythonPath: null, contextLength: 65536, maxConcurrentRequests: 8, memoryGuard: 'balanced' });
    expect(DEFAULT_LLM_SETTINGS).not.toHaveProperty('mlxLm');
  });

  test('DEFAULT_LLM_SETTINGS has per-model overlay and vllm seats', () => {
    expect(DEFAULT_LLM_SETTINGS.perModelOverrides).toEqual({});
    expect(DEFAULT_LLM_SETTINGS.vllm).toEqual({
      pythonPath: null, tensorParallelSize: 1, gpuMemoryUtilization: 0.92, maxModelLen: 0,
      dtype: 'auto', trustRemoteCode: false, toolParser: 'auto',
    });
    expect(DEFAULT_LLM_SETTINGS.engineUpdatePrompted).toEqual({ llamaCpp: null, mlx: null, omlx: null, vllm: null });
  });

  describe('isHfRepoId', () => {
    test('accepts org/name repo ids', () => {
      expect(isHfRepoId('Qwen/Qwen3-8B')).toBe(true);
      expect(isHfRepoId('meta-llama/Llama-3.1-8B-Instruct')).toBe(true);
      expect(isHfRepoId('mlx-community/Qwen2.5-0.5B_v1.2')).toBe(true);
    });

    test('rejects local paths, plain names and empty values', () => {
      expect(isHfRepoId('/home/me/models/Qwen3-8B')).toBe(false);
      expect(isHfRepoId('/models/x')).toBe(false);
      expect(isHfRepoId('C:\\models\\Qwen3-8B')).toBe(false);
      expect(isHfRepoId('C:/models/Qwen3-8B')).toBe(false);
      expect(isHfRepoId('./Qwen/Qwen3-8B')).toBe(false);
      expect(isHfRepoId('Qwen3-8B')).toBe(false);
      expect(isHfRepoId('a/b/c')).toBe(false);
      expect(isHfRepoId('')).toBe(false);
      expect(isHfRepoId(null)).toBe(false);
    });
  });

  describe('buildMlxOpenAiCommand', () => {
    test('runs the mlx-openai-server entry point through the venv interpreter', () => {
      const { command, args } = buildMlxOpenAiCommand({
        pythonPath: '/venv/bin/python3', modelPath: '/m', port: 8421,
      });
      expect(command).toBe('/venv/bin/python3');
      expect(args.slice(0, 4)).toEqual(['-I', '-c', 'import sys; from app.cli import cli; sys.exit(cli())', 'launch']);
      expect(args).toContain('--no-log-file');
    });
  });

  describe('mergeStartOpts', () => {
    test('legacy backend "mlx" normalizes to mlxOpenAi even with serverImpl="legacy" (mlx_lm.server is retired)', () => {
      const merged = mergeStartOpts({ backend: 'mlx', modelPath: '/m', port: 8421, pythonPath: '/p' }, { mlx: { serverImpl: 'legacy' } });
      expect(merged.backend).toBe('mlxOpenAi');
      expect(merged.pythonPath).toBe('/p');
    });

    test('legacy backend "mlx" without serverImpl normalizes to mlxOpenAi', () => {
      const merged = mergeStartOpts({ backend: 'mlx', modelPath: '/m', port: 8421, pythonPath: '/p' }, {});
      expect(merged.backend).toBe('mlxOpenAi');
    });

    test('mlxOpenAi pulls per-runtime config over legacy mlx config', () => {
      const merged = mergeStartOpts({ backend: 'mlxOpenAi', modelPath: '/m', port: 8421 }, {
        mlxOpenAi: { pythonPath: '/new/python', contextLength: 4096, enableAutoToolChoice: false, forceTextOnly: false },
        mlx: { pythonPath: '/legacy/python', contextLength: 8192 },
      });
      expect(merged.pythonPath).toBe('/new/python');
      expect(merged.contextLength).toBe(4096);
      expect(merged.enableAutoToolChoice).toBe(false);
    });

    test('omlx pulls its own config block and falls back to its defaults', () => {
      const merged = mergeStartOpts({ backend: 'omlx', modelPath: '/m', port: 8421 }, {
        omlx: { pythonPath: '/omlx/bin/python3', contextLength: 32768, maxConcurrentRequests: 2, memoryGuard: 'safe' },
        mlxOpenAi: { pythonPath: '/mlx/bin/python3', contextLength: 4096 },
      });
      expect(merged).toEqual({
        backend: 'omlx', modelPath: '/m', port: 8421, host: '127.0.0.1',
        pythonPath: '/omlx/bin/python3', contextLength: 32768, maxConcurrentRequests: 2, memoryGuard: 'safe', modelType: 'lm',
      });
      const defaults = mergeStartOpts({ backend: 'omlx', modelPath: '/m', port: 1 }, {});
      expect(defaults.contextLength).toBe(65536);
      expect(defaults.maxConcurrentRequests).toBe(8);
      expect(defaults.memoryGuard).toBe('balanced');
    });

    test('vllm merges call > config > default and carries toolParser (not the old auto-tool switch)', () => {
      const merged = mergeStartOpts({ backend: 'vllm', modelPath: 'Qwen/Qwen3-8B', port: 8000, maxModelLen: 16384 }, {
        vllm: { pythonPath: '/v/bin/python3', maxModelLen: 8192, gpuMemoryUtilization: 0.8, toolParser: 'hermes', enableAutoToolChoice: true },
      });
      expect(merged.pythonPath).toBe('/v/bin/python3');
      expect(merged.maxModelLen).toBe(16384);
      expect(merged.gpuMemoryUtilization).toBe(0.8);
      expect(merged.toolParser).toBe('hermes');
      expect(merged).not.toHaveProperty('enableAutoToolChoice');
      const defaults = mergeStartOpts({ backend: 'vllm', modelPath: '/m', port: 1 }, {});
      expect(defaults.gpuMemoryUtilization).toBe(0.92);
      expect(defaults.maxModelLen).toBe(0);
      expect(defaults.toolParser).toBe('auto');
      expect(defaults.tensorParallelSize).toBe(1);
    });

    test('honors persisted activeBackend when caller leaves backend unset', () => {
      const merged = mergeStartOpts({ modelPath: '/m', port: 8421, pythonPath: '/p' }, { activeBackend: 'omlx' });
      expect(merged.backend).toBe('omlx');
    });
  });

  describe('per-model overrides', () => {
    test('resolvePerModelOverride matches full path then basename', () => {
      const overrides = { '/abs/path/llama.gguf': { flags: { contextSize: 4096 } } };
      expect(resolvePerModelOverride(overrides, '/abs/path/llama.gguf')).toEqual({ flags: { contextSize: 4096 } });
      // basename match catches a model moved to a different dir
      expect(resolvePerModelOverride(overrides, '/moved/llama.gguf')).toEqual({ flags: { contextSize: 4096 } });
      expect(resolvePerModelOverride(overrides, '/other.gguf')).toBeNull();
      expect(resolvePerModelOverride(null, '/m')).toBeNull();
    });

    test('applyOverrideToCfg folds flags into the backend sub-block without mutating input', () => {
      const cfg = { llamaCpp: { contextSize: 8192, gpuLayers: -1 } };
      const out = applyOverrideToCfg(cfg, 'llamaCpp', { contextSize: 32768 });
      expect(out.llamaCpp.contextSize).toBe(32768);
      expect(out.llamaCpp.gpuLayers).toBe(-1); // untouched key preserved
      expect(cfg.llamaCpp.contextSize).toBe(8192); // input not mutated
    });

    test('override backend switches the resolved backend', () => {
      const merged = mergeStartOpts(
        { modelPath: '/m.gguf', port: 8421, binaryPath: '/b' },
        { perModelOverrides: { '/m.gguf': { backend: 'llamaCpp' } }, activeBackend: 'mlxOpenAi' },
      );
      expect(merged.backend).toBe('llamaCpp');
    });

    test('precedence: call opts > per-model override > global default', () => {
      const cfg = {
        llamaCpp: { contextSize: 8192 },
        perModelOverrides: { '/m.gguf': { flags: { contextSize: 32768 } } },
      };
      // override beats global
      let merged = mergeStartOpts({ modelPath: '/m.gguf', port: 8421, binaryPath: '/b' }, cfg);
      expect(merged.contextSize).toBe(32768);
      // call opt beats override
      merged = mergeStartOpts({ modelPath: '/m.gguf', port: 8421, binaryPath: '/b', contextSize: 131072 }, cfg);
      expect(merged.contextSize).toBe(131072);
    });

    test('override does not leak to a different model', () => {
      const cfg = { llamaCpp: { contextSize: 8192 }, perModelOverrides: { '/a.gguf': { flags: { contextSize: 32768 } } } };
      const merged = mergeStartOpts({ modelPath: '/b.gguf', port: 8421, binaryPath: '/b' }, cfg);
      expect(merged.contextSize).toBe(8192); // global, no override for this model
    });

    test('remote backend override is ignored (never switched)', () => {
      const merged = mergeStartOpts(
        { modelPath: '/m.gguf', port: 8421 },
        { activeBackend: 'llamaCpp', perModelOverrides: { '/m.gguf': { backend: 'remote' } } },
      );
      expect(merged.backend).toBe('llamaCpp');
    });
  });

  describe('persistResolvedEnginePath', () => {
    // Each python runtime has its own interpreter (oMLX pins a conflicting
    // mlx build), so a resolved path is written to that backend's block only.
    test.each([
      ['mlxOpenAi', '/mlx/bin/python3'],
      ['omlx', '/omlx/bin/python3'],
      ['vllm', '/opt/instantcognition/vllm-venv/bin/python3'],
    ])('writes pythonPath to the %s block only', (backend, py) => {
      const sets = [];
      const cs = { set: (k, v) => sets.push([k, v]) };
      persistResolvedEnginePath(cs, { backend, pythonPath: py });
      expect(sets).toEqual([[`settings.llm.${backend}.pythonPath`, py]]);
    });

    test('writes nothing for a python backend without a resolved path', () => {
      const sets = [];
      persistResolvedEnginePath({ set: (k, v) => sets.push([k, v]) }, { backend: 'omlx', pythonPath: null });
      expect(sets).toEqual([]);
    });

    test('writes binaryPath for llamaCpp backend', () => {
      const sets = [];
      const cs = { set: (k, v) => sets.push([k, v]) };
      persistResolvedEnginePath(cs, { backend: 'llamaCpp', binaryPath: '/usr/bin/llama-server' });
      expect(sets).toEqual([['settings.llm.llamaCpp.binaryPath', '/usr/bin/llama-server']]);
    });
  });
});
