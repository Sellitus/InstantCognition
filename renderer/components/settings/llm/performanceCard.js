// Performance card: tuning knobs for the active local runtime only. Each
// runtime gets a panel in the card body plus a panel in its Advanced section;
// LLMTab shows the pair matching the selected engine. The MLX auto-fallback
// toggle applies to both MLX runtimes, so it lives in one shared row.

const { el } = require('../controls');
const { LLAMA_CACHE_TYPES } = require('../../../../shared/llmDefaults');
const { VLLM_TOOL_PARSERS } = require('../../../../shared/vllmToolParsers');
const { card, advanced, knobRow, toggleGrid, numberCtl, toggleCtl, selectCtl } = require('./cardKit');

const CACHE_LABELS = {
  f32: 'F32 (full precision)', f16: 'F16 (half)', bf16: 'BF16',
  q8_0: 'Q8_0', q5_1: 'Q5_1', q5_0: 'Q5_0', q4_1: 'Q4_1', q4_0: 'Q4_0', iq4_nl: 'IQ4_NL (K only)',
};
const CACHE_OPTIONS = LLAMA_CACHE_TYPES.map((v) => ({ value: v, label: CACHE_LABELS[v] || v }));
const MEMORY_GUARD_OPTIONS = [
  { value: 'off', label: 'Off' }, { value: 'safe', label: 'Safe' },
  { value: 'balanced', label: 'Balanced' }, { value: 'aggressive', label: 'Aggressive' },
];
const TOOL_PARSER_OPTIONS = [
  { value: 'auto', label: 'Auto' }, { value: 'none', label: 'None' },
  ...VLLM_TOOL_PARSERS.map((p) => ({ value: p, label: p })),
];
const DTYPE_OPTIONS = ['auto', 'bfloat16', 'float16', 'float32'].map((v) => ({ value: v, label: v }));

const knobGrid = (rows) => el('div', { class: 'settings-v2-knob-grid' }, rows);

function numberKnob(tab, key, title, description, value, range) {
  return knobRow({
    id: key,
    title,
    description,
    control: numberCtl(key.replace(/\./g, '-'), title, value, (v) => tab._setLLM(key, v), range),
  });
}

function toggleKnob(tab, key, title, description, value) {
  return knobRow({
    id: key,
    title,
    description,
    control: toggleCtl(key.replace(/\./g, '-'), title, value, (v) => tab._setLLM(key, !!v)),
    toggle: true,
  });
}

function selectKnob(tab, key, title, description, options, value) {
  return knobRow({
    id: key,
    title,
    description,
    control: selectCtl(key.replace(/\./g, '-'), title, options, value, (v) => tab._setLLM(key, v)),
  });
}

function llamaCppPanels(tab) {
  const lc = tab._llm().llamaCpp || {};
  const main = el('div', { class: 'sv-llm-perf-panel', 'data-backend': 'llamaCpp' }, [
    knobGrid([
      numberKnob(tab, 'llamaCpp.contextSize', 'Context size', 'Tokens the model can attend to.', lc.contextSize || 65536, { min: 512, max: 1048576, step: 512 }),
      numberKnob(tab, 'llamaCpp.gpuLayers', 'GPU layers', '-1 offloads every layer to the GPU.', lc.gpuLayers != null ? lc.gpuLayers : -1, { min: -1, max: 999, step: 1 }),
      numberKnob(tab, 'llamaCpp.threads', 'Threads', '0 picks automatically.', lc.threads != null ? lc.threads : 0, { min: 0, max: 256, step: 1 }),
      numberKnob(tab, 'llamaCpp.parallel', 'Parallel slots', 'Requests served at once.', lc.parallel || 4, { min: 1, max: 64, step: 1 }),
    ]),
    toggleGrid([
      toggleKnob(tab, 'llamaCpp.flashAttention', 'Flash attention', 'Faster attention when supported.', lc.flashAttention !== false),
      toggleKnob(tab, 'llamaCpp.contBatching', 'Continuous batching', 'Interleave decoding across requests.', lc.contBatching !== false),
    ]),
  ]);
  const adv = el('div', { class: 'sv-llm-perf-panel', 'data-backend': 'llamaCpp' }, [
    knobGrid([
      selectKnob(tab, 'llamaCpp.cacheTypeK', 'K cache type', 'Lower precision shrinks VRAM.', CACHE_OPTIONS, lc.cacheTypeK || 'q8_0'),
      selectKnob(tab, 'llamaCpp.cacheTypeV', 'V cache type', 'Lower precision shrinks VRAM.', CACHE_OPTIONS, lc.cacheTypeV || 'q5_1'),
      numberKnob(tab, 'llamaCpp.batchSize', 'Batch size', 'Prompt tokens processed per step.', lc.batchSize || 2048, { min: 1, max: 16384, step: 1 }),
      numberKnob(tab, 'llamaCpp.ubatchSize', 'Micro-batch', 'Physical batch size (ubatch).', lc.ubatchSize || 512, { min: 1, max: 16384, step: 1 }),
    ]),
    toggleGrid([
      toggleKnob(tab, 'llamaCpp.mlock', 'Lock weights in RAM', 'mlock: never swap. Needs enough physical memory.', !!lc.mlock),
      toggleKnob(tab, 'llamaCpp.noMmap', 'Disable mmap', 'Read the weights into RAM instead of mapping the file.', !!lc.noMmap),
      toggleKnob(tab, 'llamaCpp.jinja', 'Jinja chat template', 'Use the template embedded in the model.', !!lc.jinja),
    ]),
  ]);
  return { main, adv };
}

