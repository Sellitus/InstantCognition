// Per-model engine overrides editor.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { errMsg } = require('../../../../shared/errMsg');
const { actionButton, errorRow, setStatus } = require('./kit');

// Parse `key=value` lines into typed flag values. Lines without a key are
// returned in `invalid` so the editor can reject them instead of dropping them.
function parseFlags(raw) {
  /** @type {Record<string, string | number | boolean>} */
  const flags = {};
  const invalid = [];
  for (const line of String(raw || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
    const idx = line.indexOf('=');
    if (idx <= 0) {
      invalid.push(line);
      continue;
    }
    const k = line.slice(0, idx).trim();
    /** @type {string | number | boolean} */
    let v = line.slice(idx + 1).trim();
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
    else if (/^-?\d*\.\d+$/.test(v)) v = parseFloat(v);
    flags[k] = v;
  }
  return { flags, invalid };
}

// Per-model overrides — let a single model override the global backend and/or
// individual engine flags, stored under settings.llm.perModelOverrides keyed
// by model path. mergeStartOpts layers call-opts > per-model > global when the
// engine starts, so this is the "this one model runs hotter" surface.
function modelOverrides({ host, configBridge }) {
  const readMap = () => {
    const s = (configBridge.snapshot() || {}).settings || {};
    const om = (s.llm && s.llm.perModelOverrides) || {};
    return (om && typeof om === 'object') ? { ...om } : {};
  };
  const writeMap = (map) => configBridge.set('settings.llm.perModelOverrides', map);

  host.appendChild(el('p', { class: 'sv-section-intro' }, [
    'Override the inference backend or individual engine flags for a specific model. ',
    'Enter the model path (or the filename — matched case-insensitively) and tune the flags below. ',
    'These values layer over the global Models defaults when that model starts.',
  ]));

  const catalogStatus = el('div', {});
  const listEl = el('div', { class: 'sv-spaces-list' }, [
    el('p', { class: 'sv-empty-hint', role: 'status' }, ['Loading backends…']),
  ]);
  host.append(catalogStatus, listEl);

  /** @type {{ id: string, label: string }[]} */
  let backends = [];

  function rowFor(modelPath, override) {
    const row = el('div', { class: 'sv-space-row' });
    const pathInput = el('input', { type: 'text', class: 'sv-text', value: modelPath, placeholder: 'Model path or filename, e.g. /models/qwen2.5-7b.gguf' });

    const beSel = el('select', { class: 'sv-select', 'aria-label': 'Backend' });
    beSel.appendChild(el('option', { value: '' }, ['(use global backend)']));
    for (const b of backends) {
      beSel.appendChild(el('option', { value: b.id }, [b.label]));
    }
    // Keep a saved backend selectable even when the catalog lacks it, so a
    // re-save never silently drops the override.
    const savedBackend = (override && override.backend) || '';
    if (savedBackend && !backends.some((b) => b.id === savedBackend)) {
      beSel.appendChild(el('option', { value: savedBackend }, [savedBackend]));
    }
    beSel.value = savedBackend;

    const flagsArea = el('textarea', {
      class: 'sv-text', rows: '3',
      placeholder: 'Flag overrides, one per line, key=value (e.g.\ncontextSize=8192\ntemperature=0.3)',
    });
    flagsArea.value = override && override.flags
      ? Object.entries(override.flags).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')
      : '';

    const statusEl = el('span', { class: 'sv-validation-status' }, ['']);

    const saveBtn = actionButton('Save', 'sv-button sv-button--primary', 'check');
    saveBtn.addEventListener('click', () => {
      const key = pathInput.value.trim();
      if (!key) {
        setStatus(statusEl, 'error', 'Model path is required.');
        return;
      }
      const { flags, invalid } = parseFlags(flagsArea.value);
      if (invalid.length) {
        setStatus(statusEl, 'error', `Not key=value: ${invalid.join(', ')}`);
        return;
      }
      const next = {};
      if (beSel.value) next.backend = beSel.value;
      if (Object.keys(flags).length) next.flags = flags;
      const map = readMap();
      // Drop the old key if the path was renamed.
      delete map[modelPath];
      map[key] = next;
      writeMap(map);
      setStatus(statusEl, 'ok', 'Saved.');
    });

    const removeBtn = actionButton('Remove', 'sv-button');
    removeBtn.addEventListener('click', () => {
      const map = readMap();
      delete map[modelPath];
      writeMap(map);
      render();
    });

    row.append(
      el('div', { class: 'sv-row' }, [pathInput]),
      el('div', { class: 'sv-row' }, [beSel]),
      flagsArea,
      el('div', { class: 'sv-actions-row' }, [saveBtn, removeBtn, statusEl]),
    );
    return row;
  }

  function render() {
    const map = readMap();
    listEl.innerHTML = '';
    const entries = Object.entries(map);
    if (!entries.length) {
      listEl.appendChild(el('p', { class: 'sv-empty-hint' }, ['No per-model overrides. Every model uses the global defaults.']));
    } else {
      entries.forEach(([path, ov]) => listEl.appendChild(rowFor(path, ov)));
    }
  }

  const addBtn = actionButton('Add override', 'sv-button sv-button--primary', 'plus');
  addBtn.disabled = true;
  addBtn.addEventListener('click', () => {
    const map = readMap();
    let n = Object.keys(map).length + 1;
    while (Object.prototype.hasOwnProperty.call(map, `model-${n}`)) n += 1;
    map[`model-${n}`] = {};
    writeMap(map);
    render();
  });
  host.appendChild(el('div', { class: 'sv-actions-row' }, [addBtn]));

  // Rows render only after the backend catalog settles: a picker built from an
  // empty catalog would show "(use global backend)" for a saved override.
  ipcRenderer.invoke('llm:backends').then((r) => {
    if (r && Array.isArray(r.backends)) {
      backends = r.backends.map((b) => ({ id: b.id, label: b.label || b.id }));
    }
  }, (err) => {
    catalogStatus.appendChild(errorRow(`Couldn't load the backend list: ${errMsg(err)}. Saved backends are kept.`));
  }).then(() => {
    addBtn.disabled = false;
    render();
  });
}

module.exports = { modelOverrides, parseFlags };
