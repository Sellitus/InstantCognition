// SessionStore — the renderer's cache of the one session the Assistant panel
// shows: its tree snapshot (meta, nodes, path, branches), the live plan, the
// pending plan proposal, token usage and which of its approval requests (its
// subagents' included) are still queued (agent:approval-resolved and the
// 'approval-resolved' session event release them). Fed by session:get, by session:event (only the active
// session's), and by foreground agent:* events tagged with its sessionId.
//
// Events: 'session' (active id changed), 'snapshot' (snapshot, {headChanged}),
// 'plan', 'plan-proposed',
// 'plan-decided', 'usage', 'event' ({channel, payload} for the active session's
// session:event stream), 'persist-failed' ({error}).

const EventEmitter = require('events');

const SESSION_ID_RE = /^s_[a-z0-9]{6,32}$/;

const isSessionId = (v) => typeof v === 'string' && SESSION_ID_RE.test(v);

function failure(res, fallback) {
  return new Error((res && res.error) || fallback);
}

class SessionStore extends EventEmitter {
  /**
   * @param {{ ipc?: { invoke: Function, on: Function } }} [opts]
   */
  constructor(opts) {
    super();
    this._ipc = (opts && opts.ipc) || require('electron').ipcRenderer;
    /** @type {string|null} */ this._activeId = null;
    this._snapshot = null;
    this._plan = null;
    this._pendingPlan = null;
    this._usage = null;
    /** @type {string[]} */ this._approvalIds = [];
    /** @type {Set<string>} subagent sessions running under the active one */ this._children = new Set();
    /** @type {{ has: (id: string) => boolean }|null} */ this._approvalQueue = null;
    /** @type {Promise<string|null>|null} */ this._creating = null;
    /** @type {Promise<any>|null} */ this._refreshing = null;
    this._refreshAgain = false;
    this._headChanged = false;
    this._wired = false;
    this._openSeq = 0;
  }

  get activeSessionId() { return this._activeId; }
  get snapshot() { return this._snapshot; }
  get plan() { return this._plan; }
  get pendingPlan() { return this._pendingPlan; }
  get usage() { return this._usage; }

  // ApprovalCard owns the queue and the responses; the store only reports
  // which of the active session's requests it still holds.
  /** @param {{ has: (id: string) => boolean }} queue */
  setApprovalQueue(queue) { this._approvalQueue = queue; }

  approvalState() {
    const q = this._approvalQueue;
    const ids = q ? this._approvalIds.filter((id) => q.has(id)) : [];
    this._approvalIds = ids;
    return { pending: ids.length, requestIds: ids.slice() };
  }

  wire() {
    if (this._wired) return;
    this._wired = true;
    const ipc = this._ipc;
    ipc.on('session:event', (_e, ev) => this.handleSessionEvent(ev));
    ipc.on('session:list-changed', (_e, ev) => this._onListChanged(ev));
    ipc.on('agent:plan-updated', (_e, p) => this.ingest('plan-updated', p));
    ipc.on('agent:plan-proposed', (_e, p) => this.ingest('plan-proposed', p));
    ipc.on('agent:tokens', (_e, p) => this.ingest('agent-tokens', p));
    ipc.on('agent:approval-request', (_e, p) => this.trackApproval(p));
    ipc.on('agent:approval-resolved', (_e, p) => this.releaseApproval(p));
  }

  /** @param {string|null} id */
  setActive(id) {
    const next = id === null || id === undefined ? null : id;
    if (next !== null && !isSessionId(next)) throw new TypeError(`SessionStore: invalid session id ${String(id)}`);
    this._openSeq += 1;
    if (next === this._activeId) return false;
    this._activeId = next;
    this._snapshot = null;
    this._plan = null;
    this._pendingPlan = null;
    this._usage = null;
    this._approvalIds = [];
    this._children = new Set();
    this._creating = null;
    this.emit('session', next);
    return true;
  }

  reset() { this.setActive(null); }

