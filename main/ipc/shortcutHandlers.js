const { ipcMain } = require('electron');

function register(_mainWindow, { shortcutService, menuService }) {
  ipcMain.on('update-global-shortcut', (_, { action, key }) => {
    shortcutService.updateShortcut(action, key);
    menuService.buildAndSetMenus();
  });

  ipcMain.on('toggle-shortcuts-lock', () => {
    if (shortcutService.isLocked) {
      shortcutService.toggleLocked = false;
      shortcutService.registerToggle();
    } else {
      shortcutService.toggleLocked = true;
      shortcutService.unregisterToggle();
    }
  });
}

module.exports = { register };
