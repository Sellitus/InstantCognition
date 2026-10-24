const {
  ENGINES,
  BACKENDS,
  getBackend,
  listBackends,
  buildCommand,
  settingsForBackend,
  composeBackendsPayload,
} = require('../../../shared/engineSchema');

describe('shared/engineSchema', () => {
  describe('backend registry', () => {
    test('declares the llm backends the app supports today', () => {
      expect(BACKENDS.llamaCpp).toBeDefined();
      expect(BACKENDS.mlxOpenAi).toBeDefined();
      expect(BACKENDS.omlx).toBeDefined();
      expect(BACKENDS.vllm).toBeDefined();
    });

    test('mlx_lm.server is no longer a backend', () => {
      expect(BACKENDS.mlxLm).toBeUndefined();
      expect(getBackend('mlxLm')).toBeNull();
      expect(() => buildCommand('mlxLm', {})).toThrow('unknown backend: mlxLm');
    });

    test('every backend names an engine kind from the known set', () => {
      for (const b of Object.values(BACKENDS)) {
        expect(ENGINES).toContain(b.engine);
      }
    });

    test('listBackends filters by engine and platform', () => {
      const llm = listBackends({ engine: 'llm' });
      expect(llm.map((b) => b.id).sort()).toEqual(['llamaCpp', 'mlxOpenAi', 'omlx', 'vllm']);
      const onMac = listBackends({ engine: 'llm', platform: 'darwin' });
      expect(onMac.map((b) => b.id).sort()).toEqual(['llamaCpp', 'mlxOpenAi', 'omlx']);
      const onLinux = listBackends({ engine: 'llm', platform: 'linux' });
      expect(onLinux.map((b) => b.id).sort()).toEqual(['llamaCpp', 'vllm']);
      const onWindows = listBackends({ engine: 'llm', platform: 'win32' });
      expect(onWindows.map((b) => b.id).sort()).toEqual(['llamaCpp', 'vllm']);
    });

    test('vllm is CUDA-only and never offered on macOS', () => {
      expect(BACKENDS.vllm.cudaOnly).toBe(true);
      expect(BACKENDS.vllm.platforms).not.toContain('darwin');
    });
  });

  // ---- PARITY: schema buildCommand must equal today's hand-built args --------
  // These mirror the exact output of llmDefaults.buildLlamaCppCommand and
  // friends. If the schema drifts, the LLMService spawn breaks silently.
  describe('buildCommand parity — llamaCpp', () => {
    const base = () => ({
      binaryPath: '/usr/bin/llama-server', modelPath: '/m/gguf', port: 8421,
      host: '127.0.0.1', contextSize: 65536, threads: 0, gpuLayers: -1,
      flashAttention: true, cacheTypeK: 'q8_0', cacheTypeV: 'q5_1',
      batchSize: 2048, ubatchSize: 512, parallel: 4,
      mlock: false, noMmap: false, contBatching: true, jinja: false,
    });

    test('reproduces the default llama-server arg set', () => {
      const { command, args } = buildCommand('llamaCpp', base());
      expect(command).toBe('/usr/bin/llama-server');
      expect(args).toEqual([
        '--model', '/m/gguf', '--port', '8421', '--host', '127.0.0.1',
        '--ctx-size', '65536',
        '--n-gpu-layers', '-1',
        '--flash-attn', 'on',
        '--cache-type-k', 'q8_0', '--cache-type-v', 'q5_1',
        '--batch-size', '2048', '--ubatch-size', '512', '--parallel', '4',
      ]);
    });

    test('omits threads when <= 0 (matches buildLlamaCppCommand guard)', () => {
      const { args } = buildCommand('llamaCpp', { ...base(), threads: 0 });
      expect(args).not.toContain('--threads');
    });

    test('emits threads when > 0', () => {
      const { args } = buildCommand('llamaCpp', { ...base(), threads: 8 });
      expect(args).toContain('--threads');
      expect(args).toContain('8');
    });

    test('emits --mmproj when a vision projector path is present', () => {
      const { args } = buildCommand('llamaCpp', { ...base(), mmprojPath: '/m/mmproj.gguf' });
      expect(args).toContain('--mmproj');
      expect(args).toContain('/m/mmproj.gguf');
    });

    test('emits --mlock / --no-mmap when truthy, omits when falsy', () => {
      const on = buildCommand('llamaCpp', { ...base(), mlock: true, noMmap: true }).args;
      expect(on).toContain('--mlock');
      expect(on).toContain('--no-mmap');
      const off = buildCommand('llamaCpp', { ...base(), mlock: false, noMmap: false }).args;
      expect(off).not.toContain('--mlock');
      expect(off).not.toContain('--no-mmap');
    });

    test('contBatching=false emits --no-cont-batching; true omits it', () => {
      const off = buildCommand('llamaCpp', { ...base(), contBatching: false }).args;
      expect(off).toContain('--no-cont-batching');
      const on = buildCommand('llamaCpp', { ...base(), contBatching: true }).args;
      expect(on).not.toContain('--no-cont-batching');
    });

    test('jinja=true emits --jinja', () => {
      expect(buildCommand('llamaCpp', { ...base(), jinja: true }).args).toContain('--jinja');
    });

    test('flashAttention=false omits --flash-attn', () => {
      expect(buildCommand('llamaCpp', { ...base(), flashAttention: false }).args).not.toContain('--flash-attn');
    });

    test('throws on missing required modelPath (fail loud, never half-spawn)', () => {
      const bad = base(); delete bad.modelPath;
      expect(() => buildCommand('llamaCpp', bad)).toThrow(/modelPath/);
    });
  });

  describe('buildCommand parity — mlxOpenAi', () => {
    const base = () => ({
      pythonPath: '/venv/bin/python3', modelPath: '/m/mlx', port: 8421,
      host: '127.0.0.1', modelType: 'lm', contextLength: 65536, enableAutoToolChoice: true,
    });

    // The pip-written `mlx-openai-server` script carries an absolute shebang to
    // the build machine, so the bundled runtime is launched through its
    // interpreter, isolated (-I) so a cwd folder named `app` cannot shadow it.
    test('reproduces the mlx-openai-server launch line through the interpreter', () => {
      const { command, args } = buildCommand('mlxOpenAi', base());
      expect(command).toBe('/venv/bin/python3');
      expect(args).toEqual([
        '-I', '-c', 'import sys; from app.cli import cli; sys.exit(cli())', 'launch', '--model-path', '/m/mlx', '--model-type', 'lm',
        '--port', '8421', '--host', '127.0.0.1', '--no-log-file',
        '--context-length', '65536', '--enable-auto-tool-choice',
      ]);
    });

    test('multimodal modelType is passed through', () => {
      const { args } = buildCommand('mlxOpenAi', { ...base(), modelType: 'multimodal' });
      expect(args).toContain('--model-type');
      expect(args).toContain('multimodal');
    });

    test('enableAutoToolChoice=false omits the flag', () => {
      const { args } = buildCommand('mlxOpenAi', { ...base(), enableAutoToolChoice: false });
      expect(args).not.toContain('--enable-auto-tool-choice');
    });

    test('contextLength=0 omits --context-length (use model default)', () => {
      const { args } = buildCommand('mlxOpenAi', { ...base(), contextLength: 0 });
      expect(args).not.toContain('--context-length');
    });
  });

  describe('buildCommand — oMLX', () => {
    const base = () => ({
      pythonPath: '/rt/bin/python3', modelPath: '/m/Qwen3-8B-4bit', basePath: '/ud/engines/omlx-home',
      port: 8421, host: '127.0.0.1', maxConcurrentRequests: 8, memoryGuard: 'balanced',
    });

    // The pip-written `omlx` script carries an absolute shebang to the build
    // machine, so the bundled runtime must be launched through its interpreter.
    test('runs <python> -I -m omlx.cli serve with the model folder and private base path', () => {
      const { command, args } = buildCommand('omlx', base());
      expect(command).toBe('/rt/bin/python3');
      expect(args).toEqual([
        '-I', '-m', 'omlx.cli', 'serve', '--model-dir', '/m/Qwen3-8B-4bit', '--no-hf-cache',
        '--base-path', '/ud/engines/omlx-home', '--port', '8421', '--host', '127.0.0.1',
        '--max-concurrent-requests', '8', '--memory-guard', 'balanced',
      ]);
    });

    test('maxConcurrentRequests <= 0 is omitted', () => {
      expect(buildCommand('omlx', { ...base(), maxConcurrentRequests: 0 }).args).not.toContain('--max-concurrent-requests');
    });

    test('throws without a base path (never touches ~/.omlx)', () => {
      expect(() => buildCommand('omlx', { ...base(), basePath: undefined })).toThrow('missing required flag basePath');
    });
  });

  describe('buildCommand — vLLM', () => {
    const base = () => ({
      pythonPath: '/opt/instantcognition/vllm-venv/bin/python3', modelPath: '/mnt/c/m/Qwen3-8B',
      servedModelName: 'Qwen3-8B', port: 8000, host: '127.0.0.1', tensorParallelSize: 1,
      gpuMemoryUtilization: 0.92, maxModelLen: 0, dtype: 'auto', trustRemoteCode: false,
    });

    test('launches `vllm serve <model>` from the venv with the served name', () => {
      const { command, args } = buildCommand('vllm', base());
      expect(command).toBe('/opt/instantcognition/vllm-venv/bin/vllm');
      expect(args).toEqual([
        'serve', '/mnt/c/m/Qwen3-8B', '--served-model-name', 'Qwen3-8B',
        '--port', '8000', '--host', '127.0.0.1', '--tensor-parallel-size', '1',
        '--gpu-memory-utilization', '0.92', '--dtype', 'auto',
      ]);
    });

    // vLLM refuses to start with --enable-auto-tool-choice but no parser.
    test('no tool parser → neither tool flag is emitted', () => {
      const { args } = buildCommand('vllm', base());
      expect(args).not.toContain('--enable-auto-tool-choice');
      expect(args).not.toContain('--tool-call-parser');
      expect(buildCommand('vllm', { ...base(), toolCallParser: null }).args).not.toContain('--enable-auto-tool-choice');
    });

    test('a tool parser emits --enable-auto-tool-choice followed by --tool-call-parser', () => {
      const { args } = buildCommand('vllm', { ...base(), toolCallParser: 'hermes' });
      expect(args.slice(-3)).toEqual(['--enable-auto-tool-choice', '--tool-call-parser', 'hermes']);
    });

    test('honors max-model-len only when > 0', () => {
      const { args } = buildCommand('vllm', { ...base(), maxModelLen: 32768 });
      expect(args).toContain('--max-model-len');
      expect(args).toContain('32768');
      expect(buildCommand('vllm', base()).args).not.toContain('--max-model-len');
    });

    test('trustRemoteCode=true emits --trust-remote-code', () => {
      expect(buildCommand('vllm', { ...base(), trustRemoteCode: true }).args).toContain('--trust-remote-code');
    });

    test('throws without a model or served name', () => {
      expect(() => buildCommand('vllm', { ...base(), modelPath: undefined })).toThrow('missing required flag modelPath');
      expect(() => buildCommand('vllm', { ...base(), servedModelName: undefined })).toThrow('missing required flag servedModelName');
    });

    test('tool flags and the served name are not user settings', () => {
      const ids = settingsForBackend('vllm').map((d) => d.id);
      expect(ids).not.toContain('llm.vllm.toolCallParser');
      expect(ids).not.toContain('llm.vllm.autoToolChoice');
      expect(ids).not.toContain('llm.vllm.servedModelName');
      expect(ids).toContain('llm.vllm.gpuMemoryUtilization');
    });
  });

  describe('buildCommand — flag kinds', () => {
    const withBackend = (flags, fn) => {
      BACKENDS.__kindTest = { engine: 'llm', platforms: [], command: 'x', flags };
      try { return fn(); } finally { delete BACKENDS.__kindTest; }
    };

    test('a literal emits unconditionally without `when`, and only when `when` holds with one', () => {
      const args = (values) => withBackend([
        { key: 'a', kind: 'literal', flag: '--always' },
        { key: 'b', kind: 'literal', flag: '--gated', when: (_v, all) => all.on === true },
      ], () => buildCommand('__kindTest', values).args);
      expect(args({})).toEqual(['--always']);
      expect(args({ on: true })).toEqual(['--always', '--gated']);
      expect(args({ on: 'yes' })).toEqual(['--always']);
    });

    test('a positional emits its bare value in declaration order, and throws when required and missing', () => {
      const flags = [
        { key: 'cmd', kind: 'literal', flag: 'run' },
        { key: 'target', kind: 'positional', required: true },
        { key: 'n', kind: 'value', flag: '-n' },
      ];
      expect(withBackend(flags, () => buildCommand('__kindTest', { target: 42, n: 1 }).args)).toEqual(['run', '42', '-n', '1']);
      expect(() => withBackend(flags, () => buildCommand('__kindTest', {}))).toThrow('missing required flag target');
    });
  });

  describe('settings generation (programmatic UI)', () => {
    test('settingsForBackend returns one def per tunable flag', () => {
      const defs = settingsForBackend('llamaCpp');
      const ids = defs.map((d) => d.id);
      expect(ids).toContain('llm.llamaCpp.contextSize');
      expect(ids).toContain('llm.llamaCpp.gpuLayers');
      expect(ids).toContain('llm.llamaCpp.cacheTypeK');
      // internal/metadata flags are NOT surfaced as settings
      expect(ids).not.toContain('llm.llamaCpp.modelPath');
    });

    test('contextSize becomes a number-typed def bound to the config path', () => {
      const ctx = settingsForBackend('llamaCpp').find((d) => d.id === 'llm.llamaCpp.contextSize');
      expect(ctx.type).toBe('number');
      expect(ctx.path).toBe('settings.llm.llamaCpp.contextSize');
      expect(ctx.min).toBe(512);
    });

    test('enum flag (vllm dtype) becomes a select', () => {
      const dtype = settingsForBackend('vllm').find((d) => d.id === 'llm.vllm.dtype');
      expect(dtype.type).toBe('select');
      expect(dtype.options.map((o) => o.value)).toContain('bfloat16');
    });

    test('bool flag (flash attention) becomes a toggle', () => {
      const fa = settingsForBackend('llamaCpp').find((d) => d.id === 'llm.llamaCpp.flashAttention');
      expect(fa.type).toBe('toggle');
    });

    test('unknown backend yields no settings', () => {
      expect(settingsForBackend('nope')).toEqual([]);
    });
  });

  describe('getBackend', () => {
    test('returns null for unknown ids', () => {
      expect(getBackend('nope')).toBeNull();
    });
  });

  describe('composeBackendsPayload', () => {
    test('annotates each backend with installed/active from detection + config', () => {
      const det = { llamaCpp: { available: true }, mlxOpenAi: { available: false }, omlx: { available: true } };
      const out = composeBackendsPayload(det, 'llamaCpp', null, 'darwin');
      const byId = Object.fromEntries(out.map((b) => [b.id, b]));
      expect(byId.llamaCpp.installed).toBe(true);
      expect(byId.llamaCpp.active).toBe(true);
      expect(byId.mlxOpenAi.installed).toBe(false);
      expect(byId.mlxOpenAi.active).toBe(false);
      expect(byId.omlx.installed).toBe(true);
      expect(byId.mlxLm).toBeUndefined();
      // vllm is platform-gated (linux/win32 only) and absent on darwin.
      expect(byId.vllm).toBeUndefined();
      // remote pseudo-backend is always present so the popover can offer it.
      expect(byId.remote).toBeDefined();
      expect(byId.remote.installed).toBe(false);
    });

    test('remote counts as installed only when an endpoint is configured', () => {
      const det = {};
      const noRemote = composeBackendsPayload(det, null, null, 'darwin');
      const withRemote = composeBackendsPayload(det, null, { endpoint: 'http://x' }, 'darwin');
      expect(noRemote.find((b) => b.id === 'remote').installed).toBe(false);
      expect(withRemote.find((b) => b.id === 'remote').installed).toBe(true);
    });

    test('marks the active backend even when not installed', () => {
      const out = composeBackendsPayload({}, 'omlx', null, 'darwin');
      expect(out.find((b) => b.id === 'omlx').active).toBe(true);
      expect(out.find((b) => b.id === 'omlx').installed).toBe(false);
    });

    test('empty detection yields only the remote pseudo-backend (unconfigured)', () => {
      const out = composeBackendsPayload({}, null, null, 'darwin');
      expect(out.filter((b) => b.installed)).toEqual([]);
      expect(out.map((b) => b.id)).toContain('remote');
    });

    test('remote pseudo-backend is appended on linux too', () => {
      const out = composeBackendsPayload({ llamaCpp: { available: true }, vllm: { available: true } }, null, null, 'linux');
      expect(out.map((b) => b.id)).toEqual(['llamaCpp', 'vllm', 'remote']);
      expect(out.find((b) => b.id === 'vllm').installed).toBe(true);
    });
  });
});