  // A foreground run started without a session gets one from main; the panel
  // adopts it so later turns land in the same tree.
  adopt(id) {
    if (this._activeId || !isSessionId(id)) return false;
    return this.setActive(id);
  }

  // Lazily creates the session on the first send. Resolves the active id, or
  // null when main refused: the turn then runs unpersisted and the failure is
  // reported through 'persist-failed' instead of blocking the user's message.
  /** @returns {Promise<string|null>} */
  ensureSession() {
    if (this._activeId) return Promise.resolve(this._activeId);
    if (this._creating) return this._creating;
    const attempt = Promise.resolve()
      .then(() => this._ipc.invoke('session:create', {}))
      .then((res) => {
        const id = res && res.ok && res.session && res.session.id;
        if (!isSessionId(id)) throw failure(res, 'session_create_failed');
        if (this._creating === attempt) {
          this._creating = null;
          if (!this._activeId) this.setActive(id);
        }
        return this._activeId;
      })
      .catch((err) => {
        if (this._creating === attempt) this._creating = null;
        const error = (err instanceof Error && err.message) || String(err);
        console.error('[SessionStore] session:create failed; this turn is not saved:', error);
        this.emit('persist-failed', { error });
        return null;
      });
    this._creating = attempt;
    return attempt;
  }

  // The session becomes active only once its tree has loaded, so a failed
  // open leaves the shown session in place. Any later open() or setActive()
  // supersedes one still in flight; a superseded open resolves null.
  /** @param {string} id */
  async open(id) {
    if (!isSessionId(id)) throw new TypeError(`SessionStore: invalid session id ${String(id)}`);
    const seq = ++this._openSeq;
    const res = await this._ipc.invoke('session:get', { sessionId: id });
    if (seq !== this._openSeq) return null;
    if (!res || !res.ok || !res.meta) throw failure(res, 'session_get_failed');
    this.setActive(id);
    this.setSnapshot(res);
    return this._snapshot;
  }

  // Overlapping refreshes share one request; a change arriving mid-flight
  // queues exactly one more so the cache ends on the newest tree.
  /** @returns {Promise<any>} resolves the snapshot; rejects when main fails */
  refresh() {
    if (!this._activeId) return Promise.resolve(null);
    if (this._refreshing) { this._refreshAgain = true; return this._refreshing; }
    const id = this._activeId;
    const run = Promise.resolve()
      .then(() => this._ipc.invoke('session:get', { sessionId: id }))
      .then((res) => {
        if (!res || !res.ok || !res.meta) throw failure(res, 'session_get_failed');
        if (this._activeId === id) this.setSnapshot(res);
        return this._snapshot;
      })
      .finally(() => {
        this._refreshing = null;
        if (this._refreshAgain && this._activeId) {
          this._refreshAgain = false;
          this.refresh().catch((err) => this._reportRefreshError(err));
        }
      });
    this._refreshing = run;
    return run;
  }

  setSnapshot(res) {
    if (!res || !res.meta || res.meta.id !== this._activeId) return false;
    this._snapshot = {
      meta: res.meta,
      nodes: Array.isArray(res.nodes) ? res.nodes : [],
      path: Array.isArray(res.path) ? res.path : [],
      branches: res.branches && typeof res.branches === 'object' ? res.branches : {},
      headId: res.meta.headId || null,
    };
    if (res.pendingPlan !== undefined) this._applyPendingPlan(res.pendingPlan);
    // headChanged marks a head move made elsewhere (sessions list, another
    // window), so the panel knows the path it shows may be stale.
    const meta = { headChanged: this._headChanged };
    this._headChanged = false;
    this.emit('snapshot', this._snapshot, meta);
    return true;
  }

  // Re-announced only when the proposal itself changed, so a refresh never
  // throws away edits the user is making to the proposal card.
  _applyPendingPlan(pending) {
    const plan = pending ? (pending.plan || pending) : null;
    const prev = this._pendingPlan ? this._pendingPlan.plan : null;
    if (JSON.stringify(plan) === JSON.stringify(prev)) return;
    if (!plan) {
      this._pendingPlan = null;
      this.emit('plan-decided', { sessionId: this._activeId });
      return;
    }
    this._pendingPlan = { sessionId: (pending && pending.sessionId) || this._activeId, plan };
    this.emit('plan-proposed', this._pendingPlan);
  }

