jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
  };
});

const { ipcMain } = require('electron');
const { register } = require('../../../../main/ipc/shortcutHandlers');

describe('shortcutHandlers', () => {
  let shortcutService;
  let menuService;

  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });

    shortcutService = {
      updateShortcut: jest.fn(),
      isLocked: false,
      toggleLocked: false,
      registerToggle: jest.fn(),
      unregisterToggle: jest.fn(),
    };
    menuService = { buildAndSetMenus: jest.fn() };
    register({}, { shortcutService, menuService });
  });

  test('update-global-shortcut updates and rebuilds menus', () => {
    ipcMain._handlers['update-global-shortcut']({}, { action: 'toggle', key: 'Ctrl+Space' });
    expect(shortcutService.updateShortcut).toHaveBeenCalledWith('toggle', 'Ctrl+Space');
    expect(menuService.buildAndSetMenus).toHaveBeenCalled();
  });

  test('toggle-shortcuts-lock: unlocks when currently locked', () => {
    shortcutService.isLocked = true;
    ipcMain._handlers['toggle-shortcuts-lock']();
    expect(shortcutService.toggleLocked).toBe(false);
    expect(shortcutService.registerToggle).toHaveBeenCalled();
    expect(shortcutService.unregisterToggle).not.toHaveBeenCalled();
  });

  test('toggle-shortcuts-lock: locks when currently unlocked', () => {
    shortcutService.isLocked = false;
    ipcMain._handlers['toggle-shortcuts-lock']();
    expect(shortcutService.toggleLocked).toBe(true);
    expect(shortcutService.unregisterToggle).toHaveBeenCalled();
    expect(shortcutService.registerToggle).not.toHaveBeenCalled();
  });
});
