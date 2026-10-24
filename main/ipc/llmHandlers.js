const { ipcMain, dialog, shell } = require('electron');
const { mergeStartOpts, persistEngineSelection, persistResolvedEnginePath, isMlxBackend, isPythonBackend } = require('../../shared/llmDefaults');
const { buildMlxFallbackChain, pythonBackendMissingMessage, importDialogOptions } = require('../utils/llmStartHelpers');
const llmClient = require('../services/LLMClientService');

function register(mainWindow, { llmService, modelManagerService, engineDiscoveryService, configService }) {
  if (!llmService || !modelManagerService || !engineDiscoveryService) return;

  const send = (channel, payload) => { if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) mainWindow.webContents.send(channel, payload); };
  llmService.on('status-change', (e) => send('llm:status-changed', e));
  llmService.on('log', (e) => send('llm:log', e));
  llmService.on('error', (e) => send('llm:error', { message: e.message || String(e) }));
  llmService.on('model-loaded', (e) => send('llm:model-loaded', e));
  llmService.on('endpoint-changed', (e) => send('llm:endpoint-changed', e));
  llmService.on('fallback', (e) => send('llm:fallback', e));
  modelManagerService.on('models-changed', () => send('llm:models-changed', null));

  ipcMain.handle('llm:get-status', () => llmService.getStatus());
  ipcMain.handle('llm:get-endpoint', () => llmService.getEndpoint());
  ipcMain.handle('llm:get-logs', () => llmService.getLogs());
  ipcMain.handle('llm:get-capabilities', () => engineDiscoveryService.getPlatformCapabilities());
    ipcMain.handle('llm:detect-engines', (_e, opts = {}) => engineDiscoveryService.detectEngines({ force: !!opts.force }));

  ipcMain.handle('llm:list-models', () => {
    const customDir = configService && configService.get('settings.llm.modelsDir', null);
    if (customDir && customDir !== modelManagerService.getModelsDir()) modelManagerService.setModelsDir(customDir);
    return modelManagerService.listModels();
  });

  ipcMain.handle('llm:open-models-dir', async () => {
    const dir = modelManagerService.ensureModelsDir();
    const failure = await shell.openPath(dir); if (failure) throw new Error(`Could not open ${dir}: ${failure}`);
    return dir;
  });

  ipcMain.handle('llm:import-model', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, importDialogOptions(opts && opts.backend));
    if (r.canceled || !r.filePaths.length) return null;
    return modelManagerService.importModel(r.filePaths[0]);
  });

  ipcMain.handle('llm:delete-model', (_e, modelPath) => modelManagerService.deleteModel(modelPath));

  // Persist forceTextOnly under the actually-running backend (post-fallback).
  if (configService) llmService.on?.('auto-recovered-text-only', () => { try { const b = llmService.getStatus().backend; if (isMlxBackend(b)) configService.set(`settings.llm.${b}.forceTextOnly`, true); } catch (err) { console.error('auto-recovered-text-only persist failed', (err instanceof Error && err.message) || err); } });

  ipcMain.handle('llm:start', async (_e, opts = {}) => {
    const cfg = configService ? configService.get('settings.llm', {}) : {};
    const merged = mergeStartOpts(opts, cfg);
    if (isPythonBackend(merged.backend)) {
      merged.pythonPath = await engineDiscoveryService.resolveBackendPath(merged.backend, merged.pythonPath);
      if (!merged.pythonPath) throw new Error(pythonBackendMissingMessage(merged.backend));
    } else {
      merged.binaryPath = await engineDiscoveryService.resolveBackendPath('llamaCpp', merged.binaryPath);
      if (!merged.binaryPath) throw new Error('llama.cpp server binary not found in vendor/ or PATH. See Settings → LLM to configure.');
    }
    if (!merged.modelPath) throw new Error('No model selected. Pick one in Settings → LLM.');
    persistResolvedEnginePath(configService, merged);
    const info = modelManagerService.resolveModelInfo?.(merged.modelPath);
    if (info?.mmprojPath && !merged.mmprojPath && merged.backend === 'llamaCpp') merged.mmprojPath = info.mmprojPath;
    if (info?.isMultimodal && isMlxBackend(merged.backend) && merged.modelType === 'lm' && !merged.forceTextOnly) merged.modelType = 'multimodal';
    const fallbackChain = await buildMlxFallbackChain({ rawOpts: opts, merged, cfg, info, engineDiscoveryService });
    if (fallbackChain.length) merged.fallbackChain = fallbackChain;
    const status = await llmService.start(merged);
    persistEngineSelection(configService, merged);
    return status;
  });

  // Keep settings.llm.activeBackend on stop — preferred backend, not "currently running".
  ipcMain.handle('llm:stop', async () => { await llmService.stop(); return llmService.getStatus(); });

  ipcMain.handle('llm:set-remote', (_e, { endpoint, apiKey, model, visionCapable } = {}) => {
    llmService.setRemoteEndpoint(endpoint, apiKey, model, visionCapable);
    if (configService) {
      const ep = endpoint ? String(endpoint).trim().replace(/\/+$/, '').replace(/\/v1$/, '') : '';
      configService.set('settings.llm.remote', { ...(configService.get('settings.llm.remote', {}) || {}), endpoint: ep, apiKey: apiKey || '', model: model || '', visionCapable: !!visionCapable });
      configService.set('settings.llm.activeBackend', endpoint ? 'remote' : null); configService.set('settings.llm.mode', endpoint ? 'remote' : 'local'); // mode is what the startup restore reads — activeBackend doubles as the local-engine picker, so any engine selection overwrites it
    }
    return llmService.getStatus();
  });
  ipcMain.handle('llm:clear-remote', () => {
    llmService.clearRemoteEndpoint();
    if (configService) { configService.set('settings.llm.activeBackend', null); configService.set('settings.llm.mode', 'local'); } // mode too, or the next launch restores the saved URL/key
    return llmService.getStatus();
  });
  // Verify a candidate endpoint+key (Settings → LLM Verify) without persisting.
  ipcMain.handle('llm:verify-remote', async (_e, { endpoint, apiKey } = {}) => {
    if (!endpoint || typeof endpoint !== 'string') return { ok: false, error: 'Endpoint is required.' };
    try { const m = await llmClient.listModels({ endpoint: endpoint.trim(), apiKey: (apiKey || '').trim() }); return { ok: true, models: (m || []).map((x) => (typeof x === 'string' ? x : (x && (x.id || x.name)) || '')).filter(Boolean).sort() }; }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'Verify failed' }; }
  });
}

module.exports = { register };
