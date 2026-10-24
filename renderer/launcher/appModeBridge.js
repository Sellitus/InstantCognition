// Main-window side of 'app-mode:set' {mode, sessionId?}: sent by main when the
// quick launcher's "Open in Assistant" hands a session over. Assistant mode
// goes through agentPanel.open({mode:'assistant'}), which flips the shell and
// focuses the composer even when the shell is already in assistant mode.
const SESSION_ID_RE = /^s_[a-z0-9]{6,32}$/;

/**
 * @param {any} payload
 * @param {{ viewShell: { setMode: Function }, agentPanel: { open: Function, loadSession?: Function } }} deps
 * @returns {{ ok: boolean, error?: string, sessionLoaded?: boolean }}
 */
function handleAppModeSet(payload, { viewShell, agentPanel }) {
  const mode = payload && payload.mode;
  if (mode !== 'assistant' && mode !== 'browser') return { ok: false, error: 'invalid_mode' };
  const sessionId = payload.sessionId;
  if (sessionId !== undefined && sessionId !== null && !SESSION_ID_RE.test(String(sessionId))) {
    return { ok: false, error: 'invalid_session_id' };
  }
  if (mode === 'browser') {
    viewShell.setMode('browser');
    return { ok: true };
  }
  agentPanel.open({ mode: 'assistant' });
  if (!sessionId) return { ok: true };
  if (typeof agentPanel.loadSession !== 'function') {
    // The session is saved and listed; the panel just has no way to open it yet.
    console.warn(`[app-mode:set] agentPanel.loadSession is unavailable; session ${sessionId} not opened`);
    return { ok: true, sessionLoaded: false };
  }
  agentPanel.loadSession(sessionId);
  return { ok: true, sessionLoaded: true };
}

module.exports = { handleAppModeSet };
