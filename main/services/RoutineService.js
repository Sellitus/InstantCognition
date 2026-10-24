// RoutineService — fires scheduled agent Routines.
//
// Reads settings.routines from ConfigService, ticks on an interval, and when a
// routine is due asks the renderer to run it (renderer drives AgentPanel ->
// the isolated agent workspace, so a fresh webContents is minted and the user
// tab bar is never touched — see AgentWorkspaceManager). The renderer reports
// back via 'routine:ran' so lastRunAt is only advanced on a real completion.
//
// Renderer dispatch runs one routine at a time (the foreground agent is
// single-flight): if the agent is busy or a dispatch is pending, the tick is a
// no-op and retries on the next tick. The window keeps running un-throttled while hidden via the
// global hotkey (backgroundThrottling:false; hide != minimize), so scheduled
// runs work even when the app is "closed" to the tray.
//
// Background mode (settings.routines.runInBackground, with a session manager
// bound): a due routine starts as a background session (source 'routine')
// that runs beside the foreground agent, and its result lands in the inbox
// (the session manager files it; a session that could not even start is
// filed here as ok:false). Each routine tracks its own run, so one waiting
// on an approval holds back only itself; the manager's capacity bounds how
// many run at once, and at capacity a due routine stays due for the next
// tick. A failed run is retried after
// FAILURE_BACKOFF_MS rather than on every tick, so a broken routine cannot
// flood the inbox.
//
// Time/IO are injectable (_setNow, bind) and _tickOnce()/_pending/_running are
// test seams, so the scheduler is verified without real timers.

const { isDue } = require('../../shared/routineSchema');

const DEFAULT_TICK_MS = 30000;
const FIRST_TICK_MS = 6000;       // let the renderer mount before first fire
const PENDING_TIMEOUT_MS = 900000; // 15 min: a stranded dispatch is retried
const FAILURE_BACKOFF_MS = 300000; // 5 min before a failed background run retries
const RETRY_REASONS = new Set(['error', 'hook_error']);

class RoutineService {
  constructor() {
    this._configService = null;
    this._agentService = null;
    this._sessionManager = null;
    this._inbox = null;
    this._failedAt = new Map(); // routine id -> time of its last failed background run
    this._window = null;
    this._timer = null;
    this._firstTimer = null;
    this._pending = null; // { id, at } — the renderer dispatch in flight
    this._running = new Map(); // background routine id -> { at, sessionId }
    this._tickMs = DEFAULT_TICK_MS;
    this._now = () => Date.now();
    this._paused = false; // visibilityThrottling-driven; pauses _tick
  }

  bind(deps = {}) {
    const { configService, agentService, sessionManager, inboxService } = /** @type {any} */ (deps);
    if (configService) this._configService = configService;
    if (agentService) this._agentService = agentService;
    if (sessionManager) this._sessionManager = sessionManager;
    if (inboxService) this._inbox = inboxService;
  }

