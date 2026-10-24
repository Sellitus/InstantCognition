// User memory IPC: drives the User Memory settings tab and powers the
// system-prompt injection that runs in AgentService.startTask.
const { ipcMain, dialog } = require('electron');
const fs = require('fs');

const FORMAT = 'instantcognition.usermemory.v1';

function register(mainWindow, services) {
  const { userMemoryService, configService } = services || {};
  if (!userMemoryService) return;

  ipcMain.handle('usermemory:list', (_e, opts) => {
    try { return { ok: true, enabled: userMemoryService.isEnabled(), facts: userMemoryService.list(opts || {}) }; }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'list failed' }; }
  });

  ipcMain.handle('usermemory:add', (_e, { text, pinned } = {}) => {
    try { const f = userMemoryService.add(text, { pinned: !!pinned }); return f ? { ok: true, fact: f } : { ok: false, error: 'empty_text' }; }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'add failed' }; }
  });

  ipcMain.handle('usermemory:edit', (_e, { id, patch } = {}) => {
    try { const f = userMemoryService.edit(id, patch || {}); return f ? { ok: true, fact: f } : { ok: false, error: 'not_found' }; }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'edit failed' }; }
  });

  ipcMain.handle('usermemory:delete', (_e, id) => {
    try { return { ok: userMemoryService.remove(id) }; }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'delete failed' }; }
  });

  ipcMain.handle('usermemory:archive', (_e, { id, on = true } = {}) => {
    try { const f = on ? userMemoryService.archive(id) : userMemoryService.unarchive(id); return f ? { ok: true, fact: f } : { ok: false, error: 'not_found' }; }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'archive failed' }; }
  });

  ipcMain.handle('usermemory:pin', (_e, { id, on = true } = {}) => {
    try { const f = userMemoryService.pin(id, on); return f ? { ok: true, fact: f } : { ok: false, error: 'not_found' }; }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'pin failed' }; }
  });

  ipcMain.on('usermemory:enable', (_e, on) => { userMemoryService.enable(!!on); });

  ipcMain.handle('usermemory:clear-all', () => {
    try { userMemoryService.clearAll(); return { ok: true }; }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'clear failed' }; }
  });

  ipcMain.handle('usermemory:export', async () => {
    if (!configService) return { ok: false, error: 'no_config' };
    const r = await dialog.showSaveDialog(mainWindow, { title: 'Export user memory', defaultPath: 'instantcognition-memory.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      const facts = userMemoryService.list({ includeArchived: true });
      fs.writeFileSync(r.filePath, JSON.stringify({ format: FORMAT, exportedAt: new Date().toISOString(), facts }, null, 2));
      return { ok: true, path: r.filePath, count: facts.length };
    } catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'export failed' }; }
  });

  ipcMain.handle('usermemory:import', async (_e, { mode = 'merge' } = {}) => {
    if (!configService) return { ok: false, error: 'no_config' };
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Import user memory', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    try {
      const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      if (!data || data.format !== FORMAT || !Array.isArray(data.facts)) return { ok: false, error: 'unrecognized_format' };
      let added = 0; let skipped = 0;
      if (mode === 'replace') {
        userMemoryService.replaceAll(data.facts);
        added = data.facts.length;
      } else {
        const existing = userMemoryService.list({ includeArchived: true });
        const seen = new Set(existing.map((f) => (f.text || '').toLowerCase()));
        for (const f of data.facts) {
          const text = String((f && f.text) || '').trim();
          if (!text) { skipped += 1; continue; }
          if (seen.has(text.toLowerCase())) { skipped += 1; continue; }
          userMemoryService.add(text, { pinned: !!(f && f.pinned), source: 'imported' });
          seen.add(text.toLowerCase());
          added += 1;
        }
      }
      try { mainWindow && mainWindow.webContents && mainWindow.webContents.send('config:changed', { kind: 'replace' }); } catch (_) {}
      return { ok: true, path: r.filePaths[0], added, skipped };
    } catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'import failed' }; }
  });
}

module.exports = { register };
