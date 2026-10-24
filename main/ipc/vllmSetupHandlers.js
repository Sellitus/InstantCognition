// vLLM setup IPC: Settings → LLM → Engines "Set up vLLM" runs the guided
// setup (llm/vllmSetup.js), streaming each step on vllm-setup:progress, and
// offers the Windows restart the WSL install ends with.
const { ipcMain } = require('electron');
const { runSetup, restartWindows } = require('../services/llm/vllmSetup');
const { errMsg } = require('../../shared/errMsg');

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {Partial<ICServices>} [services]
 */
function register(mainWindow, services = /** @type {Partial<ICServices>} */ ({})) {
  const { engineDiscoveryService } = services;
  if (!engineDiscoveryService) return;
  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) mainWindow.webContents.send('vllm-setup:progress', payload);
  };

  ipcMain.handle('vllm-setup:status', () => engineDiscoveryService.detectVllm());

  ipcMain.handle('vllm-setup:run', async () => {
    try {
      const result = await runSetup({ send });
      engineDiscoveryService.clearCache();
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle('vllm-setup:restart', async () => {
    try {
      await restartWindows();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
}

module.exports = { register };