  start(mainWindow, opts = {}) {
    this._window = mainWindow || this._window;
    if (Number.isFinite(opts.tickMs)) this._tickMs = opts.tickMs;
    this.stop();
    this._firstTimer = setTimeout(() => { this._firstTimer = null; this._tick(); }, FIRST_TICK_MS);
    this._timer = setInterval(() => this._tick(), this._tickMs);
    if (typeof this._visibilityUnsub !== 'function') {
      try {
        const vis = require('./visibilityThrottling');
        if (vis && typeof vis.onSuspend === 'function' && typeof vis.onResume === 'function') {
          const offSuspend = vis.onSuspend(() => { this._paused = true; });
          const offResume = vis.onResume(() => { this._paused = false; this._tick(); });
          this._visibilityUnsub = () => { offSuspend(); offResume(); };
        }
      } catch (_) { /* visibility hooks optional */ }
    }
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._firstTimer) { clearTimeout(this._firstTimer); this._firstTimer = null; }
  }

  _items() {
    if (!this._configService) return [];
    const list = this._configService.get('settings.routines.items', []);
    return Array.isArray(list) ? list : [];
  }

  _enabledGlobally() {
    if (!this._configService) return false;
    return this._configService.get('settings.routines.enabled', true) !== false;
  }

  _agentBusy() {
    return !!(this._agentService && typeof this._agentService.isRunning === 'function' && this._agentService.isRunning());
  }

  _background() {
    if (!this._sessionManager || !this._inbox || !this._configService) return false;
    return this._configService.get('settings.routines.runInBackground', true) !== false;
  }

  _backingOff(routine, now) {
    const at = this._failedAt.get(routine.id);
    return at !== undefined && now - at < FAILURE_BACKOFF_MS;
  }

  _canSend() {
    const w = this._window;
    return !!(w && w.webContents && (typeof w.isDestroyed !== 'function' || !w.isDestroyed()));
  }

  _tick() {
    const now = this._now();
    if (this._paused) return; // skip while hidden — resume fires a tick immediately
    if (this._pending) {
      if (now - this._pending.at > PENDING_TIMEOUT_MS) this._pending = null; // stranded — let it retry
      else return;
    }
    if (!this._enabledGlobally()) return;
    if (this._background()) {
      if (!this._sessionManager.hasCapacity()) return; // at capacity: stays due, retried next tick
      const due = this._items().find((r) => r && isDue(r, now) && !this._running.has(r.id) && !this._backingOff(r, now));
      // No caller above a timer tick: a failure to even file the result is logged here.
      if (due) { try { this._startBackground(due); } catch (err) { console.error(`[RoutineService] routine ${due.id} failed:`, (err instanceof Error && err.message) || err); } }
      return;
    }
    if (!this._canSend() || this._agentBusy()) return;
    const due = this._items().find((r) => r && isDue(r, now));
    if (!due) return;
    this._dispatch(due);
  }

  _startBackground(routine) {
    const name = String(routine.name || routine.id);
    let started;
    try {
      started = this._sessionManager.send({ text: String(routine.task || ''), source: 'routine', title: name });
    } catch (err) {
      const error = (err instanceof Error && err.message) || String(err);
      console.error(`[RoutineService] routine ${routine.id} could not start:`, error);
      this._failedAt.set(routine.id, this._now());
      this._inbox.add({ sessionId: null, title: name, summary: `Routine could not start: ${error}`, ok: false, source: 'routine' });
      return { ok: false, error };
    }
    this._running.set(routine.id, { at: this._now(), sessionId: started.sessionId });
    this._sessionManager.settled(started.sessionId).then((result) => {
      // Only an errored run retries after the backoff; any other end (stopped, out of
      // steps, waiting on the user) is this period's run, or it would refire every backoff.
      const errored = !result || RETRY_REASONS.has(result.reason);
      if (errored) this._failedAt.set(routine.id, this._now());
      else this._failedAt.delete(routine.id);
      this.noteRan({ id: routine.id, ok: !errored });
    }).catch((err) => {
      console.error(`[RoutineService] routine ${routine.id} settle failed:`, (err instanceof Error && err.message) || err);
      this._failedAt.set(routine.id, this._now());
      this.noteRan({ id: routine.id, ok: false });
    });
    return { ok: true, sessionId: started.sessionId };
  }

  _dispatch(routine) {
    this._pending = { id: routine.id, at: this._now() };
    try {
      this._window.webContents.send('routine:run', {
        id: routine.id,
        name: routine.name || routine.id,
        task: routine.task || '',
      });
    } catch (_) {
      this._pending = null; // send failed — retry next tick
    }
  }

  // The renderer (or _startBackground) reports here once the routine's run ends.
  // ok advances lastRunAt; ok:false only clears the run so a later tick retries.
  noteRan(report = {}) {
    const { id, ok } = /** @type {any} */ (report);
    if (this._running.has(id)) this._running.delete(id);
    else if (this._pending && this._pending.id === id) this._pending = null;
    else return;
    if (!ok || !this._configService) return;
    const now = this._now();
    const items = this._items().map((r) => (r && r.id === id ? { ...r, lastRunAt: now } : r));
    this._configService.set('settings.routines.items', items);
  }

  // Manual "Run now" from the settings UI.
  runNow(id) {
    const routine = this._items().find((r) => r && r.id === id);
    if (!routine) return { ok: false, error: 'not_found' };
    if (this._background()) {
      if (this._running.has(id) || !this._sessionManager.hasCapacity()) return { ok: false, error: 'busy' };
      return this._startBackground(routine);
    }
    if (this._pending || this._agentBusy()) return { ok: false, error: 'busy' };
    if (!this._canSend()) return { ok: false, error: 'no_window' };
    this._dispatch(routine);
    return { ok: true };
  }

  // ── Test seams ─────────────────────────────────────────────────────────────
  _setNow(fn) { if (typeof fn === 'function') this._now = fn; }
  _tickOnce() { this._tick(); }
}

const instance = new RoutineService();
module.exports = instance;
module.exports.RoutineService = RoutineService;
