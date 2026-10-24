// IPC for saved passwords. Guest pages (the webview preload) report login
// submits and fill results; the shell drives the save bar and Settings →
// Passwords. Shell channels answer only the main window, so a guest page can
// never list, reveal or copy a saved password. PasswordService is bound here
// because App.js is at its line cap.
const { ipcMain } = require('electron');
const passwordService = require('../services/PasswordService');
const { errMsg } = require('../../shared/errMsg');

function register(mainWindow, services) {
  passwordService.bind({
    mainWindow,
    configService: services && services.configService,
    certificateService: services && services.certService,
  });

  const fromShell = (e) => !!(e && e.sender && mainWindow && !mainWindow.isDestroyed()
    && e.sender.id === mainWindow.webContents.id);

  const shell = (fn) => async (e, arg) => {
    if (!fromShell(e)) return { ok: false, error: 'Not allowed from this sender.' };
    try {
      return await fn(arg);
    } catch (err) {
      console.error('[passwords] request failed:', errMsg(err));
      return { ok: false, error: errMsg(err) };
    }
  };

  ipcMain.on('passwords:captured', (e, payload) => passwordService.handleCaptured(e, payload));
  ipcMain.on('passwords:fill-result', (e, result) => passwordService.handleFillResult(e, result));
  ipcMain.handle('passwords:resolve-offer', shell((p) => passwordService.resolveOffer(p && p.id, p && p.action)));
  ipcMain.handle('passwords:list', shell(() => passwordService.listForSettings()));
  ipcMain.handle('passwords:reveal', shell((id) => passwordService.reveal(id)));
  ipcMain.handle('passwords:copy', shell((id) => passwordService.copy(id)));
  ipcMain.handle('passwords:delete', shell((id) => passwordService.remove(id)));
  ipcMain.handle('passwords:never-save-remove', shell((origin) => passwordService.removeNeverSave(origin)));
}

module.exports = { register };
