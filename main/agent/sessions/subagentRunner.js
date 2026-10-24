// subagentRunner — child agent runs for agent.spawn_subagent, owned by the
// session manager.
//
//   Fresh context  the child gets its own session (source 'subagent') and a
//                  new host, so its opening prompt holds only the task text.
//   Tools          parent's current filter ∩ requested names; a Plan-mode
//                  parent's child is limited to planSafe tools. The child's
//                  filter also feeds the permission engine's allowed set, so
//                  a tool it was not offered is denied, not just hidden.
//   Depth          a child sits one level below its parent; spawning past
//                  settings.llm.agent.subagents.maxDepth is refused, and the
//                  spawn tool is not offered at the last allowed level.
//   Concurrency    at most subagents.maxConcurrent top-level children run at
//                  once; further spawns wait (abortable) for a free slot. A
//                  nested child runs inside its parent child's slot: the parent
//                  is blocked on the spawn, and waiting for a second slot would
//                  deadlock once every slot is held by a parent.
//   Abort          the parent's run signal stops the child; one deadline covers
//                  the wait for a slot and the run, so the caller always hears
//                  back before its own tool timeout.
//   Result         { ok, summary (≤ 4KB UTF-8), subagentSessionId, ... } —
//                  never the child's messages or tool output.

const { classify } = require('../permissions/toolCatalog');

const SUMMARY_MAX_BYTES = 4096;
const TASK_MAX_CHARS = 20000;
const MAX_STEPS_CAP = 50;
const MAX_TOOL_NAMES = 100;
const DEADLINE_MS = 20 * 60 * 1000;
const PARENT_MODES = new Set(['ask', 'auto-edit', 'plan', 'bypass']);

const errText = (err) => (err instanceof Error && err.message) || String(err);

function intIn(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo ? Math.min(hi, Math.floor(n)) : fallback;
}

function normalizeSubagentSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: s.enabled !== false,
    maxConcurrent: intIn(s.maxConcurrent, 1, 8, 2),
    maxDepth: intIn(s.maxDepth, 0, 3, 1),
    defaultMaxSteps: intIn(s.defaultMaxSteps, 1, MAX_STEPS_CAP, 8),
  };
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
function capBytes(text, maxBytes) {
  const s = String(text == null ? '' : text);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, truncated: false };
  const marker = '\n[truncated]';
  const room = maxBytes - Buffer.byteLength(marker, 'utf8');
  let cut = Buffer.from(s, 'utf8').subarray(0, room).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return { text: cut + marker, truncated: true };
}

function normalizeToolNames(tools) {
  if (tools === undefined || tools === null) return null;
  if (!Array.isArray(tools) || tools.length > MAX_TOOL_NAMES) throw new Error('invalid_tools');
  const names = new Set();
  for (const t of tools) {
    if (typeof t !== 'string' || !t.trim() || t.length > 200) throw new Error('invalid_tools');
    names.add(t.trim());
  }
  return names.size ? names : null;
}

/**
 * @param {{ parentFilter: ((name: string, tool: any) => boolean)|null, requested: Set<string>|null, readOnly: boolean, canSpawn: boolean }} opts
 * @returns {(name: string, tool: any) => boolean}
 */
function childToolFilter({ parentFilter, requested, readOnly, canSpawn }) {
  return (name, tool) => {
    if (name === 'agent.exit_plan') return false;
    if (name === 'agent.spawn_subagent' && !canSpawn) return false;
    if (readOnly && !classify(name).planSafe) return false;
    if (parentFilter && !parentFilter(name, tool)) return false;
    // agent.done stays offered so a narrowed child can still finish.
    return !requested || requested.has(name) || name === 'agent.done';
  };
}

class SubagentRunner {
  /**
   * @param {{ store: any, createHost: (onEvent: (channel: string, payload: any) => void) => any, approval?: any,
   *   getSettings?: () => any, emitEvent: (sessionId: string|null, channel: string, payload: any) => void, deadlineMs?: number }} deps
   */
  constructor({ store, createHost, approval, getSettings, emitEvent, deadlineMs }) {
    this._store = store;
    this._createHost = createHost;
    this._approval = approval || null;
    this._getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this._emitEvent = emitEvent;
    this._deadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : DEADLINE_MS;
    /** @type {Map<string, { host: any, parentSessionId: string|null, depth: number, task: string, startedAt: number }>} */
    this._children = new Map();
    this._active = 0;
    /** @type {Array<{ grant: () => void }>} */
    this._waiters = [];
  }

  setSettingsSource(getSettings) { if (typeof getSettings === 'function') this._getSettings = getSettings; }

  settings() { return normalizeSubagentSettings(this._getSettings()); }

  depthOf(sessionId) { const c = sessionId ? this._children.get(sessionId) : null; return c ? c.depth : 0; }

  has(sessionId) { return this._children.has(sessionId); }

  hostFor(sessionId) { const c = this._children.get(sessionId); return c ? c.host : null; }

