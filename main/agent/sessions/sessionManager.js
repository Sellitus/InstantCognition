// sessionManager — runs agent turns for many sessions at once.
//
//   Map<sessionId, host> of background runs (SessionRun), bounded by
//   settings.llm.agent.sessions.maxConcurrent; sends beyond the bound wait in
//   a FIFO queue. LLM concurrency is bounded separately by the shared gate.
//   Background events leave as 'event' {sessionId, channel, payload} only
//   (session:event over IPC), never on the foreground agent:* stream.
//
//   Plan mode: a run that ends in agent.exit_plan leaves a pending plan here
//   (from a background host, or from the foreground AgentService via
//   attachForeground). planDecision() settles it:
//     approve           → session mode 'ask', resume with the plan
//     approve_auto_edit → session mode 'auto-edit', resume with the plan
//     edit              → session mode 'ask', resume with the edited plan
//     reject            → stays in 'plan'; nothing resumes
//   The resume runs on the lane that proposed the plan.
//
//   Inbox: every background run that ends (other than a user stop) becomes an
//   unread inbox item {sessionId, title, summary, ok} once an inbox is bound.
//   Subagents: spawnSubagent() runs child agents through SubagentRunner; they
//   do not count against sessions.maxConcurrent.

const EventEmitter = require('events');
const { assertSessionId, assertNodeId } = require('./sessionStore');
const { toChatMessages, countTokens } = require('./contextProjection');
const { planText } = require('./sessionRecorder');
const { normalizePlan } = require('../tools/planTools');
const { SubagentRunner } = require('./subagentRunner');

const MAX_TEXT = 100000;
const INBOX_SUMMARY_MAX = 4000;
const COMPACT_MAX_TOKENS = 1024;
const COMPACT_SYSTEM = 'Summarize the conversation below for a future turn that will not see it. Keep decisions, facts found, file paths, open questions and the current state of the task. Plain text, no preamble.';

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const n = Number(s.maxConcurrent);
  return {
    maxConcurrent: Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 2,
    notifyOnComplete: s.notifyOnComplete !== false,
    backgroundApprovalTimeoutMs: Number.isFinite(Number(s.backgroundApprovalTimeoutMs)) && Number(s.backgroundApprovalTimeoutMs) > 0 ? Number(s.backgroundApprovalTimeoutMs) : 0,
  };
}

const errText = (err) => (err instanceof Error && err.message) || String(err);

class SessionManager extends EventEmitter {
  /**
   * @param {{ store: any, createHost: (onEvent: (channel: string, payload: any) => void) => any, getSettings?: () => any,
   *   approval?: any, llm?: any, getContextSize?: () => number, getSubagentSettings?: () => any, inbox?: any }} deps
   */
  constructor({ store, createHost, getSettings, approval, llm, getContextSize, getSubagentSettings, inbox }) {
    super();
    if (!store) throw new Error('store required');
    if (typeof createHost !== 'function') throw new Error('createHost required');
    this._store = store;
    this._createHost = createHost;
    this._getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this._approval = approval || null;
    this._llm = llm || null;
    this._getContextSize = typeof getContextSize === 'function' ? getContextSize : () => 0;
    /** @type {Map<string, any>} */ this._hosts = new Map();
    /** @type {Map<string, Promise<any>>} */ this._runs = new Map();
    /** @type {Array<{ sessionId: string, req: any }>} */ this._queue = [];
    /** @type {Set<string>} */ this._claims = new Set();
    /** @type {Map<string, { plan: any, lane: 'background'|'foreground', webContentsId: any, scope?: string, tabId?: any }>} */
    this._pendingPlans = new Map();
    this._foreground = null;
    this._inbox = inbox || null;
    this._subagents = new SubagentRunner({
      store, createHost, approval: this._approval, getSettings: getSubagentSettings,
      emitEvent: (sessionId, channel, payload) => this.emitEvent(sessionId, channel, payload),
    });
  }

  /** Background completions go to this inbox (InboxService) from now on. */
  bindInbox(inbox) { this._inbox = inbox || null; }

  /** Source of settings.llm.agent.subagents. */
  setSubagentSettings(getSettings) { this._subagents.setSettingsSource(getSettings); }

  /** Runs a child agent for agent.spawn_subagent; see subagentRunner. */
  spawnSubagent(req) { return this._subagents.spawn(req || {}); }

