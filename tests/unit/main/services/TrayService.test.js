jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
  Tray: jest.fn().mockImplementation(() => ({
    setToolTip: jest.fn(),
    setContextMenu: jest.fn(),
    destroy: jest.fn(),
  })),
  nativeImage: {
    createFromPath: jest.fn(() => ({
      isEmpty: jest.fn(() => false),
      resize: jest.fn(function () { return this; }),
    })),
  },
  Menu: {
    buildFromTemplate: jest.fn(() => ({})),
  },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
}));

let trayService;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
    Tray: jest.fn().mockImplementation(() => ({
      setToolTip: jest.fn(),
      setContextMenu: jest.fn(),
      destroy: jest.fn(),
    })),
    nativeImage: {
      createFromPath: jest.fn(() => ({
        isEmpty: jest.fn(() => false),
        resize: jest.fn(function () { return this; }),
      })),
    },
    Menu: {
      buildFromTemplate: jest.fn(() => ({})),
    },
  }));

  jest.mock('fs', () => ({
    existsSync: jest.fn(() => true),
  }));

  trayService = require('../../../../main/services/TrayService');
  trayService.tray = null;
});

describe('TrayService', () => {
  test('creates tray with icon', () => {
    const tray = trayService.createTray();
    expect(tray).not.toBeNull();
    expect(trayService.tray).not.toBeNull();
  });

  test('handles missing icon file', () => {
    const fs = require('fs');
    fs.existsSync.mockReturnValue(false);

    const { nativeImage } = require('electron');
    nativeImage.createFromPath.mockReturnValue({
      isEmpty: jest.fn(() => true),
      resize: jest.fn(function () { return this; }),
    });

    const tray = trayService.createTray();
    expect(tray).toBeNull();
  });

  test('sets context menu and tooltip', () => {
    trayService.createTray();
    const mockMenu = {};
    trayService.setContextMenu(mockMenu, 'Test Tooltip');

    expect(trayService.tray.setToolTip).toHaveBeenCalledWith('Test Tooltip');
    expect(trayService.tray.setContextMenu).toHaveBeenCalledWith(mockMenu);
  });

  test('setContextMenu does nothing if tray is null', () => {
    trayService.tray = null;
    expect(() => trayService.setContextMenu({}, 'test')).not.toThrow();
  });

  test('destroy cleans up tray', () => {
    trayService.createTray();
    const trayRef = trayService.tray;
    trayService.destroy();

    expect(trayRef.destroy).toHaveBeenCalled();
    expect(trayService.tray).toBeNull();
  });
});
