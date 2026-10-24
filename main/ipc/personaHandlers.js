// Persona IPC: drives the agent persona picker, settings editor, and
// session-only lock from the renderer. Import/export plumbing lives in
// PersonaIoService so this file stays under the 100-line IPC cap.
const { ipcMain, dialog } = require('electron');
const personaIo = require('../services/PersonaIoService');
const personaPacks = require('../../shared/personaPacks');

function register(mainWindow, services) {
  const { personaService, personaRouter, configService } = services || {};
  if (!personaService || !personaRouter) return;

  ipcMain.handle('persona:list', () => {
    try { return { all: personaService.listAll(), enabled: personaService.listEnabled(), lock: personaRouter.getLock() }; }
    catch (err) { return { all: [], enabled: [], lock: null, error: (err instanceof Error && err.message) || 'list failed' }; }
  });

  ipcMain.handle('persona:test-route', async (_e, { description, sync } = {}) => {
    try {
      const text = String(description || '');
      const r = sync ? personaRouter.routeSync(text) : await personaRouter.route(text);
      return { ok: true, ...r };
    } catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'route failed' }; }
  });

  ipcMain.on('persona:lock', (_e, name) => {
    personaRouter.setLock(name && typeof name === 'string' ? name : null);
  });
  ipcMain.on('persona:reset-lock', () => { personaRouter.clearLock(); });
  ipcMain.handle('persona:clear-cache', () => {
    try { personaRouter.clearCache(); return { ok: true }; }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'clear failed' }; }
  });
  ipcMain.handle('persona:export', async () => {
    if (!configService) return { ok: false, error: 'no_config' };
    const r = await dialog.showSaveDialog(mainWindow, { title: 'Export personas', defaultPath: 'instantcognition-personas.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try { return await personaIo.exportToPath(r.filePath, configService); }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'export failed' }; }
  });

  ipcMain.handle('persona:import', async () => {
    if (!configService) return { ok: false, error: 'no_config' };
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Import personas', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    try {
      const out = await personaIo.importFromPath(r.filePaths[0], configService);
      if (out.ok) try { mainWindow && mainWindow.webContents && mainWindow.webContents.send('config:changed', { kind: 'replace' }); } catch (_) {}
      return { ...out, path: r.filePaths[0] };
    } catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'import failed' }; }
  });

  // Curated vertical packs. apply = install the pack persona via the existing
  // import path (free sanitize + enable + re-render) + open its starter panes;
  // run-task launches the pack's reusable agent task (see shared/personaPacks).
  const send = (c, p) => { try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send(c, p); } catch (_) {} };
  ipcMain.handle('pack:apply', (_e, { id } = {}) => {
    if (!configService) return { ok: false, error: 'no_config' };
    const pack = personaPacks.getPack(id);
    if (!pack) return { ok: false, error: 'not_found' };
    try {
      const out = personaIo.applyImport(
        { format: personaIo.FORMAT, exportedAt: new Date().toISOString(), customPersonas: [pack.persona], builtinOverrides: {} },
        configService,
      );
      if (out && out.ok) {
        send('config:changed', { kind: 'replace' });
        send('pack:open-panes', { label: pack.label, panes: pack.panes });
      }
      return { ...out, label: pack.label };
    } catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'apply failed' }; }
  });
  ipcMain.handle('pack:run-task', (_e, { id } = {}) => {
    const pack = personaPacks.getPack(id);
    if (!pack || !pack.task) return { ok: false, error: 'not_found' };
    send('pack:run-task', { label: pack.label, task: pack.task }); return { ok: true };
  });
}

module.exports = { register };
