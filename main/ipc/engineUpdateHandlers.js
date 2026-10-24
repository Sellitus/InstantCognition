// Engine update IPC: the daily runtime check, the manual check from Settings,
// the per-send offer of the selected engine's update, and the install (with an
// optional engine restart) the user triggers from the toast or Settings.
const { ipcMain, app } = require('electron');
const engineUpdateService = require('../services/EngineUpdateService');
const chatStream = require('../services/ChatStreamService');
const userMemory = require('../services/UserMemoryService');
const { UPDATABLE_ENGINES } = require('../services/llm/engineUpdatePrompt');

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {Partial<ICServices>} [services]
 */
function register(mainWindow, services = /** @type {Partial<ICServices>} */ ({})) {
  const { configService, llmService } = services;
  engineUpdateService.initialize(mainWindow, configService, { llmService, chatStream, userMemory });

  ipcMain.on('engine-updater:check-now', () => { engineUpdateService.check({ background: false }); });

  ipcMain.on('engine-updater:user-send', () => { engineUpdateService.offerSelected(); });

  ipcMain.handle('engine-updater:install', (_e, engine, opts) => {
    if (!UPDATABLE_ENGINES.includes(engine)) return { ok: false, error: `Unknown engine: ${engine}` };
    return engineUpdateService.install(engine, { restart: !!(opts && opts.restart === true) });
  });

  app.on('before-quit', () => engineUpdateService.stop());
}

module.exports = { register };
