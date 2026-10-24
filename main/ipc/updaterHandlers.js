// Update IPC: the manual check from Settings, the restart-to-install action
// (toast and toolbar Update pill) and the pill's state on load. Registering
// also starts UpdateService's background checks — see
// main/services/UpdateService.js for what is supported where.
const { ipcMain, app } = require('electron');
const updateService = require('../services/UpdateService');

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {Partial<ICServices>} [services]
 */
function register(mainWindow, services = /** @type {Partial<ICServices>} */ ({})) {
  const { configService } = services;
  updateService.initialize(mainWindow, configService);

  ipcMain.on('updater:check-now', () => { updateService.check({ manual: true }); });

  ipcMain.handle('updater:install', () => updateService.installNow());

  ipcMain.handle('updater:status', () => ({
    ok: true,
    supported: updateService.supported(),
    currentVersion: app.getVersion(),
    nudge: updateService.nudge(),
  }));

  app.on('before-quit', () => updateService.stop());
}

module.exports = { register };
