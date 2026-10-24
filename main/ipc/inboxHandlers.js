// Inbox IPC: list, mark read, delete and clear the results of background work
// (InboxService). Every change is pushed as 'inbox:changed' {reason, unread}
// so the Assistant pill badge stays current without polling.
const { ipcMain } = require('electron');
const { assertItemId } = require('../services/InboxService');

const msg = (err) => (err instanceof Error && err.message) || String(err);
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
  try { return await fn(arg && typeof arg === 'object' ? arg : {}); } catch (err) { return { ok: false, error: msg(err) }; }
});

function register(mainWindow, services) {
  const inbox = services && services.inboxService;
  if (!inbox) return;
  inbox.on('changed', (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('inbox:changed', e);
  });

  handle('inbox:list', () => ({ ok: true, items: inbox.list(), unread: inbox.unreadCount() }));
  handle('inbox:mark-read', ({ id, all, read }) => {
    if (read !== undefined && typeof read !== 'boolean') throw new Error('invalid_read_flag');
    if (all === true) return inbox.markAllRead();
    return inbox.markRead(assertItemId(id), read !== false);
  });
  handle('inbox:delete', ({ id }) => inbox.delete(assertItemId(id)));
  handle('inbox:clear', () => inbox.clear());
}

module.exports = { register };
