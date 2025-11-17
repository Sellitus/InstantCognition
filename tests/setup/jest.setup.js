// Jest setup file - runs before all tests
const path = require('path');

// Set up environment variables
process.env.NODE_ENV = 'test';
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// Mock console methods to reduce noise in tests
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

global.console = {
  ...console,
  error: jest.fn((...args) => {
    // Only show errors that aren't expected
    if (!args[0]?.includes('Expected') && !args[0]?.includes('mock')) {
      originalConsoleError(...args);
    }
  }),
  warn: jest.fn((...args) => {
    // Filter out common warnings
    if (!args[0]?.includes('deprecated') && !args[0]?.includes('experimental')) {
      originalConsoleWarn(...args);
    }
  }),
  log: jest.fn(), // Silence logs in tests
  info: jest.fn(),
  debug: jest.fn(),
};

// Global test utilities
global.testUtils = {
  // Create a mock event object
  createMockEvent: () => ({
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    target: {
      value: '',
      checked: false,
      dataset: {},
    },
    currentTarget: {
      value: '',
      checked: false,
      dataset: {},
    },
    key: '',
    keyCode: 0,
    which: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  }),

  // Create a mock IPC event
  createMockIpcEvent: () => ({
    sender: {
      send: jest.fn(),
      id: 1,
      webContents: {
        id: 1,
        send: jest.fn(),
      },
    },
    reply: jest.fn(),
    returnValue: undefined,
  }),

  // Wait for async operations
  waitFor: (condition, timeout = 5000) => {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        if (condition()) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - startTime > timeout) {
          clearInterval(interval);
          reject(new Error('Timeout waiting for condition'));
        }
      }, 50);
    });
  },

  // Mock file system
  createMockFs: () => ({
    existsSync: jest.fn(() => true),
    readFileSync: jest.fn(() => '{}'),
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
  }),

  // Mock configuration
  createMockConfig: () => ({
    cognitizers: [
      { name: 'ChatGPT', url: 'https://chat.openai.com', active: true },
      { name: 'Claude', url: 'https://claude.ai', active: false },
      { name: 'Gemini', url: 'https://gemini.google.com', active: false },
    ],
    multiCognitionActive: false,
    activeCognitizer: 0,
    openExternalLinks: false,
    adBlockerEnabled: true,
    hotkeyLocked: false,
    windowBounds: { x: 100, y: 100, width: 1200, height: 800 },
    baseUrls: {},
    acceptedCertificates: [],
  }),

  // Create mock webview element
  createMockWebview: () => {
    const webview = document.createElement('webview');
    Object.assign(webview, {
      src: '',
      loadURL: jest.fn(),
      reload: jest.fn(),
      stop: jest.fn(),
      goBack: jest.fn(),
      goForward: jest.fn(),
      canGoBack: jest.fn(() => false),
      canGoForward: jest.fn(() => false),
      executeJavaScript: jest.fn(() => Promise.resolve()),
      insertCSS: jest.fn(() => Promise.resolve()),
      findInPage: jest.fn(() => 1),
      stopFindInPage: jest.fn(),
      getWebContentsId: jest.fn(() => 1),
      getURL: jest.fn(() => ''),
      getTitle: jest.fn(() => ''),
      isLoading: jest.fn(() => false),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      webContents: {
        id: 1,
        send: jest.fn(),
      },
    });
    return webview;
  },
};

// Mock timers
global.setTimeout = jest.fn((callback, delay) => {
  callback();
  return 1;
});

global.setInterval = jest.fn((callback, delay) => {
  return 1;
});

global.clearTimeout = jest.fn();
global.clearInterval = jest.fn();

// Mock process.nextTick
process.nextTick = jest.fn((callback) => {
  callback();
});

// First, mock electron before any other imports
jest.mock('electron', () => require('../mocks/electron.js'));
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
jest.mock('cross-fetch', () => jest.fn());
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  format: {
    json: jest.fn(),
  },
  transports: {
    File: jest.fn(),
  },
}));

// Mock require for native modules
const mockRequire = (moduleName) => {
  switch (moduleName) {
    case 'electron':
      return require('../mocks/electron');
    case 'fs':
    case 'fs/promises':
      return global.testUtils.createMockFs();
    case 'path':
      return path;
    case 'os':
      return {
        platform: jest.fn(() => 'darwin'),
        homedir: jest.fn(() => '/home/user'),
        tmpdir: jest.fn(() => '/tmp'),
        cpus: jest.fn(() => [1, 2, 3, 4]),
        totalmem: jest.fn(() => 8 * 1024 * 1024 * 1024),
        freemem: jest.fn(() => 4 * 1024 * 1024 * 1024),
      };
    case 'child_process':
      return {
        exec: jest.fn((cmd, callback) => callback(null, '', '')),
        execSync: jest.fn(() => ''),
        spawn: jest.fn(() => ({
          on: jest.fn(),
          stdout: { on: jest.fn() },
          stderr: { on: jest.fn() },
          kill: jest.fn(),
        })),
      };
    default:
      return jest.fn();
  }
};

// Override module loading for tests
const Module = require('module');
if (Module && Module.prototype) {
  const originalRequire = Module.prototype.require;
  Module.prototype.require = new Proxy(originalRequire, {
    apply(target, thisArg, argumentsList) {
      const [moduleName] = argumentsList;
      if (['electron', 'fs', 'fs/promises', 'path', 'os', 'child_process'].includes(moduleName)) {
        return mockRequire(moduleName);
      }
      return Reflect.apply(target, thisArg, argumentsList);
    },
  });
}

// Set up DOM environment for renderer tests
if (typeof window !== 'undefined') {
  // Mock localStorage
  const localStorageMock = {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn(),
    length: 0,
    key: jest.fn(),
  };
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    writable: true,
  });

  // Mock sessionStorage
  Object.defineProperty(window, 'sessionStorage', {
    value: localStorageMock,
    writable: true,
  });

  // Mock window.electron
  window.electron = {
    send: jest.fn(),
    receive: jest.fn(),
    invoke: jest.fn(() => Promise.resolve()),
  };

  // Mock navigator
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Testing) AppleWebKit/537.36',
    configurable: true,
  });

  // Mock matchMedia
  window.matchMedia = jest.fn(() => ({
    matches: false,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));

  // Mock IntersectionObserver
  window.IntersectionObserver = jest.fn(() => ({
    observe: jest.fn(),
    unobserve: jest.fn(),
    disconnect: jest.fn(),
  }));

  // Mock ResizeObserver
  window.ResizeObserver = jest.fn(() => ({
    observe: jest.fn(),
    unobserve: jest.fn(),
    disconnect: jest.fn(),
  }));
  
  // Mock DragEvent and DataTransfer
  window.DragEvent = class DragEvent extends Event {
    constructor(type, init) {
      super(type, init);
      this.dataTransfer = init?.dataTransfer || new DataTransfer();
    }
  };
  
  window.DataTransfer = class DataTransfer {
    constructor() {
      this.data = {};
      this.effectAllowed = 'all';
      this.dropEffect = 'none';
      this.files = [];
      this.items = [];
      this.types = [];
    }
    
    setData(format, data) {
      this.data[format] = data;
      if (!this.types.includes(format)) {
        this.types.push(format);
      }
    }
    
    getData(format) {
      return this.data[format] || '';
    }
    
    clearData(format) {
      if (format) {
        delete this.data[format];
        this.types = this.types.filter(t => t !== format);
      } else {
        this.data = {};
        this.types = [];
      }
    }
  };
}
