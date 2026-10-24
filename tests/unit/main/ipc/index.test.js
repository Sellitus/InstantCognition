jest.mock('electron', () => {
  const handlers = {};
  return {
    app: {
      getPath: jest.fn(() => '/mock'),
      getVersion: jest.fn(() => '4.0.0'),
      on: jest.fn(),
      isPackaged: false,
      quit: jest.fn(),
      relaunch: jest.fn(),
      setLoginItemSettings: jest.fn(),
      getLoginItemSettings: jest.fn(() => ({ openAtLogin: false })),
    },
    ipcMain: {
      on: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      handle: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      _handlers: handlers,
    },
    shell: { openPath: jest.fn().mockResolvedValue(''), openExternal: jest.fn() },
    dialog: { showErrorBox: jest.fn() },
  };
});

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  constants: jest.requireActual('fs').constants,
}));

jest.mock('electron-prompt', () => jest.fn().mockResolvedValue(null));

const { ipcMain } = require('electron');

describe('IPC handler registration', () => {
  test('registerAll registers handlers for all IPC channel groups', () => {
    jest.resetModules();
    jest.mock('electron', () => {
      const handlers = {};
      return {
        app: {
          getPath: jest.fn(() => '/mock'),
          getVersion: jest.fn(() => '4.0.0'),
          on: jest.fn(),
          isPackaged: false,
          quit: jest.fn(),
          relaunch: jest.fn(),
          setLoginItemSettings: jest.fn(),
          getLoginItemSettings: jest.fn(() => ({ openAtLogin: false })),
        },
        ipcMain: {
          on: jest.fn((ch, fn) => { handlers[ch] = fn; }),
          handle: jest.fn((ch, fn) => { handlers[ch] = fn; }),
          _handlers: handlers,
        },
        shell: { openPath: jest.fn().mockResolvedValue('') },
        clipboard: { writeText: jest.fn() },
        session: { defaultSession: { protocol: { handle: jest.fn() } } },
        dialog: { showErrorBox: jest.fn() },
      };
    });
    jest.mock('fs', () => ({
      existsSync: jest.fn(() => true),
      readFileSync: jest.fn(() => '{}'),
      writeFileSync: jest.fn(),
      mkdirSync: jest.fn(),
      constants: jest.requireActual('fs').constants,
    }));
    jest.mock('electron-prompt', () => jest.fn().mockResolvedValue(null));

    const { registerAll } = require('../../../../main/ipc');
    const { ipcMain: freshIpc } = require('electron');

    const mockWindow = { webContents: { send: jest.fn(), on: jest.fn() } };
    const mockServices = {
      configService: {
        getAll: jest.fn(() => ({})),
        get: jest.fn((_path, fallback) => fallback),
        set: jest.fn(),
        replaceAll: jest.fn(),
        configPath: '/mock/config.json',
      },
      adblockerService: { enable: jest.fn().mockResolvedValue({}), disable: jest.fn(), setupAutoUpdate: jest.fn() },
      certService: { setAutoDeny: jest.fn() },
      shortcutService: { toggleWindow: jest.fn(), updateShortcut: jest.fn(), isLocked: false, toggleLocked: false, registerToggle: jest.fn(), unregisterToggle: jest.fn(), disableAll: jest.fn(), enableAll: jest.fn() },
      menuService: { setAppQuitting: jest.fn(), buildAndSetMenus: jest.fn() },
      errorHandler: { logRendererError: jest.fn() },
      spaceStates: new Map(),
    };

    registerAll(mockWindow, mockServices);
    // Registering starts UpdateService's delayed first check; leave it pending
    // and it fires into a torn-down environment.
    require('../../../../main/services/UpdateService').stop();

    const registeredCount = freshIpc.on.mock.calls.length + freshIpc.handle.mock.calls.length;
    expect(registeredCount).toBeGreaterThanOrEqual(25);
    // The app menu's Print… / Save Page as PDF… invoke these.
    expect(freshIpc._handlers['page:print']).toEqual(expect.any(Function));
    expect(freshIpc._handlers['page:save-pdf']).toEqual(expect.any(Function));
    // The sandboxed shell's clipboard, OS-shell and artifact-frame channels.
    for (const ch of ['clipboard:write-text', 'shell:open-external', 'shell:open-path', 'shell:show-item-in-folder',
      'artifact-frame:stage', 'artifact-frame:release']) {
      expect(freshIpc._handlers[ch]).toEqual(expect.any(Function));
    }
    expect(require('electron').session.defaultSession.protocol.handle).toHaveBeenCalledWith('ic-artifact', expect.any(Function));
  });
});
