// chatHandlers — the generic single-turn chat channel backing the unified chat
// surface. Thin adapter over ChatStreamService (which owns the stream loop,
// cancellation, and admission through the shared LLM gate).
//
// Protocol: renderer invokes 'chat:ask' {id, messages, maxTokens?, endpoint?,
// model?, temperature?, sessionId?, userNodeId?, userText?}; main pushes 'chat:token'
// {id, delta} chunks then resolves the invoke with {ok, elapsedMs, charCount}
// or {ok:false, error} (error 'engine_busy' when every gate slot is taken).
// With a sessionId the turn is persisted (chatTurns) and the result also
// carries {sessionId, userNodeId, assistantNodeId, artifacts, artifactErrors};
// userText is what the user node stores (default: the last user message).
// The session is held for the whole answer: {ok:false, error:'session_busy'}
// when another lane (agent run, background run, compaction) already holds it.
// 'chat:cancel' {id} aborts an in-flight request (the invoke then resolves
// {ok:false, error:'cancelled'}).

const { ipcMain } = require('electron');
const chatStream = require('../services/ChatStreamService');
const { checkChatTurn, recordChatTurn } = require('../agent/sessions/chatTurns');

const errText = (err) => (err instanceof Error && err.message) || String(err);

function register(mainWindow, services = {}) {
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send(channel, payload);
    }
  };
  const { agentService, sessionManager } = services;

  // Agent runs hold a gate slot only while a request is in flight; an engine
  // restart must still wait for the whole run.
  chatStream.setEngineUsers(() => !!(agentService && typeof agentService.isRunning === 'function' && agentService.isRunning())
    || !!(sessionManager && sessionManager.running().some((r) => r.state !== 'queued')));

  ipcMain.handle('chat:ask', async (_e, raw) => {
    const req = raw && typeof raw === 'object' ? raw : {};
    const store = services.sessionStore;
    let turn = null;
    if (req.sessionId !== undefined && req.sessionId !== null) {
      if (!store) return { ok: false, error: 'sessions_unavailable' };
      try { turn = checkChatTurn(store, req); } catch (err) { return { ok: false, error: errText(err) }; }
      if (sessionManager) {
        try { sessionManager.claim(turn.sessionId); } catch (err) { return { ok: false, error: errText(err) }; }
      }
    }
    let text = '';
    try {
      const res = await chatStream.ask(req, (delta) => { text += delta; send('chat:token', { id: req.id, delta }); });
      return turn ? persistTurn(turn, text, res) : res;
    } finally {
      if (turn && sessionManager) sessionManager.release(turn.sessionId);
    }
  });

  function persistTurn(turn, text, res) {
    const store = services.sessionStore;
    try {
      const artifactStore = services.artifactStore || require('../agent/artifacts/artifactStore').getDefaultArtifactStore();
      const onEvent = (sessionId, channel, payload) => { if (sessionManager) sessionManager.emitEvent(sessionId, channel, payload); };
      return { ...res, ...recordChatTurn({ store, artifactStore, onEvent }, turn, text, res) };
    } catch (err) {
      console.error('[chatHandlers] session persist failed:', errText(err));
      return { ...res, sessionId: turn.sessionId, persistError: errText(err) };
    }
  }

  ipcMain.on('chat:cancel', (_e, { id } = {}) => { chatStream.cancel(id); });
}

module.exports = { register };
