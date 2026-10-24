// LLMClientService — thin client wrapper around the active LLM endpoint
// exposed by LLMService. Talks to any OpenAI-compatible /v1/chat/completions
// server (local llama.cpp, MLX, or remote provider). Streaming chat returns
// an async iterator of token chunks. Compatibility heuristics (temperature
// rejection, MLX crash detection, friendly errors) live in ./llmCompat; SSE
// parsing/reading lives in ./llmStream; per-target endpoint/auth/model
// resolution for draft-verify routing lives in ./llm/routeTarget.
const llmService = require('./LLMService');
const compat = require('./llmCompat');
const routeTarget = require('./llm/routeTarget');
const { readSseStream } = require('./llmStream');
const { chatCompletionJson } = require('./llmJson');
const { alternateRoles } = require('./llm/roleAlternation');
const { errMsg } = require('../../shared/errMsg');

// Local cold-prompt-cache inference can legitimately take several minutes —
// default well above worst-case cold-start while still catching hung requests.
const DEFAULT_TIMEOUT_MS = 300_000;

// Bounds the in-call recovery chain (MLX text-only restart + temperature
// re-send) so a server that keeps echoing the same error can't recurse forever.
const MAX_RECOVER_HOPS = 3;

class LLMClientService {
  constructor() {
    this._fetch = (typeof fetch === 'function') ? fetch.bind(globalThis) : null;
    this._llm = llmService;
    this._configService = null;
    // `${endpoint||''}|${model||''}` keys whose server rejected `temperature`. Populated reactively from the first 400 so later calls skip it; compat.shouldOmitTemperature also covers known offenders proactively so first contact doesn't pay the retry.
    this._modelsRejectingTemperature = new Set();
    // Same shape, for servers that cannot take a `tools` payload at all. A hit here sends the request without tools, which drops the agent to its text-JSON protocol rather than failing the task.
    this._modelsRejectingTools = new Set();
  }

  // Thin delegates to ./llmCompat — kept as instance methods so the reactive
  // temperature cache stays encapsulated and unit tests can exercise them.
  _isTemperatureRejectionError(err) { return compat.isTemperatureRejectionError(err); }
  _isMlxStreamCrash(err) { return compat.isMlxStreamCrash(err); }
  _friendlyError(status, detail) { return compat.friendlyError(status, detail); }
  _shouldOmitTemperature(model, endpoint) { return compat.shouldOmitTemperature(model, endpoint, this._modelsRejectingTemperature); }
  _markTemperatureRejected(model, endpoint) { this._modelsRejectingTemperature.add(compat.temperatureKey(model, endpoint)); }
  _isToolsRejectionError(err) { return compat.isToolsRejectionError(err); }
  _shouldOmitTools(model, endpoint) { return this._modelsRejectingTools.has(compat.temperatureKey(model, endpoint)); }
  _markToolsRejected(model, endpoint) { this._modelsRejectingTools.add(compat.temperatureKey(model, endpoint)); }

  // Test injection
  _setFetch(fn) { this._fetch = fn; }
  _setLLMService(svc) { this._llm = svc; }

  bindConfig(cs) { this._configService = cs; }
  _defaultTimeout() { const v = this._configService && this._configService.get && this._configService.get('settings.llmClientTimeoutMs', DEFAULT_TIMEOUT_MS); return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_TIMEOUT_MS; }

