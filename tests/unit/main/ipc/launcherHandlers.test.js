// launcherHandlers — quick launcher IPC end to end over a real session store
// and the real ChatStreamService; only Electron (ipcMain, globalShortcut,
// BrowserWindow, screen, app) and the LLM client are replaced.
jest.mock('electron', () => {
  const { EventEmitter } = require('events');
  const handlers = {};
  const ipcMain = new EventEmitter();
  ipcMain.handle = jest.fn((ch, fn) => { handlers[ch] = fn; });
  ipcMain._handlers = handlers;
  const windows = [];
  class MockBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { send: jest.fn(), setWindowOpenHandler: jest.fn() });
      windows.push(this);
    }
    loadFile() { return Promise.resolve(); }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBounds() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    isVisible() { return this.visible; }
    isFocused() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  MockBrowserWindow._windows = windows;
  const held = new Map();
  return {
    app: { hide: jest.fn() },
    ipcMain,
    BrowserWindow: MockBrowserWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    globalShortcut: {
      _held: held,
      _taken: new Set(),
      register: jest.fn(function register(accel, fn) { if (this._taken.has(accel)) return false; held.set(accel, fn); return true; }),
      unregister: jest.fn((accel) => { held.delete(accel); }),
    },
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ipcMain, globalShortcut, BrowserWindow } = require('electron');
const { register } = require('../../../../main/ipc/launcherHandlers');
const { disposeLauncherWindow } = require('../../../../main/launcher/launcherWindow');
const { createSessionStore } = require('../../../../main/agent/sessions/sessionStore');
const { createArtifactStore } = require('../../../../main/agent/artifacts/artifactStore');
const chatStream = require('../../../../main/services/ChatStreamService');
const { gate } = require('../../../../main/agent/sessions/llmGate');
const { SessionManager } = require('../../../../main/agent/sessions/sessionManager');

const invoke = (ch, arg) => ipcMain._handlers[ch]({}, arg);
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function mockLlmClient(chunks, { throws = null } = {}) {
  return {
    chatCompletionStream: async function* () {
      if (throws) throw throws;
      for (const c of chunks) yield c;
      yield { __final: true, elapsedMs: 3 };
    },
  };
}

function makeConfig(launcher) {
  const cfg = new EventEmitter();
  cfg.get = (key, fallback) => {
    if (key === 'settings.assistant.launcher') return launcher;
    if (key === 'settings.theme') return 'dark';
    return fallback;
  };
  return cfg;
}

