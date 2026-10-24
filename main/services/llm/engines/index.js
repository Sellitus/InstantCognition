// Registry of updatable inference runtimes. Each adapter answers
// supported(platform), check(ctx) -> the row the renderer shows, and
// install(ctx) -> the installed version string; ctx carries the service's
// per-runtime `latest` cache and its `send` progress sink.

const ENGINES = [
  require('./llamaCpp'),
  require('./mlx'),
  require('./omlx'),
  require('./vllm'),
];

/** @param {string} platform */
function supportedEngines(platform) {
  return ENGINES.filter((e) => e.supported(platform));
}

/** @param {string} id */
function getEngine(id) {
  return ENGINES.find((e) => e.id === id) || null;
}

module.exports = { ENGINES, supportedEngines, getEngine };
