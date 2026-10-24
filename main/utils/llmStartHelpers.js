// Helpers for the llm:start IPC path. Extracted so llmHandlers.js stays
// under the 100-line architectural cap.

const { mergeStartOpts, isMlxBackend } = require('../../shared/llmDefaults');

// Build the cross-MLX fallback chain (mlx-openai-server <-> oMLX). Only
// attempts when the user picked an MLX backend, mlx.fallbackEnabled is on, and
// the other MLX runtime is installed. Returns [] when no fallback applies.
async function buildMlxFallbackChain({ rawOpts, merged, cfg, info, engineDiscoveryService }) {
  if (!isMlxBackend(merged.backend)) return [];
  if (!cfg || !cfg.mlx || cfg.mlx.fallbackEnabled === false) return [];
  const other = merged.backend === 'mlxOpenAi' ? 'omlx' : 'mlxOpenAi';
  const otherPath = await engineDiscoveryService.resolveBackendPath(other, null);
  if (!otherPath) return [];
  const fallbackOpts = mergeStartOpts({ ...rawOpts, backend: other }, cfg);
  fallbackOpts.pythonPath = otherPath;
  fallbackOpts.modelPath = merged.modelPath;
  fallbackOpts.modelType = info && info.isMultimodal && !fallbackOpts.forceTextOnly ? 'multimodal' : 'lm';
  return [{ backend: other, opts: fallbackOpts }];
}

// "python backend not detected" message — the python engines share a
// resolve-pythonPath step in llm:start; only the install hint differs. Lives
// here (not in the IPC handler) so llmHandlers.js stays under the 100-line cap.
function pythonBackendMissingMessage(backend) {
  if (backend === 'omlx') return 'oMLX not detected. Install it from Settings → LLM → Engines (Update), or switch backend.';
  if (isMlxBackend(backend)) return 'mlx-openai-server not detected. Install with: pip install mlx-openai-server. Or switch backend in Settings → LLM.';
  return 'vLLM is not set up. Open Settings → LLM → Engines and choose "Set up vLLM" (NVIDIA GPU on Linux or Windows required).';
}

// The llm:import-model picker: the folder runtimes import a model directory,
// llama.cpp one or more .gguf files.
/** @returns {import('electron').OpenDialogOptions} */
function importDialogOptions(backend) {
  if (backend === 'vllm') return { title: 'Import model folder', properties: ['openDirectory'] };
  if (isMlxBackend(backend) || backend === 'mlx') return { title: 'Import MLX model folder', properties: ['openDirectory'] };
  return { title: 'Import GGUF model', properties: ['openFile', 'multiSelections'], filters: [{ name: 'GGUF', extensions: ['gguf'] }] };
}

module.exports = { buildMlxFallbackChain, pythonBackendMissingMessage, importDialogOptions };
