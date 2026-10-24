const { ipcMain, webContents: webContentsModule } = require('electron');
const { safeSend } = require('../utils/safeSend');

function register(mainWindow) {
  ipcMain.on('toggleSpaceView', () => {
    safeSend(mainWindow, 'toggleSpaceView');
  });

  ipcMain.on('toggleMultiSpace', () => {
    safeSend(mainWindow, 'toggleMultiSpace');
  });

  // Open DevTools on a specific webview by webContents id (or the active one
  // if id is null/undefined). Used by F12 / Cmd+Alt+I shortcut and the
  // Inspect Element context menu.
  ipcMain.on('view:open-devtools', (event, webContentsId) => {
    try {
      let target = null;
      if (webContentsId != null && webContentsModule && typeof webContentsModule.fromId === 'function') {
        target = webContentsModule.fromId(webContentsId);
      }
      if (!target && event.sender !== mainWindow.webContents) target = event.sender;
      if (!target) return;
      if (target.isDevToolsOpened && target.isDevToolsOpened()) target.closeDevTools();
      else target.openDevTools({ mode: 'detach' });
    } catch (err) { console.error('view:open-devtools failed:', err); }
  });
}

module.exports = { register };
