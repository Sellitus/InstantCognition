// Engine IPC: the inference-engine surface surfaced to the chat popover for
// quick switching (backend catalog + availability + active selection, and the
// scanned model list). Deep per-backend tuning lives in Settings → LLM; this
// handler is read/query + select-backend only, delegating to engineSchema and
// the existing discovery/model-manager services so there is one source of truth.
const { ipcMain } = require('electron');
const { composeBackendsPayload } = require('../../shared/engineSchema');

function register(_mainWindow, services) {
  const { llmService, engineDiscoveryService, modelManagerService, configService } = services || {};
  if (!llmService || !engineDiscoveryService) return;

  // Catalog of platform-appropriate backends, each annotated installed/active.
  ipcMain.handle('llm:backends', async () => {
    const det = await engineDiscoveryService.detectEngines();
    const active = (configService && configService.get('settings.llm.activeBackend', null)) || null;
    const remote = configService && configService.get('settings.llm.remote', null);
    return { backends: composeBackendsPayload(det, active, remote), active, status: llmService.getStatus() };
  });

  // Select the active backend (persisted, not started). Switching takes effect
  // on the next engine start; a running engine keeps its current backend.
  ipcMain.handle('llm:select-backend', (_e, backendId) => {
    if (typeof backendId !== 'string' || !backendId) return { ok: false, error: 'invalid_backend' };
    if (configService) configService.set('settings.llm.activeBackend', backendId);
    return { ok: true, active: backendId, status: llmService.getStatus() };
  });

  // Scanned local models for the popover's model picker.
  ipcMain.handle('llm:list-models-popover', () => {
    if (!modelManagerService) return { ok: false, error: 'model_manager_unavailable' };
    const customDir = configService && configService.get('settings.llm.modelsDir', null);
    if (customDir && customDir !== modelManagerService.getModelsDir()) modelManagerService.setModelsDir(customDir);
    return { ok: true, models: modelManagerService.listModels() };
  });
}

module.exports = { register };
