// AgentRuntime — generic observe→plan→dispatch loop for any agentic task.
//
// Decoupled from Electron: it takes a ToolRegistry, an LLM client, and a
// per-run `toolCtx` / `invCtx`. Supports two protocol modes:
//
//   tools: OpenAI tools + tool_calls. Assistant replies may request multiple
//          parallel calls. Results appended as {role:'tool', tool_call_id}.
//   json:  Model returns a JSON array (or single object) of {tool, args} via
//          text content. Results rolled up into a single user message.
//
// invCtx.forceMode (explicit setting or the harness profile, see
// harness/profiles.js) fixes the mode; otherwise it is auto-detected per
// endpoint+model on the first call and cached.
// Intra-tab side-effect conflicts are rejected by the registry; cross-tab
// and read-only calls run concurrently via Promise.all.
//
// This runtime knows nothing about tabs, webContents, or the agent UI — it
// only dispatches tools. Callers construct `toolCtx` with whatever the tools
// need and provide a `buildInitialObservation` string.
//
// invCtx.signal (optional AbortSignal) is the run's stop switch: it aborts the
// in-flight LLM request and any running tool, and the run resolves
// { ok:false, reason:'stopped' }. invCtx.toolFilter (optional (name, tool) =>
// boolean) narrows the tools offered to the model; a call outside that set
// gets a { ok:false, error:'tool_not_available' } result and is never invoked.
//
// Harness knobs on invCtx: streamSteps streams each step through
// chatCompletionStream (tool_calls assembled from fragments, prose forwarded
// as assistant-chunk in tools mode) and falls back to one non-streaming
// request when the stream fails; systemStyle 'merge' folds system messages
// into the first user turn; temperature overrides the step default.

const { extractToolCalls, looksLikeToolCall, stripThink } = require('./responseParsers');
const { errMsg } = require('../../shared/errMsg');

const DEFAULT_MAX_STEPS = 12;
const MAX_RESULT_BYTES = 8 * 1024;
// Cap on consecutive "model emitted reasoning, no tool call" retries before
// we attempt one final forced summary then bail. Past this point the model
// is stuck in a meta-commentary loop ("I will call agent.done…") and further
// retries just burn the step budget producing more of the same.
const PARSE_RETRY_CAP = 5;
const FINAL_SUMMARY_PREVIEW_BYTES = 600;
// A reasoning model spends max_tokens on chain-of-thought before its first
// visible character, so the step that has to write the final answer is the one
// that runs out. Retry that step once with room to finish.
const REASONING_RETRY_TOKEN_BUDGET = 16384;
// Compaction tuning: trigger when the prompt reaches `threshold`× the
// configured ctx-size (settings.llm.agent.compaction, default 0.8), only after
// enough turns to be worth summarizing, and keep the most recent turns
// verbatim so in-flight tool state survives.
const COMPACT_THRESHOLD = 0.8;
const MIN_TURNS_TO_COMPACT = 6;
const COMPACT_KEEP_TURNS = 4;
// Passing a signal to LLMClientService.chatCompletion disables its built-in
// request timeout, so the runtime folds one into the signal it sends. Matches
// the client's own default (settings.llmClientTimeoutMs overrides it via
// invCtx.llmTimeoutMs).
const DEFAULT_LLM_TIMEOUT_MS = 300_000;

class AgentRuntime {
  constructor({ registry, llm }) {
    if (!registry) throw new Error('registry required');
    if (!llm) throw new Error('llm required');
    this._registry = registry;
    this._llm = llm;
    this._modeCache = new Map(); // endpoint+model → 'tools' | 'json'
  }

  _modeKey(invCtx) { return `${invCtx.endpoint || ''}::${invCtx.modelName || ''}`; }

