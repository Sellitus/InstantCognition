// Guarded webContents.send wrapper. Without this, IPC handlers that fire
// during window teardown (close, reload) throw "Object has been destroyed".
// Returns true if the message was actually sent.
function safeSend(win, channel, payload) {
  if (!win || typeof win.isDestroyed !== 'function' || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
  if (payload === undefined) wc.send(channel);
  else wc.send(channel, payload);
  return true;
}

module.exports = { safeSend };