function mlxOpenAiPanels(tab) {
  const oa = tab._llm().mlxOpenAi || {};
  const main = el('div', { class: 'sv-llm-perf-panel', 'data-backend': 'mlxOpenAi' }, [
    knobGrid([
      numberKnob(tab, 'mlxOpenAi.contextLength', 'Context length', '0 uses the model default.', oa.contextLength || 0, { min: 0, max: 1048576, step: 1024 }),
    ]),
    toggleGrid([
      toggleKnob(tab, 'mlxOpenAi.enableAutoToolChoice', 'Auto tool choice', 'Required for the agent to call tools.', oa.enableAutoToolChoice !== false),
    ]),
  ]);
  const adv = el('div', { class: 'sv-llm-perf-panel', 'data-backend': 'mlxOpenAi' }, [
    toggleGrid([
      toggleKnob(tab, 'mlxOpenAi.forceTextOnly', 'Text-only mode', 'Skip vision pathways; avoids crashes on some VL models.', !!oa.forceTextOnly),
    ]),
  ]);
  return { main, adv };
}

// oMLX reads context length from its per-model settings, which the main
// process writes before launch (llm/omlxSettings.js).
function omlxPanels(tab) {
  const om = tab._llm().omlx || {};
  const main = el('div', { class: 'sv-llm-perf-panel', 'data-backend': 'omlx' }, [
    knobGrid([
      numberKnob(tab, 'omlx.contextLength', 'Context length', '0 uses the model default.', om.contextLength != null ? om.contextLength : 65536, { min: 0, max: 1048576, step: 1024 }),
      numberKnob(tab, 'omlx.maxConcurrentRequests', 'Concurrent requests', 'Requests batched together. Higher raises throughput and memory use.', om.maxConcurrentRequests || 8, { min: 1, max: 64, step: 1 }),
      selectKnob(tab, 'omlx.memoryGuard', 'Memory guard', 'How much RAM oMLX leaves free for other apps.', MEMORY_GUARD_OPTIONS, om.memoryGuard || 'balanced'),
    ]),
  ]);
  const adv = el('div', { class: 'sv-llm-perf-panel', 'data-backend': 'omlx' }, []);
  return { main, adv };
}

function vllmPanels(tab) {
  const v = tab._llm().vllm || {};
  const main = el('div', { class: 'sv-llm-perf-panel', 'data-backend': 'vllm' }, [
    knobGrid([
      numberKnob(tab, 'vllm.maxModelLen', 'Max context', 'Tokens per request. 0 uses the model default; lower it if the model does not fit.', v.maxModelLen || 0, { min: 0, max: 1048576, step: 1024 }),
      numberKnob(tab, 'vllm.gpuMemoryUtilization', 'GPU memory share', 'Fraction of GPU memory vLLM reserves (weights plus KV cache).', v.gpuMemoryUtilization != null ? v.gpuMemoryUtilization : 0.92, { min: 0.1, max: 0.99, step: 0.01 }),
      selectKnob(tab, 'vllm.toolParser', 'Tool calling', 'Auto picks the parser for the model family; None turns tool calls off.', TOOL_PARSER_OPTIONS, v.toolParser || 'auto'),
    ]),
  ]);
  const adv = el('div', { class: 'sv-llm-perf-panel', 'data-backend': 'vllm' }, [
    knobGrid([
      numberKnob(tab, 'vllm.tensorParallelSize', 'GPUs', 'Split the model across this many GPUs (tensor parallel).', v.tensorParallelSize || 1, { min: 1, max: 16, step: 1 }),
      selectKnob(tab, 'vllm.dtype', 'Data type', 'Auto picks from the model config.', DTYPE_OPTIONS, v.dtype || 'auto'),
    ]),
    toggleGrid([
      toggleKnob(tab, 'vllm.trustRemoteCode', 'Trust remote code', 'Run custom Python shipped with Hub models. Only for models you trust.', !!v.trustRemoteCode),
    ]),
  ]);
  return { main, adv };
}

function buildPerformanceCard(tab) {
  const c = card({ id: 'performance', title: 'Performance', icon: 'zap', description: 'Tuning for the selected runtime.' });
  const adv = advanced(c, 'performance');
  const panels = { llamaCpp: llamaCppPanels(tab), mlxOpenAi: mlxOpenAiPanels(tab), omlx: omlxPanels(tab), vllm: vllmPanels(tab) };
  for (const { main, adv: advPanel } of Object.values(panels)) {
    c.body.appendChild(main);
    adv.body.appendChild(advPanel);
  }
  const mx = tab._llm().mlx || {};
  const mlxShared = toggleGrid([
    toggleKnob(tab, 'mlx.fallbackEnabled', 'Fall back to the other MLX runtime', 'If a model fails to load, retry it on the other MLX server (mlx-openai-server or oMLX).', mx.fallbackEnabled !== false),
  ]);
  mlxShared.classList.add('sv-llm-mlx-shared');
  c.body.appendChild(mlxShared);

  Object.assign(tab._refs, { perfPanels: panels, mlxShared, perfAdvanced: adv });
  return c.root;
}

module.exports = { buildPerformanceCard, CACHE_OPTIONS };
