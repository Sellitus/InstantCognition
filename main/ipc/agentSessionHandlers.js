// Session tree IPC: list/get/create/delete, meta edits, and branch / fork /
// edit / regenerate / rewind on a session's message tree. Pushes
// 'session:list-changed' {sessionId, reason} whenever the store changes.
// Every id, flag and path from the renderer is validated here before it
// reaches the store; a workspace root must lie inside a configured root.
const { ipcMain } = require('electron');
const path = require('path');
const { assertSessionId, assertNodeId } = require('../agent/sessions/sessionStore');
const { readAgentSettings } = require('../agent/workspace/agentSettings');

const MAX_TEXT = 100000;
const msg = (err) => (err instanceof Error && err.message) || String(err);
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
  try { return await fn(arg && typeof arg === 'object' ? arg : {}); } catch (err) { return { ok: false, error: msg(err) }; }
});
const optString = (v, max, code) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new Error(code);
  return v;
};
const text = (v) => { if (typeof v !== 'string' || !v.trim() || v.length > MAX_TEXT) throw new Error('invalid_content'); return v; };
const optNode = (v) => (v === undefined || v === null ? undefined : assertNodeId(v));

function insideConfiguredRoot(root, configService) {
  const roots = readAgentSettings(configService).workspace.roots;
  return roots.some((r) => { const rel = path.relative(r, root); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
}

function register(mainWindow, services) {
  const store = services && services.sessionStore;
  if (!store) return;
  const { sessionManager, checkpointStore, configService } = services;
  store.on('changed', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session:list-changed', payload);
  });
  const idle = (sessionId) => {
    if (sessionManager && sessionManager.isBusy(sessionId)) throw new Error('session_busy');
    return sessionId;
  };

  handle('session:list', () => ({ ok: true, sessions: store.list() }));
  handle('session:get', ({ sessionId }) => ({
    ok: true, ...store.get(assertSessionId(sessionId)),
    pendingPlan: sessionManager ? sessionManager.pendingPlan(sessionId) : null,
  }));
  handle('session:create', ({ title, projectId, workspaceRoot }) => {
    const meta = store.create({ title: optString(title, 200, 'invalid_title'), source: 'chat' });
    if (projectId !== undefined && projectId !== null) store.setProject(meta.id, projectId);
    if (workspaceRoot !== undefined && workspaceRoot !== null) {
      if (typeof workspaceRoot !== 'string' || !insideConfiguredRoot(workspaceRoot, configService)) throw new Error('root_not_configured');
      store.setWorkspace(meta.id, workspaceRoot);
    }
    return { ok: true, session: store.get(meta.id).meta };
  });
  // The session goes first; checkpoints that then fail to delete are reported
  // as checkpointError (the session itself is gone).
  handle('session:delete', async ({ sessionId }) => {
    store.delete(idle(assertSessionId(sessionId)));
    if (sessionManager) sessionManager.forget(sessionId);
    if (!checkpointStore) return { ok: true };
    try { await checkpointStore.removeSession(sessionId); } catch (err) {
      console.error(`[agentSessionHandlers] checkpoints of ${sessionId} not removed:`, msg(err));
      return { ok: true, checkpointError: msg(err) };
    }
    return { ok: true };
  });
  handle('session:rename', ({ sessionId, title }) => ({ ok: true, session: store.rename(assertSessionId(sessionId), optString(title, 200, 'invalid_title') || '') }));
  handle('session:pin', ({ sessionId, pinned }) => ({ ok: true, session: store.pin(assertSessionId(sessionId), pinned) }));
  handle('session:set-project', ({ sessionId, projectId }) => ({ ok: true, session: store.setProject(assertSessionId(sessionId), projectId === undefined ? null : projectId) }));
  handle('session:set-workspace', ({ sessionId, root }) => {
    assertSessionId(sessionId);
    if (root !== null && (typeof root !== 'string' || !path.isAbsolute(root) || !insideConfiguredRoot(root, configService))) throw new Error('root_not_configured');
    return { ok: true, session: store.setWorkspace(sessionId, root) };
  });
  handle('session:branch', ({ sessionId, nodeId }) => ({ ok: true, ...store.branch(idle(assertSessionId(sessionId)), assertNodeId(nodeId)) }));
  handle('session:fork', ({ sessionId, nodeId }) => ({ ok: true, session: store.fork(assertSessionId(sessionId), optNode(nodeId)) }));
  handle('session:edit', ({ sessionId, nodeId, content }) => ({ ok: true, node: store.edit(idle(assertSessionId(sessionId)), assertNodeId(nodeId), text(content)) }));
  handle('session:regenerate', ({ sessionId, nodeId }) => ({ ok: true, node: store.regenerate(idle(assertSessionId(sessionId)), assertNodeId(nodeId)) }));

  // Rewinds files to before turnId (checkpoints) and, when nothing conflicted,
  // moves the session head to the turn's parent so the turn leaves the context.
  handle('session:rewind', async ({ sessionId, turnId, files, force }) => {
    idle(assertSessionId(sessionId));
    const turn = store.getPath(sessionId, assertNodeId(turnId)).pop();
    if (!turn || turn.role !== 'user') throw new Error('not_a_user_message');
    if (files !== undefined && typeof files !== 'boolean') throw new Error('invalid_files_flag');
    if (force !== undefined && typeof force !== 'boolean') throw new Error('invalid_force_flag');
    if (!checkpointStore) throw new Error('checkpoints_unavailable');
    const res = await checkpointStore.rewind({ sessionId, turnId, files: files !== false, force: force === true });
    const conversationRewound = res.conflicts.length === 0;
    if (conversationRewound) store.setHead(sessionId, turn.parentId);
    return { ok: true, ...res, conversationRewound, headId: store.get(sessionId).meta.headId };
  });
}

module.exports = { register, insideConfiguredRoot };