  async run({ task, messages, toolCtx, invCtx, maxSteps, shouldStop, emit, interceptors }) {
    const ceiling = maxSteps || (invCtx && invCtx.maxSteps) || DEFAULT_MAX_STEPS;
    const emitSafe = typeof emit === 'function' ? emit : () => {};
    const hooks = interceptors || {};
    let mode = (invCtx && invCtx.forceMode) || this._modeCache.get(this._modeKey(invCtx || {})) || 'auto';
    const boundInvCtx = { ...(invCtx || {}), emit: emitSafe, taskDescription: task };
    let consecutiveParseRetries = 0, reasoningBudgetRaised = false;
    let tokensUsed = 0, compactedAt = 0;
    // The request this run answers; compaction must never summarize it away.
    const last = messages.length ? messages[messages.length - 1] : null;
    const taskMessage = last && last.role === 'user' ? last : null;
    const contextSize = (invCtx && Number(invCtx.contextSize)) || 0;
    const compactCfg = compactionSettings(invCtx && invCtx.compaction);
    const runSignal = invCtx && invCtx.signal;
    const aborted = () => !!(runSignal && runSignal.aborted);
    let toolFilter = invCtx && typeof invCtx.toolFilter === 'function' ? invCtx.toolFilter : null;

    for (let step = 0; step < ceiling; step++) {
      if (aborted() || (shouldStop && shouldStop())) return { ok: false, reason: 'stopped' };
      if (hooks.shouldStop && hooks.shouldStop({ step })) return { ok: false, reason: 'budget_exceeded' };
      if (hooks.beforeStep) {
        try { await hooks.beforeStep({ step, messages }); }
        catch (err) { return { ok: false, reason: 'hook_error', error: errMsg(err) }; }
      }
      emitSafe('step-observed', { step });

      const askStart = Date.now();
      let asked;
      try { asked = await this._askLLM(messages, mode, boundInvCtx, step); }
      catch (err) {
        if (aborted()) return { ok: false, reason: 'stopped' };
        throw err;
      }
      const { resp, detectedMode } = asked;
      if (mode === 'auto') {
        mode = detectedMode;
        this._modeCache.set(this._modeKey(invCtx || {}), mode);
      }

      const calls = this._extractCalls(resp, mode);
      if (!calls.length) {
        const content = stripThink(resp.content || '').trim();
        const looksToolCallish = this._looksLikeToolCall(resp.content || '');
        const looksReasoning = this._looksLikeReasoning(content);

        if (looksToolCallish || looksReasoning) {
          consecutiveParseRetries++;

          // Hard bail: the model is stuck in a meta-loop where every reply
          // narrates intent to finish without actually emitting agent.done.
          // Try ONE last forced-summary call (tightest possible prompt, low
          // temperature, large token budget). If that ALSO fails, surface a
          // CLEAN status line — never dump the raw thinking dump as the
          // user-facing summary.
          if (consecutiveParseRetries >= PARSE_RETRY_CAP) {
            emitSafe('step-parse-retry', { step, contentPreview: content.slice(0, 200), giveUp: true });
            const forced = await this._forceFinalSummary(messages, boundInvCtx);
            if (aborted()) return { ok: false, reason: 'stopped' };
            if (forced && forced.trim()) {
              return { ok: true, summary: forced.trim(), mode, reason: 'forced_summary' };
            }
            const preview = content.replace(/\s+/g, ' ').trim().slice(0, FINAL_SUMMARY_PREVIEW_BYTES);
            const ellipsis = content.length > FINAL_SUMMARY_PREVIEW_BYTES ? '…' : '';
            return {
              ok: true,
              summary: 'The agent could not produce a structured final answer after multiple retries — '
                + 'the model kept emitting reasoning instead of calling agent.done. '
                + (preview ? `Last reasoning fragment: "${preview}${ellipsis}"` : 'No reasoning was captured.'),
              mode,
              reason: 'parse_loop_recovered',
            };
          }

          // Escalating push-back. First try uses the friendly correction;
          // second try gets a stricter "JSON only, no prose" instruction so
          // weaker local models have a clearer constraint to follow.
          let retryPrompt;
          if (looksToolCallish && consecutiveParseRetries === 1) {
            retryPrompt = 'Your tool call was not recognized. Reply with ONE JSON object per line, e.g. {"tool":"browser.read_tab","args":{"spaceId":"custom1"}}. To finish, reply {"tool":"agent.done","args":{"summary":"..."}}.';
          } else if (consecutiveParseRetries === 1) {
            retryPrompt = 'You replied with reasoning, not a tool call. Issue ONE tool call now to take the next action — for example {"tool":"browser.open_tab","args":{"url":"..."}}. When you have the actual answer to the task, call {"tool":"agent.done","args":{"summary":"<the answer>"}}. Do not reply with prose.';
          } else {
            retryPrompt = 'STOP narrating. Your next reply must be EXACTLY one line of valid JSON and nothing else — no preamble, no explanation, no markdown fences. If you have the answer, reply NOW with: {"tool":"agent.done","args":{"summary":"<the FULL answer text here, written out in detail>"}}. If you need another tool, call it. Reply with the JSON object only.';
          }
          messages.push({ role: 'assistant', content: resp.content || '' });
          messages.push({ role: 'user', content: retryPrompt });
          emitSafe('step-parse-retry', { step, contentPreview: content.slice(0, 200) });
          continue;
        }
        // An empty/whitespace reply with no tool call is not a finished answer —
        // fail loudly instead of reporting a successful task with an empty summary.
        if (!content) {
          // The step that writes the final answer is where a reasoning model runs
          // out: it emits reasoning_content until finish_reason 'length' and never
          // reaches a visible character. Give it room once before giving up.
          const spentOnReasoning = !!String(resp.reasoning || '').trim() || resp.reasoningChars > 0 || resp.finishReason === 'length';
          if (spentOnReasoning && !reasoningBudgetRaised) {
            reasoningBudgetRaised = true;
            boundInvCtx.maxTokens = Math.max(REASONING_RETRY_TOKEN_BUDGET, Number(boundInvCtx.maxTokens) || 0);
            emitSafe('step-parse-retry', { step, contentPreview: '', reason: 'reasoning_budget_exhausted' });
            messages.push({ role: 'user', content: 'Your previous reply ran out of tokens while thinking and arrived empty. Keep your reasoning short and answer now: issue ONE tool call, or if you already have the answer, reply {"tool":"agent.done","args":{"summary":"<the full answer>"}}.' });
            continue;
          }
          return { ok: false, reason: spentOnReasoning ? 'reasoning_budget_exhausted' : 'empty_response', mode };
        }
        return { ok: true, summary: content, mode };
      }
      // Successful parse — reset the consecutive-retry counter so isolated
      // future stumbles get the full retry budget rather than tripping the cap.
      consecutiveParseRetries = 0;

      emitSafe('step-planned', { step, calls, mode });

      // Approval / filtering hook — gets the chance to split calls into
      // approved vs denied (denied calls get synthesized rejection results
      // and never reach the registry).
      // Calls outside the filtered tool set never reach approval or the registry.
      let approvedCalls = calls;
      const unavailableResults = [];
      if (toolFilter) {
        approvedCalls = [];
        for (const c of calls) {
          const tool = this._registry.get(c.name);
          if (tool && toolFilter(c.name, tool)) approvedCalls.push(c);
          else unavailableResults.push({ id: c.id, name: c.name, result: { ok: false, error: 'tool_not_available', tool: c.name } });
        }
      }
      let deniedResults = [];
      if (hooks.beforeInvoke && approvedCalls.length) {
        const gate = await hooks.beforeInvoke({ step, calls: approvedCalls, toolCtx, invCtx: boundInvCtx });
        if (gate && Array.isArray(gate.allowed)) approvedCalls = gate.allowed;
        if (gate && Array.isArray(gate.denied)) {
          deniedResults = gate.denied.map((d) => ({
            id: d.call && d.call.id, name: d.call && d.call.name,
            result: { ok: false, error: 'denied_by_user', reason: d.reason || 'rejected' },
          }));
        }
      }

      const registryResults = approvedCalls.length
        ? await this._registry.invokeParallel(approvedCalls, toolCtx, { ...boundInvCtx, step })
        : [];
      // Stitch results back in original call order.
      const resultsById = new Map();
      for (const r of registryResults) resultsById.set(r.id, r);
      for (const r of deniedResults) resultsById.set(r.id, r);
      for (const r of unavailableResults) resultsById.set(r.id, r);
      const results = calls.map((c) => resultsById.get(c.id) || { id: c.id, name: c.name, result: { ok: false, error: 'lost' } });

      const latencyMs = Date.now() - askStart;
      emitSafe('step-acted', { step, calls, results, mode, latencyMs });
      if (aborted()) return { ok: false, reason: 'stopped' };

      // An active skill limits the run to its tool list from here on. The new
      // filter is ANDed with the old one, so a skill can narrow but never widen.
      const skillUse = results.find((r) => r.name === 'agent.use_skill' && r.result && r.result.ok && Array.isArray(r.result.tools));
      if (skillUse) {
        const allowed = new Set(skillUse.result.tools);
        const prev = toolFilter;
        toolFilter = (name, tool) => allowed.has(name) && (!prev || prev(name, tool));
        boundInvCtx.toolFilter = toolFilter;
      }

      // Token-budget tracking: accumulate prompt + completion tokens from every
      // LLM response and surface the running total for a live cost/budget
      // indicator. Done before the terminal-tool check so the final step counts.
      // Use the prompt+completion total (not the completion-only resp.tokens) so the
      // budget counter and the onStep/logStep sink agree with the UI 'agent-tokens'
      // indicator — a large-context step costs mostly prompt tokens.
      const usage = resp && resp.usage;
      // prompt_tokens alone IS the current conversation size, because every step
      // re-sends the whole thing. tokensUsed sums across steps, so it measures
      // cumulative spend and grows far past any single context window.
      const promptTokens = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
      const turnTokens = usage
        ? promptTokens + (Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0)
        : 0;
      if (turnTokens > 0) tokensUsed += turnTokens;
      emitSafe('agent-tokens', { tokensUsed, contextSize, contextTokens: promptTokens, step });

      if (hooks.onStep) {
        try {
          await hooks.onStep({ step, calls, results, latencyMs, tokens: turnTokens, mode });
        } catch (_) { /* logging must never stop the loop */ }
      }

      // Terminal tools
      const doneCall = results.find((r) => r.name === 'agent.done' && r.result && r.result.ok);
      if (doneCall) return { ok: true, summary: doneCall.result.summary || '', mode };
      // A tool that needs the user before the run can continue returns
      // `awaitingUser` (a question) or `awaiting: '<kind>'` (e.g.
      // 'plan_approval'); either ends the run so the host can resume it.
      const awaiting = results.find((r) => r.result && (r.result.awaitingUser || r.result.awaiting));
      if (awaiting && awaiting.result.awaitingUser) {
        return { ok: false, reason: 'awaiting_user', question: awaiting.result.question, mode };
      }
      if (awaiting) {
        const kind = String(awaiting.result.awaiting);
        return { ok: false, reason: `awaiting_${kind}`, awaiting: kind, result: awaiting.result, mode };
      }

      this._appendTurn(messages, resp, calls, results, mode);

      // Compaction: when the conversation itself nears the context window,
      // summarize the oldest turns into one assistant message so the task
      // continues instead of silently truncating against the fixed ctx-size.
      // Re-arms once the conversation has grown by MIN_TURNS_TO_COMPACT since
      // the last compaction, so a long run can compact repeatedly without
      // re-summarizing a summary every step. Gated on the prompt size, never on
      // cumulative spend — those are different units, and the sum crosses the
      // window while the conversation is still small.
      if (compactCfg.auto && contextSize > 0 && promptTokens >= contextSize * compactCfg.threshold
          && messages.length >= MIN_TURNS_TO_COMPACT && messages.length - compactedAt >= MIN_TURNS_TO_COMPACT) {
        const before = messages.length;
        try {
          await this._compactConversation(messages, boundInvCtx, taskMessage);
          compactedAt = messages.length;
          // An empty recap leaves the conversation untouched; that is not a compaction.
          if (messages.length < before) {
            emitSafe('agent-compacted', { before, after: messages.length, tokensUsed, contextSize, step });
            tokensUsed = 0;
          }
        } catch (err) { console.error('[AgentRuntime] compaction failed:', (err instanceof Error && err.message) || err); /* non-fatal: the loop continues un-compacted */ }
      }

      // Reflection / confidence gating — hook decides whether to inject a
      // reflect turn based on whether results contained failures and mode policy.
      if (hooks.shouldReflect) {
        try {
          const reflect = await hooks.shouldReflect({ step, calls, results, mode });
          if (reflect && reflect.prompt) messages.push({ role: 'user', content: String(reflect.prompt) });
        } catch (_) { /* non-fatal */ }
      }
    }
    // Soft landing: the agent ran out of step budget. Rather than failing
    // hard (and losing whatever findings the conversation already contains),
    // give the model one last temperature-0 attempt to summarize what it has.
    // On success the user gets a partial-but-useful answer with reason set so
    // the UI can render a "(partial)" badge. On failure we fall back to the
    // hard reason — same surface as before.
    if (aborted()) return { ok: false, reason: 'stopped' };
    try {
      const forced = await this._forceFinalSummary(messages, boundInvCtx);
      if (aborted()) return { ok: false, reason: 'stopped' };
      if (forced && forced.trim()) {
        return { ok: true, summary: forced.trim(), mode, reason: 'maxstepsexceeded_soft' };
      }
    } catch (_) { /* fall through to hard fail */ }
    return { ok: false, reason: 'max_steps_exceeded', mode };
  }

