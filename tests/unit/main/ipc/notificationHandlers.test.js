jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    webContents: { getAllWebContents: jest.fn(() => []), fromId: jest.fn() },
    BrowserWindow: { fromWebContents: jest.fn() },
  };
});

const { ipcMain, webContents, BrowserWindow } = require('electron');
const { register } = require('../../../../main/ipc/notificationHandlers');

function makeServices() {
  const nsListeners = {};
  const notificationService = {
    _l: nsListeners,
    on: jest.fn((evt, fn) => { (nsListeners[evt] = nsListeners[evt] || []).push(fn); }),
    emit: (evt, p) => { (nsListeners[evt] || []).forEach((fn) => fn(p)); },
    list: jest.fn(() => [{ id: 'n1' }]),
    dismiss: jest.fn(() => true),
    clearAll: jest.fn(() => 3),
    markRead: jest.fn(() => true),
    markAllRead: jest.fn(() => 5),
    unreadCount: jest.fn(() => 2),
    getWebContentsIdFor: jest.fn(() => 42),
    add: jest.fn(),
  };
  const ppListeners = {};
  const permissionPromptService = {
    on: jest.fn((evt, fn) => { (ppListeners[evt] = ppListeners[evt] || []).push(fn); }),
    emit: (evt, p) => { (ppListeners[evt] || []).forEach((fn) => fn(p)); },
    resolve: jest.fn(),
    requestDecision: jest.fn(async () => 'allow'),
    denyOnRendererReset: jest.fn(),
  };
  const psListeners = {};
  const permissionService = {
    on: jest.fn((evt, fn) => { (psListeners[evt] = psListeners[evt] || []).push(fn); }),
    emit: (evt, p) => { (psListeners[evt] || []).forEach((fn) => fn(p)); },
    getOverrides: jest.fn(() => [{ origin: 'a' }]),
    clearOverride: jest.fn(() => true),
    decide: jest.fn(() => 'allow'),
  };
  return { notificationService, permissionPromptService, permissionService };
}

