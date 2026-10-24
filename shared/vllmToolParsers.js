// vllmToolParsers — picks vLLM's --tool-call-parser for a model.
//
// vLLM refuses to start with --enable-auto-tool-choice unless a parser is
// named, and the parser must match the model family's tool-call format. The
// choice comes from the model's config.json (model_type) plus its folder or
// repo name, which separates variants sharing one model_type (Qwen3 vs
// Qwen3-Coder, DeepSeek V3 vs V3.1). Only families whose parser works with the
// chat template shipped in the model repo are listed: the example templates
// some parsers need are not in the vLLM wheel. Anything unmatched gets null and
// vLLM runs without tool calling; the agent then uses its text protocol.
// Names are vLLM 0.31's registered parsers (vllm/tool_parsers/__init__.py).

const VLLM_TOOL_PARSERS = [
  'hermes', 'qwen3_coder', 'llama3_json', 'llama4_pythonic', 'mistral', 'openai', 'gemma4',
  'glm45', 'glm47', 'granite', 'granite4', 'kimi_k2', 'deepseek_v3', 'deepseek_v31', 'deepseek_v32',
  'minimax_m2', 'minimax_m3', 'phi4_mini_json',
];

// First match wins, so a narrower name test sits above the broader one.
const RULES = [
  { parser: 'kimi_k2', name: /kimi[-_]?k2/ },
  { parser: 'qwen3_coder', types: ['qwen3_next'], name: /qwen3(?:\.5|[-_]?coder|[-_]?next)/ },
  // The name test catches Hugging Face repo ids, which have no local config.json.
  { parser: 'hermes', types: ['qwen2', 'qwen2_moe', 'qwen3', 'qwen3_moe'], name: /qwen(?:2\.5|3)-\d+(?:\.\d+)?b/ },
  { parser: 'llama4_pythonic', types: ['llama4'], name: /llama[-_]?4/ },
  // model_type 'llama' also covers Llama 2, which has no tool-call format.
  { parser: 'llama3_json', name: /llama[-_]?3/ },
  { parser: 'mistral', types: ['mistral', 'mistral3', 'ministral', 'mixtral'], name: /(?:mistral|ministral|mixtral)-/ },
  { parser: 'openai', types: ['gpt_oss'], name: /gpt-oss/ },
  { parser: 'gemma4', types: ['gemma4', 'gemma4_text'], name: /gemma[-_]?4/ },
  { parser: 'glm47', name: /glm[-_]?4\.7/ },
  { parser: 'glm45', types: ['glm4_moe'] },
  { parser: 'granite4', types: ['granitemoehybrid'] },
  { parser: 'granite', types: ['granite', 'granitemoe'] },
  { parser: 'deepseek_v32', name: /deepseek[-_]?v3\.2/ },
  { parser: 'deepseek_v31', name: /deepseek[-_]?v3\.1/ },
  { parser: 'deepseek_v3', types: ['deepseek_v3'] },
  { parser: 'minimax_m3', name: /minimax[-_]?m3/ },
  { parser: 'minimax_m2', types: ['minimax_m2'], name: /minimax[-_]?m2/ },
  { parser: 'phi4_mini_json', name: /phi[-_]?4[-_]?mini/ },
];

/**
 * @param {{modelType?: string|null, name?: string|null}} model `modelType` is
 *   config.json's model_type; `name` the model folder or Hugging Face repo id
 * @returns {string|null} a parser name, or null when none is known to fit
 */
function detectToolParser({ modelType = null, name = null } = {}) {
  const type = String(modelType || '').toLowerCase();
  const label = String(name || '').toLowerCase();
  for (const rule of RULES) {
    if ((rule.name && rule.name.test(label)) || (rule.types && rule.types.includes(type))) return rule.parser;
  }
  return null;
}

/**
 * The parser to launch with: an explicit setting wins ('none' turns tool
 * calling off), otherwise the detected one.
 * @param {string|null|undefined} setting 'auto' | 'none' | a parser name
 * @param {{modelType?: string|null, name?: string|null}} model
 * @returns {string|null}
 */
function resolveToolParser(setting, model) {
  if (setting === 'none') return null;
  if (setting && setting !== 'auto') {
    if (!VLLM_TOOL_PARSERS.includes(setting)) throw new Error(`Unknown vLLM tool parser: ${setting}`);
    return setting;
  }
  return detectToolParser(model);
}

module.exports = { VLLM_TOOL_PARSERS, detectToolParser, resolveToolParser };