  async _askLLM(messages, mode, invCtx, step) {
    const wantsTools = mode === 'tools' || mode === 'auto';
    const temperature = invCtx && Number.isFinite(invCtx.temperature) ? invCtx.temperature : 0.1;
    // 768 was too tight — agent.done summaries with multi-section findings
    // get truncated mid-string, leaving the JSON tool call unparseable. 4096
    // gives summaries room to breathe; the parser will repair on overflow.
    const opts = this._withSignal({ temperature, maxTokens: (invCtx && invCtx.maxTokens) || 4096 }, invCtx);
    if (wantsTools) {
      opts.tools = this._registry.list(invCtx && typeof invCtx.toolFilter === 'function' ? invCtx.toolFilter : undefined);
      opts.toolChoice = 'auto';
      opts.parallelToolCalls = true;
    }
    // Draft/verify routing: when the invocation context asks for it, chatRouted
    // lets LLMService pick draft (local) vs verify (remote) per call.
    const outgoing = shapeMessages(messages, invCtx);
    let resp;
    if (invCtx && invCtx.routeTag && typeof this._llm.chatCompletionRouted === 'function') {
      resp = await this._llm.chatCompletionRouted(outgoing, opts, { routeTag: invCtx.routeTag });
    } else if (invCtx && invCtx.streamSteps && typeof this._llm.chatCompletionStream === 'function') {
      resp = await this._streamStep(outgoing, opts, invCtx, mode, step);
    } else {
      resp = await this._llm.chatCompletion(outgoing, opts);
    }
    const hasToolCalls = Array.isArray(resp.toolCalls) && resp.toolCalls.length > 0;
    const detectedMode = mode === 'auto' ? (hasToolCalls ? 'tools' : 'json') : mode;
    return { resp, detectedMode };
  }

