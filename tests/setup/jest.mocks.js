// This file sets up mocks before any test code or module imports
// It prevents the actual Electron app from launching during tests

// Mock electron before any code can require it
jest.mock('electron', () => ({
  app: {
    on: jest.fn(),
    whenReady: jest.fn(() => Promise.resolve()),
    quit: jest.fn(),
    exit: jest.fn(),
    relaunch: jest.fn(),
    isReady: jest.fn(() => true),
    getName: jest.fn(() => 'InstantCognition'),
    getPath: jest.fn((name) => `/mock/path/${name}`),
    getAppPath: jest.fn(() => '/mock/app/path'),
    setPath: jest.fn(),
    dock: {
      hide: jest.fn(),
      show: jest.fn(),
    },
  },
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadFile: jest.fn(),
    loadURL: jest.fn(),
    on: jest.fn(),
    webContents: {
      on: jest.fn(),
      send: jest.fn(),
      openDevTools: jest.fn(),
      session: {
        clearCache: jest.fn(),
        clearStorageData: jest.fn(),
      },
    },
    show: jest.fn(),
    hide: jest.fn(),
    close: jest.fn(),
    destroy: jest.fn(),
    isDestroyed: jest.fn(() => false),
    focus: jest.fn(),
    blur: jest.fn(),
    isFocused: jest.fn(() => true),
    getBounds: jest.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    setBounds: jest.fn(),
    center: jest.fn(),
    setAlwaysOnTop: jest.fn(),
  })),
  ipcMain: {
    on: jest.fn(),
    once: jest.fn(),
    handle: jest.fn(),
    removeHandler: jest.fn(),
    removeAllListeners: jest.fn(),
  },
  ipcRenderer: {
    send: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    invoke: jest.fn(),
    removeAllListeners: jest.fn(),
  },
  dialog: {
    showOpenDialog: jest.fn(),
    showSaveDialog: jest.fn(),
    showMessageBox: jest.fn(),
    showErrorBox: jest.fn(),
  },
  shell: {
    openExternal: jest.fn(),
    openPath: jest.fn(),
    showItemInFolder: jest.fn(),
  },
  globalShortcut: {
    register: jest.fn(() => true),
    unregister: jest.fn(),
    unregisterAll: jest.fn(),
    isRegistered: jest.fn(() => false),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    themeSource: 'system',
    on: jest.fn(),
  },
  screen: {
    getCursorScreenPoint: jest.fn(() => ({ x: 0, y: 0 })),
    getPrimaryDisplay: jest.fn(() => ({
      workAreaSize: { width: 1920, height: 1080 },
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })),
    getAllDisplays: jest.fn(() => []),
    getDisplayMatching: jest.fn(),
    getDisplayNearestPoint: jest.fn(),
  },
  Menu: jest.fn(),
  MenuItem: jest.fn(),
  Tray: jest.fn().mockImplementation(() => ({
    setImage: jest.fn(),
    setToolTip: jest.fn(),
    setContextMenu: jest.fn(),
    on: jest.fn(),
    destroy: jest.fn(),
  })),
  protocol: {
    registerFileProtocol: jest.fn(),
    registerHttpProtocol: jest.fn(),
    registerStringProtocol: jest.fn(),
    unregisterProtocol: jest.fn(),
  },
  session: {
    defaultSession: {
      clearCache: jest.fn(),
      clearStorageData: jest.fn(),
      webRequest: {
        onBeforeRequest: jest.fn(),
      },
    },
  },
  clipboard: {
    readText: jest.fn(() => ''),
    writeText: jest.fn(),
    clear: jest.fn(),
  },
  powerMonitor: {
    on: jest.fn(),
  },
  systemPreferences: {
    isDarkMode: jest.fn(() => false),
    isSwipeTrackingFromScrollEventsEnabled: jest.fn(() => false),
  },
}));

// Mock winston to prevent file system access
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

const winstonMock = {
  createLogger: jest.fn(() => mockLogger),
  format: {
    json: jest.fn(() => 'json-format'),
    simple: jest.fn(() => 'simple-format'),
    combine: jest.fn(),
    timestamp: jest.fn(),
    printf: jest.fn(),
  },
  transports: {
    File: jest.fn(() => ({})),
    Console: jest.fn(() => ({})),
  },
};

jest.mock('winston', () => winstonMock);