  running() {
    return Array.from(this._children, ([sessionId, c]) => ({
      sessionId, lane: 'subagent', parentSessionId: c.parentSessionId, depth: c.depth,
      state: c.host._paused ? 'paused' : 'running', task: c.task, startedAt: c.startedAt,
    }));
  }

  _acquire(signal) {
    if (this._active < this.settings().maxConcurrent) { this._active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => { if (signal) signal.removeEventListener('abort', onAbort); this._active++; resolve(); },
      };
      const onAbort = () => {
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new Error('aborted'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this._waiters.push(waiter);
    });
  }

  _release() {
    this._active--;
    while (this._waiters.length && this._active < this.settings().maxConcurrent) this._waiters.shift().grant();
  }

  /**
   * @param {{ task: any, tools?: any, maxSteps?: any, parentSessionId?: string|null, parentMode?: string|null,
   *   parentFilter?: ((name: string, tool: any) => boolean)|null, signal?: AbortSignal|null }} req
   */
  async spawn(req) {
    const cfg = this.settings();
    if (!cfg.enabled) throw new Error('subagents_disabled');
    const task = typeof req.task === 'string' ? req.task.trim() : '';
    if (!task) throw new Error('task required');
    if (task.length > TASK_MAX_CHARS) throw new Error('task_too_large');
    const requested = normalizeToolNames(req.tools);
    if (req.maxSteps !== undefined && req.maxSteps !== null && (!Number.isFinite(Number(req.maxSteps)) || Number(req.maxSteps) < 1)) throw new Error('invalid_max_steps');
    const maxSteps = req.maxSteps == null ? cfg.defaultMaxSteps : Math.min(MAX_STEPS_CAP, Math.floor(Number(req.maxSteps)));
    const parentSessionId = req.parentSessionId || null;
    const depth = this.depthOf(parentSessionId) + 1;
    if (depth > cfg.maxDepth) throw new Error('subagent_depth_exceeded');
    const parentMode = PARENT_MODES.has(req.parentMode || '') ? req.parentMode : null;
    const readOnly = parentMode === 'plan';
    const signal = req.signal || null;
    if (signal && signal.aborted) throw new Error('aborted');

    let host = null;
    let timedOut = false;
    const stopWait = new AbortController();
    const timer = setTimeout(() => { timedOut = true; stopWait.abort(); if (host) host.stopTask(); }, this._deadlineMs);
    const onParentAbort = () => stopWait.abort();
    if (signal) signal.addEventListener('abort', onParentAbort, { once: true });
    const holdsSlot = depth === 1;
    if (holdsSlot) {
      try { await this._acquire(stopWait.signal); } catch (err) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onParentAbort);
        throw new Error(timedOut ? 'subagent_timeout' : errText(err));
      }
    }
    let childId = null;
    let onAbort = null;
    try {
      childId = this._store.create({ source: 'subagent', title: `Subagent: ${task}` }).id;
      const sid = childId;
      // Plan mode would re-enable agent.exit_plan in the child; read-only is
      // enforced by the tool filter instead, under the stricter Ask mode.
      if (this._approval && parentMode) this._approval.setSessionMode(sid, readOnly ? 'ask' : parentMode);
      host = this._createHost((channel, payload) => {
        this._emitEvent(sid, channel, channel === 'task-completed' ? { ...payload, notify: false } : payload);
      });
      this._children.set(sid, { host, parentSessionId, depth, task, startedAt: Date.now() });
      if (parentSessionId) this._emitEvent(parentSessionId, 'subagent-started', { childSessionId: sid, task, depth, readOnly });
      const run = host;
      onAbort = () => run.stopTask();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (timedOut) host.stopTask();
      const toolFilter = childToolFilter({ parentFilter: req.parentFilter || null, requested, readOnly, canSpawn: depth < cfg.maxDepth });

      let result;
      try {
        result = await run.start({ sessionId: sid, text: task, source: 'subagent', toolFilter, maxSteps });
      } catch (err) {
        result = { ok: false, reason: 'error', error: errText(err) };
      }
      const ok = !!(result && result.ok);
      const raw = ok ? result.summary : (result && (result.summary || result.question || result.error)) || '';
      const capped = capBytes(raw, SUMMARY_MAX_BYTES);
      /** @type {Record<string, any>} */
      const out = { ok, subagentSessionId: sid, summary: capped.text, truncated: capped.truncated };
      if (!ok) out.error = timedOut ? 'subagent_timeout' : signal && signal.aborted ? 'aborted' : (result && result.reason) || 'subagent_failed';
      if (parentSessionId) this._emitEvent(parentSessionId, 'subagent-completed', { childSessionId: sid, ok, error: out.error || null });
      return out;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onParentAbort);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (childId) {
        this._children.delete(childId);
        if (this._approval && parentMode) this._approval.setSessionMode(childId, null);
      }
      if (holdsSlot) this._release();
    }
  }
}

module.exports = { SubagentRunner, normalizeSubagentSettings, childToolFilter, capBytes, SUMMARY_MAX_BYTES };