  _resolveEndpoint(override) {
    const raw = override || (this._llm && typeof this._llm.getEndpoint === 'function' ? this._llm.getEndpoint() : null);
    if (!raw) return null;
    // Defensive normalization: strip trailing slashes and a single trailing
    // `/v1` so paths like `/v1/chat/completions` never double-prefix into
    // `/v1/v1/chat/completions` (FastAPI 404). Idempotent.
    return String(raw).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  // Normalized view of the configured remote, or null when none exists — every
  // per-target decision below funnels through this one shape so a stubbed/oddly-shaped _remote in tests can't leak into routeTarget's comparisons.
  _remoteCfg() { const r = this._llm && this._llm._remote; return (r && typeof r === 'object') ? { endpoint: String(r.endpoint || ''), apiKey: r.apiKey || '', model: r.model || '' } : null; }

  // Credentials are scoped to the resolved request URL, not global engine state: a local server and a configured remote can coexist (dual state), so inferring "is this call for the remote" from status would attach one's key onto the other. See llm/routeTarget.js for the comparison semantics.
  _authHeaders(resolvedBase) { return routeTarget.targetAuthHeaders(resolvedBase, this._remoteCfg()); }

  // Default model id is scoped to the resolved request target, same reason as _authHeaders above — a remote's model id landing in a localhost call would be rejected by a local server that checks the id (oMLX, vLLM). Callers pass this._resolveEndpoint(options.endpoint) so it always agrees with where the body actually goes (pure function of that input).
  _defaultModel(resolvedBase) { const status = this._llm && typeof this._llm.getStatus === 'function' ? this._llm.getStatus() : null; return routeTarget.resolveDefaultModel(resolvedBase, (status && (status.apiModel || status.model)), this._remoteCfg()); }

  // mlx-openai-server logs a warning for every request carrying
  // `parallel_tool_calls` and then ignores it. Skip sending it to keep stderr clean.
  _endpointIgnoresParallelTools() {
    const status = this._llm && typeof this._llm.getStatus === 'function' ? this._llm.getStatus() : null;
    return !!status && status.backend === 'mlxOpenAi';
  }

  /**
   * @param {string} path
   * @param {Record<string, any>} body
   * @param {{ signal?: AbortSignal, endpoint?: string }} [opts]
   */
  async _post(path, body, { signal, endpoint } = {}) {
    if (!this._fetch) throw new Error('fetch unavailable in this environment');
    const base = this._resolveEndpoint(endpoint);
    if (!base) throw new Error('No active LLM endpoint — start LLMService or set a remote endpoint');
    const url = base.replace(/\/$/, '') + path;
    const res = await this._fetch(url, {
      method: 'POST',
      headers: this._authHeaders(base), // target-scoped (see _remoteCfg/_authHeaders) — the key attaches only if THIS request is actually going to the remote endpoint
      body: JSON.stringify(body),
      signal,
    });
    if (!res || !res.ok) {
      const status = res ? res.status : 'no-response';
      let detail = '';
      try { detail = res ? await res.text() : ''; } catch (_) { /* ignore */ }
      throw new Error(this._friendlyError(status, detail));
    }
    return res;
  }

  // apiKey override lets the renderer verify a candidate endpoint+key before
  // persisting it (Settings → LLM → Verify). When omitted, credentials are resolved from the configured remote only when this request's own URL targets that same endpoint — otherwise an explicit non-remote `endpoint` would inherit a key it wasn't asked for.
  async listModels(opts = {}) {
    if (!this._fetch) throw new Error('fetch unavailable in this environment');
    const base = this._resolveEndpoint(opts.endpoint);
    if (!base) throw new Error('No active LLM endpoint');
    const headers = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' } : this._authHeaders(base);
    const res = await this._fetch(base + '/v1/models', { headers, signal: opts.signal });
    if (!res || !res.ok) {
      let detail = ''; try { detail = res ? (await res.text()).slice(0, 240) : ''; } catch (_) { /* best-effort detail; HTTP error still thrown below */ }
      throw new Error(`listModels failed: ${res ? res.status : 'no-response'}${detail ? ' — ' + detail : ''}`);
    }
    let json; try { json = await res.json(); } catch (err) { throw new Error(this._friendlyError(res.status, `malformed JSON from /v1/models: ${errMsg(err)}`)); }
    if (Array.isArray(json)) return json;
    return (json && Array.isArray(json.data)) ? json.data : [];
  }

  async chatCompletion(messages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('messages must be a non-empty array');
    }
    const resolvedBase = this._resolveEndpoint(options.endpoint); // shared with _defaultModel so the model id is scoped to exactly where the request will land — no divergence between what we send and how we label it
    const model = options.model || this._defaultModel(resolvedBase);
    const body = {
      model,
      messages: alternateRoles(messages),
      max_tokens: options.maxTokens || 1024,
      stream: false,
    };
    if (!this._shouldOmitTemperature(model, options.endpoint)) {
      body.temperature = options.temperature != null ? options.temperature : 0.2;
    }
    if (options.responseFormat) body.response_format = options.responseFormat;
    if (options.stop) body.stop = options.stop;
    const sendTools = !!options.tools && !this._shouldOmitTools(model, options.endpoint);
    if (sendTools) {
      body.tools = options.tools;
      if (options.toolChoice) body.tool_choice = options.toolChoice;
      if (options.parallelToolCalls != null && !this._endpointIgnoresParallelTools()) {
        body.parallel_tool_calls = options.parallelToolCalls;
      }
    }
    const ctrl = options.signal ? null : new AbortController();
    const timer = ctrl ? setTimeout(() => ctrl.abort(), options.timeoutMs || this._defaultTimeout()) : null;
    try {
      let res;
      try {
        res = await this._post('/v1/chat/completions', body, { signal: options.signal || (ctrl && ctrl.signal), endpoint: options.endpoint });
      } catch (err) {
        // Shared hop counter so chained recovery works in one call: multimodal
        // crash → restart as lm → if lm also crashes, try alt MLX runtime; and
        // it bounds the temperature re-send below. _tryRecoverMlxTextOnly
        // returns false when out of options.
        const hops = options._recoverHops || 0;
        if (hops < MAX_RECOVER_HOPS && this._isMlxStreamCrash(err) && await this._tryRecoverMlxTextOnly()) {
          return this.chatCompletion(messages, { ...options, _recoverHops: hops + 1 });
        }
        // Model rejected `temperature` (Claude 4.5+ / OpenAI o-series / gpt-5+).
        // Mark the (endpoint, model) pair and retry — the recursive call hits
        // the cache in _shouldOmitTemperature and sends no temperature. The hop
        // counter also guards a server that echoes the rejection regardless.
        if (body.temperature !== undefined && hops < MAX_RECOVER_HOPS && this._isTemperatureRejectionError(err)) {
          this._markTemperatureRejected(model, options.endpoint);
          return this.chatCompletion(messages, { ...options, _recoverHops: hops + 1 });
        }
        // Server has no tool-calling surface. Mark the pair and re-send without
        // tools so the caller's text protocol answers instead of the task dying.
        if (sendTools && hops < MAX_RECOVER_HOPS && this._isToolsRejectionError(err)) {
          this._markToolsRejected(model, options.endpoint);
          return this.chatCompletion(messages, { ...options, _recoverHops: hops + 1 });
        }
        throw err;
      }
      let json; try { json = await res.json(); } catch (err) { throw new Error(this._friendlyError(res.status, `malformed JSON from /v1/chat/completions: ${errMsg(err)}`)); }
      const choice = json && json.choices && json.choices[0];
      const message = choice && choice.message;
      const content = message && message.content;
      const toolCalls = (message && Array.isArray(message.tool_calls)) ? message.tool_calls : null;
      const usage = json && json.usage;
      const tokens = usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
      // Reasoning servers put chain-of-thought in a sibling field that spends the
      // same max_tokens budget as content. Surfaced with finish_reason so a caller
      // can tell "spent the budget thinking" from "the server said nothing".
      const reasoning = (message && message.reasoning_content) || '';
      const finishReason = (choice && choice.finish_reason) || '';
      return { content: content || '', toolCalls, usage: usage || null, tokens, reasoning, finishReason, raw: json };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Structured output: response_format json_object + parse + schema validation
  // with one repair-nudge retry. Delegates to ./llmJson (extracted for the cap).
  // See llmJson.js for the return shape and schema semantics.
  async chatCompletionJson(messages, schema, options = {}) {
    return chatCompletionJson(this, messages, schema, options);
  }

  // When the MLX multimodal handler crashes once, restart the server in
  // text-only mode and let the caller retry. Returns true on successful
  // recovery, false if there was nothing to recover (no MLX, already lm).
  async _tryRecoverMlxTextOnly() {
    if (!this._llm || typeof this._llm.restartAsTextOnly !== 'function') return false;
    try { return !!(await this._llm.restartAsTextOnly()); } catch (_) { return false; }
  }

  // Yields text-delta strings then a terminal `{__final, usage, elapsedMs, charCount, toolCalls}`
  // so UIs can compute live tokens/sec.
  async *chatCompletionStream(messages, options = {}) {
    const resolvedBase = this._resolveEndpoint(options.endpoint); // same target-scoping as chatCompletion — model id must match where the stream actually lands too, not just non-streaming calls
    const model = options.model || this._defaultModel(resolvedBase);
    const body = {
      model, messages: alternateRoles(messages),
      max_tokens: options.maxTokens || 1024,
      stream: true, stream_options: { include_usage: true },
    };
    if (!this._shouldOmitTemperature(model, options.endpoint)) {
      body.temperature = options.temperature != null ? options.temperature : 0.2;
    }
    // Tools ride along like chatCompletion; streamed tool_calls fragments are assembled into the terminal frame's toolCalls by readSseStream.
    const sendTools = !!options.tools && !this._shouldOmitTools(model, options.endpoint);
    if (sendTools) {
      body.tools = options.tools;
      if (options.toolChoice) body.tool_choice = options.toolChoice;
      if (options.parallelToolCalls != null && !this._endpointIgnoresParallelTools()) body.parallel_tool_calls = options.parallelToolCalls;
    }
    const startedAt = Date.now();
    let res;
    try {
      res = await this._post('/v1/chat/completions', body, { signal: options.signal, endpoint: options.endpoint });
    } catch (err) {
      // Same temperature auto-recovery as chatCompletion. Safe to retry — the
      // failure happens before any tokens are streamed to the consumer; bounded
      // by the hop counter so a server echoing the rejection can't loop.
      const hops = options._recoverHops || 0;
      if (body.temperature !== undefined && hops < MAX_RECOVER_HOPS && this._isTemperatureRejectionError(err)) {
        this._markTemperatureRejected(model, options.endpoint);
        yield* this.chatCompletionStream(messages, { ...options, _recoverHops: hops + 1 });
        return;
      }
      if (sendTools && hops < MAX_RECOVER_HOPS && this._isToolsRejectionError(err)) {
        this._markToolsRejected(model, options.endpoint);
        yield* this.chatCompletionStream(messages, { ...options, _recoverHops: hops + 1 });
        return;
      }
      throw err;
    }
    yield* readSseStream(res, startedAt);
  }

  // Draft/verify routing — tag semantics: 'draft' prefers the cheap/local engine (no override here — getEndpoint() resolves it), while 'verify'/'judge' explicitly target the configured remote endpoint so a quality model grades even when drafts run locally. The explicit selection is required because both engines can be live at once; relying on whichever one happens to "win" default resolution would silently route judges onto whatever engine the user last touched, not what this call actually wants. Falls back to a plain chatCompletion (unchanged behavior) whenever no remote endpoint is configured — there's nothing extra to route to in that case.
  async chatCompletionRouted(messages, options = {}, route = {}) {
    const tag = route && route.routeTag;
    if ((tag === 'verify' || tag === 'judge') && this._remoteCfg()) return this.chatCompletion(messages, { ...options, endpoint: /* target is the remote itself — auth + model default both resolve against it via _authHeaders/_defaultModel above */ this._llm._remote.endpoint });
    return this.chatCompletion(messages, options);
  }

  // Inject images into the LAST user message as content parts (OpenAI vision format).
  async visionCompletion(messages, images, options = {}) {
    const augmented = messages.map((m, i) => {
      if (i !== messages.length - 1 || m.role !== 'user') return m;
      /** @type {Array<Record<string, any>>} */
      const parts = [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }];
      for (const img of images || []) {
        const url = typeof img === 'string' ? img : img.url;
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
      return { role: 'user', content: parts };
    });
    return this.chatCompletion(augmented, options);
  }
}

module.exports = new LLMClientService();
