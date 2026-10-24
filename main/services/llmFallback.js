// Shared MLX fallback orchestration for LLMService.
// Extracted to keep LLMService.js under the 265-line architectural cap.
//
// Semantics: if _spawnAndWait rejects before the health check ever passed
// (svc._loadVerified is false), pop the next entry from svc._fallbackChain
// and retry with that backend. A mid-session crash (post-health-verified)
// is left to the in-place restart loop in LLMService — fallback is for
// load-time failures only.

const { isMlxBackend } = require('../../shared/llmDefaults');
const { errMsg } = require('../../shared/errMsg');

async function startWithFallback(svc, opts) {
  svc._loadVerified = false;
  try {
    return await svc._spawnAndWait(opts);
  } catch (err) {
    if (svc._loadVerified || !svc._fallbackChain.length) throw err;
    const next = svc._fallbackChain.shift();
    svc._appendLog('warn', `Falling back: ${svc._backend} → ${next.backend} (${errMsg(err)})`);
    svc.emit('fallback', { from: svc._backend, to: next.backend, reason: errMsg(err) });
    svc._backend = next.backend;
    svc._modelType = next.opts.modelType || (isMlxBackend(next.backend) ? 'lm' : null);
    svc._lastStartOpts = { ...next.opts };
    svc._restartCount = 0;
    // The previous _spawnAndWait catch called stop({silent:true}), which set
    // _intentionalStop=true. Reset it so the fallback proc's exit handler
    // routes through the normal lifecycle.
    svc._intentionalStop = false;
    return startWithFallback(svc, next.opts);
  }
}

// Recover from the mlx "Stream(gpu, N) in current thread" crash. Two cases:
//   1) mlx-openai-server's multimodal handler crashes (mlx-vlm) — switch to
//      --model-type lm. oMLX has no model-type switch, so it skips this.
//   2) lm-mode handler also crashes (mlx-openai-server's batch scheduler hits
//      the same thread bug on certain quants like mxfp8), or oMLX crashed —
//      fall over to the alternate MLX runtime (mlxOpenAi ↔ omlx) via the
//      fallback chain.
// Returns the new status, or null when no further recovery is possible.
async function recoverFromMlxStreamCrash(svc) {
  if (!isMlxBackend(svc._backend) || !svc._lastStartOpts) return null;
  if (svc._backend === 'mlxOpenAi' && svc._modelType !== 'lm') {
    svc._appendLog('warn', 'Recovering from MLX multimodal crash — restarting with --model-type lm');
    await svc.stop({ silent: true });
    const status = await svc.start({ ...svc._lastStartOpts, modelType: 'lm', forceTextOnly: true });
    svc.emit('auto-recovered-text-only', { reason: 'mlx_stream_crash' });
    return status;
  }
  if (!svc._fallbackChain.length) return null;
  const next = svc._fallbackChain.shift();
  if (!isMlxBackend(next.backend)) return null;
  const from = svc._backend;
  svc._appendLog('warn', `MLX (${from}) crashed in text-only mode — trying ${next.backend}`);
  await svc.stop({ silent: true });
  const altOpts = { ...next.opts, modelType: 'lm', forceTextOnly: true, fallbackChain: [] };
  const status = await svc.start(altOpts);
  svc.emit('auto-recovered-alt-mlx', { from, to: next.backend, reason: 'mlx_stream_crash_lm_mode' });
  return status;
}

module.exports = { startWithFallback, recoverFromMlxStreamCrash };
