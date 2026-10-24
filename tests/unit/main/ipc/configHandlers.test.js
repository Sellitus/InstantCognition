jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    shell: {
      openPath: jest.fn().mockResolvedValue(''),
    },
    dialog: {
      showErrorBox: jest.fn(),
    },
  };
});

const fs = require('fs');
const { ipcMain, shell, dialog } = require('electron');
const { register } = require('../../../../main/ipc/configHandlers');

describe('configHandlers', () => {
  let services;
  let mainWindow;
  let changeListener;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((channel, handler) => { ipcMain._handlers[channel] = handler; });
    ipcMain.handle.mockImplementation((channel, handler) => { ipcMain._handlers[channel] = handler; });
    shell.openPath.mockResolvedValue('');
    changeListener = null;

    mainWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: { send: jest.fn() },
    };

    services = {
      configService: {
        configPath: '/tmp/config.json',
        getAll: jest.fn(() => ({ settings: { theme: 'dark' } })),
        lastLoadStatus: 'recovered',
        set: jest.fn(),
        update: jest.fn(),
        replaceAll: jest.fn(),
        on: jest.fn((evt, fn) => { if (evt === 'change') changeListener = fn; }),
      },
      httpAllowlistService: {
      },
    };

    register(mainWindow, services);
  });

  test('config:get-sync returns config and reset reason', () => {
    const event = {};
    ipcMain._handlers['config:get-sync'](event);
    expect(event.returnValue).toEqual({
      config: { settings: { theme: 'dark' } },
      resetReason: 'recovered',
    });
  });

  test('config:get async returns the same payload', async () => {
    const result = await ipcMain._handlers['config:get']();
    expect(result).toEqual({
      config: { settings: { theme: 'dark' } },
      resetReason: 'recovered',
    });
  });

  describe('config:set', () => {
    test('sets when path and value present', () => {
      ipcMain._handlers['config:set']({}, { path: 'settings.theme', value: 'light' });
      expect(services.configService.set).toHaveBeenCalledWith('settings.theme', 'light');
    });

    test('ignores when path missing', () => {
      ipcMain._handlers['config:set']({}, { value: 'x' });
      expect(services.configService.set).not.toHaveBeenCalled();
    });

    test('ignores when value is undefined', () => {
      ipcMain._handlers['config:set']({}, { path: 'a' });
      expect(services.configService.set).not.toHaveBeenCalled();
    });
  });

  describe('config:update', () => {
    test('updates and broadcasts on valid object', () => {
      const partial = { settings: { x: 1 } };
      ipcMain._handlers['config:update']({}, partial);
      expect(services.configService.update).toHaveBeenCalledWith(partial);
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('config:changed', { kind: 'update', partial });
    });

    test('ignores non-object partial', () => {
      ipcMain._handlers['config:update']({}, 'nope');
      expect(services.configService.update).not.toHaveBeenCalled();
    });

    test('ignores null partial', () => {
      ipcMain._handlers['config:update']({}, null);
      expect(services.configService.update).not.toHaveBeenCalled();
    });
  });

  describe('config:replace', () => {
    test('forwards full config and broadcasts replace', () => {
      const nextConfig = { settings: { theme: 'light' } };
      ipcMain._handlers['config:replace']({}, nextConfig);
      expect(services.configService.replaceAll).toHaveBeenCalledWith(nextConfig);
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('config:changed', { kind: 'replace' });
    });
  });

  describe('configService change relay', () => {
    test('registers a change listener when configService.on is a function', () => {
      expect(typeof changeListener).toBe('function');
    });

    test('change event broadcasts a set payload', () => {
      changeListener({ path: 'a.b', oldValue: 1, newValue: 2 });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('config:changed', {
        kind: 'set', path: 'a.b', oldValue: 1, newValue: 2,
      });
    });

    test('skips listener registration when configService.on is not a function', () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      const svc = { ...services, configService: { ...services.configService, on: undefined } };
      expect(() => register(mainWindow, svc)).not.toThrow();
    });
  });

  describe('broadcastChanged guards', () => {
    test('no broadcast when mainWindow is falsy', () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(null, services);
      expect(() => ipcMain._handlers['config:replace']({}, {})).not.toThrow();
    });

    test('no broadcast when window destroyed', () => {
      mainWindow.isDestroyed.mockReturnValue(true);
      ipcMain._handlers['config:replace']({}, {});
      expect(mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    test('swallows send errors', () => {
      mainWindow.webContents.send.mockImplementation(() => { throw new Error('destroying'); });
      expect(() => ipcMain._handlers['config:replace']({}, {})).not.toThrow();
    });

    test('handles window without webContents.send', () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register({ isDestroyed: () => false, webContents: {} }, services);
      expect(() => ipcMain._handlers['config:replace']({}, {})).not.toThrow();
    });
  });

  describe('open-config-file', () => {
    test('opens the config path when it exists', () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      ipcMain._handlers['open-config-file']();
      expect(shell.openPath).toHaveBeenCalledWith('/tmp/config.json');
      existsSpy.mockRestore();
    });

    test('shows error box when openPath rejects', async () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      shell.openPath.mockRejectedValue(new Error('no handler'));
      ipcMain._handlers['open-config-file']();
      await Promise.resolve();
      await Promise.resolve();
      expect(dialog.showErrorBox).toHaveBeenCalledWith('Error', 'Failed to open config file: no handler');
      existsSpy.mockRestore();
    });

    test('shows not-found error when config file missing', () => {
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
      ipcMain._handlers['open-config-file']();
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(dialog.showErrorBox).toHaveBeenCalledWith(
        'Config File Not Found',
        'Config file not found at: /tmp/config.json',
      );
      existsSpy.mockRestore();
    });
  });
});
