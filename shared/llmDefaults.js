/**
 * Local LLM configuration defaults and constants.
 * Used by EngineDiscoveryService, LLMService, ModelManagerService, and the LLM settings UI.
 */

const engineSchema = require('./engineSchema');

// 'mlx' is retained as a legacy umbrella id only; mergeStartOpts maps it to mlxOpenAi.
const LLM_BACKENDS = ['llamaCpp', 'mlxOpenAi', 'omlx', 'vllm', 'remote'];
const MLX_BACKENDS = ['mlxOpenAi', 'omlx'];

// Cache type options supported by llama-server's --cache-type-k / --cache-type-v flags.
// Listed from highest precision to most-compressed. `iq4_nl` is a K-only recommendation.
const LLAMA_CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl'];

const LLM_MODES = ['local', 'remote'];

const DEFAULT_LLM_SETTINGS = {
  mode: 'local',              // 'local' | 'remote'
  activeBackend: null,
  modelsDir: null,
  // Optional user-set roots to recursively scan for models. If `combined` is
  // set, both MLX dirs and GGUF files are searched under it. `mlx` and `gguf`
  // let the user point each type at a dedicated root instead of (or in addition
  // to) `combined`. All three may be set simultaneously — results are merged.
  scanDirs: { combined: null, mlx: null, gguf: null },
  llamaCpp: {
    binaryPath: null,
    contextSize: 65536,
    threads: 0,
    gpuLayers: -1,
    flashAttention: true,
    cacheTypeK: 'q8_0',
    cacheTypeV: 'q5_1',
    batchSize: 2048,
    ubatchSize: 512,
    parallel: 4,
    mlock: false,
    noMmap: false,
    contBatching: true,
    jinja: false,
  },
  // Shared MLX settings (apply across both mlx-openai-server and oMLX).
  mlx: {
    fallbackEnabled: true,    // if the chosen MLX runtime fails to load the
                              // model, try the other MLX runtime automatically
  },
  // mlx-openai-server: subprocess-per-model HTTP server.
  mlxOpenAi: {
    pythonPath: null,
    contextLength: 65536,     // 0 = use model default
    enableAutoToolChoice: true,
    forceTextOnly: false,     // load vision models as text-only to dodge the
                              // mlx-vlm 0.4.4 GPU-stream threading crash
  },
  // oMLX: continuous batching + paged SSD KV cache. Runs from its own python
  // runtime (it pins an mlx build mlx-openai-server conflicts with).
  omlx: {
    pythonPath: null,
    contextLength: 65536,     // 0 = use model default
    maxConcurrentRequests: 8,
    memoryGuard: 'balanced',
  },
  remote: {
    endpoint: '',
    apiKey: '',
    model: '',
    visionCapable: false,
    // 'native' sends the OpenAI tool schema; 'json' is the opt-out for proxies
    // that reject or 500 on a tools payload.
    toolMode: 'native',
  },
  // vLLM: NVIDIA high-throughput server. Linux natively, Windows inside the
  // app's WSL2 distro (llm/vllmSetup.js); not offered on macOS.
  vllm: {
    pythonPath: null,
    tensorParallelSize: 1,
    gpuMemoryUtilization: 0.92,
    // 0 = the model's own limit.
    maxModelLen: 0,
    dtype: 'auto',
    trustRemoteCode: false,
    // 'auto' picks from the model family (shared/vllmToolParsers.js); 'none'
    // turns tool calling off; any other value is a vLLM parser name.
    toolParser: 'auto',
  },
  vision: {
    enabled: false,
    autoDetect: true,
    maxImages: 3,
    longEdgePx: 1280,
  },
  agent: {
    maxSteps: 12,
    toolTimeoutMs: 15000,
    mode: 'auto', // 'auto' | 'tools' | 'json'
    qualityMode: 'balanced', // 'efficient' | 'balanced' | 'ultra'
    qualityOverride: null,   // optional partial budget override
    approval: { deny: [], perOrigin: {} },
    // Egress control: gate where the agent's navigate-class tools may go.
    //   mode 'open'      — no destination gating (default; unchanged behavior)
    //   mode 'allowlist' — only `allow` domains; everything else is gated
    //   mode 'blocklist' — everything except `block` domains
    // `block` is always honored (hard deny) regardless of mode.
    // onViolation 'prompt' asks the user (reuses the approval card, keyed on
    // the destination site so "always allow on this site" persists); 'deny'
    // refuses silently to the agent.
    egress: { mode: 'open', allow: [], block: [], onViolation: 'prompt' },
    // Permission mode ('ask' | 'auto-edit' | 'plan' | 'bypass') plus
    // `tool[:spec]` rules. Deny rules win over every mode, Bypass included.
    permissions: {
      mode: 'ask',
      rules: { allow: [], ask: [], deny: ['shell.run:sudo *', 'shell.run:su *'] },
    },
    // fs.* tools only reach inside these roots; protectedGlobs are
    // workspace-relative and refused for writes. The .git globs cover nested
    // repositories too: a writable sub/.git/hooks would run code on commit.
    workspace: {
      roots: [],
      protectedGlobs: ['**/.git', '**/.git/**', '**/.env', '**/.env.*'],
      maxReadBytes: 262144,
      maxWriteBytes: 1048576,
    },
    // envAllow is the only environment a spawned command inherits; names that
    // look like credentials are scrubbed even when listed.
    shell: {
      enabled: true,
      defaultTimeoutMs: 60000,
      maxTimeoutMs: 600000,
      maxOutputBytes: 65536,
      envAllow: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'USER', 'TMPDIR'],
    },
    checkpoints: { enabled: true, retentionDays: 30, maxBytesPerSession: 209715200 },
    subagents: { enabled: true, maxConcurrent: 2, maxDepth: 1, defaultMaxSteps: 8 },
    // llmConcurrency 'auto' = 1 for a local engine (launched without an explicit
    // slot count), 4 for a remote endpoint.
    // backgroundApprovalTimeoutMs 0 = a background approval waits indefinitely.
    sessions: { maxConcurrent: 2, llmConcurrency: 'auto', notifyOnComplete: true, backgroundApprovalTimeoutMs: 0 },
    skills: { autoTrigger: true, matchThreshold: 0.35 },
    instructions: {
      enabled: true,
      globalFile: '',
      workspaceFiles: ['AGENTS.md', 'INSTRUCTIONS.md'],
      maxBytes: 16384,
    },
    harness: { profiles: [] },
    streamSteps: 'auto',
    compaction: { auto: true, threshold: 0.8 },
  },
  // Per-model tuning overlay, keyed by absolute model path. Each entry is a
  // partial backend block: { backend?, flags? } where flags is a map of
  // engineSchema flag keys to values. mergeStartOpts layers these between
  // global backend defaults and the per-call opts, so a user can tune
  // contextSize / gpuLayers / etc. for one model without affecting others.
  // Precedence: call opts > per-model override > global backend default.
  perModelOverrides: {},
  lastModel: null,
  serverPort: 8421,
  serverHost: '127.0.0.1',
  autoStart: false,
  // Daily check for newer inference runtimes. Checking is automatic;
  // installing never is — the user presses Update on the toast or in Settings.
  engineAutoCheck: true,
  // Newest runtime version already offered per engine, so each update is
  // offered once (EngineUpdateService.offerSelected).
  engineUpdatePrompted: { llamaCpp: null, mlx: null, omlx: null, vllm: null },
  systemPrompt: '',
};

