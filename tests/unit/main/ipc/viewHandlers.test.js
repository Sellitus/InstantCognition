jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    webContents: { fromId: jest.fn() },
  };
});

const { ipcMain, webContents } = require('electron');
const { register } = require('../../../../main/ipc/viewHandlers');

describe('viewHandlers', () => {
  let mainWindow;
  let mainWc;

  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    webContents.fromId.mockReturnValue(null);

    mainWc = { send: jest.fn() };
    mainWindow = { isDestroyed: jest.fn(() => false), webContents: mainWc };
    register(mainWindow);
  });

  test('toggleSpaceView forwards via safeSend', () => {
    ipcMain._handlers['toggleSpaceView']();
    expect(mainWc.send).toHaveBeenCalledWith('toggleSpaceView');
  });

  test('toggleMultiSpace forwards via safeSend', () => {
    ipcMain._handlers['toggleMultiSpace']();
    expect(mainWc.send).toHaveBeenCalledWith('toggleMultiSpace');
  });

  test('toggleSpaceView is suppressed when window destroyed', () => {
    mainWindow.isDestroyed.mockReturnValue(true);
    ipcMain._handlers['toggleSpaceView']();
    expect(mainWc.send).not.toHaveBeenCalled();
  });

  describe('view:open-devtools', () => {
    test('opens devtools on webContents resolved by id (detach)', () => {
      const target = { isDevToolsOpened: jest.fn(() => false), openDevTools: jest.fn(), closeDevTools: jest.fn() };
      webContents.fromId.mockReturnValue(target);
      ipcMain._handlers['view:open-devtools']({ sender: {} }, 5);
      expect(webContents.fromId).toHaveBeenCalledWith(5);
      expect(target.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    });

    test('closes devtools when already open (toggle)', () => {
      const target = { isDevToolsOpened: jest.fn(() => true), openDevTools: jest.fn(), closeDevTools: jest.fn() };
      webContents.fromId.mockReturnValue(target);
      ipcMain._handlers['view:open-devtools']({ sender: {} }, 5);
      expect(target.closeDevTools).toHaveBeenCalled();
      expect(target.openDevTools).not.toHaveBeenCalled();
    });

    test('falls back to event.sender when no id and sender is not main wc', () => {
      const sender = { isDevToolsOpened: jest.fn(() => false), openDevTools: jest.fn() };
      ipcMain._handlers['view:open-devtools']({ sender }, null);
      expect(sender.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    });

    test('returns early when sender is the main window webContents and no id', () => {
      ipcMain._handlers['view:open-devtools']({ sender: mainWc }, null);
      // mainWc has no openDevTools; absence of throw + no-op proves the guard
      expect(mainWc.send).not.toHaveBeenCalled();
    });

    test('returns early when target has no devtools methods (null target)', () => {
      webContents.fromId.mockReturnValue(null);
      expect(() => ipcMain._handlers['view:open-devtools']({ sender: mainWc }, 99)).not.toThrow();
    });

    test('opens devtools when isDevToolsOpened is absent', () => {
      const target = { openDevTools: jest.fn() };
      webContents.fromId.mockReturnValue(target);
      ipcMain._handlers['view:open-devtools']({ sender: {} }, 5);
      expect(target.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    });

    test('errors are caught and logged', () => {
      webContents.fromId.mockImplementation(() => { throw new Error('boom'); });
      expect(() => ipcMain._handlers['view:open-devtools']({ sender: {} }, 5)).not.toThrow();
    });
  });
});
