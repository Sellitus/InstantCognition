// lifecycleHooks — orphan detection, reattach, and interceptor wrappers
// extracted from AgentService so the service stays within its line budget.

const ledgerModule = require('./ledger');

// Returns a detach function; the host calls it when the run ends or moves to
// another tab. The handler also ignores a tab that is no longer the run's
// default tab, so a stale listener can never pause a later run.
function attachOrphanListener({ wc, service }) {
  if (!wc || typeof wc.once !== 'function') return () => {};
  const onDestroyed = () => {
    if (!service._running || !service._toolCtx || service._toolCtx.defaultWebContents !== wc) return;
    if (!service._paused) {
      service._paused = true;
      service._resumePromise = new Promise((resolve) => { service._resumeResolver = resolve; });
    }
    service.emit('task-orphaned', { task: service._task });
  };
  wc.once('destroyed', onDestroyed);
  return () => { if (typeof wc.removeListener === 'function') wc.removeListener('destroyed', onDestroyed); };
}

function wrapInterceptors({ base, service }) {
  const innerBeforeStep = base.beforeStep;
  base.beforeStep = async (ctx) => {
    await innerBeforeStep(ctx);
    const st = service._ledgerState;
    if (st && (st.plan.length || st.facts_known.length || st.progress)) {
      const rendered = ledgerModule.render(st);
      if (rendered) ctx.messages.push({ role: 'user', content: `[ledger]\n${rendered}` });
    }
  };
  const innerOnStep = base.onStep;
  base.onStep = async (ctx) => {
    await innerOnStep(ctx);
    const tokens = Number(ctx && ctx.tokens) || 0;
    const latency = Number(ctx && ctx.latencyMs) || 0;
    if (tokens > 0 && latency > 0) {
      service.emit('throughput', {
        step: ctx.step, tokensThisTurn: tokens, elapsedMs: latency,
        tokPerSec: tokens / (latency / 1000),
      });
    }
  };
  return base;
}

function logBaseDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return require('path').join(app.getPath('userData'), 'agent-runs');
    }
  } catch (_) { /* fall through */ }
  return require('path').join(require('os').tmpdir(), 'instantcognition-agent-runs');
}

module.exports = { attachOrphanListener, wrapInterceptors, logBaseDir };