  /** True when a send would start at once rather than queue. */
  hasCapacity() { return this._queue.length === 0 && this._hosts.size < this.settings().maxConcurrent; }

  settings() { return normalizeSettings(this._getSettings()); }

  emitEvent(sessionId, channel, payload) { this.emit('event', { sessionId, channel, payload: payload === undefined ? {} : payload }); }

  /** Foreground plan proposals and session ids flow through here too. */
  attachForeground(agentService) {
    this._foreground = agentService;
    // The foreground panel's run gets the same per-session tab scoping as a
    // background SessionRun, keyed by whichever session it is running.
    const fg = /** @type {any} */ (agentService);
    if (fg._tabOps && typeof fg._tabOps.forSession === 'function') fg._tabOps = fg._tabOps.forSession(() => agentService.currentSessionId());
    if (fg._tabRegistry && typeof fg._tabRegistry.forSession === 'function') fg._tabRegistry = fg._tabRegistry.forSession(() => agentService.currentSessionId());
    fg._sessionBusy = (sessionId) => this._isBusy(sessionId);
    agentService.on('plan-proposed', (p) => {
      if (p && p.sessionId) this._pendingPlans.set(p.sessionId, { plan: p.plan, lane: 'foreground', webContentsId: p.webContentsId, scope: p.scope, tabId: p.tabId });
    });
  }

  _foregroundSessionId() {
    const fg = this._foreground;
    return fg && fg.isRunning() && typeof fg.currentSessionId === 'function' ? fg.currentSessionId() : null;
  }

  _isBusy(sessionId) {
    return this._claims.has(sessionId) || this._hosts.has(sessionId) || this._subagents.has(sessionId) || this._queue.some((q) => q.sessionId === sessionId) || this._foregroundSessionId() === sessionId;
  }

  /** True while any lane (background, foreground, subagent, a claim) holds the session. */
  isBusy(sessionId) { return this._isBusy(assertSessionId(sessionId)); }

  /**
   * Holds a session for work outside this manager's hosts (a chat-lane answer,
   * a compaction) so no other lane writes to it meanwhile. Throws session_busy
   * when it is already held; every claim must be paired with release().
   */
  claim(sessionId) {
    if (this._isBusy(assertSessionId(sessionId))) throw new Error('session_busy');
    this._claims.add(sessionId);
  }

  release(sessionId) { this._claims.delete(sessionId); }

  /**
   * Starts (or queues) a background turn. Resolves as soon as it is started or queued.
   * @param {{ sessionId?: string|null, text?: string, fromNodeId?: string|null, webContentsId?: number|null, source?: string, title?: string }} req
   */
  send(req) {
    const r = req || {};
    if (r.fromNodeId != null) assertNodeId(r.fromNodeId);
    else if (typeof r.text !== 'string' || !r.text.trim()) throw new Error('text required');
    if (typeof r.text === 'string' && r.text.length > MAX_TEXT) throw new Error('text_too_large');
    if (r.webContentsId != null && !Number.isInteger(r.webContentsId)) throw new Error('invalid_webContentsId');
    let sessionId = r.sessionId;
    if (r.title !== undefined && typeof r.title !== 'string') throw new Error('invalid_title');
    if (sessionId == null) sessionId = this._store.create({ source: r.source || 'agent', title: r.title }).id;
    else if (!this._store.exists(assertSessionId(sessionId))) throw new Error('session_not_found');
    if (this._isBusy(sessionId)) throw new Error('session_busy');
    const run = { sessionId, text: r.text, fromNodeId: r.fromNodeId || null, webContentsId: r.webContentsId == null ? null : r.webContentsId, source: r.source || 'agent' };
    if (this._hosts.size >= this.settings().maxConcurrent) {
      this._queue.push({ sessionId, req: run });
      this.emitEvent(sessionId, 'queued', { position: this._queue.length });
      return { ok: true, sessionId, queued: true };
    }
    this._start(run);
    return { ok: true, sessionId, queued: false };
  }