describe('launcherHandlers', () => {
  let dir;
  let store;
  let mainWindow;
  let services;
  let launcherWin;

  function setup(launcherSettings = { enabled: true, hotkey: 'Alt+Shift+Space' }) {
    for (const k of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[k];
    ipcMain.removeAllListeners();
    services = {
      sessionStore: store,
      artifactStore: createArtifactStore({ baseDir: path.join(dir, 'sessions') }),
      sessionManager: new SessionManager({ store, createHost: () => { throw new Error('no background runs in launcher tests'); } }),
      configService: makeConfig(launcherSettings),
      notificationService: { add: jest.fn() },
    };
    const launcher = register(mainWindow, services);
    // The window is built by the first show; streams go nowhere before that.
    launcher.show();
    launcherWin = BrowserWindow._windows[BrowserWindow._windows.length - 1];
    return launcher;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-launcher-'));
    store = createSessionStore({ baseDir: path.join(dir, 'sessions') });
    mainWindow = {
      isDestroyed: () => false, isMinimized: jest.fn(() => true), isVisible: jest.fn(() => true),
      restore: jest.fn(), show: jest.fn(), focus: jest.fn(), webContents: { send: jest.fn() },
    };
    globalShortcut._held.clear();
    globalShortcut._taken.clear();
    chatStream.cancelAll();
  });

  afterEach(() => {
    disposeLauncherWindow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('does nothing without a session store', () => {
    for (const k of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[k];
    expect(register(mainWindow, {})).toBeNull();
    expect(Object.keys(ipcMain._handlers)).toEqual([]);
  });

  test('submit creates a launcher session and streams the answer into the launcher window', async () => {
    setup();
    chatStream._setClient(mockLlmClient(['Paris ', 'is the capital.']));
    const res = await invoke('launcher:submit', { text: 'Capital of France?' });
    expect(res).toMatchObject({ ok: true, sessionId: expect.stringMatching(/^s_/) });
    await flush();
    const { meta, nodes } = store.get(res.sessionId);
    expect(meta).toMatchObject({ source: 'launcher', title: 'Capital of France?' });
    expect(nodes.map((n) => [n.role, n.content])).toEqual([['user', 'Capital of France?'], ['assistant', 'Paris is the capital.']]);
    const streamed = launcherWin.webContents.send.mock.calls.filter((c) => c[0] === 'launcher:stream').map((c) => c[1]);
    expect(streamed).toEqual([
      { sessionId: res.sessionId, type: 'chunk', delta: 'Paris ' },
      { sessionId: res.sessionId, type: 'chunk', delta: 'is the capital.' },
      { sessionId: res.sessionId, type: 'done' },
    ]);
  });

  test('the launcher session is held while its answer streams and freed once it is persisted', async () => {
    setup();
    let finish;
    const gateOpen = new Promise((r) => { finish = r; });
    chatStream._setClient({ chatCompletionStream: async function* stream() { yield 'Paris'; await gateOpen; yield { __final: true, elapsedMs: 1 }; } });
    const res = await invoke('launcher:submit', { text: 'Capital of France?' });
    await flush();
    expect(services.sessionManager.isBusy(res.sessionId)).toBe(true);
    expect(() => services.sessionManager.claim(res.sessionId)).toThrow('session_busy');
    finish();
    await flush();
    expect(services.sessionManager.isBusy(res.sessionId)).toBe(false);
    expect(store.get(res.sessionId).nodes.map((n) => n.content)).toEqual(['Capital of France?', 'Paris']);
  });

  test('a request that never reached the model removes its empty session and streams the error', async () => {
    setup();
    chatStream._setClient(mockLlmClient(['x']));
    gate.configure({ limit: () => 1 });
    const release = gate.tryAcquire();
    try {
      const res = await invoke('launcher:submit', { text: 'hello' });
      await flush();
      expect(store.exists(res.sessionId)).toBe(false);
      expect(launcherWin.webContents.send).toHaveBeenCalledWith('launcher:stream', { sessionId: res.sessionId, type: 'error', error: 'engine_busy' });
      expect(services.sessionManager.isBusy(res.sessionId)).toBe(false);
    } finally {
      release();
    }
  });

  test('a failed stream keeps the session with an error turn', async () => {
    setup();
    chatStream._setClient(mockLlmClient([], { throws: new Error('connect ECONNREFUSED') }));
    const res = await invoke('launcher:submit', { text: 'hello' });
    await flush();
    const { nodes } = store.get(res.sessionId);
    expect(nodes.map((n) => n.kind || 'message')).toEqual(['message', 'error']);
    expect(launcherWin.webContents.send).toHaveBeenCalledWith('launcher:stream', { sessionId: res.sessionId, type: 'error', error: 'connect ECONNREFUSED' });
  });

  test.each([[undefined], [''], ['   '], [42], ['x'.repeat(100001)]])('submit rejects invalid text %#', async (text) => {
    setup();
    await expect(invoke('launcher:submit', { text })).resolves.toEqual({ ok: false, error: 'invalid_text' });
    expect(store.list()).toEqual([]);
  });

  test('open-in-assistant shows the main window and sends app-mode:set with the session', async () => {
    const launcher = setup();
    const session = store.create({ source: 'launcher' });
    await expect(invoke('launcher:open-in-assistant', { sessionId: session.id })).resolves.toEqual({ ok: true });
    expect(mainWindow.restore).toHaveBeenCalled();
    expect(mainWindow.show).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('app-mode:set', { mode: 'assistant', sessionId: session.id });
    expect(launcher.isVisible()).toBe(false);
  });

  test('open-in-assistant rejects malformed and unknown session ids without touching the main window', async () => {
    setup();
    await expect(invoke('launcher:open-in-assistant', { sessionId: '../etc' })).resolves.toMatchObject({ ok: false });
    await expect(invoke('launcher:open-in-assistant', { sessionId: 's_abcdef123' })).resolves.toEqual({ ok: false, error: 'session_not_found' });
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('app-mode:set', expect.anything());
  });

  test('launcher:hide hides the window', async () => {
    const launcher = setup();
    await expect(invoke('launcher:hide')).resolves.toEqual({ ok: true });
    expect(launcher.isVisible()).toBe(false);
  });

  test('registers the configured hotkey, which toggles the launcher', () => {
    const launcher = setup({ enabled: true, hotkey: 'Ctrl+Alt+K' });
    expect(globalShortcut.register).toHaveBeenCalledWith('Ctrl+Alt+K', expect.any(Function));
    globalShortcut._held.get('Ctrl+Alt+K')();
    expect(launcher.isVisible()).toBe(false);
    globalShortcut._held.get('Ctrl+Alt+K')();
    expect(launcher.isVisible()).toBe(true);
  });

  test('launcher disabled: no hotkey is registered', () => {
    setup({ enabled: false, hotkey: 'Ctrl+Alt+K' });
    expect(globalShortcut.register).not.toHaveBeenCalled();
  });

  test('a taken accelerator is surfaced as a notification and a register-failed push, not swallowed', () => {
    globalShortcut._taken.add('Alt+Shift+Space');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setup();
    expect(services.notificationService.add).toHaveBeenCalledWith(expect.objectContaining({
      tag: 'launcher-hotkey', title: 'Quick launcher hotkey unavailable', body: expect.stringContaining('Alt+Shift+Space'),
    }));
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('shortcut:register-failed', { shortcut: 'Alt+Shift+Space' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('could not register hotkey "Alt+Shift+Space"'));
  });
});
