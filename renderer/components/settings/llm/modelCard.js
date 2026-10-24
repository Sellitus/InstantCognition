// Model card: pick a model from the local library, manage library files, and
// (under Advanced) the folders the library is scanned from.

const { el } = require('../controls');
const { enhanceSelect, syncSelect } = require('../../menu/Select');
const { isMlxBackend, isHfRepoId } = require('../../../../shared/llmDefaults');
const { card, advanced, knobRow, button, textCtl, setLine } = require('./cardKit');

const SCAN_SLOTS = [
  ['combined', 'Combined folder', 'Model folders and GGUF files, scanned recursively.'],
  ['mlx', 'Model folder', 'MLX and Hugging Face (safetensors) model folders only.'],
  ['gguf', 'GGUF folder', 'GGUF files only.'],
];

function buildModelCard(tab) {
  const c = card({ id: 'model', title: 'Model', icon: 'database', description: 'Models in your library for the selected runtime.' });

  const select = el('select', { class: 'sv-select', id: 'set-llm-model', 'aria-label': 'Model' });
  select.addEventListener('change', () => tab._setLLM('lastModel', select.value || null));
  const importBtn = button({ label: 'Import .gguf', icon: 'download', variant: 'ghost', iconOnly: true, onClick: () => tab._onImportModel() });
  const openBtn = button({ label: 'Open models folder', icon: 'folder', variant: 'ghost', iconOnly: true, onClick: () => tab._onOpenModelsDir() });
  const rescanBtn = button({ label: 'Rescan library', icon: 'refresh', variant: 'ghost', iconOnly: true, onClick: () => tab._onRescan() });
  const deleteBtn = button({ label: 'Delete model', icon: 'trash', variant: 'danger', iconOnly: true, onClick: () => tab._onDeleteModel() });
  const scanResult = el('p', { class: 'sv-llm-inline-status sv-llm-scan-result', 'aria-live': 'polite', 'data-state': 'idle' });

  c.body.appendChild(knobRow({
    id: 'lastModel',
    title: 'Model',
    control: el('div', { class: 'sv-llm-model-line' }, [
      enhanceSelect(select),
      el('div', { class: 'sv-icon-button-row' }, [importBtn, openBtn, rescanBtn, deleteBtn]),
    ]),
    wide: true,
    search: 'model gguf mlx import delete rescan folder library',
  }));
  c.body.appendChild(scanResult);

  // vLLM also loads straight from the Hub; the repo id becomes the selection.
  const lastModel = tab._llm().lastModel;
  const hfRepoRow = knobRow({
    id: 'vllmHfRepo',
    title: 'Hugging Face model',
    description: 'Or enter a repo id such as Qwen/Qwen3-8B. vLLM downloads it on first start.',
    control: textCtl('vllm-hf-repo', 'Hugging Face model', isHfRepoId(lastModel) ? lastModel : '', (v) => {
      const repo = String(v || '').trim();
      if (repo && !isHfRepoId(repo)) {
        setLine(scanResult, 'error', `"${repo}" is not a repo id. Use the form org/name.`);
        return;
      }
      tab._setLLM('lastModel', repo || null);
      tab._renderModels();
    }, { placeholder: 'org/model-name' }),
    wide: true,
    search: 'hugging face hub repo vllm download',
  });
  c.body.appendChild(hfRepoRow);

  const adv = advanced(c, 'model');
  const sd = tab._llm().scanDirs || {};
  for (const [slot, title, description] of SCAN_SLOTS) {
    const pathEl = el('code', { class: 'sv-llm-scan-path' }, [sd[slot] || 'Not set']);
    const browseBtn = button({ label: 'Browse…', icon: 'folder', variant: 'ghost', onClick: () => tab._onBrowseScanDir(slot, pathEl) });
    const clearBtn = button({ label: 'Clear', icon: 'trash', variant: 'ghost', onClick: () => tab._onClearScanDir(slot, pathEl) });
    clearBtn.disabled = !sd[slot];
    tab._refs[`scan_${slot}_path`] = pathEl;
    tab._refs[`scan_${slot}_clear`] = clearBtn;
    adv.body.appendChild(knobRow({
      id: `scanDirs.${slot}`,
      title,
      description,
      control: el('div', { class: 'sv-llm-scan-control' }, [pathEl, el('div', { class: 'sv-button-row' }, [browseBtn, clearBtn])]),
      wide: true,
      search: 'scan folder directory library',
    }));
  }

  Object.assign(tab._refs, { modelSelect: select, hfRepoRow, importBtn, openBtn, rescanBtn, deleteBtn, scanResultEl: scanResult, modelAdvanced: adv });
  return c.root;
}

// mlx-lm also loads unquantized Hugging Face folders; vLLM cannot load
// MLX-quantized ones or GGUF files.
function modelFitsBackend(m, backend) {
  if (backend === 'vllm') return m.format === 'hf';
  if (isMlxBackend(backend)) return m.format === 'mlx' || m.format === 'hf';
  return m.format === 'gguf';
}

const EMPTY_LABELS = {
  vllm: 'No models. Import a model folder or enter a Hugging Face repo id.',
  mlx: 'No MLX models. Import an MLX folder.',
  gguf: 'No models. Import a .gguf file.',
};

/** Fill the model <select> with library entries the runtime can load. */
function renderModelOptions(select, models, { backend, lastModel }) {
  const visible = models.filter((m) => modelFitsBackend(m, backend));
  select.textContent = '';
  const repo = backend === 'vllm' && isHfRepoId(lastModel) ? lastModel : null;
  if (repo) {
    select.appendChild(el('option', { value: repo, selected: true }, [`${repo} (Hugging Face)`]));
  }
  if (visible.length === 0) {
    if (repo) { syncSelect(select); return { visible, autoSelected: null }; }
    select.appendChild(el('option', { value: '' }, [
      EMPTY_LABELS[backend === 'vllm' ? 'vllm' : isMlxBackend(backend) ? 'mlx' : 'gguf'],
    ]));
    syncSelect(select);
    return { visible, autoSelected: null };
  }
  let matched = !!repo;
  for (const m of visible) {
    const parts = [m.sizeHuman];
    if (m.quantization) parts.push(m.quantization);
    if (m.isMultiPart) parts.push(`${m.shardCount} parts${m.incomplete ? ' INCOMPLETE' : ''}`);
    if (m.missing) parts.push('MISSING');
    const opt = el('option', { value: m.path }, [`${m.name} (${parts.filter(Boolean).join(', ')})`]);
    if (!repo && m.path === lastModel) { opt.selected = true; matched = true; }
    select.appendChild(opt);
  }
  if (repo) select.value = repo;
  else if (!matched) select.value = visible[0].path;
  syncSelect(select);
  return { visible, autoSelected: matched ? null : visible[0].path };
}

module.exports = { buildModelCard, renderModelOptions, modelFitsBackend };
