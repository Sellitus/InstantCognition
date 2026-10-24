jest.mock('electron', () => {
  const handlers = {};
  return {
    app: {
      getPath: jest.fn(() => '/mock'),
      isPackaged: false,
      setLoginItemSettings: jest.fn(),
      getLoginItemSettings: jest.fn(() => ({ openAtLogin: false })),
    },
    ipcMain: {
      on: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      handle: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      _handlers: handlers,
    },
  };
});

const { ipcMain, app } = require('electron');
const { register } = require('../../../../main/ipc/settingsHandlers');

describe('settingsHandlers', () => {
  let mockMainWindow;
  let mockServices;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((ch, fn) => { ipcMain._handlers[ch] = fn; });
    ipcMain.handle.mockImplementation((ch, fn) => { ipcMain._handlers[ch] = fn; });

    mockMainWindow = { isDestroyed: () => false, webContents: { send: jest.fn() } };
    // adblocker channels (call-createAndUpdateaAblocker, call-disableAdblocker)
    // moved to main/ipc/adblockerHandlers.js — covered by adblockerHandlers.test.js.
    mockServices = {
      certService: { setAutoDeny: jest.fn() },
    };
    register(mockMainWindow, mockServices);
  });

  test('call-enableLaunchAtStartup calls app.setLoginItemSettings', () => {
    ipcMain._handlers['call-enableLaunchAtStartup']();
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });

  test('call-isLaunchAtStartupEnabled returns current login item settings', () => {
    app.getLoginItemSettings.mockReturnValue({ openAtLogin: true });
    const result = ipcMain._handlers['call-isLaunchAtStartupEnabled']();
    expect(result).toBe(true);
  });

  test('set-auto-deny-cert-errors calls certService.setAutoDeny', () => {
    ipcMain._handlers['set-auto-deny-cert-errors'](null, true);
    expect(mockServices.certService.setAutoDeny).toHaveBeenCalledWith(true);
  });
});
