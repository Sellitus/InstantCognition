// Adblocker IPC: enable/disable, reload after blocklist changes, validate
// custom blocklist URLs, and expose the built-in catalog + runtime stats.
const { ipcMain } = require('electron');

function register(_mainWindow, services) {
  const { adblockerService } = services || {};
  if (!adblockerService) return;

  // Legacy channels kept here so the renderer side-effect dispatch keeps working.
  ipcMain.on('call-createAndUpdateaAblocker', () => {
    adblockerService.enable()
      .then(() => adblockerService.setupAutoUpdate())
      .catch((err) => console.error('Failed to enable adblocker:', err));
  });

  ipcMain.on('call-disableAdblocker', () => {
    adblockerService.disable();
  });

  ipcMain.on('adblocker:reload', () => {
    adblockerService.reload().catch((err) => {
      console.error('Adblocker reload failed:', err && err.message);
    });
  });

  ipcMain.handle('adblocker:validate', async (_e, url) => {
    try { return await adblockerService.validateBlocklistUrl(url); }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'Validation failed.' }; }
  });

  ipcMain.handle('adblocker:get-catalog', () => {
    return typeof adblockerService.getCatalog === 'function' ? adblockerService.getCatalog() : [];
  });

  ipcMain.handle('adblocker:get-stats', () => {
    return typeof adblockerService.getStats === 'function' ? adblockerService.getStats() : {
      enabled: false, activeListCount: 0, filterCount: 0, lastReloadAt: 0,
    };
  });
}

module.exports = { register };
