// ChatStreamService — the single backbone for single-turn streamed LLM answers
// (Page Copilot, council synthesis, and the unified chat surface). Owns the
// stream loop and the per-request AbortController registry. Admission goes
// through the process-wide LLM gate (main/agent/sessions/llmGate), which every
// agent run shares, so chat never pushes the engine past its slot count.
//
// Reuses LLMClientService so model id, auth headers, endpoint resolution,
// friendly errors and MLX recovery match the rest of the app rather than
// re-implementing a naive fetch. IPC handlers (chatHandlers, copilotHandlers)
// are thin adapters over `ask`.

const llmClient = require('./LLMClientService');
const { gate } = require('../agent/sessions/llmGate');

// Reasoning models spend this same budget on chain-of-thought before emitting a
// single visible character, so a budget sized for the answer alone returns
// nothing at all on them.
const DEFAULT_MAX_TOKENS = 4096;

class ChatStreamService {
  constructor() {
    this._inflight = new Map(); // id -> AbortController
    this._client = llmClient;
    this._engineUsers = null;   // optional () => boolean: other engine users that block a restart, not chat
  }

  // Test seam — swap in a test-double streaming client.
  _setClient(c) { this._client = c; }

  // Agent runs hold the gate only while a request is in flight; between
  // requests they still need the engine up, so an engine restart must wait.
  setEngineUsers(fn) { this._engineUsers = typeof fn === 'function' ? fn : null; }

  // True while the engine is in use by anyone: callers gate engine restarts on it.
  isBusy() {
    if (this._inflight.size > 0 || gate.stats().active > 0) return true;
    return !!(this._engineUsers && this._engineUsers());
  }

  cancel(id) {
    const c = id && this._inflight.get(id);
    if (!c) return false;
    c.abort();
    return true;
  }

  cancelAll() {
    for (const c of this._inflight.values()) {
      c.abort();
    }
  }

  // Stream a single-turn completion. `onToken(delta)` is invoked per text chunk.
  // Resolves {ok:true, elapsedMs, charCount} or {ok:false, error}. A request
  // that finds every LLM gate slot taken (by another stream or an agent run's
  // in-flight request) rejects with 'engine_busy' instead of queueing behind
  // it. A stream that carries no visible text
  // resolves {ok:false} — 'reasoning_budget_exhausted' when the model spent the
  // whole budget thinking, 'empty_response' otherwise — so an answerless turn
  // never reaches the UI as a success.
  /**
   * @param {{ id?: string, messages?: Array<Record<string, any>>, maxTokens?: number,
   *   endpoint?: string, model?: string, temperature?: number }} [req]
   * @param {(delta: string) => void} [onToken]
   */
  async ask({ id, messages, maxTokens = DEFAULT_MAX_TOKENS, endpoint, model, temperature } = {}, onToken) {
    if (!id) return { ok: false, error: 'missing_request_id' };
    if (!Array.isArray(messages) || !messages.length) return { ok: false, error: 'empty_messages' };
    const release = gate.tryAcquire();
    if (!release) return { ok: false, error: 'engine_busy' };

    const controller = new AbortController();
    this._inflight.set(id, controller);
    try {
      let charCount = 0;
      let elapsedMs = 0;
      let reasoningCharCount = 0;
      let assistantText = '';
      const opts = { signal: controller.signal, maxTokens };
      if (endpoint) opts.endpoint = endpoint;
      if (model) opts.model = model;
      if (typeof temperature === 'number') opts.temperature = temperature;
      for await (const chunk of this._client.chatCompletionStream(messages, opts)) {
        if (chunk && chunk.__final) {
          elapsedMs = chunk.elapsedMs || 0;
          reasoningCharCount = chunk.reasoningCharCount || 0;
          continue;
        }
        if (typeof chunk === 'string' && chunk) {
          charCount += chunk.length;
          assistantText += chunk;
          if (typeof onToken === 'function') onToken(chunk);
        }
      }
      if (!charCount) {
        return { ok: false, error: reasoningCharCount > 0 ? 'reasoning_budget_exhausted' : 'empty_response' };
      }
      this._maybeAutoCapture(messages, assistantText);
      return { ok: true, elapsedMs, charCount };
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, error: 'cancelled' };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this._inflight.delete(id);
      release();
    }
  }

  // Fire-and-forget user-memory auto-capture. Lazy-loads UserMemoryService so
  // this module stays decoupled, and never lets capture errors reach the chat
  // caller — capture is best-effort background work.
  _maybeAutoCapture(messages, assistantText) {
    if (!Array.isArray(messages) || !assistantText) return;
    try {
      const userMemory = require('./UserMemoryService');
      if (userMemory && typeof userMemory.capture === 'function') {
        userMemory.capture({ messages, answer: assistantText }).catch((err) => {
          console.error('[ChatStreamService] auto-capture failed:', (err instanceof Error && err.message) || err);
        });
      }
    } catch (err) { console.error('[ChatStreamService] auto-capture unavailable:', (err instanceof Error && err.message) || err); }
  }
}

module.exports = new ChatStreamService();
