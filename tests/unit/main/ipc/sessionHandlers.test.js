// sessionHandlers — the session:clear-site-data channel behind the Library's
// "Clear Cookies & Cache" button. Electron's session is the external boundary.

jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    session: { defaultSession: { clearCache: jest.fn(), clearStorageData: jest.fn() } },
  };
});

const { ipcMain, session } = require('electron');
const { register } = require('../../../../main/ipc/sessionHandlers');
const sessionService = require('../../../../main/services/SessionService');

const privateSession = {
  clearStorageData: jest.fn(),
  clearCache: jest.fn(),
  clearAuthCache: jest.fn(),
};
sessionService._setSessionModule({ fromPartition: () => privateSession });
sessionService.initialize({});

describe('sessionHandlers', () => {
  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    session.defaultSession.clearCache.mockReset().mockResolvedValue(undefined);
    session.defaultSession.clearStorageData.mockReset().mockResolvedValue(undefined);
    for (const fn of Object.values(privateSession)) fn.mockReset().mockResolvedValue(undefined);
    register({}, { sessionService });
  });

  test('session:clear-site-data empties both the cache and stored site data', async () => {
    expect(await ipcMain._handlers['session:clear-site-data']()).toEqual({ ok: true });
    expect(session.defaultSession.clearCache).toHaveBeenCalled();
    expect(session.defaultSession.clearStorageData).toHaveBeenCalled();
  });

  test('a failing clear reports the error instead of a false success', async () => {
    session.defaultSession.clearStorageData.mockRejectedValue(new Error('locked'));
    expect(await ipcMain._handlers['session:clear-site-data']()).toEqual({ ok: false, error: 'locked' });
  });

  test('session:clear-private wipes the private session and leaves normal browsing alone', async () => {
    expect(await ipcMain._handlers['session:clear-private']()).toEqual({ ok: true });
    expect(privateSession.clearStorageData).toHaveBeenCalled();
    expect(privateSession.clearCache).toHaveBeenCalled();
    expect(privateSession.clearAuthCache).toHaveBeenCalled();
    expect(session.defaultSession.clearStorageData).not.toHaveBeenCalled();
    expect(session.defaultSession.clearCache).not.toHaveBeenCalled();
  });

  test('session:private-ready answers only after a private clear in flight has finished', async () => {
    let finish;
    privateSession.clearCache.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    const cleared = ipcMain._handlers['session:clear-private']();
    let answer = null;
    const ready = ipcMain._handlers['session:private-ready']().then((res) => { answer = res; });
    await new Promise((r) => setImmediate(r));
    expect(answer).toBeNull();
    finish();
    await cleared;
    await ready;
    expect(answer).toEqual({ ok: true });
  });

  test('session:private-ready reports a wipe that could not be completed', async () => {
    privateSession.clearCache.mockRejectedValue(new Error('busy'));
    await ipcMain._handlers['session:clear-private']();
    expect(await ipcMain._handlers['session:private-ready']()).toEqual({ ok: false, error: 'busy' });
  });

  test('a failing private clear reports the error', async () => {
    privateSession.clearCache.mockRejectedValue(new Error('busy'));
    expect(await ipcMain._handlers['session:clear-private']()).toEqual({ ok: false, error: 'busy' });
  });

  describe('shell renderer reset', () => {
    const { EventEmitter } = require('events');
    const flush = () => new Promise((r) => setImmediate(r));
    let wc;

    beforeEach(() => {
      wc = new EventEmitter();
      register({ webContents: wc }, { sessionService });
    });

    test('a shell reload drops every private tab, so the private session is wiped', async () => {
      wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      await flush();
      expect(privateSession.clearStorageData).toHaveBeenCalled();
      expect(privateSession.clearAuthCache).toHaveBeenCalled();
    });

    test('a shell crash wipes the private session', async () => {
      wc.emit('render-process-gone', {}, { reason: 'crashed' });
      await flush();
      expect(privateSession.clearStorageData).toHaveBeenCalled();
    });

    test('an artifact iframe loading leaves the private session alone', async () => {
      wc.emit('did-start-loading');
      wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
      await flush();
      expect(privateSession.clearStorageData).not.toHaveBeenCalled();
    });

    test('a failed wipe after a reset is logged, not dropped', async () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      privateSession.clearStorageData.mockRejectedValue(new Error('locked'));
      wc.emit('render-process-gone', {}, { reason: 'crashed' });
      await flush();
      expect(err).toHaveBeenCalledWith('[sessionHandlers] could not clear the private session after a shell reset:', expect.any(Error));
      err.mockRestore();
    });
  });
});