const LLAMA_SERVER_BINARY_NAMES = {
  darwin: ['llama-server'],
  linux: ['llama-server'],
  win32: ['llama-server.exe'],
};

const LLAMA_SERVER_SEARCH_PATHS = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'],
  linux: ['/usr/local/bin', '/usr/bin', '/opt/llama.cpp/bin'],
  win32: ['C:\\Program Files\\llama.cpp', 'C:\\llama.cpp'],
};

function isMlxBackend(b) { return MLX_BACKENDS.includes(b); }
function isPythonBackend(b) { return isMlxBackend(b) || b === 'vllm'; }

/** "org/name": a Hugging Face repo vLLM downloads itself, not a local path. */
function isHfRepoId(model) {
  return /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(String(model || ''));
}

function buildLlamaCppCommand(opts) {
  // Delegates to engineSchema so the flag table is the single source of truth.
  // The command target is the resolved llama-server binary path.
  return engineSchema.buildCommand('llamaCpp', opts);
}

function buildMlxOpenAiCommand(opts) {
  // The schema's command target derives the mlx-openai-server CLI path from the
  // pythonPath's bin dir. Normalize modelType so a falsy/non-multimodal value
  // lands on 'lm' (matches the prior explicit guard).
  const normalized = { ...opts, modelType: opts.modelType === 'multimodal' ? 'multimodal' : 'lm' };
  return engineSchema.buildCommand('mlxOpenAi', normalized);
}

function buildOmlxCommand(opts) {
  return engineSchema.buildCommand('omlx', opts);
}

