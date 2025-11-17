const { EventEmitter } = require('events');

/**
 * Test utility functions for InstantCognition tests
 */

/**
 * Create a mock DOM event
 * @param {string} type - Event type
 * @param {Object} options - Event options
 * @returns {Object} Mock event object
 */
function createMockEvent(type = 'click', options = {}) {
  return {
    type,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    stopImmediatePropagation: jest.fn(),
    target: options.target || {
      value: '',
      checked: false,
      dataset: {},
      id: '',
      className: '',
      tagName: 'DIV',
    },
    currentTarget: options.currentTarget || {
      value: '',
      checked: false,
      dataset: {},
    },
    key: options.key || '',
    keyCode: options.keyCode || 0,
    which: options.which || 0,
    altKey: options.altKey || false,
    ctrlKey: options.ctrlKey || false,
    metaKey: options.metaKey || false,
    shiftKey: options.shiftKey || false,
    button: options.button || 0,
    clientX: options.clientX || 0,
    clientY: options.clientY || 0,
    screenX: options.screenX || 0,
    screenY: options.screenY || 0,
    ...options,
  };
}

/**
 * Create a mock IPC event
 * @param {Object} options - Event options
 * @returns {Object} Mock IPC event object
 */
function createMockIpcEvent(options = {}) {
  return {
    sender: options.sender || {
      send: jest.fn(),
      id: 1,
      webContents: {
        id: 1,
        send: jest.fn(),
        executeJavaScript: jest.fn().mockResolvedValue(),
      },
    },
    reply: jest.fn(),
    returnValue: undefined,
    ...options,
  };
}

/**
 * Wait for a condition to be true
 * @param {Function} condition - Function that returns boolean
 * @param {number} timeout - Maximum wait time in ms
 * @param {number} interval - Check interval in ms
 * @returns {Promise<void>}
 */
async function waitFor(condition, timeout = 5000, interval = 50) {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
      } else {
        setTimeout(check, interval);
      }
    };

    check();
  });
}

/**
 * Create a mock configuration object
 * @param {Object} overrides - Configuration overrides
 * @returns {Object} Mock configuration
 */
function createMockConfig(overrides = {}) {
  return {
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
    acceptedCertificates: [],
    ...overrides,
  };
}

/**
 * Create a mock webview element
 * @param {string} id - Webview ID
 * @param {Object} options - Webview options
 * @returns {Object} Mock webview element
 */
function createMockWebview(id = 'custom1', options = {}) {
  const webview = {
    id,
    src: options.src || '',
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
    getWebContentsId: jest.fn(() => Math.random()),
    getURL: jest.fn(() => ''),
    getTitle: jest.fn(() => ''),
    isLoading: jest.fn(() => false),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    webContents: {
      id: Math.random(),
      send: jest.fn(),
    },
    style: {
      display: 'none',
      width: '100%',
      height: '100%',
    },
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(() => false),
      toggle: jest.fn(),
    },
    dispatchEvent: jest.fn(),
    ...options,
  };

  return webview;
}

/**
 * Create a mock file system
 * @param {Object} files - File system structure
 * @returns {Object} Mock fs module
 */
function createMockFs(files = {}) {
  const mockFs = {
    existsSync: jest.fn((path) => {
      return files.hasOwnProperty(path);
    }),
    readFileSync: jest.fn((path) => {
      if (files[path]) {
        return files[path];
      }
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }),
    writeFileSync: jest.fn((path, data) => {
      files[path] = data;
    }),
    mkdirSync: jest.fn(),
    unlinkSync: jest.fn((path) => {
      delete files[path];
    }),
    readdirSync: jest.fn((path) => {
      return Object.keys(files)
        .filter((file) => file.startsWith(path))
        .map((file) => file.replace(path + '/', ''));
    }),
    statSync: jest.fn((path) => ({
      isDirectory: () => path.endsWith('/'),
      isFile: () => !path.endsWith('/'),
      size: files[path] ? files[path].length : 0,
      mtime: new Date(),
      mtimeMs: Date.now(),
    })),
    promises: {
      readFile: jest.fn((path) => Promise.resolve(files[path])),
      writeFile: jest.fn((path, data) => {
        files[path] = data;
        return Promise.resolve();
      }),
    },
  };

  return mockFs;
}

