// Comprehensive unit tests for main process

const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createTestSandbox, createMockConfig, waitFor } = require('../helpers/testUtils');

// Mock all dependencies
jest.mock('electron');
jest.mock('@cliqz/adblocker-electron');
jest.mock('cross-fetch');
jest.mock('fs');
jest.mock('dns-over-tls');
jest.mock('dns');
jest.mock('../../main/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('Main Process', () => {
  let mainModule;
  let sandbox;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Create test sandbox
    sandbox = createTestSandbox();

    // Setup default mocks
    app.isReady.mockReturnValue(true);
    app.whenReady.mockResolvedValue();
    app.getPath.mockReturnValue('/mock/path');
    app.getAppPath.mockReturnValue('/mock/app/path');
    app.commandLine = {
      appendSwitch: jest.fn(),
    };

    os.platform = jest.fn().mockReturnValue('darwin');
    os.homedir = jest.fn().mockReturnValue('/home/user');

    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify(createMockConfig()));
    fs.promises = {
      readFile: jest.fn().mockResolvedValue(Buffer.from('')),
      writeFile: jest.fn().mockResolvedValue(),
    };
    fs.statSync.mockReturnValue({
      mtimeMs: Date.now() - 1000 * 60 * 60, // 1 hour old
    });

    // Mock ElectronBlocker
    ElectronBlocker.fromLists = jest.fn().mockResolvedValue({
      enableBlockingInSession: jest.fn(),
      disableBlockingInSession: jest.fn(),
      serialize: jest.fn().mockResolvedValue(Buffer.from('')),
    });
    ElectronBlocker.deserialize = jest.fn().mockResolvedValue({
      enableBlockingInSession: jest.fn(),
      disableBlockingInSession: jest.fn(),
      serialize: jest.fn().mockResolvedValue(Buffer.from('')),
    });

    // Mock fetch
    fetch.mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(''),
    });
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  describe('Application initialization', () => {
    it('should set hardware acceleration flags', () => {
      require('../../main/index');

      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-hardware-acceleration');
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-gpu-rasterization');
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-zero-copy');
      expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('ignore-gpu-blacklist');
    });

    it('should set up error handlers', () => {
      const processOn = jest.spyOn(process, 'on');

      require('../../main/index');

      expect(processOn).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
      expect(processOn).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));

      processOn.mockRestore();
    });

    it('should configure event emitter max listeners', () => {
      const EventEmitter = require('events');
      const originalMax = EventEmitter.defaultMaxListeners;

      require('../../main/index');

      expect(EventEmitter.defaultMaxListeners).toBe(50);

      // Restore original value
      EventEmitter.defaultMaxListeners = originalMax;
    });
  });

  describe('Ad blocker functionality', () => {
    let createAndUpdateBlocker;

    beforeEach(() => {
      const mainIndex = require('../../main/index');
      // Extract the function from the module if it's exported
      // Since it's not exported, we'll test it indirectly through the app flow
    });

    it('should create ad blocker with correct configuration', async () => {
      fs.existsSync.mockReturnValue(false); // No cache exists

      require('../../main/index');

      // Trigger app ready event
      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];
      if (readyHandler) await readyHandler();

      // Wait for async operations
      await new Promise((resolve) => setImmediate(resolve));

      expect(ElectronBlocker.fromLists).toHaveBeenCalledWith(
        fetch,
        expect.arrayContaining([
          expect.stringContaining('hagezi'),
          expect.stringContaining('oisd'),
        ]),
        expect.objectContaining({
          enableCompression: true,
          loadNetworkFilters: true,
          loadCosmeticFilters: false,
        })
      );
    });

    it('should load ad blocker from cache if available', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({
        mtimeMs: Date.now() - 1000 * 60 * 30, // 30 minutes old (within 24h cache)
      });

      require('../../main/index');

      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];
      if (readyHandler) await readyHandler();

      await new Promise((resolve) => setImmediate(resolve));

      expect(fs.promises.readFile).toHaveBeenCalledWith(
        expect.stringContaining('adblocker_cache.bin')
      );
      expect(ElectronBlocker.deserialize).toHaveBeenCalled();
    });

    it('should update cache if older than 24 hours', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({
        mtimeMs: Date.now() - 1000 * 60 * 60 * 25, // 25 hours old
      });

      require('../../main/index');

      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];
      if (readyHandler) await readyHandler();

      await new Promise((resolve) => setImmediate(resolve));

      expect(ElectronBlocker.fromLists).toHaveBeenCalled();
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('adblocker_cache.bin'),
        expect.any(Buffer)
      );
    });
  });

  describe('Window management', () => {
    let mockWindow;

    beforeEach(() => {
      mockWindow = new BrowserWindow();
      BrowserWindow.mockImplementation(() => mockWindow);
    });

    it('should create main window with correct configuration', async () => {
      require('../../main/index');

      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];
      if (readyHandler) await readyHandler();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: expect.any(Number),
          height: expect.any(Number),
          webPreferences: expect.objectContaining({
            preload: expect.stringContaining('preload.js'),
            webviewTag: true,
            contextIsolation: false,
            nodeIntegration: true,
          }),
        })
      );
    });

    it('should load saved window bounds from config', async () => {
      const mockConfig = createMockConfig({
        state: {
          windowBounds: { width: 1200, height: 800, x: 100, y: 50 },
        },
      });
      fs.readFileSync.mockReturnValue(JSON.stringify(mockConfig));

      require('../../main/index');

      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];
      if (readyHandler) await readyHandler();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1200,
          height: 800,
          x: 100,
          y: 50,
        })
      );
    });

    it('should handle window close event', async () => {
      require('../../main/index');

      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];
      if (readyHandler) await readyHandler();

      // Simulate window close
      const closeHandler = mockWindow.on.mock.calls.find((call) => call[0] === 'closed')?.[1];
      if (closeHandler) closeHandler();

      expect(app.quit).not.toHaveBeenCalled(); // Window should hide, not quit app
    });
  });

  describe('Global shortcut handling', () => {
    it('should register global shortcut on app ready', async () => {
      globalShortcut.register.mockReturnValue(true);

      require('../../main/index');

      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];
      if (readyHandler) await readyHandler();

      expect(globalShortcut.register).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Function)
      );
    });

    it('should unregister shortcuts on app quit', async () => {
      require('../../main/index');

      const quitHandler = app.on.mock.calls.find((call) => call[0] === 'will-quit')?.[1];
      if (quitHandler) quitHandler();

      expect(globalShortcut.unregisterAll).toHaveBeenCalled();
    });
  });

  describe('IPC handlers', () => {
    beforeEach(() => {
      require('../../main/index');
    });

    it('should handle open-external IPC message', () => {
      const url = 'https://example.com';
      const event = { preventDefault: jest.fn() };

      const handler = ipcMain.on.mock.calls.find((call) => call[0] === 'open-external')?.[1];
      if (handler) handler(event, url);

      expect(shell.openExternal).toHaveBeenCalledWith(url);
    });

    it('should handle config-updated IPC message', () => {
      const newConfig = { theme: 'light' };
      const event = {};

      const handler = ipcMain.on.mock.calls.find((call) => call[0] === 'config-updated')?.[1];
      if (handler) handler(event, newConfig);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('config.json'),
        JSON.stringify(newConfig, null, 2)
      );
    });

    it('should handle restart-app IPC message', () => {
      const event = {};

      const handler = ipcMain.on.mock.calls.find((call) => call[0] === 'restart-app')?.[1];
      if (handler) handler(event);

      expect(app.relaunch).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });
  });

  describe('Platform-specific behavior', () => {
    it('should set user tasks on Windows', () => {
      os.platform.mockReturnValue('win32');

      require('../../main/index');

      expect(app.setUserTasks).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'InstantCognition',
            description: 'InstantCognition',
          }),
        ])
      );
    });

    it('should use macOS-specific window options', async () => {
      os.platform.mockReturnValue('darwin');

      require('../../main/index');

      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];
      if (readyHandler) await readyHandler();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          alwaysOnTop: true,
        })
      );
    });

    it('should not set always on top on Windows/Linux', async () => {
      os.platform.mockReturnValue('win32');

      require('../../main/index');

      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];
      if (readyHandler) await readyHandler();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          alwaysOnTop: false,
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should handle config load errors gracefully', async () => {
      fs.readFileSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      // Should not throw
      expect(() => {
        require('../../main/index');
      }).not.toThrow();

      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];
      if (readyHandler) await readyHandler();

      // Should use default config
      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1600,
          height: 900,
        })
      );
    });

    it('should handle ad blocker initialization errors', async () => {
      ElectronBlocker.fromLists.mockRejectedValue(new Error('Network error'));

      require('../../main/index');

      const readyHandler = app.on.mock.calls.find((call) => call[0] === 'ready')?.[1];

      // Should not throw
      await expect(async () => {
        if (readyHandler) await readyHandler();
      }).not.toThrow();
    });
  });
});
