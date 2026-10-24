// sessionServices — builds the session layer once per process and binds it to
// the foreground AgentService:
//
//   sessionStore     {userData}/sessions
//   checkpointStore  {userData}/checkpoints (per-turn file snapshots)
//   sessionManager   background runs (SessionRun) + plan decisions
//   llmGate          the shared LLM semaphore, limit from
//                    settings.llm.agent.sessions.llmConcurrency
//
// main/ipc/index.js calls getSessionServices() before registering handlers and
// exposes the result on the services object. Construction does no disk I/O;
// startMaintenance() runs the one-time legacy import and the checkpoint prune
// off the startup path and reports their failures on the session:event stream.

const path = require('path');
const { createSessionStore } = require('./sessionStore');
const { createSessionSink } = require('./sessionRecorder');
const { SessionManager } = require('./sessionManager');
const { SessionRun } = require('./SessionRun');
const { gate, resolveLimit } = require('./llmGate');
const { importLegacyRuns } = require('./legacyImport');
const { createCheckpointStore } = require('../checkpoints/checkpointStore');

const errText = (err) => (err instanceof Error && err.message) || String(err);

/**
 * @param {{ configService?: any, agentService: any, llmService?: any, userDataDir: string, approval?: any }} deps
 */
function createSessionServices({ configService, agentService, llmService, userDataDir, approval }) {
  if (!agentService) throw new Error('agentService required');
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) throw new Error('absolute userDataDir required');
  const cfg = (key, fallback) => (configService && typeof configService.get === 'function' ? configService.get(key, fallback) : fallback);
  const sessionsSettings = () => cfg('settings.llm.agent.sessions', {}) || {};
  const isRemote = () => !!(llmService && typeof llmService.getStatus === 'function' && llmService.getStatus().isRemote);

  const sessionStore = createSessionStore({ baseDir: path.join(userDataDir, 'sessions') });
  const checkpointStore = createCheckpointStore({ rootDir: path.join(userDataDir, 'checkpoints'), getSettings: () => cfg('settings.llm.agent', {}) });
  const sessionSink = createSessionSink({ store: sessionStore });
  gate.configure({ limit: () => resolveLimit(sessionsSettings().llmConcurrency, isRemote()) });
  agentService.bindSessions({ sessionSink, checkpointStore });

  const contextSize = () => {
    const llm = cfg('settings.llm', {}) || {};
    const backend = llm.activeBackend || 'llamaCpp';
    const b = llm[backend] || {};
    return (backend === 'llamaCpp' ? b.contextSize : backend === 'vllm' ? b.maxModelLen : b.contextLength) || 65536;
  };
  const sessionManager = new SessionManager({
    store: sessionStore,
    approval: approval || agentService._approval,
    llm: agentService._llm,
    getSettings: sessionsSettings,
    getContextSize: contextSize,
    createHost: (onEvent) => new SessionRun({
      source: agentService, onEvent, sessionSink, checkpointStore,
      getApprovalTimeoutMs: () => sessionManager.settings().backgroundApprovalTimeoutMs,
    }),
  });
  sessionManager.attachForeground(agentService);

  function reportMaintenance(task, err) {
    console.error(`[sessionServices] ${task} failed:`, errText(err));
    sessionManager.emitEvent(null, 'maintenance-error', { task, error: errText(err) });
  }

  /** @param {{ history?: any }} [opts] history = AgentHistoryService for the legacy import */
  function startMaintenance(opts = {}) {
    const legacy = new Promise((resolve) => setImmediate(resolve)).then(() => {
      if (!opts.history) return null;
      const r = importLegacyRuns(sessionStore, opts.history);
      if (r.imported) sessionStore.emit('changed', { sessionId: null, reason: 'legacy-import', imported: r.imported });
      if (r.failed.length) reportMaintenance('legacy-import', new Error(`${r.failed.length} run(s) failed: ${r.failed.map((f) => f.runId).join(', ')}`));
      return r;
    }).catch((err) => { reportMaintenance('legacy-import', err); return null; });
    const prune = checkpointStore.prune().catch((err) => { reportMaintenance('checkpoint-prune', err); return null; });
    return Promise.all([legacy, prune]).then(([legacyResult, pruneResult]) => ({ legacy: legacyResult, prune: pruneResult }));
  }

  return { sessionStore, sessionManager, llmGate: gate, checkpointStore, startMaintenance };
}

let instance = null;

/** Process-wide session services; built on first call from the IPC registration. */
function getSessionServices(services) {
  if (!instance) {
    const { app } = require('electron');
    instance = createSessionServices({
      configService: services.configService, agentService: services.agentService,
      llmService: services.llmService, userDataDir: app.getPath('userData'),
    });
  }
  return instance;
}

module.exports = { createSessionServices, getSessionServices };
