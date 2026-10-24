// LLMManager — owns the lifecycle of a single local inference server
// (llama.cpp, mlx-openai-server, oMLX or vLLM). Manages spawn, health polling, status, and
// restart-with-fallback. llmFallback.js reads _loadVerified/_fallbackChain/
// _backend/_lastStartOpts directly, so that surface is part of the contract.
// Exposes the singleton so the legacy `require('./services/LLMService')`
// shim can re-export it.

const EventEmitter = require('events');
const { spawn } = require('child_process');
const http = require('http');
const { BACKEND_COMMAND_BUILDERS, isMlxBackend, isPythonBackend } = require('../../../shared/llmDefaults');
const { startWithFallback, recoverFromMlxStreamCrash } = require('../llmFallback');
const { pauseForVisibility, resumeFromVisibility } = require('./llmVisibility');
const { prepareLaunch, spawnSpec, healthSpec, afterHealthy, stopProcess } = require('./backendRuntime');

const LOG_RING_MAX = 200;
const HEALTH_POLL_INTERVAL_MS = 1000;
const RESTART_BASE_DELAY_MS = 1000;
const MAX_RESTART_ATTEMPTS = 3;

class LLMManager extends EventEmitter {
  constructor() {
    super();
    // Process state — llmFallback.js reads _loadVerified/_fallbackChain/_backend/_lastStartOpts directly.
    // Direct field assignment (not Object.assign) so TypeScript infers each property on the class.
    this._proc = null; this._restartTimer = null; this._status = 'stopped'; this._backend = null;
    this._originalBackend = null; this._fallbackChain = []; this._loadVerified = false;
    this._modelPath = null; this._mmprojPath = null; this._modelType = null; this._port = null;
    this._host = '127.0.0.1'; this._endpoint = null; this._remote = null; this._logs = [];
    this._restartCount = 0; this._lastError = null; this._intentionalStop = false;
    this._spawnFn = spawn; this._httpGet = null; this._httpPost = undefined; this._apiModel = null;
    this._pauseSnapshot = null;
    this._reloading = null;
    this.on('error', () => {}); // floor listener — no-op if no UI listener attached
  }

  // For tests
  _setSpawn(fn) { this._spawnFn = fn; }
  _setHttpGet(fn) { this._httpGet = fn; }
  _setHttpPost(fn) { this._httpPost = fn; }

  getStatus() {
    return {
      status: this._status,
      backend: this._backend,
      originalBackend: this._originalBackend,
      model: this._modelPath,
      apiModel: this._apiModel, // the id requests must send when the server checks it (oMLX, vLLM); null otherwise
      mmprojPath: this._mmprojPath,
      modelType: this._modelType,
      // True when the running server has a vision projector (llama.cpp) or is a
      // multimodal MLX model / remote endpoint with vision. AgentService uses
      // this to gate vision tools.
      visionCapable: !!this._mmprojPath || this._modelType === 'multimodal' || !!(this._remote && this._remote.visionCapable),
      endpoint: this.getEndpoint(),
      port: this._port,
      host: this._host,
      restartCount: this._restartCount,
      lastError: this._lastError,
      isRemote: !this._liveLocalActive() && !!this._remote, // true only when the remote actually serves traffic (see _liveLocalActive comment) — AgentService tool-format forcing and AgentPanel's engine button label read this; it must agree with getEndpoint(), or they'd describe a different server than the one answering requests.
    };
  }

  // Live local engine outranks the merely-configured remote (dual state is reachable: "Use Remote" → mode Local → Start, and llm:start never clears it) so traffic can't silently go to a paid endpoint while UI shows the local server active. Pinned in LLMService.test.js ("dual state").
  _liveLocalActive() { return (this._status === 'running' || this._status === 'starting') && !!this._proc; }
  getEndpoint() { if (this._liveLocalActive()) return `http://${this._host}:${this._port}`;
    if (this._remote) return this._remote.endpoint;
    return null; }

  getLogs() { return [...this._logs]; }

  setRemoteEndpoint(endpoint, apiKey, model, visionCapable) {
    if (!endpoint) { this._remote = null; return; }
    // Normalize: strip trailing slashes and a trailing /v1 so callers can
    // paste either form (`https://api.openai.com` or `https://api.openai.com/v1`).
    // Both work — the client appends /v1/<endpoint> internally.
    const normalized = String(endpoint).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
    this._remote = { endpoint: normalized, apiKey: apiKey || '', model: model || '', visionCapable: !!visionCapable };
    this._backend = 'remote';
    this._setStatus('running');
    this.emit('endpoint-changed', this.getEndpoint());
  }

