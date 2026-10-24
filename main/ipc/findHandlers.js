const { ipcMain } = require('electron');
const { safeSend } = require('../utils/safeSend');

function register(mainWindow) {
  ipcMain.on('close-find-bar', () => {
    safeSend(mainWindow, 'close-find-bar');
  });
}

module.exports = { register };
