const { ipcMain } = require('electron');
const semanticIndex = require('../services/SemanticIndexService');
const contentIndex = require('../services/ContentIndexService');

// Mirrors SemanticIndexService's MAX_CORPUS: Ask searches at most the last
// 5000 history entries, so content entries for URLs outside the live set are
// unreachable and can be dropped.
const CONTENT_CORPUS_CAP = 5000;

// Drop content-index entries that Ask can no longer reach: a URL is live when
// it is among the most recent history entries or a bookmark. Called after each
// history mutation so semantic_content.json tracks the corpus instead of
// growing for the life of the install. Best-effort maintenance: a failure is
// logged, never fails the history mutation it follows.
function pruneContentIndex(historyService, bookmarkService) {
  try {
    const live = new Set((historyService.getRecent(CONTENT_CORPUS_CAP) || []).map((e) => e.url).filter(Boolean));
    if (bookmarkService && typeof bookmarkService.getTree === 'function') {
      const walk = (n) => {
        if (!n) return;
        if (n.type === 'bookmark' && n.url) live.add(n.url);
        (n.children || []).forEach(walk);
      };
      walk(bookmarkService.getTree());
    }
    contentIndex.prune(Array.from(live));
  } catch (err) {
    console.error('[browserDataHandlers] content index prune failed:', (err instanceof Error && err.message) || err);
  }
}

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {Partial<ICServices>} services
 */
function register(mainWindow, { historyService, bookmarkService, downloadService } = {}) {
  ipcMain.handle('browsing:ask', (_e, opts = {}) => semanticIndex.search(opts.query || '', { limit: opts.limit }));
    // Capture a visited page's readable body text for content-aware Ask ranking.
  // No-op unless settings.askBrowsing.indexContent is on (opt-in).
  ipcMain.handle('browsing:capture-content', (_e, { url, text } = {}) => {
    const changed = contentIndex.capture(url, text);
    return { ok: true, captured: changed };
  });

  if (historyService) {
    ipcMain.handle('history:add', (_e, entry) => {
      const added = historyService.addEntry(entry || {});
      pruneContentIndex(historyService, bookmarkService);
      return added;
    });
    ipcMain.handle('history:search', (_e, opts = {}) => historyService.search(opts.query || '', opts));
    ipcMain.handle('history:recent', (_e, opts = {}) => historyService.getRecent((opts && opts.limit) || 50));
    ipcMain.handle('history:delete', (_e, id) => {
      const ok = historyService.deleteEntry(id);
      pruneContentIndex(historyService, bookmarkService);
      return ok;
    });
    ipcMain.handle('history:clear', () => {
      historyService.clearAll();
      pruneContentIndex(historyService, bookmarkService);
      return { ok: true };
    });
  }

  if (bookmarkService) {
    ipcMain.handle('bookmarks:tree', () => bookmarkService.getTree());
    ipcMain.handle('bookmarks:search', (_e, opts = {}) => bookmarkService.search(opts.query || ''));
    // Star toggle in one round trip, so the renderer never has to mirror
    // bookmark state to decide between add and remove.
    ipcMain.handle('bookmarks:toggle', (_e, { url, title } = {}) => {
      const existing = bookmarkService.findByUrl(url);
      if (existing) {
        bookmarkService.remove(existing.id);
        return { added: false, url };
      }
      const item = bookmarkService.add({ url, title });
      return { added: true, url, id: item.id };
    });
    ipcMain.handle('bookmarks:remove', (_e, id) => bookmarkService.remove(id));
  }

  if (downloadService) {
    const send = (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send(channel, payload);
      }
    };
    downloadService.on('download-started', (e) => send('downloads:started', e));
    downloadService.on('download-updated', (e) => send('downloads:updated', e));
    downloadService.on('download-done', (e) => send('downloads:done', e));

    ipcMain.handle('downloads:active', () => downloadService.getActive());
    ipcMain.handle('downloads:history', () => downloadService.getHistory());
    ipcMain.handle('downloads:clear-history', () => { downloadService.clearHistory(); return { ok: true }; });
  }
}

module.exports = { register };