function buildVllmCommand(opts) {
  // Expects launch-ready opts: llm/backendRuntime.js has already translated the
  // model path, chosen the served name and resolved toolCallParser.
  return engineSchema.buildCommand('vllm', opts);
}

const BACKEND_COMMAND_BUILDERS = {
  llamaCpp: buildLlamaCppCommand,
  mlxOpenAi: buildMlxOpenAiCommand,
  omlx: buildOmlxCommand,
  vllm: buildVllmCommand,
};

/**
 * Merge user opts with config defaults for `llm:start`.
 * Returns a flat opts object ready to pass to LLMService.start().
 * Backend-specific fields (binaryPath / pythonPath) are NOT auto-detected
 * here — caller fills those in if missing.
 */

// Resolve the per-model override entry for a model path. Matches on the full
// stored key first, then on basename for models moved between directories.
function resolvePerModelOverride(perModelOverrides, modelPath) {
  if (!perModelOverrides || !modelPath) return null;
  if (perModelOverrides[modelPath]) return perModelOverrides[modelPath];
  const base = String(modelPath).split('/').pop().toLowerCase();
  const byBase = Object.keys(perModelOverrides).find((k) => k.split('/').pop().toLowerCase() === base);
  return byBase ? perModelOverrides[byBase] : null;
}

// Fold a per-model flag override into the backend's sub-block of a cfg clone.
// The values become elevated defaults — per-call opts still win because the
// existing merge lines read `o.x != null ? o.x : backendDefault`.
function applyOverrideToCfg(cfg, backend, flags) {
  const c = { ...cfg };
  if (!flags || typeof flags !== 'object') return c;
  if (backend === 'llamaCpp') {
    c.llamaCpp = { ...(c.llamaCpp || {}), ...flags };
  } else if (backend === 'mlxOpenAi') {
    c.mlxOpenAi = { ...(c.mlxOpenAi || {}), ...flags };
  } else if (backend === 'omlx') {
    c.omlx = { ...(c.omlx || {}), ...flags };
  } else if (backend === 'vllm') {
    c.vllm = { ...(c.vllm || {}), ...flags };
  }
  return c;
}

