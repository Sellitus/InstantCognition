// IPC handlers for the recursive model-folder scan feature. Kept in a separate
// file to keep llmHandlers.js under its per-file line budget.

const { ipcMain, dialog } = require('electron');
const fs = require('fs');

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {Partial<ICServices>} services
 */
function register(mainWindow, { modelManagerService, configService } = {}) {
  if (!modelManagerService || !configService) return;

  // Persist a new scan-dirs config. Accepts partial updates — passing { mlx: null }
  // clears that slot without touching the others.
  ipcMain.handle('llm:set-scan-dirs', (_e, patch = {}) => {
    const prev = configService.get('settings.llm.scanDirs', { combined: null, mlx: null, gguf: null }) || {};
    const next = {
      combined: Object.prototype.hasOwnProperty.call(patch, 'combined') ? (patch.combined || null) : (prev.combined || null),
      mlx: Object.prototype.hasOwnProperty.call(patch, 'mlx') ? (patch.mlx || null) : (prev.mlx || null),
      gguf: Object.prototype.hasOwnProperty.call(patch, 'gguf') ? (patch.gguf || null) : (prev.gguf || null),
    };
    for (const key of ['combined', 'mlx', 'gguf']) {
      if (next[key] && !fs.existsSync(next[key])) throw new Error(`Scan dir not found: ${next[key]}`);
    }
    configService.set('settings.llm.scanDirs', next);
    try { modelManagerService.startWatching(next); } catch (_) { /* best effort */ }
    return next;
  });

  // Open a directory picker and return the chosen absolute path (or null on cancel).
  ipcMain.handle('llm:browse-scan-dir', async (_e, { title } = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Choose models folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  // Trigger a scan using the currently-persisted dirs. Returns a summary:
  //   { mlx: <found>, gguf: <found>, added: <newly registered>, skipped: <dupes> }
  ipcMain.handle('llm:scan-models', async () => {
    const dirs = configService.get('settings.llm.scanDirs', null);
    if (!dirs) return { mlx: 0, gguf: 0, added: 0, skipped: 0 };
    return modelManagerService.scanDirs(dirs);
  });
}

module.exports = { register };
