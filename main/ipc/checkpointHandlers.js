// Checkpoint IPC: list a session's per-turn file checkpoints, preview what a
// rewind would change, and rewind files. Rewinding the conversation belongs to
// the session layer; the rewind result carries conversationNodeId for it.
const { ipcMain } = require('electron');
const { isSessionId, isTurnId } = require('../agent/checkpoints/checkpointStore');

const msg = (err) => (err instanceof Error && err.message) || String(err);
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
  try { return await fn(arg && typeof arg === 'object' ? arg : {}); } catch (err) { return { ok: false, error: msg(err) }; }
});

/** Error code for a bad request, or '' when the ids (and optional flags) are well-formed. */
function rejectArgs({ sessionId, turnId, files, force }, needTurn) {
  if (!isSessionId(sessionId)) return 'invalid_session_id';
  if (needTurn && !isTurnId(turnId)) return 'invalid_turn_id';
  if (files !== undefined && typeof files !== 'boolean') return 'invalid_files_flag';
  if (force !== undefined && typeof force !== 'boolean') return 'invalid_force_flag';
  return '';
}

function register(_mainWindow, services) {
  const store = services && services.checkpointStore;
  if (!store) return;

  handle('checkpoint:list', async (arg) => {
    const bad = rejectArgs(arg, false);
    if (bad) return { ok: false, error: bad };
    return { ok: true, ...(await store.list({ sessionId: arg.sessionId })) };
  });

  handle('checkpoint:preview', async (arg) => {
    const bad = rejectArgs(arg, true);
    if (bad) return { ok: false, error: bad };
    return { ok: true, ...(await store.preview({ sessionId: arg.sessionId, turnId: arg.turnId })) };
  });

  handle('checkpoint:rewind', async (arg) => {
    const bad = rejectArgs(arg, true);
    if (bad) return { ok: false, error: bad };
    const res = await store.rewind({ sessionId: arg.sessionId, turnId: arg.turnId, files: arg.files !== false, force: arg.force === true });
    return { ok: true, ...res };
  });
}

module.exports = { register, rejectArgs };
