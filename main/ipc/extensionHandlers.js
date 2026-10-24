const { ipcMain, dialog } = require('electron');

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {Partial<ICServices>} services
 */
function register(mainWindow, { extensionService } = {}) {
  if (!extensionService) return;

  ipcMain.handle('extensions:list', () => extensionService.list());

  ipcMain.handle('extensions:load', async (_e, { path: extPath } = {}) => {
    let target = extPath;
    if (!target && mainWindow) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Load unpacked extension',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths.length) return null;
      target = result.filePaths[0];
    }
    if (!target) return null;
    return extensionService.load(target);
  });

  // Stage an install (download/unpack as needed) and return the manifest
  // preview. With no source, open a .crx/.zip file picker. Nothing is loaded
  // until the renderer reviews permissions and calls install-commit.
  ipcMain.handle('extensions:install-prepare', async (_e, { source } = {}) => {
    let src = source;
    if (!src && mainWindow) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Install extension from file',
        properties: ['openFile'],
        filters: [{ name: 'Chrome Extension', extensions: ['crx', 'zip'] }],
      });
      if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
      src = result.filePaths[0];
    }
    if (!src) return { ok: false, error: 'No source provided' };
    return extensionService.prepareInstall(src);
  });

  ipcMain.handle('extensions:install-commit', (_e, opts = {}) => extensionService.commitInstall(opts));

  ipcMain.handle('extensions:remove', (_e, { id } = {}) => extensionService.remove(id));
}

module.exports = { register };