  node(id) {
    const s = this._snapshot;
    return s ? s.nodes.find((n) => n.id === id) || null : null;
  }

  /** The head path as node objects, root first. */
  pathNodes() {
    const s = this._snapshot;
    if (!s) return [];
    const byId = new Map(s.nodes.map((n) => [n.id, n]));
    return s.path.map((id) => byId.get(id)).filter(Boolean);
  }

  branchOf(nodeId) {
    const s = this._snapshot;
    return (s && s.branches && s.branches[nodeId]) || null;
  }

  // An event tagged with another session is not ours; an untagged foreground
  // event belongs to whatever the panel is showing.
  belongs(payload) {
    const sid = payload && payload.sessionId;
    return !sid || sid === this._activeId;
  }

  /** @param {string} sid a subagent session started under the active one */
  isChildSession(sid) { return typeof sid === 'string' && this._children.has(sid); }

  // A subagent's approval requests carry the child's session id but block the
  // active session's run, so they count as the active session's.
  ownsApproval(payload) {
    const sid = payload && payload.sessionId;
    return !!this._activeId && !!sid && (sid === this._activeId || this._children.has(sid));
  }

  /** @returns {boolean} whether the event was applied to the active session */
  ingest(channel, payload) {
    if (!this.belongs(payload)) return false;
    switch (channel) {
      case 'plan-updated':
        this._plan = payload || null;
        this.emit('plan', this._plan);
        return true;
      case 'plan-proposed':
        this._pendingPlan = null;
        this._applyPendingPlan(payload && payload.plan ? { plan: payload.plan, sessionId: payload.sessionId } : null);
        return true;
      case 'plan-decided':
        this._pendingPlan = null;
        this.emit('plan-decided', payload || {});
        return true;
      case 'agent-tokens':
        this._usage = payload || null;
        this.emit('usage', this._usage);
        return true;
      case 'subagent-started': {
        const child = payload && payload.childSessionId;
        if (isSessionId(child)) this._children.add(child);
        return true;
      }
      case 'approval-resolved':
        this.releaseApproval(payload);
        return true;
      case 'subagent-completed': {
        const child = payload && payload.childSessionId;
        if (typeof child === 'string') this._children.delete(child);
        return true;
      }
      default:
        return true;
    }
  }

  // Approval requests are routed by ownership rather than by belongs(): a
  // subagent's request is tagged with the child session.
  trackApproval(payload) {
    const id = payload && payload.requestId;
    if (!this.ownsApproval(payload) || typeof id !== 'string' || this._approvalIds.includes(id)) return false;
    this._approvalIds.push(id);
    return true;
  }

  // Main decided, timed out or cancelled the request; an unknown id is ignored.
  releaseApproval(payload) {
    const i = this._approvalIds.indexOf(payload && payload.requestId);
    if (i < 0) return false;
    this._approvalIds.splice(i, 1);
    return true;
  }

  handleSessionEvent(ev) {
    if (!ev || !this._activeId || ev.sessionId !== this._activeId || typeof ev.channel !== 'string') return false;
    const payload = { ...(ev.payload || {}), sessionId: ev.sessionId };
    this.ingest(ev.channel, payload);
    this.emit('event', { channel: ev.channel, payload });
    return true;
  }

  _onListChanged(ev) {
    if (!ev || !this._activeId || ev.sessionId !== this._activeId) return;
    if (ev.reason === 'deleted') { this.reset(); return; }
    if (ev.reason === 'head') this._headChanged = true;
    this.refresh().catch((err) => this._reportRefreshError(err));
  }

  _reportRefreshError(err) {
    const error = (err instanceof Error && err.message) || String(err);
    console.error('[SessionStore] session:get failed:', error);
    this.emit('persist-failed', { error });
  }
}

module.exports = { SessionStore, isSessionId, SESSION_ID_RE };
