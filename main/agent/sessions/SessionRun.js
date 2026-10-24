// SessionRun — the host for one background session run. It borrows the
// foreground AgentService's collaborators (tool registry, gated LLM client,
// persona/quality services, approval service) but owns its run state, so
// several sessions run side by side while the foreground panel keeps its own.
//
// Every event goes to onEvent(channel, payload) — the session manager turns
// it into session:event — and never to the foreground agent:* stream.
// A background run may have no tab (detached): it works through the
// workspace, search and tab-opening tools. The tabs it opens are tagged with
// its session id, and it sees and drives only its own agent tabs (plus
// untagged ones), so concurrent sessions never share a tab.

const { AgentHost } = require('./hostMixin');
const { AgentRuntime } = require('../AgentRuntime');
const { createStore: createConversationStore } = require('../conversationStore');
const { runTurn } = require('./runTurn');

const BORROWED = [
  '_registry', '_llm', '_llmService', '_screenshots', '_tabRegistry', '_tabOps', '_qualityMode',
  '_personaService', '_personaRouter', '_getVisionConfig', '_getActiveModel', '_getAgentConfig',
  '_configService', '_maxStepsOverride', '_webContentsModule',
];

// Nobody may be watching a background run, so its approval prompts can be
// bounded separately from the foreground ones (0 = no timer: the prompt waits
// for the user). The bound runs inside the approval service, so a timed-out
// prompt is settled there too and announced: onResolved receives
// {requestId, sessionId, decision, reason?} for every prompt of this run.
function withApprovalTimeout(approval, getTimeoutMs, onResolved) {
  return new Proxy(approval, {
    get(target, prop) {
      if (prop === 'requestApproval') {
        return (prompt) => {
          const ms = Number(getTimeoutMs());
          const timeoutMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
          return target.requestApproval(prompt, { timeoutMs, timeoutReason: 'background_timeout', onResolved });
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

class SessionRun extends AgentHost {
  /**
   * @param {{ source: any, onEvent: (channel: string, payload: any) => void, sessionSink: any, checkpointStore?: any,
   *   getApprovalTimeoutMs?: () => number }} opts source = the foreground AgentService
   */
  constructor({ source, onEvent, sessionSink, checkpointStore, getApprovalTimeoutMs }) {
    super();
    if (!source || !source._registry) throw new Error('source host required');
    if (typeof onEvent !== 'function') throw new Error('onEvent required');
    if (!sessionSink) throw new Error('sessionSink required');
    const self = /** @type {any} */ (this);
    for (const k of BORROWED) self[k] = source[k];
    self._approval = withApprovalTimeout(source._approval, getApprovalTimeoutMs || (() => 0), (info) => onEvent('approval-resolved', info));
    self._runtime = new AgentRuntime({ registry: source._registry, llm: source._llm });
    // Share the negotiated tool format so a background run skips re-probing the engine.
    if (source._runtime && source._runtime._modeCache) self._runtime._modeCache = source._runtime._modeCache;
    self._conversations = createConversationStore();
    self._conversation = null;
    self._ledgerState = null;
    self._sessionSink = sessionSink;
    self._checkpointStore = checkpointStore || null;
    self._allowDetached = true;
    this._onEvent = onEvent;
    this.startedAt = null;
  }

  emit(channel, payload) {
    this._onEvent(channel, payload);
    return super.emit(channel, payload);
  }

  /**
   * @param {{ sessionId: string, text?: string, fromNodeId?: string|null, webContentsId?: number|null, source?: string,
   *   toolFilter?: (name: string, tool: any) => boolean, maxSteps?: number }} req
   */
  start(req) {
    // runTurn clears _stopRequested when it begins, so a stop that lands
    // between scheduling and starting would otherwise be lost.
    if (this._stopRequested) {
      const result = { ok: false, reason: 'stopped' };
      this.emit('task-completed', { ...result, sessionId: req.sessionId });
      return Promise.resolve(result);
    }
    this.startedAt = Date.now();
    const self = /** @type {any} */ (this);
    self._tabOps = self._tabOps.forSession(req.sessionId, { background: true });
    self._tabRegistry = self._tabRegistry.forSession(req.sessionId);
    return runTurn(this, {
      description: req.text, fromNodeId: req.fromNodeId || null, sessionId: req.sessionId,
      webContentsId: req.webContentsId == null ? null : req.webContentsId, source: req.source || 'agent',
      toolFilter: typeof req.toolFilter === 'function' ? req.toolFilter : undefined,
      maxSteps: Number.isInteger(req.maxSteps) && req.maxSteps > 0 ? req.maxSteps : undefined,
    });
  }
}

module.exports = { SessionRun, withApprovalTimeout };
