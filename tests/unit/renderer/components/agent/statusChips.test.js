// statusChips: pure mapping from run/engine status to header chip copy.
// No boundaries; the module is exercised directly.

const { runStatusLabel, engineChipState, modelName } = require('../../../../../renderer/components/agent/statusChips');

describe('statusChips', () => {
  test('runStatusLabel maps known statuses and falls back to Ready', () => {
    expect(runStatusLabel('running')).toBe('Working…');
    expect(runStatusLabel('error')).toBe('Error');
    expect(runStatusLabel('bogus')).toBe('Ready');
    expect(runStatusLabel(undefined)).toBe('Ready');
  });

  test('modelName strips directories on both separators and the .gguf suffix', () => {
    expect(modelName('/models/qwen/Qwen3-8B-Q4.gguf')).toBe('Qwen3-8B-Q4');
    expect(modelName('C:\\m\\Llama.GGUF')).toBe('Llama');
    expect(modelName('mlx-community/phi-4')).toBe('phi-4');
    expect(modelName(null)).toBe('');
    expect(modelName(42)).toBe('');
  });

  test('a remote endpoint is ready even when no local server runs', () => {
    expect(engineChipState({ status: 'stopped', isRemote: true, model: 'gpt-x' }))
      .toEqual(expect.objectContaining({ tone: 'ok', label: 'gpt-x', ready: true }));
    expect(engineChipState({ status: 'stopped', isRemote: true }).label).toBe('Remote model');
  });

  test('a running local server is labelled by model, then backend, then a generic name', () => {
    expect(engineChipState({ status: 'running', model: '/a/b.gguf', backend: 'llama' }).label).toBe('b');
    expect(engineChipState({ status: 'running', backend: 'mlx' }).label).toBe('mlx');
    const generic = engineChipState({ status: 'running' });
    expect(generic).toEqual(expect.objectContaining({ tone: 'ok', label: 'Local model', ready: true }));
  });

  test('transitional states are busy and not ready', () => {
    for (const [status, label] of [[undefined, 'Checking model…'], ['starting', 'Starting…'], ['stopping', 'Stopping…']]) {
      expect(engineChipState({ status })).toEqual(expect.objectContaining({ tone: 'busy', label, ready: false }));
    }
    expect(engineChipState(null).label).toBe('Checking model…');
  });

  test('an engine error surfaces its message in the tooltip', () => {
    const s = engineChipState({ status: 'error', lastError: 'port 8080 in use' });
    expect(s).toEqual(expect.objectContaining({ tone: 'error', label: 'Model error', ready: false }));
    expect(s.title).toContain('port 8080 in use');
    expect(engineChipState({ status: 'error' }).title).toBe('The model failed. Open Settings → LLM.');
  });

  test('a stopped local engine asks the user to set one up', () => {
    expect(engineChipState({ status: 'stopped' }))
      .toEqual(expect.objectContaining({ tone: 'off', label: 'Set up a model', ready: false }));
  });
});
