// llmStartHelpers — pure cross-MLX fallback-chain builder, the python-backend
// missing message and the import dialog options. The only external boundary
// is engineDiscoveryService, supplied as a hand-rolled fake.

const { buildMlxFallbackChain, pythonBackendMissingMessage, importDialogOptions } = require('../../../../main/utils/llmStartHelpers');

function fakeDiscovery(resolved) {
  return { resolveBackendPath: jest.fn(async () => resolved) };
}

describe('pythonBackendMissingMessage', () => {
  test('oMLX points at the in-app installer', () => {
    expect(pythonBackendMissingMessage('omlx')).toMatch(/^oMLX not detected\..*Settings → LLM → Engines/);
  });
  test('mlx-openai-server gives the pip command', () => {
    expect(pythonBackendMissingMessage('mlxOpenAi')).toMatch(/pip install mlx-openai-server/);
  });
  test('vLLM points at the guided setup, not pip', () => {
    const msg = pythonBackendMissingMessage('vllm');
    expect(msg).toMatch(/vLLM is not set up/);
    expect(msg).toMatch(/Set up vLLM/);
    expect(msg).not.toMatch(/pip install/);
  });
});

describe('importDialogOptions', () => {
  test('vLLM picks a model folder', () => {
    expect(importDialogOptions('vllm')).toEqual({ title: 'Import model folder', properties: ['openDirectory'] });
  });
  test.each(['mlxOpenAi', 'omlx', 'mlx'])('%s picks an MLX model folder', (backend) => {
    expect(importDialogOptions(backend)).toEqual({ title: 'Import MLX model folder', properties: ['openDirectory'] });
  });
  test.each(['llamaCpp', undefined])('%s picks one or more .gguf files', (backend) => {
    const opts = importDialogOptions(backend);
    expect(opts.title).toBe('Import GGUF model');
    expect(opts.properties).toEqual(['openFile', 'multiSelections']);
    expect(opts.properties).not.toContain('openDirectory');
    expect(opts.filters).toEqual([{ name: 'GGUF', extensions: ['gguf'] }]);
  });
});

describe('buildMlxFallbackChain — guard branches (returns [])', () => {
  test('non-MLX backend yields no fallback', async () => {
    const out = await buildMlxFallbackChain({
      rawOpts: {}, merged: { backend: 'llamaCpp' }, cfg: {}, info: null,
      engineDiscoveryService: fakeDiscovery('/py'),
    });
    expect(out).toEqual([]);
  });

  test('missing cfg yields no fallback', async () => {
    const out = await buildMlxFallbackChain({
      rawOpts: {}, merged: { backend: 'mlxOpenAi' }, cfg: null, info: null,
      engineDiscoveryService: fakeDiscovery('/py'),
    });
    expect(out).toEqual([]);
  });

  test('cfg without an mlx block yields no fallback', async () => {
    const out = await buildMlxFallbackChain({
      rawOpts: {}, merged: { backend: 'omlx' }, cfg: { activeBackend: 'omlx' }, info: null,
      engineDiscoveryService: fakeDiscovery('/py'),
    });
    expect(out).toEqual([]);
  });

  test('mlx.fallbackEnabled === false yields no fallback', async () => {
    const out = await buildMlxFallbackChain({
      rawOpts: {}, merged: { backend: 'mlxOpenAi' },
      cfg: { mlx: { fallbackEnabled: false } }, info: null,
      engineDiscoveryService: fakeDiscovery('/py'),
    });
    expect(out).toEqual([]);
  });

  test('other MLX runtime not resolvable yields no fallback', async () => {
    const disc = fakeDiscovery(null);
    const out = await buildMlxFallbackChain({
      rawOpts: {}, merged: { backend: 'mlxOpenAi' },
      cfg: { mlx: {} }, info: null, engineDiscoveryService: disc,
    });
    expect(out).toEqual([]);
    // It probes the *other* runtime (omlx) since merged.backend is mlxOpenAi.
    expect(disc.resolveBackendPath).toHaveBeenCalledWith('omlx', null);
  });
});

describe('buildMlxFallbackChain — fallback produced', () => {
  test('mlxOpenAi falls back to omlx with the resolved python + shared modelPath', async () => {
    const disc = fakeDiscovery('/venv/bin/python3');
    const out = await buildMlxFallbackChain({
      rawOpts: { backend: 'mlxOpenAi' },
      merged: { backend: 'mlxOpenAi', modelPath: '/models/foo' },
      cfg: { mlx: { fallbackEnabled: true } },
      info: null,
      engineDiscoveryService: disc,
    });
    expect(out).toHaveLength(1);
    expect(out[0].backend).toBe('omlx');
    expect(out[0].opts.backend).toBe('omlx');
    expect(out[0].opts.pythonPath).toBe('/venv/bin/python3');
    expect(out[0].opts.modelPath).toBe('/models/foo');
    expect(out[0].opts.modelType).toBe('lm');
  });

  test('omlx falls back to mlxOpenAi (other-runtime selection is symmetric)', async () => {
    const disc = fakeDiscovery('/p');
    const out = await buildMlxFallbackChain({
      rawOpts: { backend: 'omlx' },
      merged: { backend: 'omlx', modelPath: '/m' },
      cfg: { mlx: {} },
      info: null,
      engineDiscoveryService: disc,
    });
    expect(disc.resolveBackendPath).toHaveBeenCalledWith('mlxOpenAi', null);
    expect(out[0].backend).toBe('mlxOpenAi');
    expect(out[0].opts.modelType).toBe('lm');
  });

  test('multimodal model without forceTextOnly yields modelType=multimodal', async () => {
    const out = await buildMlxFallbackChain({
      rawOpts: { backend: 'mlxOpenAi' },
      merged: { backend: 'mlxOpenAi', modelPath: '/m' },
      cfg: { mlx: {} },
      info: { isMultimodal: true },
      engineDiscoveryService: fakeDiscovery('/p'),
    });
    expect(out[0].opts.modelType).toBe('multimodal');
  });

  // Only mlx-openai-server can be forced text-only; oMLX loads vision models
  // as vision regardless, so the flag matters when mlxOpenAi is the fallback.
  test('multimodal model WITH forceTextOnly stays modelType=lm on mlxOpenAi', async () => {
    const out = await buildMlxFallbackChain({
      rawOpts: { backend: 'omlx', forceTextOnly: true },
      merged: { backend: 'omlx', modelPath: '/m' },
      cfg: { mlx: {} },
      info: { isMultimodal: true },
      engineDiscoveryService: fakeDiscovery('/p'),
    });
    expect(out[0].backend).toBe('mlxOpenAi');
    expect(out[0].opts.forceTextOnly).toBe(true);
    expect(out[0].opts.modelType).toBe('lm');
  });
});
