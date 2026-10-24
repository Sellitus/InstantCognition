// Clipboard and OS-shell calls for the sandboxed shell renderer, which has no
// access to Electron's clipboard or shell modules (renderer/ipc/electronShim.js).
// Each channel accepts only what the shell legitimately sends: web and mailto
// URLs, and files a download wrote.
const { ipcMain, clipboard, shell } = require('electron');
const { errMsg } = require('../../shared/errMsg');

const EXTERNAL_URL = /^(https?:|mailto:)/i;
const MAX_CLIPBOARD_CHARS = 32 * 1024 * 1024;

function register(_mainWindow, { downloadService } = /** @type {Partial<ICServices>} */ ({})) {
  // Synchronous so clipboard.writeText keeps Electron's throw-on-failure contract.
  ipcMain.on('clipboard:write-text', (event, text) => {
    if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_CHARS) {
      event.returnValue = { ok: false, error: 'clipboard text must be a string under 32M characters' };
      return;
    }
    try {
      clipboard.writeText(text);
      event.returnValue = { ok: true };
    } catch (err) {
      event.returnValue = { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (typeof url !== 'string' || !EXTERNAL_URL.test(url)) {
      throw new Error('only http, https and mailto links can open outside the app');
    }
    await shell.openExternal(url);
  });

  // Resolves to Electron's openPath result: '' on success, else an error string.
  ipcMain.handle('shell:open-path', async (_event, filePath) => {
    if (!downloadService || !downloadService.isKnownSavePath(filePath)) {
      return 'that file is not a finished download';
    }
    return shell.openPath(filePath);
  });

  ipcMain.on('shell:show-item-in-folder', (event, filePath) => {
    if (!downloadService || !downloadService.isKnownSavePath(filePath)) {
      event.returnValue = { ok: false, error: 'that file is not a finished download' };
      return;
    }
    try {
      shell.showItemInFolder(filePath);
      event.returnValue = { ok: true };
    } catch (err) {
      event.returnValue = { ok: false, error: errMsg(err) };
    }
  });
}

module.exports = { register };
