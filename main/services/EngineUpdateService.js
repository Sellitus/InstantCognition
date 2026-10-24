// EngineUpdateService — keeps the local inference runtimes current.
//
// The app ships a llama-server build and MLX / oMLX python runtimes frozen at
// build time; vLLM is installed on demand. llama.cpp cuts several builds a day
// and the python runtimes release weekly, so a bundled copy is stale within
// weeks of a release. This checks once a day
// and installs only when the user asks — a runtime download is tens of megabytes
// and replaces an executable the app spawns, so it never happens behind their
// back. Background results stay quiet unless they concern the selected local
// engine: the startup check, or the first send after a later check, offers
// that one update once per version (llm/engineUpdatePrompt.js).
//
// Installs land in userData (see llm/enginePaths.js), each llama.cpp build in
// its own directory, so an install cannot overwrite a binary a running server
// holds open and the bundled copy stays as a fallback. Per-runtime check and
// install logic lives in llm/engines/; this holds the policy.

const { errMsg } = require('../../shared/errMsg');
const discovery = require('./EngineDiscoveryService');
const { supportedEngines, getEngine } = require('./llm/engines');
const { selectedEngine, promptFor, engineForBackend } = require('./llm/engineUpdatePrompt');
const { releasePinnedPath, repointStartOpts, canRestart, restartOnNewRuntime } = require('./llm/engineRestart');

const FIRST_CHECK_MS = 60000;              // after the window has settled
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHANNEL = 'engine-updater:result';

class EngineUpdateService {
  constructor() {
    this._window = null;
    this._configService = null;
    this._timer = null;
    this._interval = null;
    this._busy = false;
    this._latest = /** @type {Record<string, any>} */ ({});
    this._lastEngines = null;
    this._deps = /** @type {{llmService?: any, chatStream?: any, userMemory?: any}} */ ({});
  }

