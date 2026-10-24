jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock'),
    isPackaged: false,
    on: jest.fn(),
    quit: jest.fn(),
  },
  globalShortcut: {
    register: jest.fn(() => true),
    unregister: jest.fn(),
    unregisterAll: jest.fn(),
  },
  ipcMain: {
    on: jest.fn(),
    handle: jest.fn(),
  },
  Menu: { buildFromTemplate: jest.fn(() => ({})), setApplicationMenu: jest.fn() },
  Tray: jest.fn(() => ({ setToolTip: jest.fn(), setContextMenu: jest.fn(), destroy: jest.fn() })),
  nativeImage: { createFromPath: jest.fn(() => ({ isEmpty: jest.fn(() => true), resize: jest.fn(function() { return this; }) })) },
  shell: { openPath: jest.fn(), openExternal: jest.fn() },
  dialog: { showErrorBox: jest.fn(), showMessageBox: jest.fn() },
  clipboard: { writeText: jest.fn() },
  session: {
    defaultSession: {
      webRequest: { onBeforeSendHeaders: jest.fn(), onHeadersReceived: jest.fn() },
      clearStorageData: jest.fn(() => Promise.resolve()),
      protocol: { handle: jest.fn() },
    },
    fromPartition: jest.fn(() => ({
      setPermissionRequestHandler: jest.fn(), setPermissionCheckHandler: jest.fn(), on: jest.fn(),
      webRequest: { onBeforeSendHeaders: jest.fn(), onHeadersReceived: jest.fn() },
    })),
  },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  copyFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(() => []),
  statSync: jest.fn(() => ({ mtimeMs: 0 })),
  promises: { readFile: jest.fn(), writeFile: jest.fn(), readdir: jest.fn().mockResolvedValue([]) },
  constants: jest.requireActual('fs').constants,
}));

jest.mock('@ghostery/adblocker-electron', () => ({
  ElectronBlocker: { fromLists: jest.fn(), deserialize: jest.fn() },
}));
jest.mock('cross-fetch', () => jest.fn());
jest.mock('child_process', () => ({ execFileSync: jest.fn(() => '0') }));
jest.mock('electron-prompt', () => jest.fn().mockResolvedValue(null));

const App = require('../../../main/App');