  _start(req) {
    const { sessionId } = req;
    const host = this._createHost((channel, payload) => this._onHostEvent(sessionId, channel, payload));
    this._hosts.set(sessionId, host);
    const done = Promise.resolve()
      .then(() => host.start(req))
      .catch((err) => {
        // runTurn already emitted task-failed for in-run errors; this reports the rest (bad tab, missing node).
        if (!host._steps || !host._steps.length) this.emitEvent(sessionId, 'start-failed', { error: errText(err) });
        console.error(`[sessionManager] session ${sessionId} run failed:`, errText(err));
        return { ok: false, reason: 'error', error: errText(err) };
      })
      .then((result) => { this._deliverToInbox(req, result); return result; })
      .finally(() => {
        this._hosts.delete(sessionId);
        this._runs.delete(sessionId);
        this._pump();
      });
    this._runs.set(sessionId, done);
  }

  _pump() {
    while (this._queue.length && this._hosts.size < this.settings().maxConcurrent) {
      const next = this._queue.shift();
      this._start(next.req);
    }
  }

  // The run has already finished, so a failed inbox write cannot fail it; it
  // is logged and surfaced on the session's event stream instead.
  _deliverToInbox(req, result) {
    if (!this._inbox || (result && result.reason === 'stopped')) return;
    const { sessionId } = req;
    const ok = !!(result && result.ok);
    let title = '';
    try {
      title = this._store.get(sessionId).meta.title || '';
    } catch (err) {
      console.error(`[sessionManager] title lookup for ${sessionId} failed:`, errText(err));
    }
    if (!title) title = String(req.text || 'Background task').split('\n')[0].trim().slice(0, 120) || 'Background task';
    const detail = ok ? result.summary : (result && (result.summary || result.question || result.error || result.reason)) || 'failed';
    try {
      this._inbox.add({ sessionId, title, summary: String(detail || '').slice(0, INBOX_SUMMARY_MAX), ok, source: req.source || 'agent' });
    } catch (err) {
      console.error(`[sessionManager] inbox delivery for ${sessionId} failed:`, errText(err));
      this.emitEvent(sessionId, 'inbox-failed', { error: errText(err) });
    }
  }

  _onHostEvent(sessionId, channel, payload) {
    if (channel === 'plan-proposed') {
      this._pendingPlans.set(sessionId, { plan: payload.plan, lane: 'background', webContentsId: payload.webContentsId });
    }
    const out = channel === 'task-completed' ? { ...payload, notify: this.settings().notifyOnComplete } : payload;
    this.emitEvent(sessionId, channel, out);
  }

  /** Resolves with the turn result once the session's current run ends (null when idle). */
  settled(sessionId) { return this._runs.get(sessionId) || Promise.resolve(null); }

  stop(sessionId) {
    assertSessionId(sessionId);
    const host = this._hosts.get(sessionId);
    if (host) { host.stopTask(); return { ok: true, state: 'stopping' }; }
    const i = this._queue.findIndex((q) => q.sessionId === sessionId);
    if (i >= 0) {
      this._queue.splice(i, 1);
      this.emitEvent(sessionId, 'dequeued', {});
      return { ok: true, state: 'dequeued' };
    }
    if (this._foregroundSessionId() === sessionId) { this._foreground.stopTask(); return { ok: true, state: 'stopping' }; }
    const child = this._subagents.hostFor(sessionId);
    if (child) { child.stopTask(); return { ok: true, state: 'stopping' }; }
    throw new Error('not_running');
  }

  _hostFor(sessionId) {
    assertSessionId(sessionId);
    const host = this._hosts.get(sessionId) || this._subagents.hostFor(sessionId) || (this._foregroundSessionId() === sessionId ? this._foreground : null);
    if (!host) throw new Error('not_running');
    return host;
  }

  pause(sessionId) { this._hostFor(sessionId).pauseTask(); return { ok: true }; }

  resume(sessionId) { this._hostFor(sessionId).resumeTask(); return { ok: true }; }

  running() {
    const out = [];
    for (const [sessionId, host] of this._hosts) {
      out.push({ sessionId, lane: 'background', state: host._paused ? 'paused' : 'running', task: host._task ? host._task.description : '', startedAt: host.startedAt });
    }
    this._queue.forEach((q, i) => out.push({ sessionId: q.sessionId, lane: 'background', state: 'queued', position: i + 1, task: q.req.text || '' }));
    out.push(...this._subagents.running());
    const fg = this._foregroundSessionId();
    if (fg) out.push({ sessionId: fg, lane: 'foreground', state: this._foreground._paused ? 'paused' : 'running', task: this._foreground._task ? this._foreground._task.description : '' });
    return out;
  }

