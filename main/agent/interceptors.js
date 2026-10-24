// Runtime interceptor builder — keeps AgentService focused on lifecycle by
// moving the hot-path hooks (budget, approval, logging, reflection, pause)
// into a pure factory. Each call to build() returns a fresh set of hooks
// bound to the provided context.

const policy = require('./approvalPolicy');
const { runJudges, isPolicyTrigger } = require('./panelOfJudges');

// sessionId selects the session's permission mode and grants; allowedTools
// (the run's tool filter) makes the permission engine deny anything outside it.
// signal is the run's stop switch: it ends a wait on a pause and stops further
// approval prompts. getUrlFor(call) names the page a call acts on (a tool may
// target another tab via args.spaceId), so per-origin rules see the right origin.
function buildInterceptors({ budget, qualityMode, approval, log, getUrl, getUrlFor, getPaused, getResumePromise, recordBudget, llm, task, sessionId, allowedTools, signal }) {
  const shouldStop = ({ step }) => {
    if (!log) return false;
    if (budget.maxSteps && step >= budget.maxSteps) return recordBudget('maxSteps', { step }, budget);
    if (budget.maxTokens && log.tokensUsed >= budget.maxTokens) return recordBudget('maxTokens', { tokens: log.tokensUsed }, budget);
    if (budget.maxSeconds && log.elapsedMs >= budget.maxSeconds * 1000) return recordBudget('maxSeconds', { elapsedMs: log.elapsedMs }, budget);
    if (budget.maxNavigations && log.navigations >= budget.maxNavigations) return recordBudget('maxNavigations', { navigations: log.navigations }, budget);
    return false;
  };

  const beforeStep = async ({ messages }) => {
    if (getPaused && getPaused()) {
      messages.push({ role: 'user', content: 'User has resumed agent control. Re-observe the current page before your next action.' });
      const p = getResumePromise && getResumePromise();
      if (p) await untilAborted(p, signal);
    }
  };

  const beforeInvoke = async ({ calls }) => {
    if (!approval) return { allowed: calls, denied: [] };
    const fallbackUrl = getUrl ? getUrl() : '';
    const urlOf = new Map(calls.map((call) => [call, getUrlFor ? getUrlFor(call) || '' : fallbackUrl]));
    /** @type {Map<string, any[]>} */
    const byUrl = new Map();
    for (const call of calls) {
      const u = /** @type {string} */ (urlOf.get(call));
      if (!byUrl.has(u)) byUrl.set(u, []);
      /** @type {any[]} */ (byUrl.get(u)).push(call);
    }
    /** @type {{ allowed: any[], denied: any[], prompts: any[] }} */
    const decision = { allowed: [], denied: [], prompts: [] };
    for (const [url, group] of byUrl) {
      /** @type {Record<string, any>} */
      const ctx = { mode: qualityMode, url };
      if (sessionId) ctx.sessionId = sessionId;
      if (allowedTools) ctx.allowedTools = allowedTools;
      const part = approval.decide(group, ctx);
      decision.allowed.push(...part.allowed);
      decision.denied.push(...part.denied);
      decision.prompts.push(...part.prompts);
    }

    // Panel of Judges on mutating actions, mode-gated.
    const judgePolicy = (qualityMode && qualityMode.judges && qualityMode.judges.policy) || 'payment_auth';
    if (llm) {
      // Check allowed and prompts — anything that trips the judge policy must
      // pass the panel before proceeding.
      const doubleCheck = async (call, actionClass, url) => {
        if (!isPolicyTrigger(actionClass, judgePolicy)) return { approved: true };
        try { return await runJudges({ llm, call, task, url, maxTokens: 120 }); }
        catch (err) { // fail-open: the permission engine already allowed this call
          console.error('[interceptors] judges failed; keeping the allow:', err);
          return { approved: true };
        }
      };
      const nextAllowed = [];
      for (const call of decision.allowed) {
        const url = urlOf.get(call) || '';
        const actionClass = policy.upgradeClass(policy.classify(call.name), call, { url });
        const verdict = await doubleCheck(call, actionClass, url);
        if (verdict.approved) nextAllowed.push(call);
        else {
          decision.denied.push({ call, reason: 'panel_of_judges_rejected' });
          if (log) log.logApproval({ call, decision: 'reject', actionClass, origin: policy.originOf(url), reason: 'judges' });
        }
      }
      decision.allowed = nextAllowed;
    }

    for (const prompt of decision.prompts) {
      if (signal && signal.aborted) {
        decision.denied.push({ call: prompt.call, reason: 'stopped' });
        if (log) log.logApproval({ call: prompt.call, decision: 'reject', actionClass: prompt.class, origin: prompt.origin, reason: 'stopped' });
        continue;
      }
      const response = await approval.requestApproval(prompt);
      if (response.decision && response.decision.startsWith('approve')) {
        approval.applyDecision(prompt, response.decision);
        decision.allowed.push(prompt.call);
        if (log) log.logApproval({ call: prompt.call, decision: response.decision, actionClass: prompt.class, origin: prompt.origin });
      } else {
        decision.denied.push({ call: prompt.call, reason: response.reason || 'rejected_by_user' });
        if (log) log.logApproval({ call: prompt.call, decision: 'reject', actionClass: prompt.class, origin: prompt.origin, reason: response.reason });
      }
    }
    return { allowed: decision.allowed, denied: decision.denied };
  };

  const onStep = async ({ step, calls, results, latencyMs, tokens }) => {
    if (log) log.logStep({ step, url: getUrl ? getUrl() : '', toolCalls: calls, results, latencyMs, tokens });
  };

  const shouldReflect = async ({ results }) => {
    const hasFailure = results.some((r) => r && r.result && r.result.ok === false);
    const policy = (qualityMode && qualityMode.reflection && qualityMode.reflection.after) || 'failure';
    if (policy === 'every') return { prompt: 'Briefly reflect (2 sentences) on what you just learned, then propose the next action as a tool call.' };
    if (policy === 'failure' && hasFailure) return { prompt: 'Last step had a failure. In ONE sentence, state the root cause and pick a different approach on your next tool call.' };
    if (policy === 'failure_or_plan_end' && hasFailure) return { prompt: 'Last step had a failure. Reflect in ONE sentence, then emit the next tool call.' };
    return null;
  };

  return { shouldStop, beforeStep, beforeInvoke, onStep, shouldReflect };
}

/** Settles with `p`, or as soon as `signal` aborts. */
function untilAborted(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); });
  });
}

module.exports = { buildInterceptors };