// Mock fs to prevent file system access
const fsMock = {
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() =>
    JSON.stringify({
      cognitizers: [
        { name: 'ChatGPT', url: 'https://chatgpt.com/', active: true },
        { name: 'Claude', url: 'https://claude.ai/new', active: false },
        { name: 'Gemini', url: 'https://gemini.google.com/', active: false },
      ],
      multiCognitionActive: false,
      activeCognitizer: 0,
      openExternalLinks: false,
      adBlockerEnabled: true,
      hotkeyLocked: false,
      windowBounds: { x: 100, y: 100, width: 1200, height: 800 },
      baseUrls: {
        custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
        custom2: { name: 'Claude', url: 'https://claude.ai/new' },
        custom3: { name: 'Gemini', url: 'https://gemini.google.com/' },
      },
    })
  ),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
  readdirSync: jest.fn(() => []),
  statSync: jest.fn(() => ({
    isDirectory: () => false,
    isFile: () => true,
    size: 0,
    mtime: new Date(),
  })),
  createReadStream: jest.fn(),
  createWriteStream: jest.fn(),
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
    unlink: jest.fn(),
    readdir: jest.fn(() => Promise.resolve([])),
    stat: jest.fn(() =>
      Promise.resolve({
        isDirectory: () => false,
        isFile: () => true,
        size: 0,
        mtime: new Date(),
      })
    ),
  },
};

jest.mock('fs', () => fsMock);

// Mock os module
const osMock = {
  platform: jest.fn(() => 'darwin'),
  homedir: jest.fn(() => '/home/test'),
  tmpdir: jest.fn(() => '/tmp'),
  cpus: jest.fn(() => [1, 2, 3, 4]),
  totalmem: jest.fn(() => 8 * 1024 * 1024 * 1024),
  freemem: jest.fn(() => 4 * 1024 * 1024 * 1024),
  hostname: jest.fn(() => 'test-host'),
  release: jest.fn(() => '10.0.0'),
  type: jest.fn(() => 'Darwin'),
  arch: jest.fn(() => 'x64'),
};

jest.mock('os', () => osMock);

// Mock child_process to prevent spawning processes
jest.mock('child_process', () => ({
  exec: jest.fn((cmd, callback) => {
    if (callback) callback(null, '', '');
    return { on: jest.fn() };
  }),
  execSync: jest.fn(() => ''),
  spawn: jest.fn(() => ({
    on: jest.fn(),
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    kill: jest.fn(),
  })),
  fork: jest.fn(() => ({
    on: jest.fn(),
    send: jest.fn(),
    kill: jest.fn(),
  })),
}));

// Mock other potentially problematic modules
jest.mock('@cliqz/adblocker-electron', () => ({
  ElectronBlocker: {
    fromLists: jest.fn().mockResolvedValue({
      enableBlockingInSession: jest.fn(),
      disableBlockingInSession: jest.fn(),
      serialize: jest.fn().mockResolvedValue(Buffer.from('mock')),
      deserialize: jest.fn(),
    }),
    deserialize: jest.fn().mockResolvedValue({
      enableBlockingInSession: jest.fn(),
      disableBlockingInSession: jest.fn(),
    }),
  },
}));

jest.mock('cross-fetch', () =>
  jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    })
  )
);

jest.mock('electron-prompt', () => jest.fn());

jest.mock('update-electron-app', () => jest.fn());

// Prevent any module from actually starting the electron app
process.argv = ['node', 'test'];
process.env.NODE_ENV = 'test';
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// Override process.exit to prevent tests from exiting
process.exit = jest.fn();

// Export mocks for tests to use
global.__mocks__ = {
  winston: winstonMock,
  fs: fsMock,
  os: osMock,
};

// Mock global objects that are not available in jsdom
if (typeof window !== 'undefined') {
  // Mock IntersectionObserver
  global.IntersectionObserver = class IntersectionObserver {
    constructor(callback) {
      this.callback = callback;
    }
    
    observe() {
      // Mock implementation
    }
    
    unobserve() {
      // Mock implementation
    }
    
    disconnect() {
      // Mock implementation
    }
  };

  // Mock ResizeObserver  
  global.ResizeObserver = class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
    }
    
    observe() {
      // Mock implementation
    }
    
    unobserve() {
      // Mock implementation
    }
    
    disconnect() {
      // Mock implementation
    }
  };

  // Mock matchMedia
  global.matchMedia = global.matchMedia || function() {
    return {
      matches: false,
      addListener: function() {},
      removeListener: function() {},
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() {}
    };
  };
}

console.log('Mocks initialized');
