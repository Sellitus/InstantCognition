// Session-level browsing data: cookies, storage and the HTTP cache, for the
// default session and the private one. History and downloads live in their own
// services and are cleared through browserDataHandlers.
const { ipcMain, session } = require('electron');
const { errMsg } = require('../../shared/errMsg');
const { onRendererReset } = require('../utils/rendererReset');

function register(mainWindow, { sessionService } = /** @type {Partial<ICServices>} */ ({})) {
  // A reloaded or crashed shell has lost its private tabs without closing them,
  // so nothing else would ever send session:clear-private for them.
  if (mainWindow && mainWindow.webContents) {
    onRendererReset(mainWindow.webContents, () => {
      sessionService.clear().catch((err) => {
        console.error('[sessionHandlers] could not clear the private session after a shell reset:', err);
      });
    });
  }

  ipcMain.handle('session:clear-site-data', async () => {
    try {
      const s = session.defaultSession;
      await s.clearCache();
      await s.clearStorageData();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  // A new private tab loads its page only after this answers ok.
  ipcMain.handle('session:private-ready', async () => {
    try {
      await sessionService.whenClean();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  // The renderer closed the last private tab; the next one must start clean.
  ipcMain.handle('session:clear-private', async () => {
    try {
      await sessionService.clear();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
}

module.exports = { register };
