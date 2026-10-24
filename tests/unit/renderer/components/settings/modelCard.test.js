// modelCard — which library models each runtime can load, the model <select>,
// and vLLM's Hugging Face repo field. jsdom env.
//
// The pure helpers run directly; the repo field is driven through a real
// LLMTab built on Linux (where vLLM is offered). Only electron ipcRenderer,
// the main-process boundary, is mocked.

jest.mock('electron', () => ({
  ipcRenderer: {
    send: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
    invoke: jest.fn(() => Promise.resolve(null)),
  },
}));

const { ipcRenderer } = require('electron');
const { renderModelOptions, modelFitsBackend } = require('../../../../../renderer/components/settings/llm/modelCard');

const MODELS = [
  { name: 'Q', path: '/m/q.gguf', format: 'gguf', sizeHuman: '4 GB' },
  { name: 'MlxQ', path: '/m/mlx-4bit', format: 'mlx', sizeHuman: '2 GB' },
  { name: 'Hf', path: '/m/Qwen3-8B', format: 'hf', sizeHuman: '16 GB' },
];

const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const options = (select) => Array.from(select.querySelectorAll('option')).map((o) => [o.value, o.textContent]);

describe('modelFitsBackend', () => {
  test.each([
    ['vllm', ['/m/Qwen3-8B']],
    ['mlxOpenAi', ['/m/mlx-4bit', '/m/Qwen3-8B']],
    ['omlx', ['/m/mlx-4bit', '/m/Qwen3-8B']],
    ['llamaCpp', ['/m/q.gguf']],
  ])('%s loads exactly %j', (backend, paths) => {
    expect(MODELS.filter((m) => modelFitsBackend(m, backend)).map((m) => m.path)).toEqual(paths);
  });
});

describe('renderModelOptions', () => {
  let select;
  beforeEach(() => { select = document.createElement('select'); });

  test.each([
    ['vllm', 'No models. Import a model folder or enter a Hugging Face repo id.'],
    ['omlx', 'No MLX models. Import an MLX folder.'],
    ['mlxOpenAi', 'No MLX models. Import an MLX folder.'],
    ['llamaCpp', 'No models. Import a .gguf file.'],
  ])('%s with nothing loadable shows one empty option: %s', (backend, text) => {
    const onlyOther = backend === 'llamaCpp' ? [MODELS[1]] : [MODELS[0]];
    const res = renderModelOptions(select, onlyOther, { backend, lastModel: null });
    expect(options(select)).toEqual([['', text]]);
    expect(res.autoSelected).toBeNull();
    expect(res.visible).toEqual([]);
  });

  test('vLLM with a repo id as lastModel lists and selects it ahead of local folders', () => {
    const res = renderModelOptions(select, MODELS, { backend: 'vllm', lastModel: 'Qwen/Qwen3-8B' });
    expect(options(select)[0]).toEqual(['Qwen/Qwen3-8B', 'Qwen/Qwen3-8B (Hugging Face)']);
    expect(select.value).toBe('Qwen/Qwen3-8B');
    expect(res.autoSelected).toBeNull();
    expect(options(select).map((o) => o[0])).toEqual(['Qwen/Qwen3-8B', '/m/Qwen3-8B']);
  });

  test('vLLM with a repo id and no local folders still offers the repo, not the empty label', () => {
    renderModelOptions(select, [MODELS[0]], { backend: 'vllm', lastModel: 'org/model' });
    expect(options(select)).toEqual([['org/model', 'org/model (Hugging Face)']]);
    expect(select.value).toBe('org/model');
  });

  test('a repo id is not offered to a non-vLLM runtime', () => {
    const res = renderModelOptions(select, MODELS, { backend: 'omlx', lastModel: 'Qwen/Qwen3-8B' });
    expect(options(select).some((o) => o[0] === 'Qwen/Qwen3-8B')).toBe(false);
    expect(res.autoSelected).toBe('/m/mlx-4bit');
  });

  test('a local lastModel the runtime can load stays selected', () => {
    const res = renderModelOptions(select, MODELS, { backend: 'mlxOpenAi', lastModel: '/m/Qwen3-8B' });
    expect(select.value).toBe('/m/Qwen3-8B');
    expect(res.autoSelected).toBeNull();
  });

  test('an unknown lastModel falls back to the first loadable model and reports it', () => {
    const res = renderModelOptions(select, MODELS, { backend: 'llamaCpp', lastModel: '/gone.gguf' });
    expect(select.value).toBe('/m/q.gguf');
    expect(res.autoSelected).toBe('/m/q.gguf');
  });
});

describe('Hugging Face repo field (vLLM)', () => {
  let host;
  let realPlatform;

  function makeTab(llm) {
    realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    let LLMTab;
    try {
      jest.isolateModules(() => { LLMTab = require('../../../../../renderer/components/settings/LLMTab'); });
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
    const save = jest.fn();
    const tab = new LLMTab({ settings: { llm: { mode: 'local', activeBackend: 'vllm', ...llm } } }, save);
    tab.render(host);
    return { tab, save };
  }

  const repoInput = () => host.querySelector('[data-setting-id="llm.vllmHfRepo"] input');
  const enter = (value) => {
    const input = repoInput();
    input.value = value;
    input.dispatchEvent(new Event('change'));
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    ipcRenderer.invoke.mockReset();
    ipcRenderer.invoke.mockResolvedValue(null);
  });

  test('is visible for vLLM and prefilled with a saved repo id', async () => {
    const { tab } = makeTab({ lastModel: 'Qwen/Qwen3-8B' });
    await tick();
    expect(tab._refs.hfRepoRow.hidden).toBe(false);
    expect(repoInput().value).toBe('Qwen/Qwen3-8B');
    expect(tab._refs.modelSelect.value).toBe('Qwen/Qwen3-8B');
  });

  test('a saved local path does not prefill the repo field', async () => {
    makeTab({ lastModel: '/models/Qwen3-8B' });
    await tick();
    expect(repoInput().value).toBe('');
  });

  test('a valid repo id is saved as lastModel and becomes the selection', async () => {
    const { tab, save } = makeTab({});
    await tick();
    save.mockClear();
    enter('  meta-llama/Llama-3.1-8B-Instruct  ');
    expect(save).toHaveBeenCalledWith('lastModel', 'meta-llama/Llama-3.1-8B-Instruct');
    expect(tab.config.settings.llm.lastModel).toBe('meta-llama/Llama-3.1-8B-Instruct');
    expect(tab._refs.modelSelect.value).toBe('meta-llama/Llama-3.1-8B-Instruct');
  });

  test.each(['Qwen3-8B', '/abs/path', 'a/b/c', 'org/'])('"%s" is rejected with an error line and not saved', async (bad) => {
    const { tab, save } = makeTab({ lastModel: '/m/keep' });
    await tick();
    save.mockClear();
    enter(bad);
    expect(save).not.toHaveBeenCalled();
    expect(tab.config.settings.llm.lastModel).toBe('/m/keep');
    const line = tab._refs.scanResultEl;
    expect(line.dataset.state).toBe('error');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.textContent).toBe(`"${bad}" is not a repo id. Use the form org/name.`);
  });

  test('clearing the field clears lastModel', async () => {
    const { save } = makeTab({ lastModel: 'Qwen/Qwen3-8B' });
    await tick();
    save.mockClear();
    enter('');
    expect(save).toHaveBeenCalledWith('lastModel', null);
  });
});
