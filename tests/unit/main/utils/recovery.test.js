// recovery — the third-consecutive-crash escape hatch. It decides whether the
// app boots normally, and its IPC actions delete the user's config, so both the
// counting and the handlers need pinning.

jest.mock('fs');

const ipcHandlers = {};

jest.mock('electron', () => {
  const win = {
    loadFile: jest.fn(),
    show: jest.fn(),
    webContents: { send: jest.fn() },
  };
  return {
    app: {
      getPath: jest.fn((name) => (name === 'temp' ? '/tmp-dir' : '/user-data')),
      isReady: jest.fn(() => true),
      relaunch: jest.fn(),
      quit: jest.fn(),
    },
    BrowserWindow: jest.fn(() => win),
    ipcMain: { on: jest.fn((channel, handler) => { ipcHandlers[channel] = handler; }) },
    shell: { openPath: jest.fn() },
    session: { defaultSession: { clearCache: jest.fn(() => Promise.resolve()), clearStorageData: jest.fn(() => Promise.resolve()) } },
    __win: win,
  };
});

const fs = require('fs');
const electron = require('electron');
const { app, shell, session } = electron;
const recovery = require('../../../../main/utils/recovery');

describe('recovery', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ['node', 'main.js'];
    recovery.isRecoveryMode = false;
    recovery.failureCount = 0;
    recovery.recoveryWindow = null;
    for (const key of Object.keys(ipcHandlers)) delete ipcHandlers[key];
    app.isReady.mockReturnValue(true);
    fs.existsSync.mockReset();
    fs.readFileSync.mockReset();
    fs.writeFileSync.mockReset();
    fs.unlinkSync.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('checkRecoveryMode', () => {
    test('--recovery forces recovery mode without touching disk', () => {
      process.argv = ['node', 'main.js', '--recovery'];
      expect(recovery.checkRecoveryMode()).toBe(true);
      expect(recovery.isRecoveryMode).toBe(true);
      expect(fs.existsSync).not.toHaveBeenCalled();
    });

    test('before app-ready it refuses to read the counter', () => {
      app.isReady.mockReturnValue(false);
      expect(recovery.checkRecoveryMode()).toBe(false);
      expect(fs.existsSync).not.toHaveBeenCalled();
    });

    test('three recorded failures trip recovery mode', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ count: 3 }));
      expect(recovery.checkRecoveryMode()).toBe(true);
      expect(recovery.failureCount).toBe(3);
    });

    test('two failures still boot normally', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ count: 2 }));
      expect(recovery.checkRecoveryMode()).toBe(false);
      expect(recovery.isRecoveryMode).toBe(false);
    });

    test('a corrupt counter file does not block startup', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{not json');
      expect(recovery.checkRecoveryMode()).toBe(false);
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('failure counter', () => {
    test('increment persists the new count', () => {
      recovery.incrementFailureCount();
      expect(recovery.failureCount).toBe(1);
      const [file, payload] = fs.writeFileSync.mock.calls[0];
      expect(file).toBe('/user-data/failure-count.json');
      expect(JSON.parse(payload).count).toBe(1);
    });

    test('increment before app-ready counts in memory only', () => {
      app.isReady.mockReturnValue(false);
      recovery.incrementFailureCount();
      expect(recovery.failureCount).toBe(1);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('a write failure is reported, not swallowed into a wrong count', () => {
      fs.writeFileSync.mockImplementation(() => { throw new Error('EROFS'); });
      expect(() => recovery.incrementFailureCount()).not.toThrow();
      expect(console.error).toHaveBeenCalledWith('Error writing failure count:', expect.any(Error));
    });

    test('reset clears the counter and removes the file', () => {
      recovery.failureCount = 3;
      fs.existsSync.mockReturnValue(true);
      recovery.resetFailureCount();
      expect(recovery.failureCount).toBe(0);
      expect(fs.unlinkSync).toHaveBeenCalledWith('/user-data/failure-count.json');
    });

    test('reset with no file on disk is a no-op unlink', () => {
      fs.existsSync.mockReturnValue(false);
      recovery.resetFailureCount();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('recovery window', () => {
    test('writes the recovery page to temp and loads it', () => {
      const win = recovery.createRecoveryWindow();
      const [file, html] = fs.writeFileSync.mock.calls[0];
      expect(file).toBe('/tmp-dir/recovery.html');
      expect(html).toContain('Recovery Mode');
      expect(html).toContain('recovery-reset-settings');
      expect(win.loadFile).toHaveBeenCalledWith('/tmp-dir/recovery.html');
      expect(win.show).toHaveBeenCalled();
    });

    test('its page passes the IPC sender check, so its buttons still reach main', () => {
      const { EventEmitter } = require('events');
      const ipc = new EventEmitter();
      require('../../../../main/utils/ipcSenderPolicy').install(ipc);
      const reset = jest.fn();
      ipc.on('recovery-reset-settings', reset);
      const win = recovery.createRecoveryWindow();
      ipc.emit('recovery-reset-settings', { sender: win.webContents, senderFrame: { url: 'file:///tmp-dir/recovery.html', parent: null } });
      expect(reset).toHaveBeenCalledTimes(1);
    });
  });

  describe('recovery actions', () => {
    beforeEach(() => {
      recovery.createRecoveryWindow();
      recovery.setupRecoveryHandlers();
      jest.useFakeTimers();
    });

    afterEach(() => { jest.useRealTimers(); });

    test('reset settings deletes config.json, clears the counter and relaunches', () => {
      fs.existsSync.mockReturnValue(true);
      ipcHandlers['recovery-reset-settings']();

      expect(fs.unlinkSync).toHaveBeenCalledWith('/user-data/config.json');
      expect(recovery.failureCount).toBe(0);
      expect(recovery.recoveryWindow.webContents.send)
        .toHaveBeenCalledWith('recovery-message', expect.stringContaining('reset successfully'));

      jest.advanceTimersByTime(2000);
      expect(app.relaunch).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });

    test('a failed reset reports the error to the recovery window', () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => { throw new Error('EBUSY'); });
      ipcHandlers['recovery-reset-settings']();
      expect(recovery.recoveryWindow.webContents.send)
        .toHaveBeenCalledWith('recovery-message', 'Error: EBUSY');
      expect(app.relaunch).not.toHaveBeenCalled();
    });

    test('clear cache empties both the cache and stored data', async () => {
      await ipcHandlers['recovery-clear-cache']();
      expect(session.defaultSession.clearCache).toHaveBeenCalled();
      expect(session.defaultSession.clearStorageData).toHaveBeenCalled();
      expect(recovery.recoveryWindow.webContents.send)
        .toHaveBeenCalledWith('recovery-message', 'Cache cleared successfully.');
    });

    test('a failing cache clear surfaces the reason', async () => {
      session.defaultSession.clearCache.mockRejectedValueOnce(new Error('locked'));
      await ipcHandlers['recovery-clear-cache']();
      expect(recovery.recoveryWindow.webContents.send)
        .toHaveBeenCalledWith('recovery-message', 'Error: locked');
    });

    test('view logs opens the logs folder', () => {
      ipcHandlers['recovery-view-logs']();
      expect(shell.openPath).toHaveBeenCalledWith('/user-data/logs');
    });

    test('try-normal clears the counter before relaunching', () => {
      recovery.failureCount = 3;
      fs.existsSync.mockReturnValue(true);
      ipcHandlers['recovery-try-normal']();
      expect(recovery.failureCount).toBe(0);
      expect(app.relaunch).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });

    test('quit quits', () => {
      ipcHandlers['recovery-quit']();
      expect(app.quit).toHaveBeenCalled();
    });
  });
});