  // One agent step over chatCompletionStream. Returns the chatCompletion shape
  // ({content, toolCalls, usage, tokens, reasoningChars, finishReason}). Prose
  // is forwarded as assistant-chunk only in tools mode: in JSON mode the
  // content IS the tool call and would surface as answer text. A stream error
  // (other than the run stopping) falls back to one non-streaming request.
  async _streamStep(messages, opts, invCtx, mode, step) {
    const emit = invCtx && typeof invCtx.emit === 'function' ? invCtx.emit : () => {};
    const showText = mode === 'tools';
    let content = '';
    let final = null;
    let lead = invCtx && invCtx.streamedTextBefore ? '\n\n' : '';
    try {
      for await (const chunk of this._llm.chatCompletionStream(messages, opts)) {
        if (chunk && typeof chunk === 'object' && chunk.__final) { final = chunk; continue; }
        const text = typeof chunk === 'string' ? chunk : (chunk && chunk.content) || '';
        if (!text) continue;
        content += text;
        if (!showText) continue;
        emit('assistant-chunk', { text: lead + text, taskId: invCtx && invCtx.taskId, total: content.length, step, streamed: true });
        lead = '';
        invCtx.streamedTextBefore = true;
      }
    } catch (err) {
      if (opts && opts.signal && opts.signal.aborted) throw err;
      console.error('[AgentRuntime] streamed step failed; retrying without streaming:', errMsg(err));
      emit('step-stream-fallback', { step, error: errMsg(err), partialChars: content.length });
      return this._llm.chatCompletion(messages, opts);
    }
    const usage = (final && final.usage) || null;
    return {
      content,
      toolCalls: (final && Array.isArray(final.toolCalls) && final.toolCalls.length) ? final.toolCalls : null,
      usage,
      tokens: usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0,
      reasoningChars: (final && final.reasoningCharCount) || 0,
      finishReason: (final && final.finishReason) || '',
    };
  }

