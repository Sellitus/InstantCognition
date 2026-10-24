jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    webContents: { fromId: jest.fn() },
  };
});

const { ipcMain, webContents } = require('electron');
const tabRegistry = require('../../../../main/services/tabRegistry');
const { register } = require('../../../../main/ipc/spaceHandlers');

describe('spaceHandlers', () => {
  let spaceStates;
  let configService;
  let mainWindow;
  let store;

  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    webContents.fromId.mockReturnValue(null);
    tabRegistry.clear();

    spaceStates = new Map();
    store = {};
    configService = { get: jest.fn((k, d) => (k in store ? store[k] : d)) };
    mainWindow = { isDestroyed: jest.fn(() => false), webContents: { send: jest.fn() } };
    register(mainWindow, { spaceStates, configService });
  });

  describe('space-activity', () => {
    test('registers tab metadata using configured space name', () => {
      store['spaces.custom1'] = { name: 'ChatGPT' };
      const wc = { setBackgroundThrottling: jest.fn(), getURL: () => '', getTitle: () => '' };
      webContents.fromId.mockReturnValue(wc);
      ipcMain._handlers['space-activity']({}, { spaceId: 'custom1', isActive: true, webContentsId: 3, kind: 'agent' });
      const entry = tabRegistry.get('custom1');
      expect(entry).toMatchObject({ webContentsId: 3, isActive: true, name: 'ChatGPT', kind: 'agent' });
    });

    test('falls back to adHocSpaces name then empty string; default kind "user"', () => {
      store['state.adHocSpaces.custom9'] = { name: 'AdHoc' };
      ipcMain._handlers['space-activity']({}, { spaceId: 'custom9', isActive: true, webContentsId: 4 });
      expect(tabRegistry.get('custom9')).toMatchObject({ name: 'AdHoc', kind: 'user' });
    });

    test('a tab whose page runs in the private session is tagged private, others are not', () => {
      const sessionService = require('../../../../main/services/SessionService');
      const privateSession = { name: 'private' };
      sessionService._setSessionModule({ fromPartition: () => privateSession });
      sessionService.initialize({});
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { spaceStates, configService, sessionService });
      const privWc = { id: 8, session: privateSession, getURL: () => '', getTitle: () => '', on: jest.fn(), once: jest.fn() };
      const pubWc = { id: 9, session: { name: 'default' }, getURL: () => '', getTitle: () => '', on: jest.fn(), once: jest.fn() };
      webContents.fromId.mockImplementation((id) => (id === 8 ? privWc : pubWc));
      ipcMain._handlers['space-activity']({}, { spaceId: 'priv', isActive: true, webContentsId: 8 });
      ipcMain._handlers['space-activity']({}, { spaceId: 'pub', isActive: false, webContentsId: 9 });
      expect(tabRegistry.get('priv')).toMatchObject({ private: true });
      expect(tabRegistry.get('pub')).toMatchObject({ private: false });
    });

    test('spaceName returns empty string when no configService', () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { spaceStates });
      ipcMain._handlers['space-activity']({}, { spaceId: 'customX', isActive: true, webContentsId: 5 });
      expect(tabRegistry.get('customX')).toMatchObject({ name: '', kind: 'user' });
    });

    test('tracks the active flag on the space state across toggles', () => {
      const wc = { setBackgroundThrottling: jest.fn(), getURL: () => '', getTitle: () => '' };
      webContents.fromId.mockReturnValue(wc);
      ipcMain._handlers['space-activity']({}, { spaceId: 'c1', isActive: false, webContentsId: 1 });
      expect(spaceStates.get('c1')).toMatchObject({ isActive: false });
      ipcMain._handlers['space-activity']({}, { spaceId: 'c1', isActive: true, webContentsId: 1 });
      expect(spaceStates.get('c1')).toMatchObject({ isActive: true });
    });

    // Regression guard. Calling setBackgroundThrottling on an already-hidden
    // guest force-clears Chromium's is_hidden_ flag; the FrameEvictor then
    // evicts the compositor frames on its ~5 min timer and the pane renders
    // blank until the app restarts. This handler must never touch it — not on
    // activate, not on deactivate, and not from a deferred timer.
    test('never calls setBackgroundThrottling, however much time passes', () => {
      jest.useFakeTimers();
      try {
        const wc = { setBackgroundThrottling: jest.fn(), getURL: () => '', getTitle: () => '' };
        webContents.fromId.mockReturnValue(wc);
        ipcMain._handlers['space-activity']({}, { spaceId: 'c2', isActive: false, webContentsId: 2 });
        ipcMain._handlers['space-activity']({}, { spaceId: 'c2', isActive: true, webContentsId: 2 });
        jest.advanceTimersByTime(60 * 60 * 1000);
        expect(wc.setBackgroundThrottling).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    test('deactivation schedules no timers at all', () => {
      jest.useFakeTimers();
      try {
        webContents.fromId.mockReturnValue(null);
        ipcMain._handlers['space-activity']({}, { spaceId: 'c3', isActive: false, webContentsId: 7 });
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    test('no webContentsId: no tabRegistry set, no wc', () => {
      ipcMain._handlers['space-activity']({}, { spaceId: 'c5', isActive: true });
      expect(tabRegistry.get('c5')).toBeNull();
      expect(spaceStates.get('c5')).toMatchObject({ isActive: true });
    });
  });

  describe('space-closed', () => {
    test('deletes state and tab registry entry', () => {
      const wc = { setBackgroundThrottling: jest.fn(), getURL: () => '', getTitle: () => '' };
      webContents.fromId.mockReturnValue(wc);
      ipcMain._handlers['space-activity']({}, { spaceId: 'c6', isActive: false, webContentsId: 9 });
      expect(spaceStates.has('c6')).toBe(true);
      ipcMain._handlers['space-closed']({}, { spaceId: 'c6' });
      expect(spaceStates.has('c6')).toBe(false);
      expect(tabRegistry.get('c6')).toBeNull();
    });

    test('handles unknown spaceId without state', () => {
      expect(() => ipcMain._handlers['space-closed']({}, { spaceId: 'never' })).not.toThrow();
    });
  });

  describe('select-previous/next-space', () => {
    test('select-previous-space forwards to renderer', () => {
      ipcMain._handlers['select-previous-space']();
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('select-previous-space');
    });

    test('select-next-space forwards to renderer', () => {
      ipcMain._handlers['select-next-space']();
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('select-next-space');
    });
  });

  describe('switch-space', () => {
    test('index 0 maps to custom10', () => {
      ipcMain._handlers['switch-space']({}, 0);
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('selectSpace', 'custom10');
    });

    test('non-zero index maps to customN', () => {
      ipcMain._handlers['switch-space']({}, 3);
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('selectSpace', 'custom3');
    });

    test('debounces rapid switches within 100ms', () => {
      const realNow = Date.now;
      let t = 1000;
      Date.now = jest.fn(() => t);
      ipcMain._handlers['switch-space']({}, 1);
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1);
      t = 1050; // within 100ms
      ipcMain._handlers['switch-space']({}, 2);
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1);
      t = 1200; // beyond 100ms
      ipcMain._handlers['switch-space']({}, 2);
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2);
      Date.now = realNow;
    });
  });
});