/**
 * Create a mock BrowserWindow
 * @param {Object} options - Window options
 * @returns {Object} Mock BrowserWindow instance
 */
function createMockWindow(options = {}) {
  const window = new EventEmitter();

  Object.assign(window, {
    id: Math.random(),
    webContents: createMockWebContents(),
    loadURL: jest.fn().mockResolvedValue(),
    loadFile: jest.fn().mockResolvedValue(),
    show: jest.fn(),
    hide: jest.fn(),
    close: jest.fn(),
    destroy: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    minimize: jest.fn(),
    maximize: jest.fn(),
    unmaximize: jest.fn(),
    isMinimized: jest.fn(() => false),
    isMaximized: jest.fn(() => false),
    isVisible: jest.fn(() => true),
    isDestroyed: jest.fn(() => false),
    isFocused: jest.fn(() => true),
    getBounds: jest.fn(() => ({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })),
    setBounds: jest.fn(),
    getPosition: jest.fn(() => [0, 0]),
    setPosition: jest.fn(),
    getSize: jest.fn(() => [800, 600]),
    setSize: jest.fn(),
    setAlwaysOnTop: jest.fn(),
    setSkipTaskbar: jest.fn(),
    setVisibleOnAllWorkspaces: jest.fn(),
    setFullScreenable: jest.fn(),
    setClosable: jest.fn(),
    setMinimizable: jest.fn(),
    setMaximizable: jest.fn(),
    setResizable: jest.fn(),
    setMovable: jest.fn(),
    setTitle: jest.fn(),
    getTitle: jest.fn(() => 'Test Window'),
    flashFrame: jest.fn(),
    ...options,
  });

  return window;
}

/**
 * Create mock WebContents
 * @param {Object} options - WebContents options
 * @returns {Object} Mock WebContents instance
 */
function createMockWebContents(options = {}) {
  const webContents = new EventEmitter();

  Object.assign(webContents, {
    id: Math.random(),
    send: jest.fn(),
    loadURL: jest.fn().mockResolvedValue(),
    reload: jest.fn(),
    goBack: jest.fn(),
    goForward: jest.fn(),
    canGoBack: jest.fn(() => false),
    canGoForward: jest.fn(() => false),
    stop: jest.fn(),
    executeJavaScript: jest.fn().mockResolvedValue(),
    insertCSS: jest.fn().mockResolvedValue(),
    setUserAgent: jest.fn(),
    getUserAgent: jest.fn(() => 'MockElectron'),
    setZoomLevel: jest.fn(),
    getZoomLevel: jest.fn(() => 0),
    setZoomFactor: jest.fn(),
    getZoomFactor: jest.fn(() => 1),
    findInPage: jest.fn(() => 1),
    stopFindInPage: jest.fn(),
    openDevTools: jest.fn(),
    closeDevTools: jest.fn(),
    isDevToolsOpened: jest.fn(() => false),
    setAudioMuted: jest.fn(),
    isAudioMuted: jest.fn(() => false),
    print: jest.fn().mockResolvedValue(),
    printToPDF: jest.fn().mockResolvedValue(Buffer.from('mock-pdf')),
    session: {
      clearCache: jest.fn().mockResolvedValue(),
      clearStorageData: jest.fn().mockResolvedValue(),
      cookies: {
        get: jest.fn().mockResolvedValue([]),
        set: jest.fn().mockResolvedValue(),
        remove: jest.fn().mockResolvedValue(),
        flushStore: jest.fn((cb) => cb && cb()),
      },
    },
    ...options,
  });

  return webContents;
}

