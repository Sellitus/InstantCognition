jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
  globalShortcut: {
    register: jest.fn(() => true),
    unregister: jest.fn(),
    unregisterAll: jest.fn(),
  },
}));

jest.mock('child_process', () => ({
  execFileSync: jest.fn(() => '0'),
}));

const { globalShortcut } = require('electron');

let shortcutService;

beforeEach(() => {
  jest.resetModules();
  jest.mock('electron', () => ({
    app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
    globalShortcut: {
      register: jest.fn(() => true),
      unregister: jest.fn(),
      unregisterAll: jest.fn(),
    },
  }));

  shortcutService = require('../../../../main/services/ShortcutService');
  shortcutService.mainWindow = null;
  shortcutService.toggleLocked = false;
  shortcutService.rebuildMenus = null;
  shortcutService._lastToggleTime = 0;
  shortcutService._lastLockTime = 0;
});

const createMockWindow = (overrides = {}) => ({
  isVisible: jest.fn(() => false),
  isFocused: jest.fn(() => false),
  show: jest.fn(),
  hide: jest.fn(),
  focus: jest.fn(),
  getBounds: jest.fn(() => ({ x: 100, y: 100, width: 800, height: 600 })),
  setBounds: jest.fn(),
  ...overrides,
});

describe('ShortcutService', () => {
  describe('Initialization', () => {
    test('registers toggle shortcut on initialize', () => {
      const mockWindow = createMockWindow();
      const { globalShortcut: gs } = require('electron');

      shortcutService.initialize(mockWindow);

      expect(gs.register).toHaveBeenCalled();
      const registeredKeys = gs.register.mock.calls.map((c) => c[0]);
      expect(registeredKeys).toContain(shortcutService.toggleShortcut);
    });

    test('registers lock shortcut on initialize', () => {
      const mockWindow = createMockWindow();
      const { globalShortcut: gs } = require('electron');

      shortcutService.initialize(mockWindow);

      const registeredKeys = gs.register.mock.calls.map((c) => c[0]);
      expect(registeredKeys).toContain(shortcutService.lockShortcut);
    });

    test('uses platform-specific default shortcut', () => {
      if (process.platform === 'darwin') {
        expect(shortcutService.toggleShortcut).toBe('Alt+Space');
      } else {
        expect(shortcutService.toggleShortcut).toBe('CmdOrCtrl+Space');
      }
    });
  });

  describe('Toggle window', () => {
    test('shows hidden window', () => {
      const mockWindow = createMockWindow({ isVisible: jest.fn(() => false) });
      shortcutService.mainWindow = mockWindow;

      shortcutService.toggleWindow();

      expect(mockWindow.show).toHaveBeenCalled();
    });

    test('hides visible focused window', () => {
      const mockWindow = createMockWindow({
        isVisible: jest.fn(() => true),
        isFocused: jest.fn(() => true),
      });
      shortcutService.mainWindow = mockWindow;

      shortcutService.toggleWindow();

      expect(mockWindow.hide).toHaveBeenCalled();
    });

    test('focuses visible but unfocused window (non-macOS)', () => {
      // Skip on macOS since Stage Manager detection alters behavior
      if (process.platform === 'darwin') return;

      const mockWindow = createMockWindow({
        isVisible: jest.fn(() => true),
        isFocused: jest.fn(() => false),
      });
      shortcutService.mainWindow = mockWindow;

      shortcutService.toggleWindow();

      expect(mockWindow.focus).toHaveBeenCalled();
    });

    test('does nothing when mainWindow is null', () => {
      shortcutService.mainWindow = null;
      expect(() => shortcutService.toggleWindow()).not.toThrow();
    });
  });

  describe('Update shortcut', () => {
    test('unregisters old shortcut before registering new', () => {
      const mockWindow = createMockWindow();
      const { globalShortcut: gs } = require('electron');
      shortcutService.mainWindow = mockWindow;

      const oldShortcut = shortcutService.toggleShortcut;
      shortcutService.updateShortcut('register', 'Alt+X');

      expect(gs.unregister).toHaveBeenCalledWith(oldShortcut);
    });

    test('updates toggle shortcut to new key', () => {
      shortcutService.mainWindow = createMockWindow();
      shortcutService.updateShortcut('register', 'Alt+X');

      expect(shortcutService.toggleShortcut).toBe('Alt+X');
    });

    test('returns success result', () => {
      shortcutService.mainWindow = createMockWindow();
      const result = shortcutService.updateShortcut('register', 'Alt+X');
      expect(result.success).toBe(true);
    });

    test('handles unregister action', () => {
      const { globalShortcut: gs } = require('electron');
      const result = shortcutService.updateShortcut('unregister', 'Alt+X');
      expect(gs.unregister).toHaveBeenCalledWith('Alt+X');
      expect(result.success).toBe(true);
    });

    test('calls rebuildMenus callback', () => {
      const rebuildMenus = jest.fn();
      shortcutService.mainWindow = createMockWindow();
      shortcutService.rebuildMenus = rebuildMenus;

      shortcutService.updateShortcut('register', 'Alt+X');

      expect(rebuildMenus).toHaveBeenCalled();
    });
  });

  describe('Lock/unlock', () => {
    test('isLocked getter returns lock state', () => {
      expect(shortcutService.isLocked).toBe(false);
      shortcutService.toggleLocked = true;
      expect(shortcutService.isLocked).toBe(true);
    });
  });

  describe('Cleanup', () => {
    test('unregisterAll calls globalShortcut.unregisterAll', () => {
      const { globalShortcut: gs } = require('electron');
      shortcutService.unregisterAll();
      expect(gs.unregisterAll).toHaveBeenCalled();
    });
  });

  // Capture the callback passed to globalShortcut.register for a given key so
  // we can drive the hotkey body (debounce + window logic) directly.
  function callbackFor(key) {
    const { globalShortcut: gs } = require('electron');
    const call = gs.register.mock.calls.find((c) => c[0] === key);
    return call && call[1];
  }

  describe('registerVoice', () => {
    test('warns when registration fails', () => {
      const { globalShortcut: gs } = require('electron');
      gs.register.mockReturnValue(false);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      shortcutService.registerVoice();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('voice shortcut'));
      warn.mockRestore();
    });

    test('hotkey shows a hidden window and emits voice:hotkey-toggle', () => {
      const send = jest.fn();
      const win = createMockWindow({ isVisible: jest.fn(() => false), webContents: { send } });
      shortcutService.mainWindow = win;
      shortcutService._lastVoiceTime = 0;
      shortcutService.registerVoice();
      callbackFor(shortcutService.voiceShortcut)();
      expect(win.show).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith('voice:hotkey-toggle');
    });

    test('hotkey is debounced within 50ms', () => {
      const send = jest.fn();
      const win = createMockWindow({ isVisible: jest.fn(() => true), webContents: { send } });
      shortcutService.mainWindow = win;
      shortcutService.registerVoice();
      const cb = callbackFor(shortcutService.voiceShortcut);
      shortcutService._lastVoiceTime = Date.now();
      cb();
      expect(send).not.toHaveBeenCalled();
    });

    test('hotkey does not show an already-visible window', () => {
      const send = jest.fn();
      const win = createMockWindow({ isVisible: jest.fn(() => true), webContents: { send } });
      shortcutService.mainWindow = win;
      shortcutService._lastVoiceTime = 0;
      shortcutService.registerVoice();
      callbackFor(shortcutService.voiceShortcut)();
      expect(win.show).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith('voice:hotkey-toggle');
    });
  });

  describe('registerToggle / registerLock failure warnings', () => {
    test('registerToggle warns when register returns false', () => {
      const { globalShortcut: gs } = require('electron');
      gs.register.mockReturnValue(false);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      shortcutService.registerToggle();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('toggle shortcut'));
      warn.mockRestore();
    });

    test('registerLock warns when register returns false', () => {
      const { globalShortcut: gs } = require('electron');
      gs.register.mockReturnValue(false);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      shortcutService.registerLock();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock shortcut'));
      warn.mockRestore();
    });

    test('registerToggle tells the renderer when registration fails', () => {
      const { globalShortcut: gs } = require('electron');
      gs.register.mockReturnValue(false);
      const send = jest.fn();
      shortcutService.mainWindow = createMockWindow({ webContents: { send } });
      shortcutService.registerToggle();
      expect(send).toHaveBeenCalledWith('shortcut:register-failed', { shortcut: shortcutService.toggleShortcut });
    });

    test('registerLock tells the renderer when registration fails', () => {
      const { globalShortcut: gs } = require('electron');
      gs.register.mockReturnValue(false);
      const send = jest.fn();
      shortcutService.mainWindow = createMockWindow({ webContents: { send } });
      shortcutService.registerLock();
      expect(send).toHaveBeenCalledWith('shortcut:register-failed', { shortcut: shortcutService.lockShortcut });
    });

    test('a destroyed webContents does not crash the failure notification', () => {
      const { globalShortcut: gs } = require('electron');
      gs.register.mockReturnValue(false);
      shortcutService.mainWindow = createMockWindow({
        webContents: { send: jest.fn(() => { throw new Error('Object has been destroyed'); }) },
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => shortcutService.registerToggle()).not.toThrow();
      warn.mockRestore();
    });

    test('updateShortcut propagates a failed register as success:false', () => {
      const { globalShortcut: gs } = require('electron');
      gs.register.mockReturnValue(false);
      shortcutService.mainWindow = createMockWindow({ webContents: { send: jest.fn() } });
      const result = shortcutService.updateShortcut('register', 'Alt+X');
      expect(result).toEqual({ success: false });
    });

    test('updateShortcut propagates a successful register as success:true', () => {
      const { globalShortcut: gs } = require('electron');
      gs.register.mockReturnValue(true);
      shortcutService.mainWindow = createMockWindow({ webContents: { send: jest.fn() } });
      const result = shortcutService.updateShortcut('window.lock', 'Alt+Z');
      expect(result).toEqual({ success: true });
    });
  });

  describe('toggle hotkey callback', () => {
    test('debounced when fired twice within 50ms', () => {
      const win = createMockWindow({ isVisible: jest.fn(() => false) });
      shortcutService.mainWindow = win;
      shortcutService.registerToggle();
      const cb = callbackFor(shortcutService.toggleShortcut);
      shortcutService._lastToggleTime = 0;
      cb();
      expect(win.show).toHaveBeenCalledTimes(1);
      // Immediate second fire is swallowed (Date.now() - last < 50).
      win.show.mockClear();
      cb();
      expect(win.show).not.toHaveBeenCalled();
    });
  });

  describe('lock hotkey callback', () => {
    test('first press locks (unregisters toggle); second press unlocks', () => {
      const { globalShortcut: gs } = require('electron');
      shortcutService.mainWindow = createMockWindow();
      shortcutService.toggleLocked = false;
      shortcutService.registerLock();
      const cb = callbackFor(shortcutService.lockShortcut);
      shortcutService._lastLockTime = 0;
      cb();
      expect(shortcutService.toggleLocked).toBe(true);
      expect(gs.unregister).toHaveBeenCalledWith(shortcutService.toggleShortcut);
      shortcutService._lastLockTime = 0;
      cb();
      expect(shortcutService.toggleLocked).toBe(false);
    });

    test('debounced when fired twice within 100ms', () => {
      shortcutService.mainWindow = createMockWindow();
      shortcutService.toggleLocked = false;
      shortcutService.registerLock();
      const cb = callbackFor(shortcutService.lockShortcut);
      shortcutService._lastLockTime = 0;
      cb();
      expect(shortcutService.toggleLocked).toBe(true);
      // Second immediate fire is swallowed -> state unchanged.
      shortcutService._lastLockTime = Date.now();
      cb();
      expect(shortcutService.toggleLocked).toBe(true);
    });
  });

  describe('initialize loads shortcuts from config', () => {
    test('uses configured window.toggle and window.lock keys when present', () => {
      jest.resetModules();
      jest.doMock('electron', () => ({
        app: { getPath: jest.fn(() => '/mock'), isPackaged: false },
        globalShortcut: { register: jest.fn(() => true), unregister: jest.fn(), unregisterAll: jest.fn() },
      }));
      const cfgPath = require.resolve('../../../../main/services/ConfigService');
      jest.doMock('../../../../main/services/ConfigService', () => ({
        getAll: () => ({
          settings: {
            shortcuts: {
              'window.toggle': { key: 'Ctrl+Alt+T' },
              'window.lock': { key: 'Ctrl+Alt+K' },
            },
          },
        }),
        replaceAll: jest.fn(),
        dispose: jest.fn(),
      }));
      const svc = require('../../../../main/services/ShortcutService');
      svc.initialize(createMockWindow());
      expect(svc.toggleShortcut).toBe('Ctrl+Alt+T');
      expect(svc.lockShortcut).toBe('Ctrl+Alt+K');
      jest.dontMock('../../../../main/services/ConfigService');
      // Keep the module registry clean for subsequent files.
      delete require.cache[cfgPath];
    });
  });

  describe('updateShortcut window.lock + invalid action', () => {
    test('window.lock unregisters old, sets new, persists, re-registers', () => {
      const { globalShortcut: gs } = require('electron');
      shortcutService.mainWindow = createMockWindow();
      const oldLock = shortcutService.lockShortcut;
      const result = shortcutService.updateShortcut('window.lock', 'Alt+Z');
      expect(gs.unregister).toHaveBeenCalledWith(oldLock);
      expect(shortcutService.lockShortcut).toBe('Alt+Z');
      expect(result.success).toBe(true);
    });

    test('unknown action returns success:false', () => {
      const result = shortcutService.updateShortcut('bogus', 'Alt+Q');
      expect(result).toEqual({ success: false });
    });

    test('window.lock calls rebuildMenus when present', () => {
      const rebuild = jest.fn();
      shortcutService.mainWindow = createMockWindow();
      shortcutService.rebuildMenus = rebuild;
      shortcutService.updateShortcut('window.lock', 'Alt+Z');
      expect(rebuild).toHaveBeenCalled();
    });
  });
});
