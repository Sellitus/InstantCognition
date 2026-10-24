// Engine card: pick the local inference runtime and see which are installed.
// Only the runtimes this platform can run are offered: the MLX servers on
// macOS, vLLM on Linux and Windows (NVIDIA), llama.cpp everywhere.

const { el } = require('../controls');
const { icon: makeIcon } = require('../../Icon');
const { card, knobRow, pillsCtl, button, setLine } = require('./cardKit');
const { buildVllmSetupPanel, renderVllmSetup } = require('./vllmSetupPanel');

const ALL_ENGINE_OPTIONS = [
  { value: 'llamaCpp', label: 'llama.cpp', platforms: ['darwin', 'linux', 'win32'] },
  { value: 'mlxOpenAi', label: 'mlx-openai-server', platforms: ['darwin'] },
  { value: 'omlx', label: 'oMLX', platforms: ['darwin'] },
  { value: 'vllm', label: 'vLLM', platforms: ['linux', 'win32'] },
];

/** @param {string} [platform] */
function engineOptions(platform = process.platform) {
  return ALL_ENGINE_OPTIONS.filter((o) => o.platforms.includes(platform)).map(({ value, label }) => ({ value, label }));
}

const ENGINE_OPTIONS = engineOptions();

function buildEngineCard(tab) {
  const redetectBtn = button({
    label: 'Re-detect engines',
    icon: 'refresh',
    variant: 'ghost',
    iconOnly: true,
    onClick: () => tab._onRedetect(),
  });
  const c = card({
    id: 'engine',
    title: 'Engine',
    icon: 'cpu',
    description: 'Inference runtime for local models. Its tuning knobs appear under Performance.',
    actions: [redetectBtn],
  });

  c.body.appendChild(knobRow({
    id: 'activeBackend',
    title: 'Runtime',
    control: pillsCtl('backend', 'Runtime', ENGINE_OPTIONS, tab._selectedBackend, (v) => tab._onBackendChange(v)),
    wide: true,
    search: 'engine backend llama.cpp mlx omlx vllm gguf runtime',
  }));

  const enginesEl = el('div', { class: 'sv-llm-engines', 'aria-live': 'polite' }, ['Detecting…']);
  const capsEl = el('p', { class: 'sv-llm-capabilities', hidden: true });
  const detectStatus = el('p', { class: 'sv-llm-inline-status', hidden: true });
  c.body.appendChild(knobRow({
    id: 'detectedEngines',
    title: 'Installed',
    description: 'Detected runtimes on this machine.',
    control: el('div', { class: 'sv-llm-engines-panel' }, [enginesEl, capsEl, detectStatus]),
    wide: true,
    search: 'detected engines installed version re-detect',
  }));
  if (ENGINE_OPTIONS.some((o) => o.value === 'vllm')) {
    c.body.appendChild(knobRow({
      id: 'vllmSetup',
      title: 'vLLM setup',
      description: 'Installs vLLM for your NVIDIA GPU. On Windows it runs inside WSL2, which setup installs too.',
      control: buildVllmSetupPanel(tab),
      wide: true,
      search: 'vllm setup install wsl nvidia cuda gpu',
    }));
  }

  Object.assign(tab._refs, { enginesEl, capsEl, detectStatus, redetectBtn });
  return c.root;
}

/** Paint the detected-engine list from an `llm:detect-engines` result. */
function renderEngines(refs, engines) {
  const { capabilities } = engines;
  const notReported = { available: false, reason: 'not reported' };
  const rowFor = {
    llamaCpp: (d) => ['llama.cpp', d.available, d.path || d.reason || '', d.version],
    mlxOpenAi: (d) => ['mlx-openai-server', d.available, d.pythonPath || d.reason || '', d.version],
    omlx: (d) => ['oMLX', d.available, d.pythonPath || d.reason || '', d.version],
    vllm: (d) => ['vLLM', d.available, d.reason || d.pythonPath || '', d.version],
  };
  const rows = ENGINE_OPTIONS.map((o) => rowFor[o.value](engines[o.value] || notReported));
  refs.enginesEl.textContent = '';
  for (const [name, available, info, version] of rows) {
    refs.enginesEl.appendChild(el('div', { class: 'sv-llm-engine-row ' + (available ? 'available' : 'unavailable') }, [
      makeIcon(available ? 'check' : 'close', { className: 'sv-llm-engine-status', label: available ? 'Installed' : 'Not installed' }),
      el('span', { class: 'sv-llm-engine-name' }, [name]),
      el('span', { class: 'sv-llm-engine-info', title: info }, [version || info]),
    ]));
  }
  if (capabilities) {
    refs.capsEl.textContent = `${capabilities.platform} · ${capabilities.arch} · ${capabilities.cpuCores} cores · ${capabilities.ramGB} GB RAM${capabilities.hasMetalSupport ? ' · Metal' : ''}`;
    refs.capsEl.hidden = false;
  }
  refs.detectStatus.hidden = true;
  if (refs.vllmSetup) renderVllmSetup(refs, engines.vllm || null);
}

function renderEnginesError(refs, message) {
  refs.enginesEl.textContent = '';
  refs.detectStatus.hidden = false;
  setLine(refs.detectStatus, 'error', message);
}

module.exports = { buildEngineCard, renderEngines, renderEnginesError, engineOptions, ENGINE_OPTIONS };
