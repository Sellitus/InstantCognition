// Integration tests for main process initialization

const { app } = require('electron');

jest.mock('electron');
jest.mock('../../main/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('Main Process Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Setup app mocks
    app.isReady = jest.fn().mockReturnValue(false);
    app.whenReady = jest.fn().mockResolvedValue();
    app.on = jest.fn();
    app.quit = jest.fn();
    app.commandLine = {
      appendSwitch: jest.fn(),
    };
  });

  describe('Application lifecycle', () => {
    it('should wait for app to be ready before initializing', () => {
      require('../../main/index');

      expect(app.whenReady).toHaveBeenCalled();
      expect(app.on).toHaveBeenCalledWith('ready', expect.any(Function));
    });

    it('should handle window-all-closed event', () => {
      require('../../main/index');

      expect(app.on).toHaveBeenCalledWith('window-all-closed', expect.any(Function));

      // Get the handler and test it
      const handler = app.on.mock.calls.find((call) => call[0] === 'window-all-closed')?.[1];
      if (handler) {
        handler();

        // On macOS, app should not quit
        if (process.platform === 'darwin') {
          expect(app.quit).not.toHaveBeenCalled();
        } else {
          expect(app.quit).toHaveBeenCalled();
        }
      }
    });

    it('should handle activate event', () => {
      require('../../main/index');

      expect(app.on).toHaveBeenCalledWith('activate', expect.any(Function));
    });

    it('should handle will-quit event', () => {
      require('../../main/index');

      expect(app.on).toHaveBeenCalledWith('will-quit', expect.any(Function));
    });
  });

  describe('Command line switches', () => {
    it('should set hardware acceleration switches', () => {
      require('../../main/index');

      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-hardware-acceleration');
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-gpu-rasterization');
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-zero-copy');
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('ignore-gpu-blacklist');
    });
  });
});
