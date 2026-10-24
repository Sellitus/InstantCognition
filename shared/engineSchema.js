// engineSchema — declarative source of truth for inference backends.
//
// Each backend declares its engine kind, capability flags, platform support,
// and the CLI/server flags it accepts. A single generic builder turns a set
// of values into { command, args }, and flagToSettingDef() turns a flag into a
// settings-registry row. Adding a backend or a flag is a data edit here, not a
// new code branch — the settings UI and the CLI builder both read this table.
//
// Flag shapes:
//   { key, kind: 'literal'|'positional'|'value'|'bool'|'count', flag, arg?: 'joined'|'separate',
//     default, platform?: 'cuda', requires?: [flagKey], when?: (v,all)=>bool,
//     label, hint?, min?, max?, step?, enum?, advanced? }
//   kind 'literal'    — emits `flag` as-is, unless its `when` is false
//   kind 'positional' — emits the bare value
//   kind 'value'  — emits `flag value` (or `flag=value` if arg:'joined') when v != null
//   kind 'bool'   — emits `flag` alone when truthy; `flag on/off` if onOff:true
//   kind 'count'  — emits `flag N`
//
// The command target (the binary / python -m / CLI) is backend-specific:
// `command` may be a string (resolved value) or a function(opts) → string.

// The renderer bundles this schema and has no Node path module.
function posixSibling(file, name) {
  const cut = file.lastIndexOf('/');
  if (cut < 0) return name;
  return `${file.slice(0, cut)}/${name}`;
}

const ENGINES = ['llm', 'embedding', 'reranker', 'tts', 'stt', 'image'];

