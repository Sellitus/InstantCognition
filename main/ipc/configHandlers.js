const { ipcMain, shell, dialog } = require('electron');
const fs = require('fs');

function register(mainWindow, { configService }) {
  const getConfigPayload = () => ({
    config: configService.getAll(),
    resetReason: configService.lastLoadStatus,
  });

  ipcMain.handle('config:get', () => getConfigPayload());
  ipcMain.on('config:get-sync', (event) => {
    event.returnValue = getConfigPayload();
  });

  ipcMain.on('config:set', (_event, { path: keyPath, value }) => {
    if (keyPath && value !== undefined) {
      configService.set(keyPath, value);
    }
  });

  ipcMain.on('config:update', (_event, partial) => {
    if (partial && typeof partial === 'object') {
      configService.update(partial);
      broadcastChanged({ kind: 'update', partial });
    }
  });

  ipcMain.on('config:replace', (_event, newConfig) => {
    configService.replaceAll(newConfig);
    broadcastChanged({ kind: 'replace' });
  });

  // Broadcast individual path mutations so other panels can react without
  // re-reading the whole config tree. ConfigService emits 'change' from set();
  // update() and replaceAll() emit synthetic events from this handler instead
  // (the service skips per-path events on bulk mutation). Defensive on the
  // listener registration — test harnesses pass a plain object.
  if (configService && typeof configService.on === 'function') {
    configService.on('change', ({ path: keyPath, oldValue, newValue }) => {
      broadcastChanged({ kind: 'set', path: keyPath, oldValue, newValue });
    });
  }

  function broadcastChanged(payload) {
    if (!mainWindow) return;
    try {
      if (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed()) return;
      if (mainWindow.webContents && typeof mainWindow.webContents.send === 'function') {
        mainWindow.webContents.send('config:changed', payload);
      }
    } catch (_) { /* renderer may be destroying */ }
  }

  ipcMain.on('open-config-file', () => {
    const configPath = configService.configPath;
    if (fs.existsSync(configPath)) {
      shell.openPath(configPath).catch((err) => {
        dialog.showErrorBox('Error', 'Failed to open config file: ' + err.message);
      });
    } else {
      dialog.showErrorBox('Config File Not Found', `Config file not found at: ${configPath}`);
    }
  });
}

module.exports = { register };