describe('notificationHandlers', () => {
  let services;
  let mainWindow;

  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    webContents.getAllWebContents.mockReturnValue([]);
    webContents.fromId.mockReturnValue(null);
    BrowserWindow.fromWebContents.mockReturnValue(null);

    services = makeServices();
    mainWindow = { isDestroyed: jest.fn(() => false), isMinimized: jest.fn(() => false), restore: jest.fn(), show: jest.fn(), focus: jest.fn(), webContents: { send: jest.fn() } };
    register(mainWindow, services);
  });

  test('no-ops when notificationService missing', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow, { permissionPromptService: {}, permissionService: {} });
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('no-ops when permissionService missing', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow, { notificationService: {}, permissionPromptService: {} });
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('no-ops when services arg omitted entirely', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow);
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  describe('event relays', () => {
    test('notificationService relay events forward to renderer', () => {
      services.notificationService.emit('added', { id: 1 });
      services.notificationService.emit('cleared', null);
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('notifications:added', { id: 1 });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('notifications:cleared', null);
    });

    test('permission prompt relays', () => {
      services.permissionPromptService.emit('prompt', { id: 'p1' });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('notifications:permission-prompt', { id: 'p1' });
    });

    test('a settled prompt is relayed so the renderer can drop it', () => {
      services.permissionPromptService.emit('resolved', { id: 'p1', decision: 'deny' });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('notifications:permission-resolved', { id: 'p1', decision: 'deny' });
    });

    test('pending prompts are tied to the shell renderer that shows them', () => {
      expect(services.permissionPromptService.denyOnRendererReset).toHaveBeenCalledWith(mainWindow.webContents);
    });

    test('override-changed broadcasts to all webContents', () => {
      const wcA = { send: jest.fn() };
      const wcB = { send: jest.fn() };
      webContents.getAllWebContents.mockReturnValue([wcA, wcB]);
      services.permissionService.emit('override-changed', { origin: 'x' });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('notifications:permission-changed', { origin: 'x' });
      expect(wcA.send).toHaveBeenCalledWith('permission:changed', { origin: 'x' });
      expect(wcB.send).toHaveBeenCalledWith('permission:changed', { origin: 'x' });
    });

    test('override-changed swallows per-wc send errors', () => {
      const bad = { send: jest.fn(() => { throw new Error('x'); }) };
      webContents.getAllWebContents.mockReturnValue([bad]);
      expect(() => services.permissionService.emit('override-changed', {})).not.toThrow();
    });

    test('override-changed swallows getAllWebContents errors', () => {
      webContents.getAllWebContents.mockImplementation(() => { throw new Error('boom'); });
      expect(() => services.permissionService.emit('override-changed', {})).not.toThrow();
    });

    test('send guard: destroyed window suppresses relay', () => {
      mainWindow.isDestroyed.mockReturnValue(true);
      services.notificationService.emit('added', { id: 1 });
      expect(mainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('list/dismiss/clear/mark handlers', () => {
    test('notifications:list', async () => {
      expect(await ipcMain._handlers['notifications:list']()).toEqual([{ id: 'n1' }]);
    });
    test('notifications:dismiss', async () => {
      expect(await ipcMain._handlers['notifications:dismiss']({}, 'n1')).toBe(true);
      expect(services.notificationService.dismiss).toHaveBeenCalledWith('n1');
    });
    test('notifications:clear-all', async () => {
      expect(await ipcMain._handlers['notifications:clear-all']()).toBe(3);
    });
    test('notifications:mark-read', async () => {
      expect(await ipcMain._handlers['notifications:mark-read']({}, 'n1')).toBe(true);
    });
    test('notifications:mark-all-read', async () => {
      expect(await ipcMain._handlers['notifications:mark-all-read']()).toBe(5);
    });
  });

  describe('notifications:activate', () => {
    test('returns false when no webContents id maps', async () => {
      services.notificationService.getWebContentsIdFor.mockReturnValue(0);
      expect(await ipcMain._handlers['notifications:activate']({}, 'n1')).toBe(false);
    });

    test('returns false when wc not found', async () => {
      webContents.fromId.mockReturnValue(null);
      expect(await ipcMain._handlers['notifications:activate']({}, 'n1')).toBe(false);
    });

    test('returns false when wc destroyed', async () => {
      webContents.fromId.mockReturnValue({ isDestroyed: () => true });
      expect(await ipcMain._handlers['notifications:activate']({}, 'n1')).toBe(false);
    });

    test('activates and focuses host window (restore path)', async () => {
      const wc = { isDestroyed: () => false, send: jest.fn() };
      webContents.fromId.mockReturnValue(wc);
      const hostWin = { isDestroyed: () => false, isMinimized: () => true, restore: jest.fn(), show: jest.fn(), focus: jest.fn() };
      BrowserWindow.fromWebContents.mockReturnValue(hostWin);
      const r = await ipcMain._handlers['notifications:activate']({}, 'n1');
      expect(wc.send).toHaveBeenCalledWith('notification:activate', 'n1');
      expect(hostWin.restore).toHaveBeenCalled();
      expect(hostWin.show).toHaveBeenCalled();
      expect(hostWin.focus).toHaveBeenCalled();
      expect(r).toBe(true);
    });

    test('routes activate under the webview localId when the record carries one', async () => {
      services.notificationService.list.mockReturnValue([{ id: 'n1', localId: 'local-abc' }]);
      const wc = { isDestroyed: () => false, send: jest.fn() };
      webContents.fromId.mockReturnValue(wc);
      await ipcMain._handlers['notifications:activate']({}, 'n1');
      // The preload keys live Notification instances by its localId, not the
      // service-generated record id.
      expect(wc.send).toHaveBeenCalledWith('notification:activate', 'local-abc');
      expect(wc.send).not.toHaveBeenCalledWith('notification:activate', 'n1');
    });

    test('falls back to mainWindow when no host window', async () => {
      const wc = { isDestroyed: () => false, send: jest.fn() };
      webContents.fromId.mockReturnValue(wc);
      BrowserWindow.fromWebContents.mockReturnValue(null);
      const r = await ipcMain._handlers['notifications:activate']({}, 'n1');
      expect(mainWindow.show).toHaveBeenCalled();
      expect(r).toBe(true);
    });

    test('returns false when fromId throws', async () => {
      webContents.fromId.mockImplementation(() => { throw new Error('boom'); });
      expect(await ipcMain._handlers['notifications:activate']({}, 'n1')).toBe(false);
    });
  });

  describe('permission override handlers', () => {
    test('list-overrides', async () => {
      expect(await ipcMain._handlers['notifications:permission:list-overrides']()).toEqual([{ origin: 'a' }]);
    });

    test('clear-override returns false when no permission', async () => {
      expect(await ipcMain._handlers['notifications:permission:clear-override']({}, { origin: 'a' })).toBe(false);
    });

    test('clear-override calls service with default origin "*"', async () => {
      const r = await ipcMain._handlers['notifications:permission:clear-override']({}, { permission: 'notifications' });
      expect(services.permissionService.clearOverride).toHaveBeenCalledWith('*', 'notifications');
      expect(r).toBe(true);
    });

    test('clear-override uses provided origin', async () => {
      await ipcMain._handlers['notifications:permission:clear-override']({}, { origin: 'https://x', permission: 'geo' });
      expect(services.permissionService.clearOverride).toHaveBeenCalledWith('https://x', 'geo');
    });

    test('clear-override defaults arg to {} (no permission → false)', async () => {
      expect(await ipcMain._handlers['notifications:permission:clear-override']({})).toBe(false);
    });
  });

  describe('notifications:permission:resolve', () => {
    test('resolves when id present', () => {
      ipcMain._handlers['notifications:permission:resolve']({}, { id: 'p1', decision: 'allow', remember: true });
      expect(services.permissionPromptService.resolve).toHaveBeenCalledWith('p1', 'allow', true);
    });

    test('does nothing when no id', () => {
      ipcMain._handlers['notifications:permission:resolve']({}, {});
      expect(services.permissionPromptService.resolve).not.toHaveBeenCalled();
    });

    test('defaults payload to {}', () => {
      ipcMain._handlers['notifications:permission:resolve']({});
      expect(services.permissionPromptService.resolve).not.toHaveBeenCalled();
    });
  });

  describe('notification:show', () => {
    test('adds notification with sender URL origin', () => {
      const event = { sender: { id: 7, getURL: () => 'https://site.com/p', session: {} } };
      ipcMain._handlers['notification:show'](event, { title: 'T', body: 'B' });
      expect(services.notificationService.add).toHaveBeenCalledWith(expect.objectContaining({
        origin: 'https://site.com/p', title: 'T', body: 'B', webContentsId: 7, ephemeral: false,
      }));
    });

    test('uses payload.origin when string', () => {
      const event = { sender: { id: 7, getURL: () => 'https://x' } };
      ipcMain._handlers['notification:show'](event, { origin: 'https://explicit', title: 'T' });
      expect(services.notificationService.add).toHaveBeenCalledWith(expect.objectContaining({ origin: 'https://explicit' }));
    });

    test('marks ephemeral when sender uses private session', () => {
      const priv = { id: 'priv' };
      const sessionService = { isPrivateContents: jest.fn((wc) => !!wc && wc.session === priv) };
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { ...services, sessionService });
      const event = { sender: { id: 9, getURL: () => 'https://x', session: priv } };
      ipcMain._handlers['notification:show'](event, { title: 'T' });
      expect(services.notificationService.add).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    });

    test('a private-session check that throws drops the notification visibly instead of saving it', () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      const sessionService = { isPrivateContents: jest.fn(() => { throw new Error('x'); }) };
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { ...services, sessionService });
      const event = { sender: { id: 9, getURL: () => 'https://x', session: {} } };
      expect(() => ipcMain._handlers['notification:show'](event, { title: 'T' })).not.toThrow();
      expect(services.notificationService.add).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledWith('[notifications] add failed:', expect.any(Error));
      err.mockRestore();
    });

    test('null webContentsId when sender id not a number', () => {
      const event = { sender: { id: 'abc', getURL: () => 'https://x' } };
      ipcMain._handlers['notification:show'](event, { title: 'T' });
      expect(services.notificationService.add).toHaveBeenCalledWith(expect.objectContaining({ webContentsId: null }));
    });

    test('add failure is caught and logged', () => {
      services.notificationService.add.mockImplementation(() => { throw new Error('addfail'); });
      const event = { sender: { id: 1, getURL: () => 'https://x' } };
      expect(() => ipcMain._handlers['notification:show'](event, {})).not.toThrow();
    });

    test('defaults payload to {} when omitted', () => {
      const event = { sender: { id: 1, getURL: () => 'https://x' } };
      ipcMain._handlers['notification:show'](event);
      expect(services.notificationService.add).toHaveBeenCalled();
    });
  });

  describe('permission:check / permission:request', () => {
    test('permission:check returns deny when no permission', async () => {
      expect(await ipcMain._handlers['permission:check']({}, 'https://x')).toBe('deny');
    });

    test('permission:check delegates to service.decide', async () => {
      services.permissionService.decide.mockReturnValue('allow');
      expect(await ipcMain._handlers['permission:check']({}, 'https://x', 'geo')).toBe('allow');
      expect(services.permissionService.decide).toHaveBeenCalledWith('https://x', 'geo', { ephemeral: false });
    });

    test('permission:request returns denied when no permission', async () => {
      expect(await ipcMain._handlers['permission:request']({}, 'https://x')).toBe('denied');
    });

    test('permission:request returns granted when decide is allow', async () => {
      services.permissionService.decide.mockReturnValue('allow');
      expect(await ipcMain._handlers['permission:request']({}, 'https://x', 'geo')).toBe('granted');
    });

    test('permission:request returns denied when decide is deny', async () => {
      services.permissionService.decide.mockReturnValue('deny');
      expect(await ipcMain._handlers['permission:request']({}, 'https://x', 'geo')).toBe('denied');
    });

    test('permission:request prompts when decide is prompt → granted', async () => {
      services.permissionService.decide.mockReturnValue('prompt');
      services.permissionPromptService.requestDecision.mockResolvedValue('allow');
      expect(await ipcMain._handlers['permission:request']({}, 'https://x', 'geo')).toBe('granted');
      expect(services.permissionPromptService.requestDecision).toHaveBeenCalledWith('https://x', 'geo', undefined, { ephemeral: false });
    });

    test('a private tab\'s check and request use and keep only session-only answers', async () => {
      const priv = { id: 'priv' };
      const sessionService = { isPrivateContents: jest.fn((wc) => !!wc && wc.session === priv) };
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { ...services, sessionService });
      const event = { sender: { session: priv } };
      services.permissionService.decide.mockReturnValue('prompt');
      await ipcMain._handlers['permission:check'](event, 'https://x', 'notifications');
      expect(services.permissionService.decide).toHaveBeenLastCalledWith('https://x', 'notifications', { ephemeral: true });
      expect(await ipcMain._handlers['permission:request'](event, 'https://x', 'notifications')).toBe('granted');
      expect(services.permissionPromptService.requestDecision).toHaveBeenCalledWith('https://x', 'notifications', undefined, { ephemeral: true });
    });

    test('permission:request prompts when decide is prompt → denied', async () => {
      services.permissionService.decide.mockReturnValue('prompt');
      services.permissionPromptService.requestDecision.mockResolvedValue('deny');
      expect(await ipcMain._handlers['permission:request']({}, 'https://x', 'geo')).toBe('denied');
    });
  });
});
