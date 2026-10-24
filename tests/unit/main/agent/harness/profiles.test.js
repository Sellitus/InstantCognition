// Harness profiles: built-in model families, user glob overrides, and the
// streamSteps / runtime-mode helpers runTurn feeds the agent loop.

const { resolveProfile, shouldStreamSteps, runtimeModeFor, DEFAULT_PROFILE } = require('../../../../../main/agent/harness/profiles');

describe('resolveProfile built-ins', () => {
  test.each([
    ['gemma-3-27b-it', 'gemma', 'json', 'merge'],
    ['Qwen2.5-Coder-32B-Instruct', 'qwen', 'json', 'system'],
    ['meta-llama/Llama-3.3-70B-Instruct', 'llama', 'json', 'system'],
    ['gpt-oss-20b', 'gpt-oss', 'native', 'system'],
    ['gpt-4.1-mini', 'gpt', 'native', 'system'],
    ['o3-mini', 'gpt', 'native', 'system'],
    ['mistral-small-3.2', 'mistral', 'native', 'system'],
    ['claude-sonnet-4-5', 'claude', 'native', 'system'],
  ])('%s → %s (%s)', (model, name, toolFormat, systemStyle) => {
    expect(resolveProfile(model, 'http://127.0.0.1:8421')).toMatchObject({ name, toolFormat, systemStyle, temperature: null });
  });

  test('a local model path matches on the file name, not on its folders', () => {
    expect(resolveProfile('/Users/me/llama.cpp/models/gemma-3-4b.gguf', '')).toMatchObject({ name: 'gemma', toolFormat: 'json' });
    expect(resolveProfile('/models/llama-stuff/phi-4.gguf', '')).toEqual(DEFAULT_PROFILE);
  });

  test('an unknown, empty or missing model keeps the negotiated default', () => {
    expect(resolveProfile('phi-4', '')).toEqual(DEFAULT_PROFILE);
    expect(resolveProfile('', '')).toEqual(DEFAULT_PROFILE);
    expect(resolveProfile(null, null)).toEqual(DEFAULT_PROFILE);
  });
});

describe('resolveProfile user overrides', () => {
  test('a matching user glob overrides the built-in field by field', () => {
    const p = resolveProfile('gemma-3-27b-it', 'http://x', [{ match: 'gemma-*', toolFormat: 'native', temperature: 0.4 }]);
    expect(p).toEqual({ name: 'user:gemma-*', toolFormat: 'native', systemStyle: 'merge', streamSteps: false, temperature: 0.4 });
  });

  test('the first matching profile wins, matching is case-insensitive and may name the profile', () => {
    const p = resolveProfile('GPT-4o', '', [
      { match: 'claude*', toolFormat: 'json' },
      { match: 'gpt-4*', name: 'mine', streamSteps: false },
      { match: '*', toolFormat: 'json' },
    ]);
    expect(p).toMatchObject({ name: 'mine', toolFormat: 'native', streamSteps: false });
  });

  test('an endpoint glob narrows the match', () => {
    const profiles = [{ match: 'qwen*', endpoint: 'https://api.example.com/**', toolFormat: 'native' }];
    expect(resolveProfile('qwen3-32b', 'https://api.example.com/v1', profiles).toolFormat).toBe('native');
    expect(resolveProfile('qwen3-32b', 'http://127.0.0.1:8421', profiles).toolFormat).toBe('json');
  });

  test('malformed fields fall through to the built-in; junk entries are ignored', () => {
    const p = resolveProfile('llama-3.1-8b', '', [
      null, 'x', { match: 42 }, { match: '' },
      { match: 'llama*', toolFormat: 'xml', systemStyle: 'loud', streamSteps: 'yes', temperature: 5 },
    ]);
    expect(p).toEqual({ name: 'user:llama*', toolFormat: 'json', systemStyle: 'system', streamSteps: false, temperature: null });
    expect(resolveProfile('llama-3.1-8b', '', 'not-an-array')).toMatchObject({ name: 'llama' });
  });

  test('a negated or oversize glob never matches', () => {
    expect(resolveProfile('gemma-2', '', [{ match: '!gemma*', toolFormat: 'native' }]).toolFormat).toBe('json');
    expect(resolveProfile('gemma-2', '', [{ match: `${'*'.repeat(201)}`, toolFormat: 'native' }]).toolFormat).toBe('json');
  });
});

describe('shouldStreamSteps / runtimeModeFor', () => {
  test('on/off force the setting; auto follows the profile', () => {
    const gpt = resolveProfile('gpt-4.1', '');
    const gemma = resolveProfile('gemma-3', '');
    expect(shouldStreamSteps('on', gemma)).toBe(true);
    expect(shouldStreamSteps('off', gpt)).toBe(false);
    expect(shouldStreamSteps('auto', gpt)).toBe(true);
    expect(shouldStreamSteps('auto', gemma)).toBe(false);
    expect(shouldStreamSteps(undefined, null)).toBe(false);
  });

  test('native → tools, json → json, auto → null (negotiate)', () => {
    expect(runtimeModeFor(resolveProfile('gpt-4.1', ''))).toBe('tools');
    expect(runtimeModeFor(resolveProfile('gemma-3', ''))).toBe('json');
    expect(runtimeModeFor(resolveProfile('phi-4', ''))).toBeNull();
    expect(runtimeModeFor(null)).toBeNull();
  });
});
