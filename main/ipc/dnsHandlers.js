// DNS resolver IPC: drives DnsService from the renderer settings UI.
const { ipcMain } = require('electron');
const { errMsg } = require('../../shared/errMsg');

function broadcast(mw) {
  if (mw && typeof mw.isDestroyed === 'function' && !mw.isDestroyed()) {
    try { mw.webContents.send('config:changed', { kind: 'dns-applied' }); } catch (_) {}
  }
}

function register(mainWindow, services) {
  const { dnsService } = services || {};
  if (!dnsService) return;

  ipcMain.on('dns:apply', () => {
    try { dnsService.applyFromConfig(); broadcast(mainWindow); }
    catch (err) { console.warn('[dns] apply failed:', errMsg(err)); }
  });

  ipcMain.handle('dns:validate', async (_e, url) => {
    try { return await dnsService.validateDohUrl(url); }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'Validation failed.' }; }
  });

}

module.exports = { register };