  // Adds `signal` to LLM call opts when the run has one: the run signal and a
  // request timeout combined, since a caller-supplied signal replaces the
  // client's own timeout.
  _withSignal(opts, invCtx) {
    const runSignal = invCtx && invCtx.signal;
    if (!runSignal) return opts;
    const ms = Number(invCtx.llmTimeoutMs);
    const timeoutMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_LLM_TIMEOUT_MS;
    return { ...opts, signal: AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)]) };
  }

  _extractCalls(resp, mode) {
    if (mode === 'tools' && Array.isArray(resp.toolCalls) && resp.toolCalls.length) {
      return resp.toolCalls.map((tc, i) => ({
        id: tc.id || `call_${Date.now()}_${i}`,
        name: (tc.function && tc.function.name) || tc.name || '',
        args: parseMaybeJson((tc.function && tc.function.arguments) || tc.arguments || '{}'),
        _raw: tc,
      })).filter((c) => c.name);
    }
    return extractToolCalls(resp.content || '');
  }

  _looksLikeToolCall(content) { return looksLikeToolCall(content); }

  // Heuristic: substantive reply that reads like planning/reasoning rather than
  // a final answer. Triggered by length + future-tense intent markers (LLM is
  // narrating what it's about to do, but forgot to actually issue the tool call).
  _looksLikeReasoning(content) {
    if (!content || content.length < 80) return false;
    const REASONING_RX = /\b(I (?:will|need to|should|can|am going to)|I'?ll|Let'?s|Let me|Next step|Plan:|Trying to|Maybe I|Wait,)\b/i;
    return REASONING_RX.test(content);
  }

  // Last-ditch summary attempt invoked when the model has burned through every
  // parse retry. Uses temperature:0 + a tightly-scoped prompt that asks for
  // ONLY agent.done. Returns the parsed summary, or '' on any failure (caller
  // falls back to a clean status message — never the raw thinking dump).
  async _forceFinalSummary(messages, invCtx) {
    try {
      // Strip the trailing retry pushbacks (last few assistant↔user pairs)
      // so the model isn't re-anchored on its own bad reasoning. We keep
      // everything up to the last successful tool turn.
      const trimmed = trimTrailingParseRetries(messages);
      const final = trimmed.concat([{
        role: 'user',
        content: 'Time is up. Reply with EXACTLY one JSON object and nothing else — no markdown, no preamble, no <think> tags:\n'
          + '{"tool":"agent.done","args":{"summary":"<your best answer based on the tool results above>"}}\n'
          + 'The summary must be a complete, user-facing answer based on what you have already observed. '
          + 'If some information is missing, summarise what you DO know and note what was unavailable. '
          + 'Do NOT request more tool calls. Do NOT explain — just emit the JSON.',
      }]);
      const opts = this._withSignal({ temperature: 0, maxTokens: (invCtx && invCtx.maxTokens) || 4096 }, invCtx);
      // Stream the response so the UI can show text appearing live during
      // what's otherwise a multi-second wait. Falls back to non-streaming
      // when chatCompletionStream isn't available on the client (unit tests).
      const resp = await this._chatStreamingOrPlain(final, opts, invCtx);
      // Try OpenAI-native first (servers that emit structured tool_calls).
      if (resp && Array.isArray(resp.toolCalls) && resp.toolCalls.length) {
        for (const tc of resp.toolCalls) {
          const name = (tc.function && tc.function.name) || tc.name || '';
          if (name === 'agent.done') {
            const args = parseMaybeJson((tc.function && tc.function.arguments) || tc.arguments || '{}');
            if (args && args.summary) return String(args.summary);
          }
        }
      }
      // Fall back to the dialect parser (handles json/hermes/etc).
      const calls = extractToolCalls((resp && resp.content) || '');
      const done = calls && calls.find((c) => c.name === 'agent.done');
      if (done && done.args && done.args.summary) return String(done.args.summary);
      // Last resort: if the response is plain text and doesn't look like
      // reasoning, treat it as the summary directly.
      const text = stripThink((resp && resp.content) || '').trim();
      if (text && !this._looksLikeReasoning(text)) return text;
    } catch (_) { /* swallow — caller has its own fallback */ }
    return '';
  }

  // Try chatCompletionStream first; if not available or it throws, fall back
  // to chatCompletion. As chunks arrive, emit `assistant-chunk` events so the
  // renderer's AnswerView can stream the partial text. Always returns the
  // same shape as chatCompletion: { content, toolCalls?, usage?, tokens? }.
  async _chatStreamingOrPlain(messages, opts, invCtx) {
    const emit = invCtx && typeof invCtx.emit === 'function' ? invCtx.emit : null;
    if (typeof this._llm.chatCompletionStream !== 'function') {
      return this._llm.chatCompletion(shapeMessages(messages, invCtx), opts);
    }
    let buffer = '';
    let usage = null;
    messages = shapeMessages(messages, invCtx);
    try {
      const iter = this._llm.chatCompletionStream(messages, opts);
      for await (const chunk of iter) {
        if (chunk && typeof chunk === 'object' && chunk.__final) { usage = chunk.usage || null; continue; }
        const text = typeof chunk === 'string' ? chunk : (chunk && chunk.content) || '';
        if (!text) continue;
        buffer += text;
        if (emit) try { emit('assistant-chunk', { text, taskId: invCtx && invCtx.taskId, total: buffer.length }); } catch (err) { console.error('[AgentRuntime] assistant-chunk emit failed:', (err instanceof Error && err.message) || err); }
      }
      return { content: buffer, toolCalls: null, usage, tokens: usage && usage.completion_tokens || 0 };
    } catch (err) {
      // A stopped run must not be revived by the fallback request.
      if (opts && opts.signal && opts.signal.aborted) throw err;
      // Stream failed mid-flight — fall back to a fresh non-streaming call so
      // the user still gets an answer (parsing logic stays the same downstream).
      try { return await this._llm.chatCompletion(messages, opts); }
      catch (_) { throw err; }
    }
  }

  _appendTurn(messages, resp, calls, results, mode) {
    if (mode === 'tools') {
      messages.push({ role: 'assistant', content: resp.content || '', tool_calls: calls.map((c) => c._raw || toToolCall(c)) });
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: truncate(JSON.stringify(r.result || {})) });
      }
    } else {
      messages.push({ role: 'assistant', content: resp.content || '' });
      const lines = results.map((r, i) => `${i + 1}. ${r.name} → ${truncate(JSON.stringify(r.result || {}))}`);
      messages.push({ role: 'user', content: `Results:\n${lines.join('\n')}` });
    }
  }

  // Summarize the oldest turns into a factual recap so a long task continues
  // inside the ctx-size window instead of truncating. Keeps the leading system
  // messages, the run's task message and roughly the most recent
  // COMPACT_KEEP_TURNS verbatim. The kept tail starts on an assistant message:
  // tool results (native role 'tool', JSON-mode "Results:") cut off from the
  // assistant turn that made the calls are rejected or misread by the model.
  // Strict chat templates reject two same-role turns in a row, so the recap
  // prefixes the first kept assistant turn after the task, or stands as a user
  // turn when the task is not ahead of the tail.
  async _compactConversation(messages, invCtx, taskMessage) {
    if (!Array.isArray(messages) || messages.length < MIN_TURNS_TO_COMPACT) return;
    let headEnd = 0;
    while (headEnd < messages.length && messages[headEnd].role === 'system') headEnd++;
    const nominal = Math.max(headEnd + 1, messages.length - COMPACT_KEEP_TURNS);
    const summarizable = (start) => messages.slice(headEnd, start).some((m) => m !== taskMessage);
    let tailStart = -1;
    for (let i = nominal; i > headEnd && tailStart < 0; i--) if (messages[i].role === 'assistant' && summarizable(i)) tailStart = i;
    for (let i = nominal + 1; i < messages.length && tailStart < 0; i++) if (messages[i].role === 'assistant') tailStart = i;
    if (tailStart < 0) return;
    const middle = messages.slice(headEnd, tailStart).filter((m) => m !== taskMessage);
    if (!middle.length) return;
    const keepTask = middle.length < tailStart - headEnd;
    const summary = await this._summarizeForCompaction(middle, invCtx);
    if (!summary) return;
    const head = messages.slice(0, headEnd);
    const tail = messages.slice(tailStart);
    const recap = `[Compacted ${middle.length} earlier turns] Summary of prior progress:\n${summary}`;
    messages.length = 0;
    head.forEach((m) => messages.push(m));
    if (keepTask) {
      messages.push(taskMessage);
      tail[0] = { ...tail[0], content: [recap, tail[0].content].filter(Boolean).join('\n\n') };
    } else {
      messages.push({ role: 'user', content: recap });
    }
    tail.forEach((m) => messages.push(m));
  }

  async _summarizeForCompaction(turns, invCtx) {
    const prompt = [{
      role: 'user',
      content: 'Summarize the following agent turns into a concise factual recap. Keep every concrete result, URL, value, and decision; drop narration and tool-call boilerplate. Reply with prose only, no JSON.\n\n'
        + turns.map((m) => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n'),
    }];
    const opts = this._withSignal({ temperature: 0, maxTokens: (invCtx && invCtx.maxTokens) || 2048 }, invCtx);
    // Suppress the user-facing emit sink: the recap is internal bookkeeping, not the
    // agent's answer, so its streamed chunks must not reach the answer view. The
    // text still accumulates internally (buffer/usage) via the same streaming path.
    const resp = await this._chatStreamingOrPlain(prompt, opts, { ...invCtx, emit: undefined });
    return stripThink((resp && resp.content) || '').trim();
  }
}

