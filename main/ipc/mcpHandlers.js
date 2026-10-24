// MCP IPC: surfaces Model Context Protocol server status to the renderer. Tool
// browsing/call channels were removed (no renderer or preload consumer). Server config lives in settings.mcp.servers and is edited through the standard config IPC; these handlers are read/query + lifecycle only, so there is one source of truth for server definitions.
const { ipcMain } = require('electron');

function register(_mainWindow, services) {
  const { mcpService } = services || {};
  if (!mcpService) return;

  ipcMain.handle('mcp:available', () => ({
    ok: true,
    available: mcpService.isAvailable(),
    enabled: !!(mcpService._config && mcpService._config.enabled),
  }));

  ipcMain.handle('mcp:status', () => ({ ok: true, servers: mcpService.getStatus() }));

  ipcMain.handle('mcp:reload', async () => {
    try { await mcpService._reload(); return { ok: true }; }
    catch (err) { return { ok: false, error: (err instanceof Error && err.message) || 'reload_failed' }; }
  });
}

module.exports = { register };
