// Page output IPC: the app menu's Print… / Save Page as PDF… act on the active
// tab, which only the renderer knows; it replies with that tab's webContents id.
const { ipcMain, webContents } = require('electron');
const pageOutput = require('../services/pageOutput');

/**
 * Only a guest page may be printed or saved; the shell's own webContents is not
 * a target even though its id is resolvable too.
 * @param {unknown} id
 * @returns {Electron.WebContents | null}
 */
function guestPage(id) {
  if (!Number.isInteger(id)) return null;
  const contents = webContents.fromId(/** @type {number} */ (id));
  return contents && !contents.isDestroyed() && contents.getType() === 'webview' ? contents : null;
}

/** @param {Electron.BrowserWindow} mainWindow */
function register(mainWindow) {
  ipcMain.handle('page:print', (_e, id) => pageOutput.printPage(guestPage(id), mainWindow));
  ipcMain.handle('page:save-pdf', (_e, id) => pageOutput.savePageAsPdf(guestPage(id), mainWindow));
}

module.exports = { register };
