// engineCard — which runtimes each platform offers, the detected-engine rows,
// and the vLLM setup row. jsdom env. Only electron ipcRenderer is mocked
// (the setup panel imports it).

jest.mock('electron', () => ({
  ipcRenderer: { on: jest.fn(), removeListener: jest.fn(), invoke: jest.fn() },
}));

const ENGINE_CARD = '../../../../../renderer/components/settings/llm/engineCard';

function loadUnder(platform) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  let mod;
  try {
    jest.isolateModules(() => { mod = require(ENGINE_CARD); });
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
  return mod;
}

function build(platform) {
  const mod = loadUnder(platform);
  const tab = { _refs: {}, _selectedBackend: 'llamaCpp', _onBackendChange: jest.fn(), _onRedetect: jest.fn(), _fetchEngines: jest.fn() };
  const root = mod.buildEngineCard(tab);
  document.body.appendChild(root);
  return { mod, tab, root };
}

const rowNames = (refs) => Array.from(refs.enginesEl.querySelectorAll('.sv-llm-engine-name')).map((n) => n.textContent);

describe('engineCard', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  test.each([
    ['darwin', ['llamaCpp', 'mlxOpenAi', 'omlx']],
    ['linux', ['llamaCpp', 'vllm']],
    ['win32', ['llamaCpp', 'vllm']],
    ['freebsd', []],
  ])('engineOptions(%s) offers %j', (platform, values) => {
    const { engineOptions } = require(ENGINE_CARD);
    expect(engineOptions(platform).map((o) => o.value)).toEqual(values);
  });

  test('ENGINE_OPTIONS follows the platform the module loads on', () => {
    expect(loadUnder('linux').ENGINE_OPTIONS.map((o) => o.value)).toEqual(['llamaCpp', 'vllm']);
    expect(loadUnder('darwin').ENGINE_OPTIONS.map((o) => o.value)).toEqual(['llamaCpp', 'mlxOpenAi', 'omlx']);
  });

  test('darwin builds no vLLM setup row and paints only its three runtimes', () => {
    const { mod, tab, root } = build('darwin');
    expect(root.querySelector('[data-setting-id="llm.vllmSetup"]')).toBeNull();
    expect(tab._refs.vllmSetup).toBeUndefined();
    mod.renderEngines(tab._refs, {
      llamaCpp: { available: true, path: '/bin/llama-server', version: 'b6000' },
      mlxOpenAi: { available: false, reason: 'mlx-openai-server not installed' },
      omlx: { available: true, pythonPath: '/py', version: '0.7.0' },
      vllm: { available: false, setupState: 'unsupported', reason: 'not on macOS' },
    });
    expect(rowNames(tab._refs)).toEqual(['llama.cpp', 'mlx-openai-server', 'oMLX']);
    const infos = Array.from(tab._refs.enginesEl.querySelectorAll('.sv-llm-engine-info')).map((n) => n.textContent);
    expect(infos).toEqual(['b6000', 'mlx-openai-server not installed', '0.7.0']);
  });

  test('linux builds the vLLM setup row and renderEngines drives it from the vllm row', () => {
    const { mod, tab, root } = build('linux');
    expect(root.querySelector('[data-setting-id="llm.vllmSetup"]')).not.toBeNull();
    mod.renderEngines(tab._refs, {
      llamaCpp: { available: true, path: '/bin/llama-server', version: 'b6000' },
      vllm: { available: false, setupState: 'not-installed', reason: 'vLLM is not installed yet.' },
    });
    expect(rowNames(tab._refs)).toEqual(['llama.cpp', 'vLLM']);
    const vllmRow = tab._refs.enginesEl.querySelectorAll('.sv-llm-engine-row')[1];
    expect(vllmRow.classList.contains('unavailable')).toBe(true);
    expect(vllmRow.querySelector('.sv-llm-engine-info').textContent).toBe('vLLM is not installed yet.');
    expect(tab._refs.vllmSetup.status.textContent).toBe('vLLM is not installed yet.');
    expect(tab._refs.vllmSetup.runBtn.hidden).toBe(false);
  });

  test('a runtime the detect result omits is shown as not reported', () => {
    const { mod, tab } = build('win32');
    mod.renderEngines(tab._refs, { llamaCpp: { available: true, path: '/x' } });
    const info = tab._refs.enginesEl.querySelectorAll('.sv-llm-engine-info')[1];
    expect(info.textContent).toBe('not reported');
    expect(tab._refs.vllmSetup.status.textContent).toBe('vLLM status was not reported.');
  });

  test('renderEnginesError clears the rows and shows an alert', () => {
    const { mod, tab } = build('darwin');
    mod.renderEngines(tab._refs, { llamaCpp: { available: true, path: '/x' } });
    mod.renderEnginesError(tab._refs, 'boom');
    expect(tab._refs.enginesEl.textContent).toBe('');
    expect(tab._refs.detectStatus.hidden).toBe(false);
    expect(tab._refs.detectStatus.textContent).toBe('boom');
    expect(tab._refs.detectStatus.getAttribute('role')).toBe('alert');
  });
});
