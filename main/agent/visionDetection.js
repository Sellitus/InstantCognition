// visionDetection — decides whether the agent should attach screenshots to
// each observation. Honors explicit user opt-out, then either accepts an
// engine-reported vision capability or falls back to a model-name regex.

const VISION_MODEL_RX = /gpt-4o|gpt-4\.1|claude-3|claude-4|gemini|llava|qwen.*vl|pixtral|moondream|internvl/i;

function isVisionEnabled({ getVisionConfig, llmService, getActiveModel }) {
  const cfg = typeof getVisionConfig === 'function' ? getVisionConfig() : null;
  if (!cfg || !cfg.enabled) return false;
  if (!cfg.autoDetect) return true;
  try {
    const status = llmService && typeof llmService.getStatus === 'function' ? llmService.getStatus() : null;
    if (status && status.visionCapable) return true;
  } catch (_) { /* fall through to model-name regex */ }
  const model = typeof getActiveModel === 'function' ? getActiveModel() : '';
  return VISION_MODEL_RX.test(String(model || ''));
}

module.exports = { isVisionEnabled, VISION_MODEL_RX };