/**
 * Mock timers and provide utilities for testing time-based code
 */
class TimerMock {
  constructor() {
    this.timers = [];
    this.originalSetTimeout = global.setTimeout;
    this.originalSetInterval = global.setInterval;
    this.originalClearTimeout = global.clearTimeout;
    this.originalClearInterval = global.clearInterval;
  }

  mock() {
    global.setTimeout = jest.fn((callback, delay) => {
      const id = Math.random();
      this.timers.push({ id, callback, delay, type: 'timeout' });
      return id;
    });

    global.setInterval = jest.fn((callback, delay) => {
      const id = Math.random();
      this.timers.push({ id, callback, delay, type: 'interval' });
      return id;
    });

    global.clearTimeout = jest.fn((id) => {
      this.timers = this.timers.filter((timer) => timer.id !== id);
    });

    global.clearInterval = jest.fn((id) => {
      this.timers = this.timers.filter((timer) => timer.id !== id);
    });
  }

  restore() {
    global.setTimeout = this.originalSetTimeout;
    global.setInterval = this.originalSetInterval;
    global.clearTimeout = this.originalClearTimeout;
    global.clearInterval = this.originalClearInterval;
    this.timers = [];
  }

  tick(time) {
    const timersToRun = this.timers.filter((timer) => {
      if (timer.type === 'timeout' && timer.delay <= time) {
        return true;
      }
      return false;
    });

    timersToRun.forEach((timer) => {
      timer.callback();
      if (timer.type === 'timeout') {
        this.timers = this.timers.filter((t) => t.id !== timer.id);
      }
    });
  }

  runAll() {
    while (this.timers.length > 0) {
      const timer = this.timers.shift();
      timer.callback();
    }
  }
}

/**
 * Create a mock DOM environment for component tests
 * @returns {Object} Mock DOM elements
 */
