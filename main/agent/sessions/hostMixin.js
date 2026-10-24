// AgentHost — the run-control surface shared by every agent host: the
// foreground AgentService and each background SessionRun. runTurn() drives a
// host through these fields, so both kinds of host keep identical names
// (_running, _paused, _resumePromise, _abort, _task, _steps, _toolCtx, …).

const EventEmitter = require('events');
const { attachOrphanListener } = require('../lifecycleHooks');
const { isVisionEnabled } = require('../visionDetection');
const browserTools = require('../tools/browser');
const cdpTools = require('../tools/cdpTools');
const sessionService = require('../../services/SessionService');

// Agents never read, act on or screenshot a page in the private browsing session.
const PRIVATE_TAB_REFUSAL = "The agent doesn't run in private tabs";

// browser.js tools resolve "the active tab" among agent tabs only; every other
// browser.* tool uses the cdpTools rule. The permission URL must follow the
// same rule as the tool's own target or a per-origin deny can be sidestepped.
const AGENT_TAB_TOOLS = new Set(browserTools.map((t) => t.name));

function pageUrl(wc) {
  if (!wc || typeof wc.getURL !== 'function') return '';
  if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return '';
  return wc.getURL();
}

class AgentHost extends EventEmitter {
  constructor() {
    super();
    /** @type {any} */ this._task = null;
    /** @type {any[]} */ this._steps = [];
    /** @type {any} */ this._toolCtx = null;
    /** @type {any} */ this._currentLog = null;
    /** @type {any} */ this._webContentsModule = null;
    /** @type {any} */ this._llmService = null;
    /** @type {any} */ this._resumePromise = null;
    /** @type {any} */ this._resumeResolver = null;
    /** @type {AbortController|null} */ this._abort = null;
    /** @type {string|null} */ this._sessionId = null;
    /** @type {(() => void)|null} */ this._orphanDetach = null;
    this._running = false;
    this._stopRequested = false;
    this._paused = false;
  }

  pauseTask() {
    if (!this._running || this._paused) return;
    this._paused = true;
    this._resumePromise = new Promise((r) => { this._resumeResolver = r; });
    this.emit('task-paused', { task: this._task });
  }

  resumeTask() {
    if (!this._paused) return;
    this._paused = false;
    if (this._resumeResolver) this._resumeResolver();
    this._resumeResolver = null; this._resumePromise = null;
    this.emit('task-resumed', { task: this._task });
  }

  // Also rejects this run's open approval prompts, so their cards close and
  // the loop is not left waiting on a decision nobody will make, and settles a
  // pause, so a run parked in beforeStep wakes up and sees the abort.
  stopTask() {
    this._stopRequested = true;
    if (this._abort) this._abort.abort();
    if (this._resumeResolver) this._resumeResolver();
    this._paused = false; this._resumeResolver = null; this._resumePromise = null;
    // Subclasses own _approval (AgentService's service, SessionRun's bounded proxy).
    const approval = /** @type {any} */ (this)._approval;
    if (this._running && approval && typeof approval.cancelSession === 'function') approval.cancelSession(this._sessionId || null, 'stopped');
  }

  // Re-bind the task to a different tab after orphan (original tab closed).
  reattachTask({ webContentsId }) {
    if (!this._running) return { ok: false, error: 'not_running' };
    const wc = this._resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: 'webContents not found' };
    if (this._isPrivateTab(wc)) return { ok: false, error: PRIVATE_TAB_REFUSAL };
    this._task = { ...this._task, webContentsId };
    if (this._toolCtx) {
      this._toolCtx.defaultWebContents = wc;
      this._watchTab(wc);
    }
    this.emit('task-reattached', { webContentsId });
    this.resumeTask();
    return { ok: true };
  }

  /** Orphan detection follows the run's current tab only; null wc just detaches. */
  _watchTab(wc) {
    if (this._orphanDetach) this._orphanDetach();
    this._orphanDetach = wc ? attachOrphanListener({ wc, service: this }) : null;
  }

  _isPrivateTab(wc) { return sessionService.isPrivateContents(wc); }

  _resolveWebContents(id) {
    if (id == null) return null;
    if (this._webContentsModule && typeof this._webContentsModule.fromId === 'function') return this._webContentsModule.fromId(id);
    try { return require('electron').webContents.fromId(id); } catch (_) { return null; }
  }

  isRunning() { return this._running; }
  getSteps() { return [...this._steps]; }
  /** Session the in-flight (or last) run persists to; null when unpersisted. */
  currentSessionId() { return this._sessionId; }

  _visionEnabled() {
    const self = /** @type {any} */ (this);
    return isVisionEnabled({ getVisionConfig: self._getVisionConfig, llmService: this._llmService, getActiveModel: self._getActiveModel });
  }

  _recordBudget(reason, usage, budget) {
    if (this._currentLog) this._currentLog.logBudget({ reason, usage, budget });
    this.emit('budget-breach', { reason, usage, budget });
    return true;
  }

  _currentUrl() { return pageUrl(this._task && this._resolveWebContents(this._task.webContentsId)); }

  /** URL of the page `call` will act on, for per-origin permission rules. */
  _urlForCall(call) {
    const ctx = this._toolCtx;
    const name = call && typeof call.name === 'string' ? call.name : '';
    if (!ctx || !name.startsWith('browser.')) return this._currentUrl();
    const spaceId = call.args && typeof call.args.spaceId === 'string' ? call.args.spaceId : undefined;
    const resolve = AGENT_TAB_TOOLS.has(name) ? browserTools.activeWc : cdpTools.activeWc;
    return pageUrl(resolve(ctx, spaceId));
  }

  _onRuntimeEvent(channel, payload) {
    if (channel === 'step-planned') this._steps.push({ kind: 'planned', ...payload });
    if (channel === 'step-acted') this._steps.push({ kind: 'acted', ...payload });
    this.emit(channel, payload);
  }
}

module.exports = { AgentHost, PRIVATE_TAB_REFUSAL };