// When the model's been spamming reasoning and we want to force a final
// summary, we strip the tail-end retry pushbacks (assistant reasoning →
// user "STOP narrating…" pair) so the model isn't re-anchored on its own
// bad replies. Walks backward as long as the messages look like the parse-
// retry pattern; bails the moment it sees a tool result or a substantive
// turn so we never throw away successful intermediate progress.
/**
 * settings.llm.agent.compaction → { auto, threshold }. A threshold outside
 * (0, 1] would compact every step or never, so it falls back to the default.
 * @param {any} cfg
 * @returns {{ auto: boolean, threshold: number }}
 */
function compactionSettings(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const t = Number(c.threshold);
  return { auto: c.auto !== false, threshold: t > 0 && t <= 1 ? t : COMPACT_THRESHOLD };
}

function trimTrailingParseRetries(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const out = messages.slice();
  while (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (!last || !prev) break;
    const lastIsRetryPrompt = last.role === 'user'
      && typeof last.content === 'string'
      && /STOP narrating|Reply with ONE JSON object|reasoning, not a tool call/i.test(last.content);
    const prevIsAssistantReasoning = prev.role === 'assistant'
      && (!Array.isArray(prev.tool_calls) || !prev.tool_calls.length);
    if (lastIsRetryPrompt && prevIsAssistantReasoning) {
      out.length -= 2;
      continue;
    }
    break;
  }
  return out;
}

