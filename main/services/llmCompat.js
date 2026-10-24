// Compatibility heuristics for OpenAI-compatible servers: which models reject
// the `temperature` parameter, how to recognize that rejection and the MLX
// Stream(gpu,N) thread-bug crash, and how to translate raw server errors into
// actionable messages. Pure functions — the caller owns the reactive state (a
// Set of `${endpoint}|${model}` keys learned from a prior 400).

function temperatureKey(model, endpoint) {
  return `${endpoint || ''}|${model || ''}`;
}

// Identify (endpoint, model) pairs whose server rejects `temperature`. The
// heuristic is intentionally conservative — a miss is recovered by the reactive
// retry in chatCompletion; a false positive would silently change sampling for
// a model that still honored the parameter. `rejected` is the caller's Set.
function shouldOmitTemperature(model, endpoint, rejected) {
  if (rejected && rejected.has(temperatureKey(model, endpoint))) return true;
  const id = String(model || '');
  // Anthropic Claude 4.5+ — covers claude-4.5/4-5/4.7/4-7 with optional
  // -opus-/-sonnet-/-haiku- segment in either order.
  if (/claude-(?:opus-|sonnet-|haiku-)?4[.\-_]?[5-9]/i.test(id)) return true;
  if (/claude-4[.\-_]?[5-9]-(?:opus|sonnet|haiku)/i.test(id)) return true;
  // OpenAI o-series reasoning models (o1, o3, o4-mini, …) and gpt-5+.
  if (/^o[1-9](?:[.\-_]|$)/i.test(id)) return true;
  if (/^gpt-[5-9](?:[.\-_]|$)/i.test(id)) return true;
  return false;
}

// Detect the specific 400 we want to auto-recover from. Covers
//   "temperature is deprecated for this model"  (Anthropic via litellm)
//   "Unsupported parameter: 'temperature' …"   (OpenAI o-series, gpt-5)
//   "temperature is not supported"             (variant phrasings)
// The bounded window keeps temperature + the rejection term within the same
// JSON field / sentence — guards against false positives where both words
// happen to appear far apart in a large error body.
function isTemperatureRejectionError(err) {
  const msg = String((err && err.message) || '');
  return /\btemperature\b[^.{}]{0,60}\b(?:deprecated|unsupported|not\s+supported|no\s+longer\s+supported|removed)\b/i.test(msg)
    || /\b(?:unsupported|deprecated)(?:\s+parameter)?\b[^.{}]{0,30}['"]?\btemperature\b/i.test(msg);
}

// Detect a server that cannot take an OpenAI `tools` payload — a proxy that
// rejects the parameter outright, or a model whose chat template has no
// tool-call section. Recovering means re-sending without tools, so the agent
// falls back to its text-JSON protocol instead of failing the whole task.
function isToolsRejectionError(err) {
  const msg = String((err && err.message) || '');
  return /\btools?(?:_choice)?\b[^.{}]{0,60}\b(?:unsupported|not\s+supported|does\s+not\s+support|deprecated|invalid|not\s+allowed)\b/i.test(msg)
    || /\b(?:unsupported|invalid|unrecognized)(?:\s+parameter)?\b[^.{}]{0,30}['"]?\btools?(?:_choice)?\b/i.test(msg)
    || /chat\s+template[^.{}]{0,60}\btool/i.test(msg)
    // vLLM started without a tool-call parser: '"auto" tool choice requires --enable-auto-tool-choice ...'
    || /tool choice requires --enable-auto-tool-choice/i.test(msg);
}

// Matches both the multimodal handler crash (Stream(gpu,0)) and the lm batch
// scheduler crash (Stream(gpu,1+)) — same MLX threading bug class.
function isMlxStreamCrash(err) {
  return !!(err && /Stream\s*\(\s*gpu\s*,\s*\d+\s*\)/i.test(String(err.message || '')));
}

// Translate known server bugs / quirks into actionable messages so the user is
// told what to do, not handed the raw 500 body. Stream(gpu,N) fires only when
// LLMService's auto-recovery (multimodal→lm, mlxOpenAi↔omlx) is exhausted
// (mxfp8 quants trigger it). EngineCore covers vLLM crashes, typically
// prompt > max_model_len after a long agent conversation.
function friendlyError(status, detail) {
  const body = String(detail || '').slice(0, 800);
  const stream = body.match(/Stream\s*\(\s*gpu\s*,\s*(\d+)\s*\)/i);
  if (stream) return `MLX hit the Stream(gpu,${stream[1]}) thread bug — auto-recovery exhausted. Fix: in Settings → LLM, switch Backend to llama.cpp, or pick a different model quantization (mxfp8 is known to trigger this). Raw: ${body.slice(0, 200)}`;
  if (status === 503 && /loading|warming/i.test(body)) return `Model still loading. Wait a few seconds and try again. (${status})`;
  if (status === 500 && /EngineCore encountered an issue/i.test(body)) return `Remote LLM server crashed mid-request (vLLM EngineCore). Most likely the conversation exceeded the model's context window after a long agent run. Fix: click "+ New conversation" in the agent panel to reset the conversation, or switch to a model with a larger context in Settings → LLM. If this happens on the very first turn, the model server may need a restart. (${status})`;
  return `LLM request failed (${status}): ${body.slice(0, 500)}`;
}

module.exports = {
  temperatureKey,
  shouldOmitTemperature,
  isTemperatureRejectionError,
  isToolsRejectionError,
  isMlxStreamCrash,
  friendlyError,
};