describe('App', () => {
  let appInstance;
  let mockWindow;

  beforeEach(() => {
    appInstance = new App();
    mockWindow = {
      isDestroyed: jest.fn(() => false), // ipc/* handlers guard every webContents.send with this; any test whose config reaches a main→renderer emit (e.g. the boot remote-restore specs below) needs it on the fixture, not just in production BrowserWindows
      webContents: { send: jest.fn(), on: jest.fn(), session: { clearCache: jest.fn(), cookies: { flushStore: jest.fn() } } },
      isVisible: jest.fn(() => false),
      show: jest.fn(),
      hide: jest.fn(),
      focus: jest.fn(),
    };
  });

  afterEach(() => {
    // Clean up any started intervals (MemoryService, RoutineService)
    const memoryService = require('../../../main/services/MemoryService');
    memoryService.cleanup();
    const routineService = require('../../../main/services/RoutineService');
    routineService.stop();
    // Registering updaterHandlers and engineUpdateHandlers arms each service's
    // first-check timer; on a loaded machine this file outlives the 60 s engine
    // timer, which then probes engine paths after teardown.
    require('../../../main/services/UpdateService').stop();
    require('../../../main/services/EngineUpdateService').stop();
    // bindConfig() schedules its first _reload on setImmediate; without this it
    // fires after the environment is torn down and requires modules from a dead
    // registry.
    const mcpService = require('../../../main/services/McpService');
    return mcpService.stopAll();
  });

  test('creates App instance with empty state', () => {
    expect(appInstance.mainWindow).toBeNull();
    expect(appInstance.spaceStates).toBeInstanceOf(Map);
  });

  test('initialize sets mainWindow', () => {
    appInstance.initialize(mockWindow);
    expect(appInstance.mainWindow).toBe(mockWindow);
  });

  test('initialize registers IPC handlers', () => {
    const { ipcMain } = require('electron');
    const onCount = ipcMain.on.mock.calls.length;

    appInstance.initialize(mockWindow);

    expect(ipcMain.on.mock.calls.length).toBeGreaterThan(onCount);
  });

  test('initialize wires the privacy settings into the default session', () => {
    const { session } = require('electron');
    session.defaultSession.webRequest.onBeforeSendHeaders.mockClear();
    appInstance.initialize(mockWindow);
    expect(session.defaultSession.webRequest.onBeforeSendHeaders).toHaveBeenCalledWith(expect.any(Function));
  });

  test('initialize gives the private session the privacy listeners and download tracking', () => {
    const sessionService = require('../../../main/services/SessionService');
    sessionService._installed = false;
    appInstance.initialize(mockWindow);
    const priv = sessionService.getSession();
    const { session } = require('electron');
    expect(priv).not.toBe(session.defaultSession);
    expect(priv.webRequest.onBeforeSendHeaders).toHaveBeenCalledWith(expect.any(Function));
    expect(priv.webRequest.onHeadersReceived).toHaveBeenCalledWith({ urls: ['<all_urls>'] }, expect.any(Function));
    expect(priv.on).toHaveBeenCalledWith('will-download', expect.any(Function));
  });

  test('setupLifecycleHandlers registers app events', () => {
    const { app } = require('electron');
    appInstance.mainWindow = mockWindow;
    appInstance.setupLifecycleHandlers();

    const registeredEvents = app.on.mock.calls.map((c) => c[0]);
    expect(registeredEvents).toContain('before-quit');
    expect(registeredEvents).toContain('will-quit');
    // activate handler is registered in index.js, not App.js
  });

  describe('initialize idempotency (macOS activate after window loss)', () => {
    // index.js's 'activate' handler re-calls appInstance.initialize() whenever the main window was destroyed but the process stayed alive on darwin — a path that doesn't exist today, so this is a guard against a future window-rebuild feature stepping on it. A second full initialize() would throw in Electron ("Attempted to register a second handler") at registerAll and stack a duplicate tray + every per-service .on registration; the only things safe/needed to update are App's own references.
    test('second call updates mainWindow but re-registers no IPC handlers and recreates nothing', () => {
      const { ipcMain, Tray } = require('electron');
      appInstance.initialize(mockWindow); // first pass: everything real happens here — tray created once, every handler registered once

      const handlesAfterFirst = ipcMain.handle.mock.calls.length; // registerAll uses handle(); the two self-registering services (agentTabOps/approvalService) use on() so count both
      const onsAfterFirst = ipcMain.on.mock.calls.length;
      const trayConstructionsAfterFirst = Tray.mock.calls.length;

      const secondWindow = { isDestroyed: jest.fn(() => false), webContents: { send: jest.fn(), on: jest.fn(), session: mockWindow.webContents.session }, isVisible: jest.fn(() => true), show: jest.fn(), hide: jest.fn(), focus: jest.fn() }; // a fresh fixture stands in for the rebuilt BrowserWindow index.js would hand back — must not be identical to the first one, or "updates mainWindow" could pass by accident

      appInstance.initialize(secondWindow);

      expect(appInstance.mainWindow).toBe(secondWindow); // the ONE thing that should change on re-init is which window services talk to
      expect(ipcMain.handle.mock.calls.length).toBe(handlesAfterFirst); // a real second Electron run would throw "Attempted to register a second handler" here — this asserts we never reach that path at all, not just that it's tolerated
      expect(ipcMain.on.mock.calls.length).toBe(onsAfterFirst);
      expect(Tray.mock.calls.length).toBe(trayConstructionsAfterFirst); // a stacked tray is user-visible clutter and means two menus/shortcuts both think they own the app — exactly what "re-initialize" was never supposed to do, only re-point at the new window
    });
  });

  describe('boot remote-endpoint restore', () => {
    const configService = require('../../../main/services/ConfigService');
    const llmService = require('../../../main/services/LLMService');

    beforeEach(() => { llmService._remote = null; }); // prior test in this file may have activated one via initialize(); start from a known-clean singleton
    afterEach(() => { configService.config = null; }); // ConfigService is a module-level singleton shared across tests IN THIS FILE (jest isolates per-file only) — reset so the next initialize() doesn't inherit this fixture

    function seedConfig({ remote, activeBackend, mode }) {
      const llm = {};
      if (remote !== undefined) llm.remote = remote;
      if (activeBackend !== undefined) llm.activeBackend = activeBackend;
      if (mode !== undefined) llm.mode = mode;
      configService.config = { settings: { llm } }; // bypass loadConfig entirely — get() short-circuits on a non-null .config, so no fs involvement in this test at all
    }

    test("restores the remote endpoint when activeBackend === 'remote' (explicit user choice)", () => {
      seedConfig({ remote: { endpoint: 'https://api.example.com', apiKey: 'sk-test', model: 'big-model' }, activeBackend: 'remote' }); // this is exactly what llm:set-remote persists on "Use Remote" — the positive control proving the gate below does not over-correct and start restoring nothing at all
      appInstance.initialize(mockWindow);
      expect(llmService._remote).toMatchObject({ endpoint: 'https://api.example.com' }); // if this starts failing after a change to App.js, someone removed or re-gated the restore path — pure-remote setups would silently lose their configured API on every restart until they notice no model is responding
    });

    // activeBackend doubles as the local-engine picker: picking llama.cpp anywhere in
    // Settings overwrites it, which stranded a remote-mode user with "No active LLM
    // endpoint" on every restart while Settings still showed a reachable endpoint.
    test("restores the remote endpoint when mode === 'remote' even after a local engine pick overwrote activeBackend", () => {
      seedConfig({ remote: { endpoint: 'https://api.example.com', apiKey: 'sk-test', model: 'big-model' }, activeBackend: 'llamaCpp', mode: 'remote' });
      appInstance.initialize(mockWindow);
      expect(llmService._remote).toMatchObject({ endpoint: 'https://api.example.com' });
    });

    test("does NOT activate remote when activeBackend === 'local', even though an endpoint + key are still persisted", () => {
      seedConfig({ remote: { endpoint: 'https://api.example.com', apiKey: 'sk-test' }, activeBackend: 'local', mode: 'local' }); // the exact state Clear Remote leaves on disk (it nulls in-memory _remote and drops mode back to 'local', but never wipes settings.llm.remote itself — see llmHandlers.js clear-remote)
      appInstance.initialize(mockWindow);
      expect(llmService._remote).toBeNull(); // unconditionally restoring here means "clear remote → restart" silently re-enables a paid API endpoint with no UI indication the user ever asked for it again — that is what this test exists to catch, and there is currently nothing else in the suite watching App.js's boot path at all
    });

    test("does NOT activate remote when activeBackend was never set (legacy/partial config)", () => {
      seedConfig({ remote: { endpoint: 'https://api.example.com', apiKey: 'sk-test' } }); // no activeBackend key present — get() will return its default, not throw; a legacy pre-v-something config that somehow has an endpoint string but never went through llm:set-remote's full persist path
      appInstance.initialize(mockWindow);
      expect(llmService._remote).toBeNull(); // same reasoning as the 'local' case: absent intent is treated as "do not silently spend money", and the UI will show Local mode so a user who actually wanted remote has an obvious one-click way to get it back rather than discovering the endpoint re-activated by accident
    });
  });
});
