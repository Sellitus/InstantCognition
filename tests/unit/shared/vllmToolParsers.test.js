// vllmToolParsers — picks vLLM's --tool-call-parser. A wrong pick makes vLLM
// refuse to start or emit tool calls the agent cannot parse; a missed pick
// silently drops native tool calling.

const { VLLM_TOOL_PARSERS, detectToolParser, resolveToolParser } = require('../../../shared/vllmToolParsers');

describe('detectToolParser', () => {
  test('Qwen3 maps to hermes by model_type alone', () => {
    expect(detectToolParser({ modelType: 'qwen3', name: 'my-finetune' })).toBe('hermes');
    expect(detectToolParser({ modelType: 'qwen3_moe', name: null })).toBe('hermes');
  });

  test('Qwen3 maps to hermes by repo name alone (Hugging Face ids have no local config.json)', () => {
    expect(detectToolParser({ modelType: null, name: 'Qwen/Qwen3-8B' })).toBe('hermes');
    expect(detectToolParser({ name: 'Qwen2.5-7B-Instruct' })).toBe('hermes');
  });

  test('Qwen3-Coder maps to qwen3_coder even though its model_type is a hermes one', () => {
    expect(detectToolParser({ modelType: 'qwen3_moe', name: 'Qwen3-Coder-30B-A3B-Instruct' })).toBe('qwen3_coder');
    expect(detectToolParser({ name: 'Qwen/Qwen3-Coder-480B-A35B-Instruct' })).toBe('qwen3_coder');
  });

  test('Llama 3 maps to llama3_json by name', () => {
    expect(detectToolParser({ modelType: 'llama', name: 'Meta-Llama-3.1-8B-Instruct' })).toBe('llama3_json');
    expect(detectToolParser({ name: 'meta-llama/Llama-3.2-3B-Instruct' })).toBe('llama3_json');
  });

  test('Llama 2 has no tool-call format, so model_type llama alone gives null', () => {
    expect(detectToolParser({ modelType: 'llama', name: 'Llama-2-7b-chat-hf' })).toBeNull();
  });

  test('Qwen2.5-VL is not matched by the Qwen text rules', () => {
    expect(detectToolParser({ modelType: 'qwen2_5_vl', name: 'Qwen2.5-VL-7B-Instruct' })).toBeNull();
  });

  test('unknown model and empty input give null', () => {
    expect(detectToolParser({ modelType: 'bert', name: 'bert-base-uncased' })).toBeNull();
    expect(detectToolParser({})).toBeNull();
    expect(detectToolParser()).toBeNull();
  });

  test('every rule names a parser vLLM registers', () => {
    const samples = [
      { name: 'Kimi-K2-Instruct' }, { modelType: 'llama4' }, { modelType: 'mistral' }, { modelType: 'gpt_oss' },
      { modelType: 'gemma4' }, { name: 'GLM-4.7' }, { modelType: 'glm4_moe' }, { modelType: 'granitemoehybrid' },
      { modelType: 'granite' }, { name: 'DeepSeek-V3.2' }, { name: 'DeepSeek-V3.1' }, { modelType: 'deepseek_v3' },
      { name: 'MiniMax-M3' }, { modelType: 'minimax_m2' }, { name: 'Phi-4-mini-instruct' },
    ];
    for (const m of samples) {
      const parser = detectToolParser(m);
      expect(parser).not.toBeNull();
      expect(VLLM_TOOL_PARSERS).toContain(parser);
    }
  });
});

describe('resolveToolParser', () => {
  const qwen3 = { modelType: 'qwen3', name: 'Qwen3-8B' };

  test("'none' turns tool calling off even for a detectable model", () => {
    expect(resolveToolParser('none', qwen3)).toBeNull();
  });

  test('an explicit parser name passes through over detection', () => {
    expect(resolveToolParser('mistral', qwen3)).toBe('mistral');
    expect(resolveToolParser('qwen3_coder', { modelType: null, name: 'unknown-model' })).toBe('qwen3_coder');
  });

  test("'auto' and an unset setting detect from the model", () => {
    expect(resolveToolParser('auto', qwen3)).toBe('hermes');
    expect(resolveToolParser(undefined, qwen3)).toBe('hermes');
    expect(resolveToolParser(null, qwen3)).toBe('hermes');
  });

  test("'auto' with an unknown model gives null", () => {
    expect(resolveToolParser('auto', { modelType: 'bert', name: 'bert-base-uncased' })).toBeNull();
  });

  test('an unregistered parser name is rejected rather than passed to vLLM', () => {
    expect(() => resolveToolParser('hermes2', qwen3)).toThrow('Unknown vLLM tool parser: hermes2');
  });
});
