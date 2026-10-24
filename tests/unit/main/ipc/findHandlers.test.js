// findHandlers — the find bar lives inside a webview, so closing it has to
// travel guest → main → host renderer. If this relay breaks, Escape leaves the
// bar on screen with no way to dismiss it.

const listeners = {};

jest.mock('electron', () => ({
  ipcMain: { on: jest.fn((channel, handler) => { listeners[channel] = handler; }) },
}));

const { register } = require('../../../../main/ipc/findHandlers');

describe('findHandlers', () => {
  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
  });

  test('close-find-bar is relayed back to the host window', () => {
    const mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: jest.fn() } };
    register(mainWindow);

    listeners['close-find-bar']();

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('close-find-bar');
  });

  test('a destroyed window drops the relay instead of throwing', () => {
    const mainWindow = { isDestroyed: () => true, webContents: { isDestroyed: () => true, send: jest.fn() } };
    register(mainWindow);

    expect(() => listeners['close-find-bar']()).not.toThrow();
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();
  });
});