  clearRemoteEndpoint() {
    this._remote = null;
    if (!this._proc) this._setStatus('stopped');
    this.emit('endpoint-changed', this.getEndpoint());
  }

  // Start a local LLM child process. opts: {backend, binaryPath|pythonPath, modelPath, port, host?, fallbackChain?}.
  // fallbackChain: ordered list of {backend, opts} to try on load failure.
  // A start that arrives during a reload waits for it, then keeps the reloaded
  // server when it already runs that model and replaces it otherwise.
  async start(opts) {
    if (this._reloading) {
      await Promise.allSettled([this._reloading]);
      const cur = this._lastStartOpts;
      if (this._proc && opts && cur && cur.backend === opts.backend && cur.modelPath === opts.modelPath) return this.getStatus();
      if (this._proc) await this.stop({ silent: true });
    }
    return this._start(opts);
  }

  // Swap the server for one started with `opts`. The old process's exit
  // reports 'stopped' before the new one spawns, which is when a user would
  // press Start; the reload holds the slot so that start waits instead of
  // racing it for the port.
  async reload(opts) {
    if (this._reloading) throw new Error('LLM server is already reloading');
    const run = (async () => { await this.stop({ silent: true }); return this._start(opts); })();
    this._reloading = run;
    try { return await run; } finally { this._reloading = null; }
  }

  async _start(opts) {
    if (this._proc) throw new Error('LLM server already running');
    if (!opts) throw new Error('opts required');
    const backend = opts.backend || 'llamaCpp';
    if (!BACKEND_COMMAND_BUILDERS[backend]) throw new Error(`unsupported backend: ${backend}`);
    if (backend === 'llamaCpp' && !opts.binaryPath) throw new Error('binaryPath required');
    if (isPythonBackend(backend) && !opts.pythonPath) throw new Error('pythonPath required');
    if (!opts.modelPath) throw new Error('modelPath required');
    if (!opts.port) throw new Error('port required');

    this._intentionalStop = false;
    this._restartCount = 0;
    this._lastError = null;
    this._backend = backend;
    this._originalBackend = backend;
    this._fallbackChain = Array.isArray(opts.fallbackChain) ? [...opts.fallbackChain] : [];
    this._modelPath = opts.modelPath;
    this._mmprojPath = opts.mmprojPath || null;
    this._modelType = opts.modelType || (isMlxBackend(backend) ? 'lm' : null);
    this._port = opts.port;
    this._host = opts.host || '127.0.0.1';
    this._lastStartOpts = { ...opts };

    return startWithFallback(this, opts);
  }

  // Auto-recover from the mlx Stream(gpu, N) in-current-thread crash. See
  // recoverFromMlxStreamCrash in llmFallback.js for the two-stage strategy.
  async restartAsTextOnly() { return recoverFromMlxStreamCrash(this); }

