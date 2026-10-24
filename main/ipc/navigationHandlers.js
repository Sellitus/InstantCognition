const { ipcMain } = require('electron');
const { safeSend } = require('../utils/safeSend');

function register(mainWindow) {
  ipcMain.on('navigate-back', (event) => {
    if (event.sender !== mainWindow.webContents) {
      // From webview preload — navigate the webview directly.
      // No canGoBack() guard — it returns false for SPA pushState navigations.
      try {
        event.sender.navigationHistory.goBack();
      } catch (_) {
        safeSend(mainWindow, 'navigateBackActive');
      }
    } else {
      safeSend(mainWindow, 'navigateBackActive');
    }
  });

  ipcMain.on('navigate-forward', (event) => {
    if (event.sender !== mainWindow.webContents) {
      try {
        event.sender.navigationHistory.goForward();
      } catch (_) {
        safeSend(mainWindow, 'navigateForwardActive');
      }
    } else {
      safeSend(mainWindow, 'navigateForwardActive');
    }
  });

  ipcMain.on('navigate-refresh', () => safeSend(mainWindow, 'refreshActive'));
  ipcMain.on('navigate-home', () => safeSend(mainWindow, 'navigateHomeReset'));
  // Duplicate handler from preload (refreshActive sends same channel)
  ipcMain.on('refreshActive', () => safeSend(mainWindow, 'refreshActive'));
}

module.exports = { register };
