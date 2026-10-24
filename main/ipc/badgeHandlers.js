// badgeHandlers — IPC surface for the Badging API (`navigator.setAppBadge`).

const { ipcMain } = require('electron');

/**
 * @param {Electron.BrowserWindow} _mainWindow
 * @param {Partial<ICServices>} services
 */
function register(_mainWindow, { badgeService } = {}) {
  if (!badgeService) return;

  ipcMain.on('badge:set', (event, payload = {}) => {
    try {
      const origin = typeof payload.origin === 'string' ? payload.origin
        : (event.sender && typeof event.sender.getURL === 'function' && event.sender.getURL() ? (() => { try { return new URL(event.sender.getURL()).origin; } catch (_e) { return '*'; } })() : '*');
      badgeService.setForOrigin(origin, payload.count);
    } catch (err) { console.error('[badge:set] failed:', err); }
  });

  ipcMain.on('badge:clear', (event, payload = {}) => {
    try {
      const origin = typeof payload.origin === 'string' ? payload.origin
        : (event.sender && typeof event.sender.getURL === 'function' && event.sender.getURL() ? (() => { try { return new URL(event.sender.getURL()).origin; } catch (_e) { return '*'; } })() : '*');
      badgeService.clearForOrigin(origin);
    } catch (err) { console.error('[badge:clear] failed:', err); }
  });
}

module.exports = { register };
