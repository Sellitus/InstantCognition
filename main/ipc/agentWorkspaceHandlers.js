// agentWorkspaceHandlers — IPC for the isolated agent tab workspace.
const { ipcMain } = require('electron');
const { errMsg } = require('../../shared/errMsg');

const RUN_ID = /^[A-Za-z0-9_-]+$/; // matches the task_${Date.now()} shape AgentService mints

// taskIds cross the IPC boundary untrusted: AgentHistoryService joins them
// into .meta.json paths, so a '../' taskId is a path-traversal primitive.
// Absent ids stay a no-op (null); anything else must match the minted shape.
// typeof guard first: an object payload's toString can yield traversal paths.
function optionalRunId(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string' || !RUN_ID.test(raw)) throw new Error(`invalid run id: ${JSON.stringify(raw)}`);
  return raw;
}

function register(_mainWindow, services) {
  const { agentWorkspaceService } = services || {};
  if (!agentWorkspaceService) return;

  // Renderer -> main: hand back the authoritative workspace state after
  // applying a tab op or detecting a navigation. Triggers debounced persist.
  ipcMain.on('agent-workspace:state-update', (_e, payload) => {
    try { agentWorkspaceService.applyStateFromRenderer(payload || {}); }
    catch (err) { console.warn('[agent-workspace] state-update failed:', errMsg(err)); }
  });

  // Renderer requests: hydrate UI on bootstrap.
  ipcMain.handle('agent-workspace:get-state', () => agentWorkspaceService.getState());

  // AgentPanel chokepoint: called before agent:start. {taskId, isNew}.
  ipcMain.handle('agent-workspace:set-active-conversation', async (_e, payload) => {
    try {
      const p = payload || {};
      agentWorkspaceService.setActiveConversation({ ...p, taskId: optionalRunId(p.taskId) });
      return { ok: true };
    }
    catch (err) { return { ok: false, error: errMsg(err) }; }
  });

  // After agent:task-started: associate the live workspace with the new taskId
  // so subsequent state-update broadcasts persist to <taskId>.meta.json.
  ipcMain.on('agent-workspace:bind-conversation-id', (_e, payload) => {
    try { agentWorkspaceService.bindConversationId(optionalRunId(payload && payload.taskId)); }
    catch (err) { console.warn('[agent-workspace] bind failed:', errMsg(err)); }
  });
}

module.exports = { register };