// systemStyle 'merge': chat templates without a system role (Gemma) get the
// system text prepended to the first user turn. The run's own message array
// is never mutated — only the copy sent to the server.
function shapeMessages(messages, invCtx) {
  if (!invCtx || invCtx.systemStyle !== 'merge' || !Array.isArray(messages)) return messages;
  const system = messages.filter((m) => m && m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).filter(Boolean);
  if (!system.length) return messages;
  const rest = messages.filter((m) => !m || m.role !== 'system');
  const block = system.join('\n\n');
  const at = rest.findIndex((m) => m && m.role === 'user');
  if (at < 0) return [{ role: 'user', content: block }, ...rest];
  const first = rest[at];
  const merged = typeof first.content === 'string'
    ? { ...first, content: `${block}\n\n${first.content}` }
    : { ...first, content: [{ type: 'text', text: block }, ...(Array.isArray(first.content) ? first.content : [])] };
  return [...rest.slice(0, at), merged, ...rest.slice(at + 1)];
}

function toToolCall(c) {
  return { id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } };
}

function parseMaybeJson(s) {
  if (typeof s !== 'string') return s || {};
  try { return JSON.parse(s); } catch (_) { return {}; }
}

function truncate(s, max) {
  const limit = max || MAX_RESULT_BYTES;
  if (!s || s.length <= limit) return s;
  return s.slice(0, limit) + `…[truncated ${s.length - limit} bytes]`;
}

module.exports = { AgentRuntime, shapeMessages, compactionSettings };