const BACKENDS = {
  // ---- llama.cpp (llama-server) — Apple Silicon + CPU + CUDA ----------------
  llamaCpp: {
    engine: 'llm',
    label: 'llama.cpp',
    openAiCompat: true,
    toolSupport: true,
    platforms: ['darwin', 'linux', 'win32'],
    command: (o) => o.binaryPath,
    flags: [
      { key: 'modelPath', kind: 'value', flag: '--model', required: true, setting: false },
      { key: 'port', kind: 'value', flag: '--port', required: true, setting: false },
      { key: 'host', kind: 'value', flag: '--host', default: '127.0.0.1', setting: false },
      { key: 'contextSize', kind: 'value', flag: '--ctx-size', default: 65536, min: 512 },
      { key: 'mmprojPath', kind: 'value', flag: '--mmproj', optional: true },
      { key: 'threads', kind: 'value', flag: '--threads', when: (v) => typeof v === 'number' && v > 0 },
      { key: 'gpuLayers', kind: 'value', flag: '--n-gpu-layers', when: (v) => typeof v === 'number' },
      { key: 'flashAttention', kind: 'bool', flag: '--flash-attn', onOff: true, default: true },
      { key: 'cacheTypeK', kind: 'value', flag: '--cache-type-k', default: 'q8_0' },
      { key: 'cacheTypeV', kind: 'value', flag: '--cache-type-v', default: 'q5_1' },
      { key: 'batchSize', kind: 'value', flag: '--batch-size', when: (v) => typeof v === 'number' && v > 0, default: 2048 },
      { key: 'ubatchSize', kind: 'value', flag: '--ubatch-size', when: (v) => typeof v === 'number' && v > 0, default: 512 },
      { key: 'parallel', kind: 'value', flag: '--parallel', when: (v) => typeof v === 'number' && v > 0, default: 4 },
      { key: 'mlock', kind: 'bool', flag: '--mlock', default: false },
      { key: 'noMmap', kind: 'bool', flag: '--no-mmap', default: false },
      { key: 'contBatching', kind: 'bool', flag: '--no-cont-batching', invert: true, default: true },
      { key: 'jinja', kind: 'bool', flag: '--jinja', default: false },
    ],
  },

  // ---- mlx-openai-server — subprocess-per-model HTTP server (Apple Silicon) -
  mlxOpenAi: {
    engine: 'llm',
    label: 'MLX (mlx-openai-server)',
    openAiCompat: true,
    toolSupport: true,
    platforms: ['darwin'],
    // Run through the interpreter: pip writes the `mlx-openai-server` script
    // with an absolute shebang, which points at the build machine once
    // bundled. The package ships no __main__, so its click entry is called
    // directly. -I keeps the working directory off sys.path, where any
    // folder named `app` would shadow the package.
    command: (o) => o.pythonPath,
    flags: [
      { key: 'isolated', kind: 'literal', flag: '-I' },
      { key: 'entry', kind: 'literal', flag: '-c' },
      { key: 'entryCode', kind: 'literal', flag: 'import sys; from app.cli import cli; sys.exit(cli())' },
      { key: 'mode', kind: 'literal', flag: 'launch' },
      { key: 'modelPath', kind: 'value', flag: '--model-path', required: true, setting: false },
      { key: 'modelType', kind: 'value', flag: '--model-type', default: 'lm', setting: false },
      { key: 'port', kind: 'value', flag: '--port', required: true, setting: false },
      { key: 'host', kind: 'value', flag: '--host', default: '127.0.0.1', setting: false },
      { key: 'noLogFile', kind: 'literal', flag: '--no-log-file' },
      { key: 'contextLength', kind: 'value', flag: '--context-length', when: (v) => typeof v === 'number' && v > 0, default: 65536 },
      { key: 'enableAutoToolChoice', kind: 'bool', flag: '--enable-auto-tool-choice', default: true },
    ],
  },

  // ---- oMLX — continuous-batching MLX server with a paged SSD KV cache -------
  // --model-dir takes the selected model folder itself, so the model's id is
  // that folder's name. oMLX has no flag for context length, pinning or the
  // default model; llm/omlxSettings.js writes those to <base-path> before launch.
  // Every serve flag passed is also saved into <base-path>/settings.json, so a
  // flag left out keeps its last value: tunables here always carry a default.
  omlx: {
    engine: 'llm',
    label: 'oMLX',
    openAiCompat: true,
    toolSupport: true,
    platforms: ['darwin'],
    // 503 until the pinned model finishes its startup preload.
    healthPath: '/health',
    healthTimeoutMs: 180000,
    // Run through the interpreter: pip writes the `omlx` script with an
    // absolute shebang, which points at the build machine once bundled. -I
    // keeps the working directory off sys.path.
    command: (o) => o.pythonPath,
    flags: [
      { key: 'isolated', kind: 'literal', flag: '-I' },
      { key: 'module', kind: 'literal', flag: '-m' },
      { key: 'moduleName', kind: 'literal', flag: 'omlx.cli' },
      { key: 'mode', kind: 'literal', flag: 'serve' },
      { key: 'modelPath', kind: 'value', flag: '--model-dir', required: true, setting: false },
      { key: 'noHfCache', kind: 'literal', flag: '--no-hf-cache' },
      { key: 'basePath', kind: 'value', flag: '--base-path', required: true, setting: false },
      { key: 'port', kind: 'value', flag: '--port', required: true, setting: false },
      { key: 'host', kind: 'value', flag: '--host', default: '127.0.0.1', setting: false },
      { key: 'maxConcurrentRequests', kind: 'value', flag: '--max-concurrent-requests', when: (v) => typeof v === 'number' && v > 0, default: 8, min: 1 },
      { key: 'memoryGuard', kind: 'value', flag: '--memory-guard', default: 'balanced', enum: ['off', 'safe', 'balanced', 'aggressive'] },
    ],
  },

  // ---- vLLM — high-throughput CUDA server (OpenAI-compat), NVIDIA only ------
  // Launched as `vllm serve <model>`, the CLI beside the venv's interpreter. On
  // Windows that interpreter lives inside the app's WSL distro, so paths are
  // POSIX and llm/backendRuntime.js wraps the command in wsl.exe. vLLM refuses
  // to start with --enable-auto-tool-choice unless --tool-call-parser names a
  // parser, so the first is emitted only alongside a resolved parser
  // (shared/vllmToolParsers.js); without one the agent uses its text protocol.
  vllm: {
    engine: 'llm',
    label: 'vLLM (NVIDIA)',
    openAiCompat: true,
    toolSupport: true,
    cudaOnly: true,
    platforms: ['linux', 'win32'],
    // The socket stays closed until the engine is ready; a first start compiles
    // CUDA graphs and may download the model from Hugging Face.
    healthPath: '/health',
    healthTimeoutMs: 1800000,
    command: (o) => posixSibling(o.pythonPath, 'vllm'),
    flags: [
      { key: 'mode', kind: 'literal', flag: 'serve' },
      { key: 'modelPath', kind: 'positional', required: true, setting: false },
      { key: 'servedModelName', kind: 'value', flag: '--served-model-name', required: true, setting: false },
      { key: 'port', kind: 'value', flag: '--port', required: true, setting: false },
      { key: 'host', kind: 'value', flag: '--host', default: '127.0.0.1', setting: false },
      { key: 'tensorParallelSize', kind: 'value', flag: '--tensor-parallel-size', when: (v) => typeof v === 'number' && v > 0, default: 1, min: 1 },
      { key: 'gpuMemoryUtilization', kind: 'value', flag: '--gpu-memory-utilization', when: (v) => typeof v === 'number' && v > 0 && v <= 1, default: 0.92, min: 0.1, max: 0.99, step: 0.01 },
      { key: 'maxModelLen', kind: 'value', flag: '--max-model-len', when: (v) => typeof v === 'number' && v > 0, default: 0, min: 0 },
      { key: 'dtype', kind: 'value', flag: '--dtype', default: 'auto', enum: ['auto', 'half', 'float16', 'bfloat16', 'float', 'float32'] },
      { key: 'trustRemoteCode', kind: 'bool', flag: '--trust-remote-code', default: false },
      { key: 'autoToolChoice', kind: 'literal', flag: '--enable-auto-tool-choice', when: (_v, all) => !!all.toolCallParser },
      { key: 'toolCallParser', kind: 'value', flag: '--tool-call-parser', setting: false },
    ],
  },
};

