// IPC for the address-bar suggestion dropdown. Main picks the engine and its
// endpoint from config, so the renderer can only supply the typed text.
const { ipcMain, net } = require('electron');
const { fetchSuggestions } = require('../services/searchSuggest');

function register(_mainWindow, services) {
  const { configService } = services || {};
  if (!configService) return;

  ipcMain.handle('search:suggest', async (_e, payload = {}) => {
    if (!configService.get('settings.searchSuggestionsEnabled', true)) return { ok: true, suggestions: [] };
    try {
      const suggestions = await fetchSuggestions({
        engine: configService.get('settings.defaultSearchEngine', 'google'),
        customEngines: configService.get('settings.customSearchEngines', []),
        query: payload && typeof payload.query === 'string' ? payload.query : '',
        fetch: (url, init) => net.fetch(url, init),
      });
      return { ok: true, suggestions };
    } catch (err) {
      console.warn('[search:suggest] suggestions unavailable:', (err instanceof Error && err.message) || err);
      return { ok: false, error: (err instanceof Error && err.message) || String(err) };
    }
  });
}

module.exports = { register };
