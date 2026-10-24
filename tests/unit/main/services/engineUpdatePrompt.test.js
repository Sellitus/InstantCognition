// engineUpdatePrompt — which runtime update, if any, is worth a prompt.

const { engineForBackend, selectedEngine, promptFor } = require('../../../../main/services/llm/engineUpdatePrompt');

const llamaRow = { engine: 'llamaCpp', ok: true, latest: 'b10831', updateAvailable: true };
const mlxRow = { engine: 'mlx', ok: true, latest: 'mlx-lm 0.32.0, mlx-openai-server 1.9.0', updateAvailable: true };

describe('engineForBackend', () => {
  test.each([
    ['llamaCpp', 'llamaCpp'],
    ['mlxOpenAi', 'mlx'],
    ['omlx', 'omlx'],
    ['vllm', 'vllm'],
    // Removed backend: a stale config value maps to no runtime.
    ['mlxLm', null],
    ['remote', null],
    ['toString', null],
    [null, null],
  ])('%s runs on %s', (backend, engine) => {
    expect(engineForBackend(backend)).toBe(engine);
  });
});

describe('selectedEngine', () => {
  test('a live local engine wins over the configured backend', () => {
    expect(selectedEngine({ status: 'running', backend: 'omlx', isRemote: false }, { mode: 'local', activeBackend: 'llamaCpp' })).toBe('omlx');
  });

  test('a remote endpoint serving traffic selects no runtime', () => {
    expect(selectedEngine({ status: 'running', backend: 'remote', isRemote: true }, { mode: 'local', activeBackend: 'llamaCpp' })).toBeNull();
  });

  test('with nothing running, the configured local backend is selected', () => {
    expect(selectedEngine({ status: 'stopped', backend: null, isRemote: false }, { mode: 'local', activeBackend: 'llamaCpp' })).toBe('llamaCpp');
  });

  test('with nothing running, remote mode selects no runtime', () => {
    expect(selectedEngine({ status: 'stopped', backend: null, isRemote: false }, { mode: 'remote', activeBackend: 'mlxOpenAi' })).toBeNull();
    expect(selectedEngine(null, { mode: 'local', activeBackend: 'remote' })).toBeNull();
  });

  test('nothing configured selects no runtime', () => {
    expect(selectedEngine(null, null)).toBeNull();
  });
});

describe('promptFor', () => {
  test('offers the selected runtime update that has not been offered yet', () => {
    expect(promptFor({ engines: [llamaRow, mlxRow], prompted: {}, engine: 'mlx' })).toBe(mlxRow);
  });

  test('does not repeat a version already offered', () => {
    expect(promptFor({ engines: [llamaRow], prompted: { llamaCpp: 'b10831' }, engine: 'llamaCpp' })).toBeNull();
  });

  test('ignores updates for a runtime that is not selected', () => {
    expect(promptFor({ engines: [llamaRow], prompted: {}, engine: 'mlx' })).toBeNull();
  });

  test('ignores current runtimes and failed checks', () => {
    expect(promptFor({ engines: [{ ...llamaRow, updateAvailable: false }], prompted: {}, engine: 'llamaCpp' })).toBeNull();
    expect(promptFor({ engines: [{ engine: 'llamaCpp', ok: false, error: 'offline' }], prompted: {}, engine: 'llamaCpp' })).toBeNull();
  });

  test('nothing to offer before a check or without a selection', () => {
    expect(promptFor({ engines: null, prompted: {}, engine: 'llamaCpp' })).toBeNull();
    expect(promptFor({ engines: [llamaRow], prompted: null, engine: null })).toBeNull();
  });
});