function getBackend(id) {
  return BACKENDS[id] || null;
}

function listBackends(opts = {}) {
  const { engine, platform } = opts;
  return Object.entries(BACKENDS)
    .filter(([, b]) => (!engine || b.engine === engine))
    .filter(([, b]) => (!platform || (b.platforms || []).includes(platform)))
    .map(([id, b]) => ({ id, ...b }));
}

/**
 * Build a { command, args } pair for a backend from a values object.
 * Values are pre-merged (call opts > per-model > global defaults) by the caller;
 * this function only projects the declared flags to CLI tokens.
 *
 * Emits each flag in declaration order. A flag participates when its value is
 * present and its `when` predicate (if any) is satisfied. 'literal' flags emit
 * a bare token. Required flags missing a value throw — fail loud, never spawn
 * a half-formed command.
 */
function buildCommand(backendId, values = {}) {
  const backend = BACKENDS[backendId];
  if (!backend) throw new Error(`unknown backend: ${backendId}`);
  const v = values || {};
  const args = [];
  for (const flag of backend.flags) {
    const { kind } = flag;
    const val = v[flag.key];

    if (kind === 'literal') {
      if (flag.flag != null && (!flag.when || flag.when(val, v))) args.push(flag.flag);
      continue;
    }

    if (flag.when && !flag.when(val, v)) {
      if (flag.required) throw new Error(`${backendId}: required flag ${flag.key} failed its condition`);
      continue;
    }
    if (val == null) {
      if (flag.required) throw new Error(`${backendId}: missing required flag ${flag.key}`);
      continue;
    }

    if (kind === 'positional') {
      args.push(String(val));
    } else if (kind === 'value') {
      const tok = flag.arg === 'joined' ? `${flag.flag}=${val}` : flag.flag;
      args.push(tok, String(val));
    } else if (kind === 'bool') {
      const on = flag.invert ? !val : !!val;
      if (!on) continue;
      if (flag.onOff) args.push(flag.flag, 'on');
      else args.push(flag.flag);
    } else if (kind === 'count') {
      args.push(flag.flag, String(val));
    }
  }
  const command = typeof backend.command === 'function' ? backend.command(v) : backend.command;
  return { command, args };
}

/**
 * Project a backend flag into a settings-registry setting def. Lets the UI be
 * generated from the same schema that builds the CLI, so a new backend flag
 * appears in settings with no manual UI wiring.
 */
function flagToSettingDef(backendId, flag) {
  if (!flag || flag.kind === 'literal') return null;
  if (flag.setting === false) return null;
  const def = {
    id: `llm.${backendId}.${flag.key}`,
    path: `settings.llm.${backendId}.${flag.key}`,
    title: flag.label || flag.key,
    description: flag.hint || '',
    advanced: !!flag.advanced,
  };
  if (flag.enum) {
    def.type = 'select';
    def.options = flag.enum.map((v) => ({ value: v, label: v }));
  } else if (flag.kind === 'bool') {
    def.type = 'toggle';
  } else if (typeof flag.min === 'number' && typeof flag.max === 'number') {
    def.type = 'slider';
    def.min = flag.min; def.max = flag.max; def.step = flag.step || 1;
  } else if (typeof flag.default === 'number') {
    def.type = 'number';
    if (flag.min != null) def.min = flag.min;
    if (flag.max != null) def.max = flag.max;
    if (flag.step != null) def.step = flag.step;
  } else {
    def.type = 'text';
  }
  if (flag.default != null) def.defaultValue = flag.default;
  return def;
}

