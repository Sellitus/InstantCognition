// LLMTab — the Local & Remote LLM configuration custom module. jsdom env.
//
// Mock only external boundaries: electron ipcRenderer (this module talks to
// main exclusively through it). Toast and controls.js are internal
// collaborators and run for real (both are jsdom-safe pure-DOM).

jest.mock('electron', () => ({
  ipcRenderer: {
    send: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
    invoke: jest.fn(() => Promise.resolve(null)),
  },
}));

const { ipcRenderer } = require('electron');

// The Engine card offers only the runtimes the platform runs, read once at
// module load, so each tab is built under a pinned platform (darwin unless a
// test asks otherwise) and the result does not depend on the CI host.
function loadLLMTab(platform = 'darwin') {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  let LLMTab;
  try {
    jest.isolateModules(() => { LLMTab = require('../../../../../renderer/components/settings/LLMTab'); });
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
  return LLMTab;
}

function makeTab(config = {}, invokeImpl = null, platform = 'darwin') {
  if (invokeImpl) ipcRenderer.invoke.mockImplementation(invokeImpl);
  else ipcRenderer.invoke.mockResolvedValue(null);
  const saved = [];
  const save = jest.fn((cfg) => saved.push(JSON.parse(JSON.stringify(cfg))));
  const LLMTab = loadLLMTab(platform);
  const tab = new LLMTab(config, save);
  return { tab, save, saved };
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const findBtn = (root, text) => Array.from(root.querySelectorAll('button')).find((b) => b.textContent.includes(text));

describe('LLMTab', () => {
  let host;
  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    ipcRenderer.send.mockClear();
    ipcRenderer.on.mockClear();
    ipcRenderer.invoke.mockReset();
    ipcRenderer.invoke.mockResolvedValue(null);
  });

  // -- State normalization ----------------------------------------------

  test('defaults to local mode + llamaCpp backend when config is empty', () => {
    const { tab } = makeTab({});
    tab.render(host);
    expect(tab._mode).toBe('local');
    expect(tab._selectedBackend).toBe('llamaCpp');
    expect(host.classList.contains('sv-llm-tab')).toBe(true);
  });

  test('legacy activeBackend "mlx" normalizes to mlxOpenAi', () => {
    const { tab } = makeTab({ settings: { llm: { activeBackend: 'mlx' } } });
    tab.render(host);
    expect(tab._selectedBackend).toBe('mlxOpenAi');
  });

  test('activeBackend "remote" with no explicit mode resolves mode=remote', () => {
    const { tab } = makeTab({ settings: { llm: { activeBackend: 'remote' } } });
    tab.render(host);
    expect(tab._mode).toBe('remote');
    // 'remote' is not a VALID_BACKEND → backend falls back to llamaCpp.
    expect(tab._selectedBackend).toBe('llamaCpp');
  });

  test('explicit mode wins over activeBackend inference', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local', activeBackend: 'remote' } } });
    tab.render(host);
    expect(tab._mode).toBe('local');
  });

  test('an unknown activeBackend falls back to llamaCpp', () => {
    const { tab } = makeTab({ settings: { llm: { activeBackend: 'totally-bogus' } } });
    tab.render(host);
    expect(tab._selectedBackend).toBe('llamaCpp');
  });

  // -- Cards + visibility -----------------------------------------------

  const CARD_KEYS = ['source', 'engine', 'model', 'server', 'performance', 'remote', 'vision', 'logs'];
  const visibleCards = (tab) => CARD_KEYS.filter((k) => !tab._refs.cards[k].hidden);
  const visiblePerf = (tab) => Object.entries(tab._refs.perfPanels)
    .filter(([, p]) => !p.main.hidden && !p.adv.hidden).map(([k]) => k);

  test('builds every Models card in order, each a searchable settings-v2 card', () => {
    const { tab } = makeTab({});
    tab.render(host);
    const ids = Array.from(host.children).map((c) => c.dataset.cardId);
    expect(ids).toEqual(CARD_KEYS.map((k) => `llm-${k}`));
    for (const card of host.children) expect(card.classList.contains('settings-v2-card')).toBe(true);
    expect(tab._refs.cards.vision.tagName).toBe('DETAILS');
    expect(tab._refs.cards.logs.tagName).toBe('DETAILS');
    expect(tab._refs.cards.logs.classList.contains('sv-llm-logs-card')).toBe(true);
  });

  test.each([
    ['local', 'llamaCpp', ['source', 'engine', 'model', 'server', 'performance', 'vision', 'logs'], ['llamaCpp'], false, 'Import .gguf'],
    ['local', 'mlxOpenAi', ['source', 'engine', 'model', 'server', 'performance', 'vision', 'logs'], ['mlxOpenAi'], true, 'Import MLX model folder'],
    ['local', 'omlx', ['source', 'engine', 'model', 'server', 'performance', 'vision', 'logs'], ['omlx'], true, 'Import MLX model folder'],
    ['remote', 'llamaCpp', ['source', 'remote', 'vision', 'logs'], ['llamaCpp'], false, 'Import .gguf'],
  ])('mode=%s backend=%s shows exactly the right cards and perf panel', (mode, backend, cards, perf, mlxShared, importLabel) => {
    const { tab } = makeTab({ settings: { llm: { mode, activeBackend: backend } } });
    tab.render(host);
    expect(visibleCards(tab)).toEqual(cards);
    expect(visiblePerf(tab)).toEqual(perf);
    expect(tab._refs.mlxShared.hidden).toBe(!mlxShared);
    expect(tab._refs.importBtn.getAttribute('aria-label')).toBe(importLabel);
    expect(tab._refs.importBtn.title).toBe(importLabel);
    expect(tab._refs.hfRepoRow.hidden).toBe(true);
  });

  test('darwin offers exactly llama.cpp, mlx-openai-server and oMLX, with no vLLM setup row', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } });
    tab.render(host);
    const values = Array.from(host.querySelectorAll('[data-setting-id="llm.activeBackend"] input[type="radio"]')).map((i) => i.value);
    expect(values).toEqual(['llamaCpp', 'mlxOpenAi', 'omlx']);
    expect(host.querySelector('[data-setting-id="llm.vllmSetup"]')).toBeNull();
  });

  test.each(['linux', 'win32'])('%s offers llama.cpp and vLLM, and selecting vLLM shows its panel, repo field and folder import', (platform) => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'local' } } }, null, platform);
    tab.render(host);
    const values = Array.from(host.querySelectorAll('[data-setting-id="llm.activeBackend"] input[type="radio"]')).map((i) => i.value);
    expect(values).toEqual(['llamaCpp', 'vllm']);
    expect(host.querySelector('[data-setting-id="llm.vllmSetup"]')).not.toBeNull();
    const vllm = host.querySelector('#set-llm-backend-vllm');
    vllm.checked = true;
    vllm.dispatchEvent(new Event('change'));
    expect(save).toHaveBeenCalledWith('activeBackend', 'vllm');
    expect(visiblePerf(tab)).toEqual(['vllm']);
    expect(tab._refs.mlxShared.hidden).toBe(true);
    expect(tab._refs.hfRepoRow.hidden).toBe(false);
    expect(tab._refs.importBtn.getAttribute('aria-label')).toBe('Import model folder');
  });

  test('an MLX backend saved on Linux is not offered there and falls back to llamaCpp', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local', activeBackend: 'omlx' } } }, null, 'linux');
    tab.render(host);
    expect(tab._selectedBackend).toBe('llamaCpp');
  });

  test('the removed mlxLm backend is no longer valid and falls back to llamaCpp', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local', activeBackend: 'mlxLm' } } });
    tab.render(host);
    expect(tab._selectedBackend).toBe('llamaCpp');
    expect(host.querySelector('#set-llm-backend-mlxLm')).toBeNull();
  });

  test('switching the Source pill to Remote persists mode and swaps the cards', () => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'local' } } });
    tab.render(host);
    const remote = host.querySelector('#set-llm-mode-remote');
    remote.checked = true;
    remote.dispatchEvent(new Event('change'));
    expect(tab._mode).toBe('remote');
    expect(save).toHaveBeenLastCalledWith('mode', 'remote');
    expect(visibleCards(tab)).toEqual(['source', 'remote', 'vision', 'logs']);
  });

  test('switching the Engine pill persists activeBackend, swaps the perf panel and re-renders models', () => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'local', activeBackend: 'llamaCpp' } } });
    tab.render(host);
    tab.models = [{ name: 'M', path: '/m', format: 'mlx', sizeHuman: '1G' }];
    const omlx = host.querySelector('#set-llm-backend-omlx');
    omlx.checked = true;
    omlx.dispatchEvent(new Event('change'));
    expect(tab._selectedBackend).toBe('omlx');
    expect(save).toHaveBeenCalledWith('activeBackend', 'omlx');
    expect(visiblePerf(tab)).toEqual(['omlx']);
    expect(tab._refs.modelSelect.value).toBe('/m');
  });

  test('an invalid engine value coerces back to llamaCpp', () => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'local', activeBackend: 'omlx' } } });
    tab.render(host);
    expect(tab._selectedBackend).toBe('omlx');
    const r = host.querySelector('#set-llm-backend-llamaCpp');
    r.value = 'garbage';
    r.checked = true;
    r.dispatchEvent(new Event('change'));
    // pillGroup reports the option's declared value, so feed the handler directly too.
    tab._onBackendChange('garbage');
    expect(tab._selectedBackend).toBe('llamaCpp');
    expect(save).toHaveBeenLastCalledWith('activeBackend', 'llamaCpp');
  });

  // -- _setLLM deep write ------------------------------------------------

  test('_setLLM creates nested settings.llm paths and calls save', () => {
    const { tab, save } = makeTab({});
    tab.render(host);
    save.mockClear();
    tab._setLLM('llamaCpp.contextSize', 4096);
    expect(tab.config.settings.llm.llamaCpp.contextSize).toBe(4096);
    expect(save).toHaveBeenCalledTimes(1);
  });

  test('destroy() removes every realtime listener it registered (no leak on re-mount)', () => {
    ipcRenderer.on.mockClear();
    ipcRenderer.removeListener.mockClear();
    const { tab } = makeTab({});
    tab.render(host);
    const registered = ipcRenderer.on.mock.calls.filter((c) => String(c[0]).startsWith('llm:'));
    expect(registered.length).toBeGreaterThan(0);
    tab.destroy();
    // Each llm:* channel registered must be removed with the same handler.
    for (const [channel, fn] of registered) {
      expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, fn);
    }
  });

  // -- Every knob persists (table-driven) --------------------------------

  // [data-setting-id, kind, input, saved key, saved value, starting config]
  const KNOBS = [
    ['llm.mode', 'pills', 'remote', 'mode', 'remote', {}],
    ['llm.activeBackend', 'pills', 'mlxOpenAi', 'activeBackend', 'mlxOpenAi', {}],
    ['llm.llamaCpp.contextSize', 'number', '8192', 'llamaCpp.contextSize', 8192, {}],
    ['llm.llamaCpp.gpuLayers', 'number', '20', 'llamaCpp.gpuLayers', 20, {}],
    ['llm.llamaCpp.threads', 'number', '8', 'llamaCpp.threads', 8, {}],
    ['llm.llamaCpp.parallel', 'number', '2', 'llamaCpp.parallel', 2, {}],
    ['llm.llamaCpp.flashAttention', 'toggle', false, 'llamaCpp.flashAttention', false, {}],
    ['llm.llamaCpp.contBatching', 'toggle', false, 'llamaCpp.contBatching', false, {}],
    ['llm.llamaCpp.cacheTypeK', 'select', 'f16', 'llamaCpp.cacheTypeK', 'f16', {}],
    ['llm.llamaCpp.cacheTypeV', 'select', 'q4_0', 'llamaCpp.cacheTypeV', 'q4_0', {}],
    ['llm.llamaCpp.batchSize', 'number', '1024', 'llamaCpp.batchSize', 1024, {}],
    ['llm.llamaCpp.ubatchSize', 'number', '256', 'llamaCpp.ubatchSize', 256, {}],
    ['llm.llamaCpp.mlock', 'toggle', true, 'llamaCpp.mlock', true, {}],
    ['llm.llamaCpp.noMmap', 'toggle', true, 'llamaCpp.noMmap', true, {}],
    ['llm.llamaCpp.jinja', 'toggle', true, 'llamaCpp.jinja', true, {}],
    ['llm.mlxOpenAi.contextLength', 'number', '32768', 'mlxOpenAi.contextLength', 32768, { activeBackend: 'mlxOpenAi' }],
    ['llm.mlxOpenAi.enableAutoToolChoice', 'toggle', false, 'mlxOpenAi.enableAutoToolChoice', false, { activeBackend: 'mlxOpenAi' }],
    ['llm.mlxOpenAi.forceTextOnly', 'toggle', true, 'mlxOpenAi.forceTextOnly', true, { activeBackend: 'mlxOpenAi' }],
    ['llm.omlx.contextLength', 'number', '32768', 'omlx.contextLength', 32768, { activeBackend: 'omlx' }],
    ['llm.omlx.maxConcurrentRequests', 'number', '4', 'omlx.maxConcurrentRequests', 4, { activeBackend: 'omlx' }],
    ['llm.omlx.memoryGuard', 'select', 'safe', 'omlx.memoryGuard', 'safe', { activeBackend: 'omlx' }],
    ['llm.mlx.fallbackEnabled', 'toggle', false, 'mlx.fallbackEnabled', false, { activeBackend: 'omlx' }],
    ['llm.vllm.maxModelLen', 'number', '16384', 'vllm.maxModelLen', 16384, {}],
    ['llm.vllm.gpuMemoryUtilization', 'number', '0.85', 'vllm.gpuMemoryUtilization', 0.85, {}],
    ['llm.vllm.toolParser', 'select', 'hermes', 'vllm.toolParser', 'hermes', {}],
    ['llm.vllm.tensorParallelSize', 'number', '2', 'vllm.tensorParallelSize', 2, {}],
    ['llm.vllm.dtype', 'select', 'bfloat16', 'vllm.dtype', 'bfloat16', {}],
    ['llm.vllm.trustRemoteCode', 'toggle', true, 'vllm.trustRemoteCode', true, {}],
    ['llm.serverPort', 'number', '9000', 'serverPort', 9000, {}],
    ['llm.autoStart', 'toggle', true, 'autoStart', true, {}],
    ['llm.vision.enabled', 'toggle', true, 'vision.enabled', true, {}],
    ['llm.vision.autoDetect', 'toggle', false, 'vision.autoDetect', false, {}],
    ['llm.vision.maxImages', 'number', '5', 'vision.maxImages', 5, {}],
    ['llm.vision.longEdgePx', 'number', '1024', 'vision.longEdgePx', 1024, {}],
    ['llm.remote.endpoint', 'text', '  https://api.test/v1  ', 'remote.endpoint', 'https://api.test/v1', { mode: 'remote' }],
    ['llm.remote.apiKey', 'text', '  sk-123  ', 'remote.apiKey', 'sk-123', { mode: 'remote' }],
    ['llm.remote.visionCapable', 'toggle', true, 'remote.visionCapable', true, { mode: 'remote' }],
    ['llm.remote.toolMode', 'pills', 'json', 'remote.toolMode', 'json', { mode: 'remote' }],
  ];
  // Rows that render state or actions rather than a persisted knob.
  const NON_KNOB_ROWS = new Set([
    'llm.detectedEngines', 'llm.lastModel', 'llm.serverStatus', 'llm.scanDirs.combined', 'llm.scanDirs.mlx',
    'llm.scanDirs.gguf', 'llm.remote.verify', 'llm.remote.model', 'llm.remote.activate', 'llm.logs',
    // Writes lastModel, which the model select owns; covered by its own tests.
    'llm.vllmHfRepo',
  ]);

  function drive(row, kind, input) {
    if (kind === 'toggle') {
      const cb = row.querySelector('input[type="checkbox"]');
      cb.checked = input;
      cb.dispatchEvent(new Event('change'));
    } else if (kind === 'pills') {
      const radio = row.querySelector(`input[type="radio"][value="${input}"]`);
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
    } else if (kind === 'select') {
      const sel = row.querySelector('select');
      sel.value = input;
      sel.dispatchEvent(new Event('change'));
    } else {
      const field = row.querySelector('input');
      field.value = input;
      field.dispatchEvent(new Event('change'));
    }
  }

  test.each(KNOBS)('%s (%s) persists exactly through _setLLM', (settingId, kind, input, key, value, llm) => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'local', ...llm } } });
    tab.render(host);
    const rows = host.querySelectorAll(`[data-setting-id="${settingId}"]`);
    expect(rows.length).toBe(1);
    expect(rows[0].dataset.search.length).toBeGreaterThan(0);
    save.mockClear();
    drive(rows[0], kind, input);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(key, value);
    const parts = key.split('.');
    let cur = tab.config.settings.llm;
    for (const p of parts) cur = cur[p];
    expect(cur).toBe(value);
  });

  test('every Models row carries data-setting-id + data-search and every knob is in the table', () => {
    const { tab } = makeTab({});
    tab.render(host);
    const rows = Array.from(host.querySelectorAll('.settings-v2-row'));
    const known = new Set(KNOBS.map((k) => k[0]));
    for (const row of rows) {
      expect(row.dataset.settingId).toMatch(/^llm\./);
      expect(row.dataset.search).toBeTruthy();
      const id = row.dataset.settingId;
      expect(known.has(id) || NON_KNOB_ROWS.has(id)).toBe(true);
    }
    const ids = rows.map((r) => r.dataset.settingId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of known) expect(ids).toContain(id);
  });

  test('the MLX fallback toggle renders exactly once', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local', activeBackend: 'mlxOpenAi' } } });
    tab.render(host);
    expect(host.querySelectorAll('[data-setting-id="llm.mlx.fallbackEnabled"]').length).toBe(1);
    expect(host.querySelectorAll('input[id*="fallback"]').length).toBe(1);
  });

  test('number knobs clamp out-of-range input before persisting', () => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'local' } } });
    tab.render(host);
    const ctx = host.querySelector('[data-setting-id="llm.llamaCpp.contextSize"] input');
    ctx.value = '100';
    ctx.dispatchEvent(new Event('change'));
    expect(save).toHaveBeenLastCalledWith('llamaCpp.contextSize', 512);
    expect(ctx.value).toBe('512');
    const port = host.querySelector('[data-setting-id="llm.serverPort"] input');
    port.value = '70000';
    port.dispatchEvent(new Event('change'));
    expect(save).toHaveBeenLastCalledWith('serverPort', 65535);
  });

  test('empty / non-numeric number input is rejected: nothing saved, field marked invalid and reverted', () => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'local', llamaCpp: { gpuLayers: 12 } } } });
    tab.render(host);
    const gpu = host.querySelector('[data-setting-id="llm.llamaCpp.gpuLayers"] input');
    save.mockClear();
    gpu.value = '';
    gpu.dispatchEvent(new Event('change'));
    expect(save).not.toHaveBeenCalled();
    expect(gpu.getAttribute('aria-invalid')).toBe('true');
    expect(gpu.value).toBe('12');
    expect(tab.config.settings.llm.llamaCpp.gpuLayers).toBe(12);
  });

  test('an unknown cache type value is rejected by the select', () => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'local' } } });
    tab.render(host);
    const sel = host.querySelector('[data-setting-id="llm.llamaCpp.cacheTypeK"] select');
    sel.appendChild(Object.assign(document.createElement('option'), { value: 'q2_bogus' }));
    save.mockClear();
    sel.value = 'q2_bogus';
    sel.dispatchEvent(new Event('change'));
    expect(save).not.toHaveBeenCalled();
    expect(sel.value).toBe('q8_0');
  });

  test('cache selects are enhanced and label every cache type', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local', llamaCpp: { cacheTypeK: 'iq4_nl' } } } });
    tab.render(host);
    const row = host.querySelector('[data-setting-id="llm.llamaCpp.cacheTypeK"]');
    expect(row.querySelector('.ic-select .ic-select-trigger')).not.toBeNull();
    const labels = Array.from(row.querySelectorAll('option')).map((o) => o.textContent);
    expect(labels).toEqual(['F32 (full precision)', 'F16 (half)', 'BF16', 'Q8_0', 'Q5_1', 'Q5_0', 'Q4_1', 'Q4_0', 'IQ4_NL (K only)']);
    expect(row.querySelector('select').value).toBe('iq4_nl');
  });

  // -- Remote endpoint / key persist on commit (regression) ---------------

  test('committing the endpoint persists the trimmed URL (was a no-op)', () => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: '' } } } });
    tab.render(host);
    expect(tab._refs.remoteRefreshBtn.disabled).toBe(true);
    const url = tab._refs.remoteUrlInput;
    url.value = ' https://openrouter.ai/api ';
    url.dispatchEvent(new Event('change'));
    expect(save).toHaveBeenLastCalledWith('remote.endpoint', 'https://openrouter.ai/api');
    expect(tab.config.settings.llm.remote.endpoint).toBe('https://openrouter.ai/api');
    expect(url.value).toBe('https://openrouter.ai/api');
    expect(tab._refs.remoteRefreshBtn.disabled).toBe(false);
  });

  test('committing the API key persists it (was a no-op)', () => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'remote' } } });
    tab.render(host);
    const key = tab._refs.remoteKeyInput;
    expect(key.type).toBe('password');
    key.value = 'sk-live ';
    key.dispatchEvent(new Event('change'));
    expect(save).toHaveBeenLastCalledWith('remote.apiKey', 'sk-live');
    expect(tab.config.settings.llm.remote.apiKey).toBe('sk-live');
  });

  test('an invalid endpoint is not persisted and shows a visible error', () => {
    const { tab, save } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://ok.test' } } } });
    tab.render(host);
    save.mockClear();
    const url = tab._refs.remoteUrlInput;
    url.value = 'ftp://files.test';
    url.dispatchEvent(new Event('change'));
    expect(save).not.toHaveBeenCalled();
    expect(tab.config.settings.llm.remote.endpoint).toBe('https://ok.test');
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(tab._refs.remoteUrlStatus.hidden).toBe(false);
    expect(tab._refs.remoteUrlStatus.getAttribute('role')).toBe('alert');
    expect(tab._refs.remoteUrlStatus.textContent).toBe('Enter an http(s) URL, e.g. https://api.openai.com');
    url.value = 'https://fixed.test';
    url.dispatchEvent(new Event('change'));
    expect(save).toHaveBeenLastCalledWith('remote.endpoint', 'https://fixed.test');
    expect(url.hasAttribute('aria-invalid')).toBe(false);
    expect(tab._refs.remoteUrlStatus.hidden).toBe(true);
  });

  test('model <select> change persists lastModel (or null when blank)', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } });
    tab.render(host);
    const sel = tab._refs.modelSelect;
    sel.innerHTML = '<option value="/m/a.gguf">a</option>';
    sel.value = '/m/a.gguf';
    sel.dispatchEvent(new Event('change'));
    expect(tab.config.settings.llm.lastModel).toBe('/m/a.gguf');
    sel.innerHTML = '<option value="">none</option>';
    sel.value = '';
    sel.dispatchEvent(new Event('change'));
    expect(tab.config.settings.llm.lastModel).toBeNull();
  });

  test('Delete removes the selected model after the confirm is accepted', async () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local', lastModel: '/m/a.gguf' } } });
    tab.render(host);
    const sel = tab._refs.modelSelect;
    sel.innerHTML = '<option value="/m/a.gguf">a</option>';
    sel.value = '/m/a.gguf';

    tab._refs.deleteBtn.click();
    await tick();
    const dialogBtn = Array.from(document.querySelectorAll('.confirm-dialog-actions button'))
      .find((b) => b.textContent.includes('Delete'));
    expect(dialogBtn).toBeTruthy();
    dialogBtn.click();
    await tick();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('llm:delete-model', '/m/a.gguf');
    // The deleted model must not stay selected in config.
    expect(tab.config.settings.llm.lastModel).toBeNull();
  });

  test('Delete does nothing when the confirm is cancelled', async () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local', lastModel: '/m/a.gguf' } } });
    tab.render(host);
    const sel = tab._refs.modelSelect;
    sel.innerHTML = '<option value="/m/a.gguf">a</option>';
    sel.value = '/m/a.gguf';

    tab._refs.deleteBtn.click();
    await tick();
    const cancelBtn = Array.from(document.querySelectorAll('.confirm-dialog-actions button'))
      .find((b) => b.textContent.includes('Cancel'));
    cancelBtn.click();
    await tick();

    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('llm:delete-model', expect.anything());
    expect(tab.config.settings.llm.lastModel).toBe('/m/a.gguf');
  });

  // -- refresh() data fetch + render ------------------------------------

  test('render() → refresh() paints engines, models, status, and logs', async () => {
    const invoke = (channel) => {
      switch (channel) {
        case 'llm:detect-engines':
          return Promise.resolve({
            llamaCpp: { available: true, path: '/bin/llama', version: '1.0' },
            mlxOpenAi: { available: false, reason: 'no python' },
            omlx: { available: false, reason: 'oMLX not installed' },
            capabilities: { platform: 'darwin', arch: 'arm64', cpuCores: 10, ramGB: 32, hasMetalSupport: true },
          });
        case 'llm:list-models':
          return Promise.resolve([
            { name: 'Llama', path: '/m/llama.gguf', format: 'gguf', sizeHuman: '4 GB', quantization: 'Q4' },
          ]);
        case 'llm:get-status':
          return Promise.resolve({ status: 'running', endpoint: 'http://127.0.0.1:8421' });
        case 'llm:get-logs':
          return Promise.resolve([{ level: 'info', message: 'started' }]);
        default:
          return Promise.resolve(null);
      }
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local', lastModel: '/m/llama.gguf' } } }, invoke);
    tab.render(host);
    await tick();
    expect(tab._refs.enginesEl.textContent).toContain('llama.cpp');
    expect(tab._refs.capsEl.hidden).toBe(false);
    expect(tab._refs.capsEl.textContent).toContain('darwin');
    const opt = tab._refs.modelSelect.querySelector('option[value="/m/llama.gguf"]');
    expect(opt).not.toBeNull();
    expect(opt.selected).toBe(true);
    expect(tab._refs.statusPill.textContent).toBe('running');
    expect(tab._refs.statusPill.className).toContain('running');
    expect(tab._refs.endpointEl.textContent).toBe('http://127.0.0.1:8421');
    expect(tab._refs.startBtn.disabled).toBe(true); // running → start disabled
    expect(tab._refs.logsEl.textContent).toContain('[info] started');
  });

  test('_renderEngines lists one row per offered runtime and marks unreported ones', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:detect-engines') {
        return Promise.resolve({
          llamaCpp: { available: false, reason: 'not found' },
          omlx: { available: true, pythonPath: '/py', version: '0.7.0' },
          vllm: { available: true, version: '0.31.0' },
        });
      }
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    const rows = Array.from(tab._refs.enginesEl.querySelectorAll('.sv-llm-engine-row'));
    expect(rows.map((r) => r.querySelector('.sv-llm-engine-name').textContent)).toEqual(['llama.cpp', 'mlx-openai-server', 'oMLX']);
    expect(rows.map((r) => r.classList.contains('available'))).toEqual([false, false, true]);
    expect(rows[1].querySelector('.sv-llm-engine-info').textContent).toBe('not reported');
    expect(rows[2].querySelector('.sv-llm-engine-info').textContent).toBe('0.7.0');
    expect(tab._refs.enginesEl.textContent).not.toContain('vLLM');
  });

  test('_renderModels shows the no-models option when none match the backend', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:list-models') return Promise.resolve([{ name: 'x', path: '/x', format: 'mlx', sizeHuman: '1G' }]);
      return Promise.resolve(null);
    };
    const { tab, save } = makeTab({ settings: { llm: { mode: 'local', activeBackend: 'llamaCpp' } } }, invoke);
    tab.render(host);
    await tick();
    const opts = tab._refs.modelSelect.querySelectorAll('option');
    expect(opts.length).toBe(1);
    expect(opts[0].value).toBe('');
    expect(opts[0].textContent).toBe('No models. Import a .gguf file.');
    expect(save).not.toHaveBeenCalledWith('lastModel', expect.anything());
  });

  test('_renderModels auto-selects + persists the first model when none matches lastModel', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:list-models') return Promise.resolve([{ name: 'A', path: '/a.gguf', format: 'gguf', sizeHuman: '2G' }]);
      return Promise.resolve(null);
    };
    const { tab, save } = makeTab({ settings: { llm: { mode: 'local', lastModel: '/not/here' } } }, invoke);
    tab.render(host);
    await tick();
    expect(tab._refs.modelSelect.value).toBe('/a.gguf');
    expect(save).toHaveBeenCalledWith('lastModel', '/a.gguf');
    expect(host.querySelector('[data-setting-id="llm.lastModel"] .ic-select-trigger').textContent).toContain('A (2G)');
  });

  test('detect-engines rejection renders a visible error in the Engine card', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:detect-engines') return Promise.reject(new Error('boom'));
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    expect(() => tab.render(host)).not.toThrow();
    await tick();
    const st = tab._refs.detectStatus;
    expect(st.hidden).toBe(false);
    expect(st.textContent).toBe("Couldn't detect engines: boom");
    expect(st.getAttribute('role')).toBe('alert');
    expect(tab._refs.enginesEl.textContent).toBe('');
  });

  // -- Re-detect button --------------------------------------------------

  test('Re-detect button forces a fresh detect-engines call', async () => {
    const calls = [];
    const invoke = (channel, arg) => {
      calls.push([channel, arg]);
      if (channel === 'llm:detect-engines') {
        return Promise.resolve({ llamaCpp: { available: true, path: '/x' }, mlxOpenAi: { available: false }, omlx: { available: false } });
      }
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    findBtn(host, 'Re-detect').click();
    await tick();
    expect(calls.some(([c, a]) => c === 'llm:detect-engines' && a && a.force === true)).toBe(true);
  });

  // -- Server start / stop ----------------------------------------------

  test('Start (local) invokes llm:start with backend + model path', async () => {
    const calls = [];
    const invoke = (channel, arg) => { calls.push([channel, arg]); return Promise.resolve(null); };
    const { tab } = makeTab({ settings: { llm: { mode: 'local', activeBackend: 'llamaCpp' } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.modelSelect.innerHTML = '<option value="/m/x.gguf">x</option>';
    tab._refs.modelSelect.value = '/m/x.gguf';
    await tab._onStartServer();
    const start = calls.find(([c]) => c === 'llm:start');
    expect(start).toBeTruthy();
    expect(start[1]).toEqual({ backend: 'llamaCpp', modelPath: '/m/x.gguf' });
    expect(tab._engineActionPending).toBe(false);
  });

  test('Start while an action is pending is a no-op', async () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } });
    tab.render(host);
    await tick();
    tab._engineActionPending = true;
    ipcRenderer.invoke.mockClear();
    await tab._onStartServer();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('llm:start', expect.anything());
  });

  test('Start in remote mode delegates to _activateRemote (no llm:start)', async () => {
    const calls = [];
    const invoke = (channel, arg) => { calls.push([channel, arg]); return Promise.resolve(null); };
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test' } } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.remoteUrlInput.value = 'https://api.test';
    await tab._onStartServer();
    expect(calls.some(([c]) => c === 'llm:set-remote')).toBe(true);
    expect(calls.some(([c]) => c === 'llm:start')).toBe(false);
  });

  test('Start failure surfaces a toast and clears the pending flag', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:start') return Promise.reject(new Error('cannot start'));
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    await tab._onStartServer();
    expect(tab._engineActionPending).toBe(false);
    expect(document.querySelector('.toast-stack')).not.toBeNull();
  });

  test('Stop (local) invokes llm:stop; Stop (remote) clears remote', async () => {
    const calls = [];
    const invoke = (channel) => { calls.push(channel); return Promise.resolve(null); };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    await tab._onStopServer();
    expect(calls).toContain('llm:stop');

    const { tab: rtab } = makeTab({ settings: { llm: { mode: 'remote' } } }, invoke);
    rtab.render(host);
    await tick();
    calls.length = 0;
    await rtab._onStopServer();
    expect(calls).toContain('llm:clear-remote');
  });

  test('Stop failure surfaces a toast', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:stop') return Promise.reject(new Error('stop fail'));
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    await tab._onStopServer();
    expect(tab._engineActionPending).toBe(false);
  });

  // -- Model import / scan ----------------------------------------------

  test('Import model: success path persists returned path and refetches models', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:import-model') return Promise.resolve({ path: '/imported.gguf' });
      if (channel === 'llm:list-models') return Promise.resolve([{ name: 'I', path: '/imported.gguf', format: 'gguf', sizeHuman: '3G' }]);
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    await tab._onImportModel();
    expect(tab.config.settings.llm.lastModel).toBe('/imported.gguf');
  });

  test('Import model: rejection surfaces a toast and does not throw', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:import-model') return Promise.reject(new Error('import fail'));
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    await expect(tab._onImportModel()).resolves.toBeUndefined();
  });

  test('Rescan reports counts; scan failure shows the error', async () => {
    let scanImpl = () => Promise.resolve({ mlx: 2, gguf: 5, added: 3, skipped: 4 });
    const invoke = (channel) => {
      if (channel === 'llm:scan-models') return scanImpl();
      if (channel === 'llm:list-models') return Promise.resolve([]);
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.rescanBtn.click();
    expect(tab._refs.rescanBtn.disabled).toBe(true);
    await tick(); await tick();
    expect(tab._refs.rescanBtn.disabled).toBe(false);
    expect(tab._refs.scanResultEl.textContent).toBe('Found 2 MLX + 5 GGUF (3 new, 4 already registered)');
    expect(tab._refs.scanResultEl.dataset.state).toBe('ok');
    scanImpl = () => Promise.reject(new Error('scan boom'));
    const r = await tab._runScan();
    expect(r).toBeNull();
    expect(tab._refs.scanResultEl.textContent).toBe('Scan failed: scan boom');
    expect(tab._refs.scanResultEl.dataset.state).toBe('error');
  });

  test('Open models folder failure is shown in the Model card (was swallowed)', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:open-models-dir') return Promise.reject(new Error('EPERM'));
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.openBtn.click();
    await tick();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('llm:open-models-dir');
    expect(tab._refs.scanResultEl.textContent).toBe("Couldn't open the models folder: EPERM");
    expect(tab._refs.scanResultEl.getAttribute('role')).toBe('alert');
  });

  test('Browse scan dir: chosen folder is set, cleared button enabled, scan runs', async () => {
    const calls = [];
    const invoke = (channel, arg) => {
      calls.push([channel, arg]);
      if (channel === 'llm:browse-scan-dir') return Promise.resolve('/models/dir');
      if (channel === 'llm:scan-models') return Promise.resolve({ mlx: 0, gguf: 0, added: 0, skipped: 0 });
      if (channel === 'llm:list-models') return Promise.resolve([]);
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    const pathEl = tab._refs.scan_combined_path;
    await tab._onBrowseScanDir('combined', pathEl);
    expect(pathEl.textContent).toBe('/models/dir');
    expect(tab._refs.scan_combined_clear.disabled).toBe(false);
    expect(calls.some(([c, a]) => c === 'llm:set-scan-dirs' && a.combined === '/models/dir')).toBe(true);
  });

  test('Browse scan dir cancelled (no folder) is a no-op', async () => {
    const calls = [];
    const invoke = (channel, arg) => {
      calls.push([channel, arg]);
      if (channel === 'llm:browse-scan-dir') return Promise.resolve(null);
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    await tab._onBrowseScanDir('mlx', tab._refs.scan_mlx_path);
    expect(calls.some(([c]) => c === 'llm:set-scan-dirs')).toBe(false);
  });

  test('Clear scan dir resets the path and disables its Clear button', async () => {
    const calls = [];
    const invoke = (channel, arg) => { calls.push([channel, arg]); return Promise.resolve(null); };
    const { tab } = makeTab({ settings: { llm: { mode: 'local', scanDirs: { gguf: '/old' } } } }, invoke);
    tab.render(host);
    await tick();
    const pathEl = tab._refs.scan_gguf_path;
    expect(pathEl.textContent).toBe('/old');
    expect(tab._refs.scan_gguf_clear.disabled).toBe(false);
    expect(tab._refs.scan_mlx_clear.disabled).toBe(true);
    await tab._onClearScanDir('gguf', pathEl);
    expect(pathEl.textContent).toBe('Not set');
    expect(tab._refs.scan_gguf_clear.disabled).toBe(true);
    expect(calls.some(([c, a]) => c === 'llm:set-scan-dirs' && a.gguf === null)).toBe(true);
  });

  // -- Remote: verify / activate / clear --------------------------------

  test('Verify with no endpoint shows an error and skips the IPC', async () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'remote' } } });
    tab.render(host);
    await tick();
    tab._refs.remoteUrlInput.value = '';
    ipcRenderer.invoke.mockClear();
    await tab._verifyRemote(false);
    expect(tab._refs.verifyStatusEl.textContent).toContain('required');
    expect(tab._refs.verifyStatusEl.dataset.state).toBe('error');
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('llm:verify-remote', expect.anything());
  });

  test('Verify success populates the model dropdown + OK status', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:verify-remote') return Promise.resolve({ ok: true, models: ['gpt-4o', 'gpt-4o-mini'] });
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test' } } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.remoteUrlInput.value = 'https://api.test';
    await tab._verifyRemote(false);
    expect(tab._refs.verifyStatusEl.dataset.state).toBe('ok');
    expect(tab._refs.verifyStatusEl.textContent).toContain('2 models');
    const opts = Array.from(tab._refs.remoteModelSelect.querySelectorAll('option')).map((o) => o.value);
    expect(opts).toEqual(expect.arrayContaining(['gpt-4o', 'gpt-4o-mini']));
    expect(tab._refs.remoteModelSelect.disabled).toBe(false);
  });

  test('Verify OK with zero models reports the empty-list message', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:verify-remote') return Promise.resolve({ ok: true, models: [] });
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test' } } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.remoteUrlInput.value = 'https://api.test';
    await tab._verifyRemote(true);
    expect(tab._refs.verifyStatusEl.textContent).toContain('0 models');
    expect(tab._refs.remoteModelSelect.disabled).toBe(true);
  });

  test('Verify failure (ok:false) surfaces the returned error', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:verify-remote') return Promise.resolve({ ok: false, error: 'bad key' });
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test' } } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.remoteUrlInput.value = 'https://api.test';
    await tab._verifyRemote(false);
    expect(tab._refs.verifyStatusEl.textContent).toBe('bad key');
    expect(tab._refs.verifyStatusEl.dataset.state).toBe('error');
  });

  test('Verify rejection surfaces a "Verify failed:" message', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:verify-remote') return Promise.reject(new Error('network'));
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test' } } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.remoteUrlInput.value = 'https://api.test';
    await tab._verifyRemote(false);
    expect(tab._refs.verifyStatusEl.textContent).toContain('Verify failed: network');
  });

  test('remote model dropdown change persists settings.llm.remote.model', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:verify-remote') return Promise.resolve({ ok: true, models: ['m1'] });
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test' } } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.remoteUrlInput.value = 'https://api.test';
    await tab._verifyRemote(false);
    const sel = tab._refs.remoteModelSelect;
    sel.value = 'm1';
    sel.dispatchEvent(new Event('change'));
    expect(tab.config.settings.llm.remote.model).toBe('m1');
  });

  test('saved remote.model pre-populates the model dropdown', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test', model: 'saved-model' } } } });
    tab.render(host);
    const opt = tab._refs.remoteModelSelect.querySelector('option');
    expect(opt.value).toBe('saved-model');
    expect(tab._refs.remoteModelSelect.disabled).toBe(false);
  });

  test('Use Remote with no endpoint warns and does not call llm:set-remote', async () => {
    const calls = [];
    const invoke = (channel) => { calls.push(channel); return Promise.resolve(null); };
    const { tab } = makeTab({ settings: { llm: { mode: 'remote' } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.remoteUrlInput.value = '';
    await tab._activateRemote();
    expect(calls).not.toContain('llm:set-remote');
  });

  test('Use Remote success calls llm:set-remote with endpoint/key/model', async () => {
    const calls = [];
    const invoke = (channel, arg) => { calls.push([channel, arg]); return Promise.resolve(null); };
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test', toolMode: 'native' } } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.remoteUrlInput.value = 'https://api.test';
    tab._refs.remoteKeyInput.value = 'sk-123';
    tab._refs.remoteModelSelect.innerHTML = '<option value="m">m</option>';
    tab._refs.remoteModelSelect.value = 'm';
    await tab._activateRemote();
    const set = calls.find(([c]) => c === 'llm:set-remote');
    expect(set[1]).toEqual({ endpoint: 'https://api.test', apiKey: 'sk-123', model: 'm', visionCapable: false });
  });

  test('Use Remote rejection surfaces an error toast', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:set-remote') return Promise.reject(new Error('activate fail'));
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test' } } } }, invoke);
    tab.render(host);
    await tick();
    tab._refs.remoteUrlInput.value = 'https://api.test';
    await expect(tab._activateRemote()).resolves.toBeUndefined();
    expect(document.querySelector('.toast-stack .toast-message').textContent).toContain('Activate failed: activate fail');
  });

  test.each([
    ['local engine running', { status: 'running', isRemote: false }, ['Remote API set', 'which is not locally hosted', 'keeps serving until you stop it'], 'Remote API active'],
    ['local engine starting', { status: 'starting', isRemote: false }, ['Remote API set', 'which is not locally hosted', 'keeps serving until you stop it'], 'Remote API active'],
    ['no local engine', { status: 'stopped', isRemote: false }, ['Remote API active'], 'keeps serving'],
  ])('Use Remote success toast under %s states who serves', async (_n, held, wants, notWant) => {
    const invoke = (c) => (c === 'llm:get-status' ? Promise.resolve(held) : Promise.resolve(null));
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test', toolMode: 'native' } } } }, invoke);
    tab.render(host);
    await tick();
    await tab._activateRemote();
    const text = document.querySelector('.toast-stack .toast-message').textContent;
    for (const want of wants) expect(text).toContain(want);
    expect(text).not.toContain(notWant);
  });

  test('Activate row copy stays neutral while status is unknown, then follows llm:status-changed', async () => {
    const handlers = {};
    ipcRenderer.on.mockImplementation((channel, fn) => { handlers[channel] = fn; });
    const { tab } = makeTab({ settings: { llm: { mode: 'remote', remote: { endpoint: 'https://api.test' } } } });
    tab.render(host);
    await tick();
    const desc = host.querySelector('[data-setting-id="llm.remote.activate"] .settings-v2-row-description');
    expect(desc.textContent).toBe('Switch the app to this endpoint, or clear it.');
    tab._refs.remoteModelSelect.innerHTML = '<option value="mn">mn</option>';
    tab._refs.remoteModelSelect.value = 'mn';
    await tab._activateRemote();
    expect(document.querySelector('.toast-stack .toast-message').textContent).toBe('Remote API active: mn (native tools)');
    handlers['llm:status-changed'](null, { info: { status: 'running', isRemote: false } });
    expect(desc.textContent).toContain("the remote endpoint's model, which is not locally hosted");
    expect(desc.textContent).toContain('keeps serving until you stop it');
    handlers['llm:status-changed'](null, { info: { status: 'running', isRemote: true } });
    expect(desc.textContent).toContain('the remote becomes the active endpoint');
  });

  test('Clear Remote invokes llm:clear-remote (rejection swallowed)', async () => {
    const calls = [];
    const invoke = (channel) => {
      calls.push(channel);
      if (channel === 'llm:clear-remote') return Promise.reject(new Error('ignored'));
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'remote' } } }, invoke);
    tab.render(host);
    await tick();
    await expect(tab._clearRemote()).resolves.toBeUndefined();
    expect(calls).toContain('llm:clear-remote');
  });

  test('remote tool-format pill persists settings.llm.remote.toolMode', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'remote' } } });
    tab.render(host);
    const pill = host.querySelector('#set-llm-remote-tool-mode-native');
    expect(pill).not.toBeNull();
    pill.checked = true;
    pill.dispatchEvent(new Event('change'));
    expect(tab.config.settings.llm.remote.toolMode).toBe('native');
  });

  // -- Realtime listeners ------------------------------------------------

  test('_wireRealtime registers the four IPC listeners and status-changed repaints', async () => {
    const handlers = {};
    ipcRenderer.on.mockImplementation((channel, fn) => { handlers[channel] = fn; });
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } });
    tab.render(host);
    await tick();
    expect(Object.keys(handlers).sort()).toEqual(
      ['llm:fallback', 'llm:log', 'llm:models-changed', 'llm:status-changed'].sort()
    );
    handlers['llm:status-changed'](null, { info: { status: 'running', endpoint: 'http://x' } });
    expect(tab._refs.statusPill.textContent).toBe('running');
    expect(tab._refs.endpointEl.textContent).toBe('http://x');
    // fallback listener with payload shows a toast; null payload is ignored.
    expect(() => handlers['llm:fallback'](null, null)).not.toThrow();
    handlers['llm:fallback'](null, { from: 'omlx', to: 'mlxOpenAi', reason: 'oom' });
    expect(document.querySelector('.toast-stack')).not.toBeNull();
  });

  test('status "starting" disables both server buttons (transitional)', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:get-status') return Promise.resolve({ status: 'starting', endpoint: '' });
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    expect(tab._refs.startBtn.disabled).toBe(true);
    expect(tab._refs.stopBtn.disabled).toBe(true);
  });

  // -- Model annotations + visible fetch errors --------------------------

  test('_renderModels annotates multi-part / incomplete / missing models', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:list-models') {
        return Promise.resolve([
          { name: 'Shard', path: '/s.gguf', format: 'gguf', sizeHuman: '40G', quantization: 'Q5', isMultiPart: true, shardCount: 3, incomplete: true, missing: true },
        ]);
      }
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    expect(tab._refs.modelSelect.querySelector('option').textContent).toBe('Shard (40G, Q5, 3 parts INCOMPLETE, MISSING)');
  });

  test('_renderStatus skips button toggles while an action is pending; null status is ignored', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } });
    tab.render(host);
    tab.status = { status: 'running', endpoint: 'http://x' };
    tab._engineActionPending = true;
    tab._refs.startBtn.disabled = false;
    tab._renderStatus();
    expect(tab._refs.startBtn.disabled).toBe(false);
    expect(tab._refs.statusPill.textContent).toBe('running');
    tab.status = null;
    tab._renderStatus();
    expect(tab._refs.statusPill.textContent).toBe('running');
  });

  test('_populateRemoteModelDropdown with no models shows the "No models returned" option', () => {
    const { tab } = makeTab({ settings: { llm: { mode: 'remote' } } });
    tab.render(host);
    const sel = tab._refs.remoteModelSelect;
    tab._populateRemoteModelDropdown(sel, []);
    const opts = sel.querySelectorAll('option');
    expect(opts.length).toBe(1);
    expect(opts[0].textContent).toBe('No models returned');
  });

  test('list-models / get-status / get-logs rejections each render a visible error', async () => {
    const invoke = (channel) => {
      if (channel === 'llm:list-models') return Promise.reject(new Error('m'));
      if (channel === 'llm:get-status') return Promise.reject(new Error('s'));
      if (channel === 'llm:get-logs') return Promise.reject(new Error('l'));
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    expect(() => tab.render(host)).not.toThrow();
    await tick();
    expect(tab._refs.scanResultEl.textContent).toBe("Couldn't load the model library: m");
    expect(tab._refs.scanResultEl.dataset.state).toBe('error');
    expect(tab._refs.statusPill.textContent).toBe('unknown');
    expect(tab._refs.statusPill.classList.contains('error')).toBe(true);
    expect(tab._refs.endpointEl.textContent).toBe("Couldn't read server status: s");
    expect(tab._refs.logsStatus.hidden).toBe(false);
    expect(tab._refs.logsStatus.textContent).toBe("Couldn't read server logs: l");
  });

  test('a later successful log fetch hides the earlier log error', async () => {
    let fail = true;
    const invoke = (channel) => {
      if (channel === 'llm:get-logs') return fail ? Promise.reject(new Error('l')) : Promise.resolve([{ level: 'warn', message: 'hi' }]);
      return Promise.resolve(null);
    };
    const { tab } = makeTab({ settings: { llm: { mode: 'local' } } }, invoke);
    tab.render(host);
    await tick();
    expect(tab._refs.logsStatus.hidden).toBe(false);
    fail = false;
    await tab._fetchLogs();
    expect(tab._refs.logsStatus.hidden).toBe(true);
    expect(tab._refs.logsEl.textContent).toBe('[warn] hi');
  });
});
