jest.mock('electron', () => {
  const handlers = {};
  return {
    app: {
      getPath: jest.fn(() => '/mock'),
      isPackaged: false,
      quit: jest.fn(),
      relaunch: jest.fn(),
    },
    ipcMain: {
      on: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      handle: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      _handlers: handlers,
    },
  };
});

jest.mock('electron-prompt', () => jest.fn().mockResolvedValue(null));

const { ipcMain, app } = require('electron');
const { register } = require('../../../../main/ipc/windowHandlers');

describe('windowHandlers', () => {
  let mockMainWindow;
  let mockServices;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((ch, fn) => { ipcMain._handlers[ch] = fn; });

    mockMainWindow = { isDestroyed: () => false, webContents: { send: jest.fn() } };
    mockServices = {
      shortcutService: { toggleWindow: jest.fn() },
      menuService: { setAppQuitting: jest.fn() },
      errorHandler: { logRendererError: jest.fn() },
    };
    register(mockMainWindow, mockServices);
  });

  test('toggle-window calls shortcutService.toggleWindow', () => {
    ipcMain._handlers['toggle-window']();
    expect(mockServices.shortcutService.toggleWindow).toHaveBeenCalled();
  });

  test('quitApp sets isAppQuitting and calls app.quit', () => {
    ipcMain._handlers['quitApp']();
    expect(mockServices.menuService.setAppQuitting).toHaveBeenCalledWith(true);
    expect(app.quit).toHaveBeenCalled();
  });

  test('restart-app calls app.relaunch then app.quit', () => {
    ipcMain._handlers['restart-app']();
    expect(mockServices.menuService.setAppQuitting).toHaveBeenCalledWith(true);
    expect(app.relaunch).toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalled();
  });

  test('zoomInActive forwards correct channel to renderer', () => {
    ipcMain._handlers['zoomInActive']();
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('zoomInActive');
  });

  test('zoomOutActive forwards zoomOutActive (not zoomInActive — bug fix)', () => {
    ipcMain._handlers['zoomOutActive']();
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('zoomOutActive');
  });

  test('zoomResetActive forwards zoomResetActive (not zoomInActive — bug fix)', () => {
    ipcMain._handlers['zoomResetActive']();
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('zoomResetActive');
  });

  test('renderer-error calls errorHandler.logRendererError', () => {
    const errorInfo = { message: 'test error' };
    ipcMain._handlers['renderer-error'](null, errorInfo);
    expect(mockServices.errorHandler.logRendererError).toHaveBeenCalledWith(errorInfo);
  });
});