  /**
   * @param {Electron.BrowserWindow|null} mainWindow
   * @param {any} configService
   * @param {{llmService?: any, chatStream?: any, userMemory?: any}} [deps] engine
   *   status, and the engine users a restart waits on
   */
  initialize(mainWindow, configService, deps = {}) {
    this._window = mainWindow || null;
    this._configService = configService || null;
    this._deps = deps || {};
    this.stop();
    if (!this._enabled()) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.check({ background: true, startup: true });
      this._interval = setInterval(() => this.check({ background: true }), CHECK_INTERVAL_MS);
      if (typeof this._interval.unref === 'function') this._interval.unref();
    }, FIRST_CHECK_MS);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  _enabled() {
    if (!this._configService) return true;
    return this._configService.get('settings.llm.engineAutoCheck', true) !== false;
  }

  /** @returns {boolean} whether the renderer was reached */
  _send(payload) {
    const w = this._window;
    if (!w || (typeof w.isDestroyed === 'function' && w.isDestroyed()) || !w.webContents) return false;
    try {
      w.webContents.send(CHANNEL, payload);
      return true;
    } catch (err) {
      console.warn('[engine-update] result not delivered:', errMsg(err));
      return false;
    }
  }

  /**
   * Report what is installed and what is available for each runtime.
   * @param {{background?: boolean, startup?: boolean}} [opts] a manual check
   *   always answers; a background one only records, except that the startup
   *   check offers the selected engine's update.
   */
  async check({ background = false, startup = false } = {}) {
    if (!background) this._send({ ok: true, status: 'checking' });
    const engines = /** @type {any[]} */ ([]);
    for (const adapter of supportedEngines(process.platform)) {
      try {
        const info = await adapter.check(this._ctx());
        if (info) engines.push(info);
      } catch (err) {
        const message = errMsg(err) || 'Engine update check failed.';
        console.warn(`[engine-update] ${adapter.id} check failed:`, message);
        if (!background) engines.push({ engine: adapter.id, ok: false, name: adapter.name, error: message });
      }
    }
    this._lastEngines = engines;
    if (!background) {
      const available = engines.some((e) => e.updateAvailable);
      // Seen here, the selected engine's update is not offered again on the next send.
      const shown = promptFor({ engines, prompted: null, engine: this._selected() });
      if (shown && this._configService) this._configService.set(`settings.llm.engineUpdatePrompted.${shown.engine}`, shown.latest);
      this._send({ ok: true, status: available ? 'available' : 'up-to-date', engines, liveEngine: this._liveEngine() });
    } else if (startup) {
      this.offerSelected();
    }
    return engines;
  }

  /**
   * Offer the selected local engine's pending update, once per version.
   * @returns {boolean} whether a prompt was sent
   */
  offerSelected() {
    const cfg = this._configService;
    const engine = this._selected();
    const prompted = cfg ? cfg.get('settings.llm.engineUpdatePrompted', {}) : {};
    const row = promptFor({ engines: this._lastEngines, prompted, engine });
    if (!row) return false;
    // Recorded only once shown, so a window mid-reload does not lose the offer.
    if (!this._send({ ok: true, status: 'available', engines: [row], liveEngine: this._liveEngine() })) return false;
    if (cfg) cfg.set(`settings.llm.engineUpdatePrompted.${engine}`, row.latest);
    return true;
  }

  _selected() {
    const cfg = this._configService;
    const llm = this._deps.llmService;
    return selectedEngine(llm ? llm.getStatus() : null, cfg ? cfg.get('settings.llm', {}) : null);
  }

  // The runtime Update + Restart would reload, or null when none can be.
  _liveEngine() {
    const llm = this._deps.llmService;
    const s = llm ? llm.getStatus() : null;
    const engine = s && !s.isRemote ? engineForBackend(s.backend) : null;
    return canRestart({ engine, llmService: llm, discovery }) ? engine : null;
  }

  _ctx() {
    return { latest: this._latest, send: (payload) => this._send(payload) };
  }

  /**
   * Install the newest build of one runtime. Progress and the outcome go to the
   * renderer on CHANNEL; the returned value is for the IPC caller.
   * @param {string} engine an id from llm/engines
   * @param {{restart?: boolean}} [opts] restart the running engine on the new
   *   runtime once it is idle
   */
  async install(engine, { restart = false } = {}) {
    const adapter = getEngine(engine);
    if (!adapter || !adapter.supported(process.platform)) return { ok: false, error: `Unknown engine: ${engine}` };
    if (this._busy) return { ok: false, error: 'An engine install is already running.' };
    this._busy = true;
    const id = /** @type {'llamaCpp'|'mlx'|'omlx'|'vllm'} */ (adapter.id);
    try {
      const version = await adapter.install(this._ctx());
      discovery.clearCache();
      releasePinnedPath(this._configService, discovery, id);
      await repointStartOpts({ engine: id, llmService: this._deps.llmService, discovery });
      // The last check's row is now stale; it must not be offered again.
      const row = (this._lastEngines || []).find((e) => e && e.engine === engine);
      if (row) row.updateAvailable = false;
      const pendingRestart = restart && this._liveEngine() === engine;
      this._send({ ok: true, status: 'installed', engine, version, pendingRestart });
      if (pendingRestart) await this._restart(engine, version);
      return { ok: true, version };
    } catch (err) {
      const message = errMsg(err) || 'Engine install failed.';
      this._send({ ok: false, status: 'error', engine, error: message });
      return { ok: false, error: message };
    } finally {
      this._busy = false;
    }
  }

  async _restart(engine, version) {
    try {
      const { llmService, chatStream, userMemory } = this._deps;
      const isBusy = () => !!(chatStream && chatStream.isBusy()) || !!(userMemory && userMemory.isCapturing());
      const r = await restartOnNewRuntime({ engine, discovery, configService: this._configService, llmService, isBusy });
      if (r.restarted) this._send({ ok: true, status: 'restarted', engine, version, model: r.model });
      else this._send({ ok: true, status: 'installed', engine, version, pendingRestart: false });
    } catch (err) {
      this._send({ ok: false, status: 'error', phase: 'restart', engine, error: errMsg(err) || 'Engine restart failed.' });
    }
  }
}

const instance = new EngineUpdateService();
module.exports = instance;
module.exports.EngineUpdateService = EngineUpdateService;
