// engineUpdatePrompt — decides whether a runtime update is worth interrupting
// the user for. Only the runtime behind the selected local engine counts, and
// each new version is offered once: the startup check or the first send after
// it, whichever comes first. A remote endpoint never runs a local runtime, so
// it never prompts.

// Backend id -> the updatable runtime it runs on. mlx-openai-server keeps the
// 'mlx' runtime id that persisted engineUpdatePrompted entries already use.
const BACKEND_ENGINE = { llamaCpp: 'llamaCpp', mlxOpenAi: 'mlx', omlx: 'omlx', vllm: 'vllm' };
const UPDATABLE_ENGINES = Object.freeze(Object.values(BACKEND_ENGINE));

/**
 * @param {string|null|undefined} backend an LLM backend id
 * @returns {'llamaCpp'|'mlx'|'omlx'|'vllm'|null} the updatable runtime that backend runs on
 */
function engineForBackend(backend) {
  return (backend && Object.prototype.hasOwnProperty.call(BACKEND_ENGINE, backend)) ? BACKEND_ENGINE[backend] : null;
}

/**
 * The runtime the user has selected: the live engine when one is running,
 * otherwise the configured local backend.
 * @param {{status?: string, backend?: string|null, isRemote?: boolean}|null} status LLMManager.getStatus()
 * @param {{mode?: string, activeBackend?: string|null}|null} llmSettings settings.llm
 */
function selectedEngine(status, llmSettings) {
  if (status && status.isRemote) return null;
  const live = status && (status.status === 'running' || status.status === 'starting');
  if (live) return engineForBackend(status.backend);
  const cfg = llmSettings || {};
  if (cfg.mode === 'remote' || cfg.activeBackend === 'remote') return null;
  return engineForBackend(cfg.activeBackend);
}

/**
 * @param {{engines: any[]|null, prompted: Record<string, string|null>|null, engine: string|null}} input
 *   engines: the last check's per-runtime rows; prompted: latest version
 *   already offered per runtime (settings.llm.engineUpdatePrompted).
 * @returns {any|null} the row to offer, or null when there is nothing new
 */
function promptFor({ engines, prompted, engine }) {
  if (!engine || !Array.isArray(engines)) return null;
  const row = engines.find((e) => e && e.engine === engine && e.ok !== false);
  if (!row || !row.updateAvailable || !row.latest) return null;
  if (prompted && prompted[engine] === row.latest) return null;
  return row;
}

module.exports = { UPDATABLE_ENGINES, engineForBackend, selectedEngine, promptFor };
