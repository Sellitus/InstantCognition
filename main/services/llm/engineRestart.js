// engineRestart — puts a freshly installed runtime into use.
//
// llm:start caches the resolved binary / python path in config so later starts
// skip detection, and the engine remembers its start options for crash
// fallback and resume-after-hide. After an install both still name the
// previous runtime, so they are released or repointed here; a re-detect ranks
// the managed install first. A path set by hand is never touched.

const { persistEngineSelection } = require('../../../shared/llmDefaults');
const { engineForBackend } = require('./engineUpdatePrompt');

const IDLE_POLL_MS = 1000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const PATH_KEY = { llamaCpp: 'binaryPath', mlx: 'pythonPath', omlx: 'pythonPath', vllm: 'pythonPath' };

const PINNED_KEYS = {
  llamaCpp: ['settings.llm.llamaCpp.binaryPath'],
  mlx: ['settings.llm.mlxOpenAi.pythonPath'],
  omlx: ['settings.llm.omlx.pythonPath'],
  vllm: ['settings.llm.vllm.pythonPath'],
};

/**
 * @param {any} configService
 * @param {{isDiscoveredPath: (engine: string, p: string) => boolean}} discovery
 * @param {'llamaCpp'|'mlx'|'omlx'|'vllm'} engine
 */
function releasePinnedPath(configService, discovery, engine) {
  if (!configService) return;
  for (const key of PINNED_KEYS[engine] || []) {
    const pinned = configService.get(key, null);
    if (pinned && discovery.isDiscoveredPath(engine, pinned)) configService.set(key, null);
  }
}

// Start options that follow runtime updates: their path is one detection
// produced, or none. A hand-set path pins the user's own build.
function followsUpdates(discovery, engine, opts) {
  const p = opts && opts[PATH_KEY[engine]];
  return !p || discovery.isDiscoveredPath(engine, p);
}

function withRuntime(opts, engine, resolved) {
  const key = PATH_KEY[engine];
  const next = { ...opts, [key]: resolved };
  // A fallback entry on the same runtime follows it to the new interpreter.
  if (Array.isArray(next.fallbackChain)) {
    next.fallbackChain = next.fallbackChain.map((f) => (
      f && engineForBackend(f.backend) === engine ? { ...f, opts: { ...f.opts, [key]: resolved } } : f
    ));
  }
  return next;
}

async function resolveRuntime(discovery, opts, engine) {
  const bare = { ...opts };
  delete bare[PATH_KEY[engine]];
  discovery.clearCache();
  return discovery.resolveBackendPath(bare.backend, null);
}

/**
 * Point the engine's remembered start options (its last start, and the
 * snapshot a hidden window parks) at the newest runtime, so any later restart
 * the app makes on its own loads it.
 * @param {{engine: 'llamaCpp'|'mlx'|'omlx'|'vllm', llmService: any, discovery: any}} deps
 */
async function repointStartOpts({ engine, llmService, discovery }) {
  if (!llmService) return;
  const follows = (o) => !!o && engineForBackend(o.backend) === engine && followsUpdates(discovery, engine, o);
  const last = llmService._lastStartOpts;
  if (follows(last)) {
    const resolved = await resolveRuntime(discovery, last, engine);
    if (resolved) llmService._lastStartOpts = withRuntime(last, engine, resolved);
  }
  const snap = llmService._pauseSnapshot;
  if (snap && follows(snap.opts)) {
    const resolved = await resolveRuntime(discovery, snap.opts, engine);
    if (resolved) snap.opts = withRuntime(snap.opts, engine, resolved);
  }
}

/**
 * @param {() => boolean} isBusy
 * @param {{pollMs?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<void>}
 */
function waitForIdle(isBusy, { pollMs = IDLE_POLL_MS, timeoutMs = IDLE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (!isBusy()) { resolve(); return; }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('The engine stayed busy, so it was not restarted. Restart it from the engine button to load the new runtime.'));
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/**
 * Whether Update + Restart can reload this engine: it runs that runtime from
 * a path detection produced.
 * @param {{engine: string|null, llmService: any, discovery: any}} deps
 */
function canRestart({ engine, llmService, discovery }) {
  if (!engine || !llmService) return false;
  const s = llmService.getStatus();
  const opts = llmService._lastStartOpts;
  return s.status === 'running' && !s.isRemote && !!opts
    && engineForBackend(opts.backend) === engine && followsUpdates(discovery, engine, opts);
}

/**
 * Restart the running engine on the newest installed runtime, keeping its
 * model and start options. Waits until nothing uses the engine first: the
 * update is offered as the user sends a message, and a restart then would cut
 * the reply off. An engine on a hand-set runtime path is left alone.
 * @param {{engine: 'llamaCpp'|'mlx'|'omlx'|'vllm', llmService: any, isBusy: () => boolean,
 *   discovery: any, configService: any, idle?: {pollMs?: number, timeoutMs?: number}}} deps
 * @returns {Promise<{restarted: boolean, model?: string}>}
 */
async function restartOnNewRuntime({ engine, llmService, isBusy, discovery, configService, idle }) {
  if (!canRestart({ engine, llmService, discovery })) return { restarted: false };
  const current = llmService._lastStartOpts;
  // Resolved up front: the probe takes seconds, and nothing may slip in
  // between the last idle check and stop().
  const resolved = await resolveRuntime(discovery, current, engine);
  if (!resolved) throw new Error('The updated runtime could not be found, so the engine was not restarted.');
  for (;;) {
    await waitForIdle(isBusy, idle);
    // The user may have stopped, switched models or engines while waiting.
    if (!canRestart({ engine, llmService, discovery }) || llmService._lastStartOpts !== current) return { restarted: false };
    if (!isBusy()) break;
  }
  const opts = withRuntime(current, engine, resolved);
  await llmService.reload(opts);
  persistEngineSelection(configService, opts);
  return { restarted: true, model: opts.modelPath };
}

module.exports = { releasePinnedPath, repointStartOpts, canRestart, waitForIdle, restartOnNewRuntime };