// Backfill friendly labels/hints for flags that lacked them in the data above,
// so the generated settings rows read well. Centralized so the flag table stays terse.
const FLAG_LABELS = {
  llamaCpp: {
    contextSize: { label: 'Context size', hint: 'Prompt context length (n_ctx). Larger uses more RAM.' },
    threads: { label: 'CPU threads', hint: '0 = auto.' },
    gpuLayers: { label: 'GPU layers', hint: '-1 = all layers offloaded to GPU.' },
    flashAttention: { label: 'Flash attention', hint: 'Faster attention on supported models.' },
    cacheTypeK: { label: 'KV cache type (K)', hint: 'Quantization for the key cache.' },
    cacheTypeV: { label: 'KV cache type (V)', hint: 'Quantization for the value cache.' },
    batchSize: { label: 'Batch size', hint: 'Logical batch size for prompt processing.' },
    ubatchSize: { label: 'Micro-batch size', hint: 'Physical batch size for prompt processing.' },
    parallel: { label: 'Parallel slots', hint: 'Decoding slots the server holds open.' },
    mlock: { label: 'Lock model in RAM (mlock)' },
    noMmap: { label: 'Disable mmap (load fully into RAM)' },
    contBatching: { label: 'Continuous batching' },
    jinja: { label: 'Use Jinja chat template' },
  },
  mlxOpenAi: {
    contextLength: { label: 'Context length', hint: '0 = use the model default.' },
    enableAutoToolChoice: { label: 'Auto tool choice', hint: 'Enable OpenAI-style tool calling.' },
  },
  omlx: {
    maxConcurrentRequests: { label: 'Concurrent requests', hint: 'Requests batched together. Higher raises throughput and memory use.' },
    memoryGuard: { label: 'Memory guard', hint: 'How much RAM oMLX leaves free for other apps.' },
  },
  vllm: {
    tensorParallelSize: { label: 'Tensor parallel size', hint: 'Number of GPUs to split the model across.' },
    gpuMemoryUtilization: { label: 'GPU memory utilization', hint: 'Fraction (0–1) of GPU memory vLLM may use.' },
    maxModelLen: { label: 'Max model length', hint: 'Maximum context in tokens. 0 = the model default.' },
    dtype: { label: 'Data type', hint: 'auto picks a sensible default for the model.' },
    trustRemoteCode: { label: 'Trust remote code', hint: 'Run Python code shipped in the model repo. Only for models you trust.' },
  },
};

function settingsForBackend(backendId) {
  const backend = BACKENDS[backendId];
  if (!backend) return [];
  const labels = FLAG_LABELS[backendId] || {};
  const defs = [];
  for (const flag of backend.flags) {
    const extra = labels[flag.key] || {};
    const def = flagToSettingDef(backendId, { ...flag, ...extra });
    if (def) defs.push(def);
  }
  return defs;
}

/**
 * Compose the backend list the chat-popover quick-switcher consumes: the
 * platform-appropriate local backends plus a "remote" pseudo-backend, each
 * annotated with whether it's installed and whether it's the active selection.
 * `detected` is the per-backend availability map from
 * EngineDiscoveryService.detectEngines(); `remote` is settings.llm.remote
 * (an endpoint ⇒ the remote pseudo-backend is configured). Pure projection —
 * no I/O — so it stays testable without spawning engines.
 */
function composeBackendsPayload(detected = {}, active = null, remote = null, platform = process.platform) {
  const inst = {
    llamaCpp: !!(detected.llamaCpp && detected.llamaCpp.available),
    mlxOpenAi: !!(detected.mlxOpenAi && detected.mlxOpenAi.available),
    omlx: !!(detected.omlx && detected.omlx.available),
    vllm: !!(detected.vllm && detected.vllm.available),
  };
  const local = listBackends({ platform }).map((b) => ({
    id: b.id,
    label: b.label,
    toolSupport: !!b.toolSupport,
    installed: !!inst[b.id],
    active: active === b.id,
  }));
  // remote is a selection target, not a spawned engine — append it unconditionally
  // so the popover can offer "use a remote OpenAI-compatible endpoint".
  local.push({ id: 'remote', label: 'Remote endpoint', toolSupport: true, installed: !!(remote && remote.endpoint), active: active === 'remote' });
  return local;
}

module.exports = {
  ENGINES,
  BACKENDS,
  getBackend,
  listBackends,
  buildCommand,
  flagToSettingDef,
  settingsForBackend,
  composeBackendsPayload,
};
