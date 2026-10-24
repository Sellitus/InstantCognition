const { ipcMain, app } = require('electron');
const { safeSend } = require('../utils/safeSend');

function register(mainWindow, { certService }) {
  ipcMain.on('call-enableLaunchAtStartup', () => {
    app.setLoginItemSettings({ openAtLogin: true });
  });

  ipcMain.on('call-disableLaunchAtStartup', () => {
    app.setLoginItemSettings({ openAtLogin: false });
  });

  ipcMain.handle('call-isLaunchAtStartupEnabled', () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.on('set-auto-deny-cert-errors', (_, enabled) => {
    certService.setAutoDeny(enabled);
  });

  ipcMain.on('set-private-ip-cert-ranges', (_, ranges) => {
    if (ranges && typeof ranges === 'object') {
      certService.setPrivateIpRanges(ranges);
    }
  });

  ipcMain.on('toggle-settings-menu', () => safeSend(mainWindow, 'toggle-settings-menu'));
}

module.exports = { register };
