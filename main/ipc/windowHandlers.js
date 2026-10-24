const { ipcMain, app } = require('electron');
const { safeSend } = require('../utils/safeSend');

function register(mainWindow, { shortcutService, menuService, errorHandler }) {
  ipcMain.on('toggle-window', () => {
    shortcutService.toggleWindow();
  });

  ipcMain.on('quitApp', () => {
    menuService.setAppQuitting(true);
    app.quit();
  });

  ipcMain.on('restart-app', () => {
    menuService.setAppQuitting(true);
    app.relaunch();
    app.quit();
  });

  ipcMain.on('zoomInActive', () => safeSend(mainWindow, 'zoomInActive'));
  ipcMain.on('zoomOutActive', () => safeSend(mainWindow, 'zoomOutActive'));
  ipcMain.on('zoomResetActive', () => safeSend(mainWindow, 'zoomResetActive'));

  ipcMain.on('show-url-prompt', (event) => {
    require('electron-prompt')({
      title: 'Visit URL',
      label: 'Enter the URL to visit:',
      value: 'https://',
      inputAttrs: { type: 'url' },
      type: 'input',
    })
      .then((url) => {
        if (url && event.sender && !event.sender.isDestroyed()) {
          event.sender.send('navigate-to-url', { url });
        }
      })
      .catch((err) => {
        if (err) console.error('URL prompt error:', err);
      });
  });

  ipcMain.on('renderer-error', (_, errorInfo) => {
    if (errorHandler && errorHandler.logRendererError) {
      errorHandler.logRendererError(errorInfo);
    }
  });
}

module.exports = { register };
