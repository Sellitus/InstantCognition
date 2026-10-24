// Routine IPC — the renderer reports a dispatched routine's outcome back
// ('routine:ran') so RoutineService only advances lastRunAt on a real
// completion, and exposes a manual "Run now" trigger for the settings UI.

const { ipcMain } = require('electron');

function register(_mainWindow, services = {}) {
  const { routineService } = /** @type {any} */ (services);
  if (!routineService) return;

  ipcMain.on('routine:ran', (_e, payload) => {
    try { routineService.noteRan(payload || {}); } catch (_) { /* best effort */ }
  });

  ipcMain.handle('routine:run-now', async (_e, payload) => {
    try { return routineService.runNow((payload || {}).id); }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'failed' }; }
  });
}

module.exports = { register };
