const { ipcMain } = require('electron');
const agentHistoryService = require('../services/AgentHistoryService');
const { SESSION_ID_RE, NODE_ID_RE } = require('../agent/sessions/sessionStore');

const RUN_ID = /^[A-Za-z0-9_-]+$/; // matches the task_${Date.now()} shape AgentService mints

// Ids cross the IPC boundary untrusted: a '../' id is a path-traversal primitive
// into the agent-runs dir (open/delete/rename/pin all join it into a path).
// Only minted ids are legal, so reject anything outside that shape up front.
// typeof guard first: an object payload's toString can yield traversal paths.
function requireRunId(id) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) throw new Error(`invalid run id: ${JSON.stringify(id)}`);
  return id;
}

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {Partial<ICServices>} services
 */
function register(mainWindow, { agentService } = {}) {
  if (!agentService) return;
  try { agentHistoryService.initialize({}); } catch (err) { console.error('[agentHandlers] agent history init failed:', (err instanceof Error && err.message) || err); }

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  // Every agent:* payload names the session the run persists to (when it has one).
  const sessionOf = () => (typeof agentService.currentSessionId === 'function' ? agentService.currentSessionId() : null);
  const tag = (e) => { const sid = sessionOf(); return sid && e && typeof e === 'object' && !Array.isArray(e) && e.sessionId === undefined ? { ...e, sessionId: sid } : e; };
  const forward = (local, ipc) => agentService.on(local, (e) => send(ipc, tag(e)));
  forward('task-started', 'agent:task-started');
  forward('task-completed', 'agent:task-completed');
  forward('task-failed', 'agent:task-failed');
  forward('task-paused', 'agent:task-paused');
  forward('task-resumed', 'agent:task-resumed');
  forward('task-orphaned', 'agent:task-orphaned');
  forward('task-reattached', 'agent:task-reattached');
  forward('budget-breach', 'agent:budget-breach');
  forward('step-planned', 'agent:step-planned');
  forward('step-acted', 'agent:step-acted');
  forward('step-parse-retry', 'agent:step-parse-retry');
  forward('plan-updated', 'agent:plan-updated');
  forward('throughput', 'agent:throughput');
  forward('assistant-chunk', 'agent:assistant-chunk');
  forward('agent-tokens', 'agent:tokens');
  forward('agent-compacted', 'agent:compacted');
  forward('plan-proposed', 'agent:plan-proposed');
  forward('persist-failed', 'agent:persist-failed');
  agentService.on('step-observed', (e) => send('agent:step-observed', tag({ step: e.step })));

  ipcMain.handle('agent:start', async (_e, opts = {}) => {
    if (opts.sessionId != null && (typeof opts.sessionId !== 'string' || !SESSION_ID_RE.test(opts.sessionId))) throw new Error('invalid_session_id');
    if (opts.fromNodeId != null && (typeof opts.fromNodeId !== 'string' || !NODE_ID_RE.test(opts.fromNodeId))) throw new Error('invalid_node_id');
    return agentService.startTask({
    description: opts.description, webContentsId: opts.webContentsId,
    // A non-numeric maxSteps would coerce the runtime loop ceiling to NaN, so the
    // loop never runs and the task falsely "succeeds". Coerce to a positive int,
    // or drop it so the service default ceiling applies.
    maxSteps: Number.isFinite(opts.maxSteps) ? Math.max(1, Math.trunc(opts.maxSteps)) : undefined,
    qualitySkillOverride: opts.qualitySkillOverride || null,
    scope: opts.scope, tabId: opts.tabId,
    priorTurns: Array.isArray(opts.priorTurns) ? opts.priorTurns : null,
    sessionId: opts.sessionId || undefined, fromNodeId: opts.fromNodeId || undefined,
  }); });
  ipcMain.handle('agent:reattach', async (_e, opts = {}) => agentService.reattachTask({ webContentsId: opts.webContentsId }));

  ipcMain.on('agent:stop', () => { agentService.stopTask(); });
  ipcMain.on('agent:pause', () => { agentService.pauseTask(); });
  ipcMain.on('agent:resume', () => { agentService.resumeTask(); });
  ipcMain.on('agent:reset-conversation', (_e, opts) => {
    if (typeof agentService.resetConversation !== 'function') return;
    if (opts && (opts.scope || opts.tabId)) agentService.resetConversation(opts);
    else agentService.resetConversation();
  });

  // History surface
  ipcMain.handle('agent:history-open', (_e, id) => agentHistoryService.open(requireRunId(id)));
}

module.exports = { register };
