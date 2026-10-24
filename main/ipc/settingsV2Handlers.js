// Settings v2 IPC: side-effect channels for the registry-driven settings UI.
const { ipcMain, dialog, app, shell, session } = require('electron');

const warn = (tag, err) => console.warn(`[settings] ${tag} failed:`, err && /** @type {any} */ (err).message);

function broadcast(mw, payload) {
  if (mw && typeof mw.isDestroyed === 'function' && !mw.isDestroyed()) {
    try { mw.webContents.send('config:changed', payload); }
    catch (err) { warn('config:changed broadcast', err); }
  }
}

function register(mainWindow, services) {
  const { configService } = services || {};

  ipcMain.handle('dialog:choose-directory', async (_e, opts = {}) => {
    const target = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined;
    try {
      const r = await dialog.showOpenDialog(target, { title: opts.title || 'Choose folder', properties: ['openDirectory', 'createDirectory'], defaultPath: opts.defaultPath });
      return (r.canceled || !r.filePaths || !r.filePaths.length) ? null : r.filePaths[0];
    } catch (_) { return null; }
  });

  ipcMain.on('settings:apply-spellcheck', () => {
    if (!configService) return;
    const enabled = configService.get('settings.spellCheck.enabled', false);
    const langs = configService.get('settings.spellCheck.languages', ['en-US']);
    try {
      const ses = session.defaultSession;
      if (!ses || typeof ses.setSpellCheckerEnabled !== 'function') return;
      ses.setSpellCheckerEnabled(!!enabled);
      if (enabled && Array.isArray(langs) && langs.length && typeof ses.setSpellCheckerLanguages === 'function') ses.setSpellCheckerLanguages(langs);
    } catch (err) { warn('apply-spellcheck', err); }
  });

  ipcMain.on('settings:apply-accept-languages', () => {
    if (!configService) return;
    const langs = configService.get('settings.acceptLanguages', ['en-US', 'en']);
    if (!Array.isArray(langs) || !langs.length) return;
    try {
      const ses = /** @type {any} */ (session.defaultSession);
      if (ses && typeof ses.setUserAgent === 'function') ses.setUserAgent(ses.getUserAgent(), langs.join(','));
    } catch (err) { warn('apply-accept-languages', err); }
  });

  ipcMain.on('settings:set-log-level', (_e, level) => {
    try {
      const lg = /** @type {any} */ (require('../utils/logger'));
      if (lg && typeof lg.setLevel === 'function') lg.setLevel(String(level || 'info'));
    } catch (err) { warn('set-log-level', err); }
  });

  ipcMain.on('settings:set-default-browser', () => {
    try { app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); }
    catch (err) { warn('set-default-browser', err); }
  });

  ipcMain.on('settings:reset-all', () => {
    if (!configService) return;
    try {
      const { DEFAULT_CONFIG } = require('../../shared/configDefaults');
      const fresh = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      const preservedSpaces = configService.get('spaces') || fresh.spaces;
      const preservedState = configService.get('state') || fresh.state;
      configService.replaceAll({ ...fresh, spaces: preservedSpaces, state: preservedState });
      broadcast(mainWindow, { kind: 'replace' });
    } catch (err) { warn('reset-all', err); }
  });

  ipcMain.on('open-external-url', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url).catch((err) => warn('open-external-url', err));
  });

  ipcMain.on('webviews:set-zoom-default', (_e, factor) => {
    const f = Number(factor);
    if (!Number.isFinite(f) || !mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return;
    try { mainWindow.webContents.send('webviews:set-zoom-default', f); } catch (err) { warn('set-zoom-default', err); }
  });
}

module.exports = { register };