function createMockDOM() {
  // Create mock DOM elements commonly used in tests
  const mockElements = {
    'side-bar': document.createElement('div'),
    'toggle-button': document.createElement('button'),
    'settings-menu': document.createElement('div'),
    'settings-close-button': document.createElement('button'),
    'shortcuts-list': document.createElement('div'),
    'shortcut-search': document.createElement('input'),
    'reset-all-shortcuts': document.createElement('button'),
    'cognitizers-list': document.createElement('div'),
    'general-tab': document.createElement('div'),
    'shortcuts-tab': document.createElement('div'),
    'cognitizers-tab': document.createElement('div'),
    'appearance-tab': document.createElement('div'),
    'preventMenuExpansion': document.createElement('input'),
    'enableAdblocker': document.createElement('input'),
    'launchAtStartup': document.createElement('input'),
    'openLinkExternal': document.createElement('input'),
    'browserHomeUrl': document.createElement('input'),
    'enableDefaultCognitizer': document.createElement('input'),
    'defaultCognitizerSelect': document.createElement('select'),

    'enableAnimations': document.createElement('input'),
    'enableRippleEffects': document.createElement('input'),
    'sidebarWidth': document.createElement('input'),
    'sidebarWidthValue': document.createElement('span')
  };

  // Add IDs to elements
  Object.entries(mockElements).forEach(([id, element]) => {
    element.id = id;
  });

  // Create menu content element with class
  const menuContent = document.createElement('div');
  menuContent.className = 'menu-content';
  mockElements['side-bar'].appendChild(menuContent);

  // Create dropdown sections
  const dropdownSection = document.createElement('div');
  dropdownSection.className = 'dropdown-section';
  menuContent.appendChild(dropdownSection);

  // Create cognitizer dropdown section
  const cognitizerSection = document.createElement('div');
  cognitizerSection.className = 'cognitizer-dropdown-section';
  menuContent.appendChild(cognitizerSection);

  // Mock global functions
  global.window = {
    fullNames: {
      'custom1': 'Custom 1',
      'custom2': 'Custom 2',
      'browser': 'Browser'
    },
    setCollapsedMenuIcons: jest.fn(),
    saveSettings: jest.fn(),
    sidebar: {
      setPreventExpansion: jest.fn()
    }
  };
  
  // Add window functions to actual window object too
  if (typeof window !== 'undefined') {
    window.fullNames = global.window.fullNames;
    window.setCollapsedMenuIcons = global.window.setCollapsedMenuIcons;
    window.saveSettings = global.window.saveSettings;
    window.sidebar = global.window.sidebar;
  }

  // Mock getElementById to return our elements
  const originalGetElementById = document.getElementById;
  document.getElementById = jest.fn((id) => {
    return mockElements[id] || originalGetElementById.call(document, id);
  });

  // Mock querySelector and querySelectorAll
  document.querySelector = jest.fn((selector) => {
    if (selector === '.menu-content') return menuContent;
    if (selector === '.settings-menu') return mockElements['settings-menu'];
    if (selector.includes('[name="theme"]')) {
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'theme';
      radio.value = 'dark';
      radio.checked = true;
      return radio;
    }
    return null;
  });

  document.querySelectorAll = jest.fn((selector) => {
    if (selector === '.tab-button') {
      return [
        createTabButton('general'),
        createTabButton('shortcuts'),
        createTabButton('cognitizers'),
        createTabButton('appearance')
      ];
    }
    if (selector === '.tab-content') {
      return [
        mockElements['general-tab'],
        mockElements['shortcuts-tab'],
        mockElements['cognitizers-tab'],
        mockElements['appearance-tab']
      ];
    }
    if (selector === '.dropdown-section > div') {
      return [
        createDropdownItem('custom1button'),
        createDropdownItem('custom2button'),
        createDropdownItem('browserbutton')
      ];
    }
    if (selector === '.cognitizer-dropdown-section > div') {
      return [
        createDropdownItem('custom1button'),
        createDropdownItem('custom2button')
      ];
    }
    if (selector.includes('[name="theme"]')) {
      return [
        createRadioButton('theme', 'dark'),
        createRadioButton('theme', 'light'),
        createRadioButton('theme', 'system')
      ];
    }
    return [];
  });

  // Mock body for appending elements
  document.body.appendChild = jest.fn();
  document.body.insertAdjacentHTML = jest.fn();
  document.body.classList = {
    add: jest.fn(),
    remove: jest.fn(),
    toggle: jest.fn()
  };

  return mockElements;
}

function createTabButton(tabName) {
  const button = document.createElement('button');
  button.className = 'tab-button';
  button.dataset.tab = tabName;
  if (tabName === 'general') button.classList.add('active');
  return button;
}

function createDropdownItem(id) {
  const div = document.createElement('div');
  div.id = id;
  
  // Create a real classList implementation
  const classList = new Set();
  div.classList = {
    add: jest.fn((className) => classList.add(className)),
    remove: jest.fn((className) => classList.delete(className)),
    contains: jest.fn((className) => classList.has(className)),
    toggle: jest.fn((className) => {
      if (classList.has(className)) {
        classList.delete(className);
        return false;
      } else {
        classList.add(className);
        return true;
      }
    })
  };
  
  // Add methods for querying
  div.querySelector = jest.fn(() => null);
  div.appendChild = jest.fn();
  div.removeChild = jest.fn();
  
  return div;
}

function createRadioButton(name, value) {
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = name;
  radio.value = value;
  if (value === 'dark') radio.checked = true;
  return radio;
}

module.exports = {
  createMockEvent,
  createMockIpcEvent,
  waitFor,
  createMockConfig,
  createMockWebview,
  createMockFs,
  createMockWindow,
  createMockWebContents,
  TimerMock,
  createMockDOM,
  createTabButton,
  createDropdownItem,
  createRadioButton,
};
