// Answers one launcher question as a chat-lane turn of an existing session:
// streams deltas through `emit(type, extra)` ('chunk' {delta}, then 'done' or
// 'error' {error}) and persists the turn exactly like chat:ask with a
// sessionId. A request that never reached the model (engine busy) leaves no
// turn behind, so its freshly created session is deleted instead of lingering
// empty in the session list.
const { recordChatTurn, NOT_STARTED } = require('../agent/sessions/chatTurns');

const errText = (err) => (err instanceof Error && err.message) || String(err);

/**
 * @param {{ chat: { ask: Function }, store: any, artifactStore: () => any,
 *   onSessionEvent: (sessionId: string, channel: string, payload: any) => void }} deps
 * @param {string} sessionId
 * @param {string} text
 * @param {(type: 'chunk'|'done'|'error', extra: object) => void} emit
 * @returns {Promise<void>} settles after the final 'done' / 'error' emit; never rejects
 */
function runLauncherAnswer(deps, sessionId, text, emit) {
  const { chat, store } = deps;
  const turn = { sessionId, userNode: null, userText: text };
  let answer = '';
  return Promise.resolve()
    .then(() => chat.ask({ id: `launcher-${sessionId}`, messages: [{ role: 'user', content: text }] }, (delta) => {
      answer += delta;
      emit('chunk', { delta });
    }))
    .then((res) => {
      if (!res.ok && NOT_STARTED.has(String(res.error))) store.delete(sessionId);
      else recordChatTurn({ store, artifactStore: deps.artifactStore(), onEvent: deps.onSessionEvent }, turn, answer, res);
      emit(res.ok ? 'done' : 'error', res.ok ? {} : { error: String(res.error) });
    })
    .catch((err) => {
      console.error(`[launcher] answer for ${sessionId} failed:`, errText(err));
      emit('error', { error: errText(err) });
    });
}

module.exports = { runLauncherAnswer };
