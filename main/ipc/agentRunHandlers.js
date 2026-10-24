// Session run IPC: start/stop/pause/resume background session runs, settle a
// proposed plan, compact a session's context and report its size. Every run
// event leaves as 'session:event' {sessionId, channel, payload}; background
// runs never use the foreground agent:* channels.
const { ipcMain } = require('electron');
const { assertSessionId, assertNodeId } = require('../agent/sessions/sessionStore');

const MAX_TEXT = 100000;
const SOURCES = new Set(['chat', 'agent', 'routine', 'launcher', 'subagent']);
const msg = (err) => (err instanceof Error && err.message) || String(err);
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
  try { return await fn(arg && typeof arg === 'object' ? arg : {}); } catch (err) { return { ok: false, error: msg(err) }; }
});

/** Validated session:send request, or throws with an error code. */
function sendArgs({ sessionId, text, fromNodeId, webContentsId, source }) {
  const out = {};
  if (sessionId !== undefined && sessionId !== null) out.sessionId = assertSessionId(sessionId);
  if (fromNodeId !== undefined && fromNodeId !== null) {
    if (!out.sessionId) throw new Error('session_required');
    out.fromNodeId = assertNodeId(fromNodeId);
  } else if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error('invalid_text');
  else out.text = text;
  if (webContentsId !== undefined && webContentsId !== null) {
    if (!Number.isInteger(webContentsId) || webContentsId < 0) throw new Error('invalid_webContentsId');
    out.webContentsId = webContentsId;
  }
  if (source !== undefined) {
    if (!SOURCES.has(source)) throw new Error('invalid_source');
    out.source = source;
  }
  return out;
}

function register(mainWindow, services) {
  const manager = services && services.sessionManager;
  if (!manager) return;
  manager.on('event', (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session:event', e);
  });

  handle('session:send', (arg) => manager.send(sendArgs(arg)));
  handle('session:stop', ({ sessionId }) => manager.stop(assertSessionId(sessionId)));
  handle('session:pause', ({ sessionId }) => manager.pause(assertSessionId(sessionId)));
  handle('session:resume', ({ sessionId }) => manager.resume(assertSessionId(sessionId)));
  handle('session:plan-decision', ({ sessionId, decision, plan }) => manager.planDecision({ sessionId: assertSessionId(sessionId), decision, plan }));
  handle('session:compact', ({ sessionId }) => manager.compact(assertSessionId(sessionId)));
  handle('session:context-usage', ({ sessionId }) => manager.contextUsage(assertSessionId(sessionId)));
  handle('session:running', () => ({ ok: true, runs: manager.running() }));
}

module.exports = { register, sendArgs };