function mergeStartOpts(opts, cfg) {
  const o = opts || {};
  let c = cfg || {};
  let backend = o.backend || c.activeBackend || 'llamaCpp';
  // Legacy 'mlx' umbrella id from pre-v9 configs.
  if (backend === 'mlx') backend = 'mlxOpenAi';

  // Per-model overlay: settings.llm.perModelOverrides[modelPath] = {backend?, flags?}.
  // A backend switch re-resolves the backend; flags are folded into the chosen
  // backend's sub-block so existing call>default logic yields call>perModel>global.
  const modelKey = o.modelPath || c.lastModel;
  const override = resolvePerModelOverride(c.perModelOverrides, modelKey);
  if (override) {
    if (override.backend && override.backend !== backend && override.backend !== 'remote') {
      backend = override.backend;
    }
    // Shallow-clone cfg so the elevated defaults don't mutate the caller's object.
    c = applyOverrideToCfg(c, backend, override.flags);
  }

  const merged = {
    backend,
    modelPath: o.modelPath || c.lastModel,
    port: o.port || c.serverPort || 8421,
    host: o.host || c.serverHost || '127.0.0.1',
  };
  if (backend === 'mlxOpenAi') {
    const m = c.mlxOpenAi || {};
    const lg = c.mlx || {};
    merged.pythonPath = o.pythonPath || m.pythonPath || lg.pythonPath;
    merged.contextLength = o.contextLength != null ? o.contextLength : (m.contextLength != null ? m.contextLength : (lg.contextLength || 0));
    merged.enableAutoToolChoice = o.enableAutoToolChoice != null
      ? o.enableAutoToolChoice
      : (m.enableAutoToolChoice !== false && lg.enableAutoToolChoice !== false);
    merged.forceTextOnly = o.forceTextOnly != null ? !!o.forceTextOnly : !!(m.forceTextOnly || lg.forceTextOnly);
    merged.modelType = o.modelType || 'lm';
  } else if (backend === 'omlx') {
    const m = c.omlx || {};
    merged.pythonPath = o.pythonPath || m.pythonPath;
    merged.contextLength = o.contextLength != null ? o.contextLength : (m.contextLength != null ? m.contextLength : 65536);
    merged.maxConcurrentRequests = o.maxConcurrentRequests != null ? o.maxConcurrentRequests : (m.maxConcurrentRequests || 8);
    merged.memoryGuard = o.memoryGuard || m.memoryGuard || 'balanced';
    // oMLX picks text vs vision handling itself; modelType only tracks it for status.
    merged.modelType = o.modelType || 'lm';
  } else if (backend === 'llamaCpp') {
    const lc = c.llamaCpp || {};
    merged.binaryPath = o.binaryPath || lc.binaryPath;
    merged.contextSize = o.contextSize || lc.contextSize || 65536;
    merged.threads = o.threads != null ? o.threads : (lc.threads || 0);
    merged.gpuLayers = o.gpuLayers != null ? o.gpuLayers : (lc.gpuLayers != null ? lc.gpuLayers : -1);
    merged.flashAttention = o.flashAttention != null ? o.flashAttention : (lc.flashAttention !== false);
    merged.cacheTypeK = o.cacheTypeK || lc.cacheTypeK || 'q8_0';
    merged.cacheTypeV = o.cacheTypeV || lc.cacheTypeV || 'q5_1';
    merged.batchSize = o.batchSize != null ? o.batchSize : (lc.batchSize || 2048);
    merged.ubatchSize = o.ubatchSize != null ? o.ubatchSize : (lc.ubatchSize || 512);
    merged.parallel = o.parallel != null ? o.parallel : (lc.parallel || 4);
    merged.mlock = o.mlock != null ? o.mlock : !!lc.mlock;
    merged.noMmap = o.noMmap != null ? o.noMmap : !!lc.noMmap;
    merged.contBatching = o.contBatching != null ? o.contBatching : (lc.contBatching !== false);
    merged.jinja = o.jinja != null ? o.jinja : !!lc.jinja;
    // Vision projector path — when set, llama-server loads it via --mmproj and
    // serves vision via OpenAI chat completions image parts. Auto-detected by
    // the llm:start handler from the model's sibling files.
    if (o.mmprojPath) merged.mmprojPath = o.mmprojPath;
  } else if (backend === 'vllm') {
    const v = c.vllm || {};
    merged.pythonPath = o.pythonPath || v.pythonPath;
    merged.tensorParallelSize = o.tensorParallelSize != null ? o.tensorParallelSize : (v.tensorParallelSize != null ? v.tensorParallelSize : 1);
    merged.gpuMemoryUtilization = o.gpuMemoryUtilization != null ? o.gpuMemoryUtilization : (v.gpuMemoryUtilization != null ? v.gpuMemoryUtilization : 0.92);
    merged.maxModelLen = o.maxModelLen != null ? o.maxModelLen : (v.maxModelLen || 0);
    merged.dtype = o.dtype || v.dtype || 'auto';
    merged.trustRemoteCode = o.trustRemoteCode != null ? o.trustRemoteCode : !!v.trustRemoteCode;
    merged.toolParser = o.toolParser || v.toolParser || 'auto';
  }
  return merged;
}

// Persists the resolved start opts so the next llm:start call skips engine
// discovery entirely (which can take several seconds on a cold python3).
function persistEngineSelection(configService, merged) {
  if (!configService || !merged) return;
  configService.set('settings.llm.lastModel', merged.modelPath);
  configService.set('settings.llm.activeBackend', merged.backend);
  persistResolvedEnginePath(configService, merged);
}

// Write only the resolved python/binary path, without touching activeBackend or
// lastModel. Useful to commit the probe result eagerly so a later spawn failure
// doesn't force a cold re-probe on the next attempt.
function persistResolvedEnginePath(configService, merged) {
  if (!configService || !merged) return;
  if (isPythonBackend(merged.backend) && merged.pythonPath) {
    configService.set(`settings.llm.${merged.backend}.pythonPath`, merged.pythonPath);
  } else if (merged.backend === 'llamaCpp' && merged.binaryPath) {
    configService.set('settings.llm.llamaCpp.binaryPath', merged.binaryPath);
  }
}

module.exports = {
  LLM_BACKENDS,
  MLX_BACKENDS,
  LLM_MODES,
  LLAMA_CACHE_TYPES,
  DEFAULT_LLM_SETTINGS,
  LLAMA_SERVER_BINARY_NAMES,
  LLAMA_SERVER_SEARCH_PATHS,
  BACKEND_COMMAND_BUILDERS,
  buildLlamaCppCommand,
  buildMlxOpenAiCommand,
  buildOmlxCommand,
  buildVllmCommand,
  isMlxBackend,
  isPythonBackend,
  isHfRepoId,
  mergeStartOpts,
  resolvePerModelOverride,
  applyOverrideToCfg,
  persistEngineSelection,
  persistResolvedEnginePath,
};