  /** Drops what this process keeps for a deleted session: its pending plan, permission grants and mode override. */
  forget(sessionId) {
    assertSessionId(sessionId);
    if (this._isBusy(sessionId)) throw new Error('session_busy');
    this._pendingPlans.delete(sessionId);
    if (this._approval) {
      this._approval.clearSession(sessionId);
      this._approval.setSessionMode(sessionId, null);
    }
  }

  pendingPlan(sessionId) { const p = this._pendingPlans.get(assertSessionId(sessionId)); return p ? p.plan : null; }

  /** @param {{ sessionId: string, decision: string, plan?: any }} arg */
  planDecision({ sessionId, decision, plan }) {
    assertSessionId(sessionId);
    if (!['approve', 'approve_auto_edit', 'reject', 'edit'].includes(decision)) throw new Error('invalid_decision');
    const pending = this._pendingPlans.get(sessionId);
    if (!pending) throw new Error('no_pending_plan');
    if (!this._approval) throw new Error('approval_unavailable');
    if (decision === 'reject') {
      this._pendingPlans.delete(sessionId);
      this._approval.setSessionMode(sessionId, 'plan');
      this.emitEvent(sessionId, 'plan-decided', { decision });
      return { ok: true, decision, resumed: false };
    }
    let approved = pending.plan;
    if (decision === 'edit') {
      const n = normalizePlan(plan);
      if (n.error) throw new Error(n.error);
      approved = n.plan;
    }
    if (this._isBusy(sessionId)) throw new Error('session_busy');
    const foreground = pending.lane === 'foreground' && this._foreground;
    if (foreground && this._foreground.isRunning()) throw new Error('agent_busy');
    this._approval.setSessionMode(sessionId, decision === 'approve_auto_edit' ? 'auto-edit' : 'ask');
    this._pendingPlans.delete(sessionId);
    const text = `The user approved the plan${decision === 'edit' ? ' with edits' : ''}. Execute it now, step by step, keeping the todo list current with agent.todo_write.\n\n${planText(approved)}`;
    this.emitEvent(sessionId, 'plan-decided', { decision, plan: approved });
    if (foreground) {
      this._foreground.startTask({ description: text, webContentsId: pending.webContentsId, scope: pending.scope, tabId: pending.tabId, sessionId })
        .catch((err) => {
          console.error(`[sessionManager] plan resume failed for ${sessionId}:`, errText(err));
          this.emitEvent(sessionId, 'start-failed', { error: errText(err) });
        });
      return { ok: true, decision, resumed: true, lane: 'foreground' };
    }
    const sent = this.send({ sessionId, text, webContentsId: pending.webContentsId });
    return { ok: true, decision, resumed: true, lane: 'background', queued: sent.queued };
  }

  contextUsage(sessionId) {
    const msgs = toChatMessages(this._store.getPath(assertSessionId(sessionId)));
    const contextSize = Number(this._getContextSize()) || 0;
    const tokens = countTokens(msgs);
    return { ok: true, tokens, contextSize, ratio: contextSize > 0 ? tokens / contextSize : null, messages: msgs.length };
  }

  /** Summarizes the active path into a compaction node; later turns see only the summary plus what follows it. */
  async compact(sessionId) {
    if (!this._llm) throw new Error('llm_unavailable');
    this.claim(sessionId);
    try { return await this._compact(sessionId); } finally { this.release(sessionId); }
  }

  async _compact(sessionId) {
    const turns = toChatMessages(this._store.getPath(sessionId));
    if (!turns.length) throw new Error('nothing_to_compact');
    const transcript = turns.map((m) => `${m.role}: ${m.content}`).join('\n\n');
    const resp = await this._llm.chatCompletion([{ role: 'system', content: COMPACT_SYSTEM }, { role: 'user', content: transcript }], { maxTokens: COMPACT_MAX_TOKENS, temperature: 0 });
    const summary = String((resp && resp.content) || '').trim();
    if (!summary) throw new Error('empty_summary');
    const node = this._store.append(sessionId, { role: 'system', kind: 'compaction', content: summary, data: { coveredMessages: turns.length } });
    this.emitEvent(sessionId, 'compacted', { nodeId: node.id, coveredMessages: turns.length });
    return { ok: true, nodeId: node.id, coveredMessages: turns.length };
  }
}

module.exports = { SessionManager, normalizeSettings };
