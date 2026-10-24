// errorHandler — the main-process crash path. Nothing else writes the error
// log or raises the critical-error dialog, so a silent break here means a crash
// with no trace and no user-visible message.

jest.mock('fs');

const processHandlers = {};
const appHandlers = {};

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/user-data'),
    getVersion: jest.fn(() => '4.0.0'),
    isPackaged: false,
    isReady: jest.fn(() => true),
    whenReady: jest.fn(() => Promise.resolve()),
    quit: jest.fn(),
    on: jest.fn((event, handler) => { appHandlers[event] = handler; }),
  },
  dialog: { showMessageBox: jest.fn(() => Promise.resolve({ response: 1 })) },
  shell: { openPath: jest.fn() },
}));

const fs = require('fs');
const { app, dialog, shell } = require('electron');
const errorHandler = require('../../../../main/utils/errorHandler');

describe('errorHandler', () => {
  let stream;
  let processOn;

  beforeEach(() => {
    stream = { write: jest.fn(), end: jest.fn() };
    fs.existsSync.mockReturnValue(false);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.createWriteStream.mockReturnValue(stream);
    for (const key of Object.keys(appHandlers)) delete appHandlers[key];
    for (const key of Object.keys(processHandlers)) delete processHandlers[key];
    processOn = jest.spyOn(process, 'on').mockImplementation((event, handler) => {
      processHandlers[event] = handler;
      return process;
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    errorHandler.logStream = null;
    errorHandler.logPath = null;
    errorHandler.errorCount = 0;
    errorHandler.criticalErrors = [];
  });

  afterEach(() => {
    processOn.mockRestore();
    jest.restoreAllMocks();
    dialog.showMessageBox.mockClear();
    shell.openPath.mockClear();
    app.quit.mockClear();
  });

  test('initialize creates the logs directory and writes a header', () => {
    const logPath = errorHandler.initialize();

    expect(fs.mkdirSync).toHaveBeenCalledWith('/user-data/logs', { recursive: true });
    expect(logPath).toMatch(/^\/user-data\/logs\/error-.*\.log$/);
    const header = stream.write.mock.calls.map((c) => c[0]).join('');
    expect(header).toContain('InstantCognition Error Log');
    expect(header).toContain('App Version: 4.0.0');
  });

  test('an existing logs directory is left alone', () => {
    fs.existsSync.mockReturnValue(true);
    errorHandler.initialize();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  test('initialize subscribes the process and app crash events', () => {
    errorHandler.initialize();
    expect(Object.keys(processHandlers).sort()).toEqual(['uncaughtException', 'unhandledRejection', 'warning']);
    expect(Object.keys(appHandlers).sort()).toEqual(['child-process-gone', 'render-process-gone']);
  });

  test('an uncaught exception is logged and raises the critical dialog', () => {
    errorHandler.initialize();
    stream.write.mockClear();

    processHandlers.uncaughtException(new Error('boom'));

    expect(errorHandler.errorCount).toBe(1);
    expect(errorHandler.criticalErrors).toHaveLength(1);
    const logged = stream.write.mock.calls.map((c) => c[0]).join('');
    expect(logged).toContain('Uncaught Exception');
    expect(logged).toContain('Message: boom');
    expect(dialog.showMessageBox).toHaveBeenCalled();
  });

  test('a rejected promise is logged but never interrupts the user', () => {
    errorHandler.initialize();
    processHandlers.unhandledRejection('nope');

    expect(errorHandler.criticalErrors).toHaveLength(0);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('a renderer crash is critical; a child-process crash is not', () => {
    errorHandler.initialize();
    appHandlers['render-process-gone']({}, {}, { reason: 'crashed', exitCode: 11 });
    expect(errorHandler.criticalErrors).toHaveLength(1);

    appHandlers['child-process-gone']({}, { type: 'GPU' });
    expect(errorHandler.criticalErrors).toHaveLength(1);
    expect(errorHandler.errorCount).toBe(2);
  });

  test('a critical error before app-ready waits for the ready event', async () => {
    app.isReady.mockReturnValue(false);
    errorHandler.initialize();
    errorHandler.handleError('Early', new Error('too soon'), true);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(dialog.showMessageBox).toHaveBeenCalled();
    app.isReady.mockReturnValue(true);
  });

  test('"View Log" opens the log file and "Quit" quits', async () => {
    errorHandler.initialize();

    dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    errorHandler.showErrorDialog({ type: 'x', message: 'm' });
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.openPath).toHaveBeenCalledWith(errorHandler.logPath);

    dialog.showMessageBox.mockResolvedValueOnce({ response: 2 });
    errorHandler.showErrorDialog({ type: 'x', message: 'm' });
    await Promise.resolve();
    await Promise.resolve();
    expect(app.quit).toHaveBeenCalled();
  });

  test('writeToLog before initialize is a no-op instead of a throw', () => {
    expect(() => errorHandler.writeToLog('orphan')).not.toThrow();
    expect(stream.write).not.toHaveBeenCalled();
  });

  test('logRendererError records a non-critical renderer error', () => {
    errorHandler.initialize();
    errorHandler.logRendererError({ message: 'renderer blew up' });
    expect(errorHandler.errorCount).toBe(1);
    expect(errorHandler.criticalErrors).toHaveLength(0);
  });

  test('close ends the stream once and stays closed', () => {
    errorHandler.initialize();
    errorHandler.close();
    errorHandler.close();
    expect(stream.end).toHaveBeenCalledTimes(1);
  });
});