  async _spawnAndWait(opts) {
    this._setStatus('starting');
    let proc;
    try {
      const { opts: launch, apiModel } = prepareLaunch(this._backend, { ...opts, host: this._host });
      this._apiModel = apiModel;
      const built = BACKEND_COMMAND_BUILDERS[this._backend](launch);
      const { command, args, options } = spawnSpec(this._backend, built.command, built.args);
      this._appendLog('info', `Starting ${this._backend}: ${command} ${args.join(' ')}`);
      proc = this._spawnFn(command, args, options);
    } catch (err) {
      const msg = (err instanceof Error && err.message) || String(err);
      this._lastError = msg;
      this._setStatus('error');
      this._appendLog('error', `spawn failed: ${msg}`);
      throw err;
    }
    this._proc = proc;

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => this._appendLog('stdout', chunk.toString()));
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => this._appendLog('stderr', chunk.toString()));
    }
    proc.on('error', (err) => {
      const msg = (err instanceof Error && err.message) || String(err);
      this._lastError = msg;
      this._appendLog('error', `process error: ${msg}`);
      this.emit('error', err);
    });
    proc.on('exit', (code, signal) => {
      this._appendLog('info', `process exited code=${code} signal=${signal}`);
      this._proc = null;
      const wasRunning = this._status === 'running' || this._status === 'starting';
      if (this._intentionalStop || code === 0) {
        this._setStatus('stopped');
        return;
      }
      // Only retry the same args for mid-session crashes (load already verified).
      // Pre-health crashes propagate to startWithFallback, which tries the next
      // backend if a fallback chain was provided.
      if (wasRunning && this._loadVerified && this._restartCount < MAX_RESTART_ATTEMPTS) {
        this._restartCount += 1;
        const delay = RESTART_BASE_DELAY_MS * Math.pow(2, this._restartCount - 1);
        this._appendLog('warn', `restarting in ${delay}ms (attempt ${this._restartCount}/${MAX_RESTART_ATTEMPTS})`);
        this._restartTimer = setTimeout(() => {
          this._restartTimer = null;
          this._spawnAndWait(opts).catch((err) => {
            this._lastError = (err instanceof Error && err.message) || String(err);
            if (!this._intentionalStop) this._setStatus('error');
          });
        }, delay);
      } else {
        this._setStatus('error');
      }
    });

    try {
      await this._waitForHealthy();
      this._setStatus('running');
      this.emit('model-loaded', { model: this._modelPath, endpoint: this.getEndpoint() });
      return this.getStatus();
    } catch (err) {
      const msg = (err instanceof Error && err.message) || String(err);
      this._lastError = msg;
      // Await the stop so A is fully torn down before the rejection reaches
      // startWithFallback — otherwise the late stop() races fallback B's spawn.
      // Set 'error' after: the proc's exit handler routes the intentional stop
      // to 'stopped', which would otherwise mask the failure.
      await this.stop({ silent: true });
      this._setStatus('error');
      throw err;
    }
  }

  // The health path and timeout come from the backend's schema entry; a load
  // check that fails after health (oMLX) still counts as a load-time failure.
  async _waitForHealthy() {
    const { path: healthPath, timeoutMs } = healthSpec(this._backend);
    for (let i = 0; i < Math.ceil(timeoutMs / HEALTH_POLL_INTERVAL_MS); i++) {
      if (!this._proc) throw new Error('process exited before becoming healthy');
      if (await this._healthCheck(healthPath)) {
        await afterHealthy(this._backend, { host: this._host, port: this._port, apiModel: this._apiModel }, this._httpPost);
        this._loadVerified = true;
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }
    throw new Error(`health check timeout after ${Math.round(timeoutMs / 1000)}s`);
  }

  _healthCheck(healthPath = '/v1/models') {
    return new Promise((resolve) => {
      if (this._httpGet) { // test injection
        Promise.resolve(this._httpGet(`http://${this._host}:${this._port}${healthPath}`))
          .then((ok) => resolve(!!ok)).catch(() => resolve(false));
        return;
      }
      const req = http.get({ host: this._host, port: this._port, path: healthPath, timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  async stop({ silent = false } = {}) {
    this._intentionalStop = true;
    // Wipes any pending visibility-pause snapshot — a manual stop is a real
    // "I don't want this running" signal, not a deferral.
    this._pauseSnapshot = null;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    const proc = this._proc;
    if (!proc) {
      if (!silent) this._setStatus('stopped');
      return;
    }
    for (const failure of await stopProcess(this._backend, proc)) this._appendLog('warn', failure);
    // A stale capture (a stop racing a respawn) must not null a newer proc.
    if (this._proc === proc) this._proc = null;
    if (!silent) this._setStatus('stopped');
  }

  // Park the local subprocess while the window is hidden. See llmVisibility.js.
  pauseForVisibility() { pauseForVisibility(this); }

  async resumeFromVisibility() { await resumeFromVisibility(this); }

  _setStatus(next) {
    if (this._status === next) return;
    const prev = this._status;
    this._status = next;
    this.emit('status-change', { previous: prev, current: next, info: this.getStatus() });
  }

  _appendLog(level, message) {
    const lines = String(message).split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      const entry = { ts: Date.now(), level, message: line };
      this._logs.push(entry);
      if (this._logs.length > LOG_RING_MAX) {
        this._logs.shift();
      }
      this.emit('log', entry);
    }
  }
}
module.exports = new LLMManager();
module.exports.LLMManager = LLMManager;