// notificationHandlers.js — IPC for the web-notifications inbox + permission prompts.

const { ipcMain, webContents: webContentsMod, BrowserWindow } = require('electron');

const RELAY = [
  ['added', 'notifications:added'], ['replaced', 'notifications:replaced'],
  ['dismissed', 'notifications:dismissed'], ['cleared', 'notifications:cleared'],
  ['read-changed', 'notifications:read-changed'],
];

function register(mainWindow, { notificationService, permissionPromptService, permissionService, sessionService } = /** @type {Partial<ICServices>} */ ({})) {
  if (!notificationService || !permissionPromptService || !permissionService) return;

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) mainWindow.webContents.send(channel, payload);
  };

  for (const [event, channel] of RELAY) notificationService.on(event, (e) => send(channel, e));
  for (const [ev, ch] of [['prompt', 'notifications:permission-prompt'], ['resolved', 'notifications:permission-resolved']]) permissionPromptService.on(ev, (e) => send(ch, e));
  if (mainWindow && mainWindow.webContents) permissionPromptService.denyOnRendererReset(mainWindow.webContents);

  permissionService.on('override-changed', (e) => {
    send('notifications:permission-changed', e);
    try {
      for (const wc of webContentsMod.getAllWebContents()) {
        try { wc.send('permission:changed', e); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
  });

  const ns = notificationService;
  // Private-tab senders: their notifications and remembered answers stay in memory.
  const fromPrivate = (wc) => !!(sessionService && sessionService.isPrivateContents(wc));
  ipcMain.handle('notifications:list', () => ns.list());
  ipcMain.handle('notifications:dismiss', (_e, id) => ns.dismiss(id));
  ipcMain.handle('notifications:clear-all', () => ns.clearAll());
  ipcMain.handle('notifications:mark-read', (_e, id) => ns.markRead(id));
  ipcMain.handle('notifications:mark-all-read', () => ns.markAllRead());

  ipcMain.handle('notifications:activate', (_e, id) => {
    const wcId = ns.getWebContentsIdFor(id);
    if (!wcId) return false;
    try {
      const wc = webContentsMod.fromId(wcId);
      if (!wc || wc.isDestroyed()) return false;
      const rec = ns.list().find((r) => r.id === id);
      // Preload live instances are keyed by their own localId; records without
      // one fall back to the record id, which the preload ignores.
      wc.send('notification:activate', (rec && rec.localId) || id);
      const hostWin = BrowserWindow.fromWebContents(wc) || mainWindow;
      if (hostWin && !hostWin.isDestroyed()) {
        if (hostWin.isMinimized()) hostWin.restore();
        hostWin.show(); hostWin.focus();
      }
      return true;
    } catch (_) { return false; }
  });

  ipcMain.handle('notifications:permission:list-overrides', () => permissionService.getOverrides());
  ipcMain.handle('notifications:permission:clear-override', (_e, { origin, permission } = {}) => (
    permission ? permissionService.clearOverride(origin || '*', permission) : false
  ));
  ipcMain.on('notifications:permission:resolve', (_e, p = {}) => {
    if (p.id) permissionPromptService.resolve(p.id, p.decision, !!p.remember);
  });

  ipcMain.on('notification:show', (event, payload = {}) => {
    try {
      const wc = event.sender;
      const webContentsId = wc && typeof wc.id === 'number' ? wc.id : null;
      const ephemeral = fromPrivate(wc);
      ns.add({
        origin: typeof payload.origin === 'string' ? payload.origin : (wc && wc.getURL ? wc.getURL() : ''),
        title: payload.title, body: payload.body,
        iconDataUrl: payload.iconDataUrl, iconUrl: payload.iconUrl,
        tag: payload.tag, data: payload.data,
        requireInteraction: payload.requireInteraction, silent: payload.silent,
        actions: payload.actions, webContentsId, ephemeral,
        localId: payload.localId,
      });
    } catch (err) { console.error('[notifications] add failed:', err); }
  });

  ipcMain.handle('permission:check', (e, origin, permission) => (
    permission ? permissionService.decide(origin, permission, { ephemeral: fromPrivate(e.sender) }) : 'deny'
  ));
  ipcMain.handle('permission:request', async (e, origin, permission) => {
    if (!permission) return 'denied';
    const ephemeral = fromPrivate(e.sender);
    let d = permissionService.decide(origin, permission, { ephemeral });
    if (d === 'prompt') d = await permissionPromptService.requestDecision(origin, permission, undefined, { ephemeral });
    return d === 'allow' ? 'granted' : 'denied';
  });
}

module.exports = { register };
