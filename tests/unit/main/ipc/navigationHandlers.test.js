jest.mock('electron', () => {
  const handlers = {};
  return {
    app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
  };
});

const { ipcMain } = require('electron');
const { register } = require('../../../../main/ipc/navigationHandlers');

describe('navigationHandlers', () => {
  let mockMainWindow;

  beforeEach(() => {
    jest.clearAllMocks();
    ipcMain._handlers = {};
    ipcMain.on.mockImplementation((ch, fn) => { ipcMain._handlers[ch] = fn; });

    mockMainWindow = {
      isDestroyed: () => false,
      webContents: { send: jest.fn() },
    };
    register(mockMainWindow);
  });

  test('registers handlers for navigate-back, forward, refresh, home', () => {
    const channels = Object.keys(ipcMain._handlers);
    expect(channels).toContain('navigate-back');
    expect(channels).toContain('navigate-forward');
    expect(channels).toContain('navigate-refresh');
    expect(channels).toContain('navigate-home');
    expect(channels).toContain('refreshActive');
  });

  test('navigate-back from renderer forwards as navigateBackActive', () => {
    ipcMain._handlers['navigate-back']({ sender: mockMainWindow.webContents });
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('navigateBackActive');
  });

  test('navigate-back from webview navigates the webview directly', () => {
    const mockWebviewContents = {
      navigationHistory: {
        goBack: jest.fn(),
      },
    };
    ipcMain._handlers['navigate-back']({ sender: mockWebviewContents });
    expect(mockWebviewContents.navigationHistory.goBack).toHaveBeenCalled();
    expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
  });

  test('navigate-forward from renderer forwards as navigateForwardActive', () => {
    ipcMain._handlers['navigate-forward']({ sender: mockMainWindow.webContents });
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('navigateForwardActive');
  });

  test('navigate-forward from webview navigates the webview directly', () => {
    const mockWebviewContents = {
      navigationHistory: {
        goForward: jest.fn(),
      },
    };
    ipcMain._handlers['navigate-forward']({ sender: mockWebviewContents });
    expect(mockWebviewContents.navigationHistory.goForward).toHaveBeenCalled();
    expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
  });

  test('navigate-back falls back to renderer on webContents error', () => {
    const brokenWebviewContents = {
      navigationHistory: null,
    };
    ipcMain._handlers['navigate-back']({ sender: brokenWebviewContents });
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('navigateBackActive');
  });

  test('navigate-refresh forwards to renderer as refreshActive', () => {
    ipcMain._handlers['navigate-refresh']();
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('refreshActive');
  });

  test('navigate-home forwards to renderer as navigateHomeReset', () => {
    ipcMain._handlers['navigate-home']();
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('navigateHomeReset');
  });
});
