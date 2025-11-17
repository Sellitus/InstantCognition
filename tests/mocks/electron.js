// Comprehensive Electron mock for testing
const { EventEmitter } = require('events');

class MockBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = Math.random().toString(36).substr(2, 9);
    this.webContents = new MockWebContents();
    this.options = options;
    this.bounds = { x: 0, y: 0, width: 800, height: 600 };
    this.isVisible = false;
    this.isDestroyed = false;
    this.title = '';
  }

  loadURL(url) {
    this.webContents.loadURL(url);
    return Promise.resolve();
  }

  loadFile(file) {
    return Promise.resolve();
  }

  show() {
    this.isVisible = true;
    this.emit('show');
  }

  hide() {
    this.isVisible = false;
    this.emit('hide');
  }

  close() {
    this.emit('close');
    this.destroy();
  }

  destroy() {
    if (!this.isDestroyed) {
      this.isDestroyed = true;
      this.emit('closed');
      this.removeAllListeners();
    }
  }

  getBounds() {
    return this.bounds;
  }

  setBounds(bounds) {
    this.bounds = { ...this.bounds, ...bounds };
  }

  setTitle(title) {
    this.title = title;
  }

  getTitle() {
    return this.title;
  }

  isMinimized() {
    return false;
  }

  isMaximized() {
    return false;
  }

  focus() {
    this.emit('focus');
  }

  blur() {
    this.emit('blur');
  }

  setAlwaysOnTop(flag) {}
  setSkipTaskbar(flag) {}
  setVisibleOnAllWorkspaces(flag) {}
  setFullScreenable(flag) {}
  setClosable(flag) {}
  setMinimizable(flag) {}
  setMaximizable(flag) {}
}

class MockWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = Math.random().toString(36).substr(2, 9);
    this.session = new MockSession();
    this.userAgent = 'MockElectron';
    this.zoomLevel = 0;
    this.audioMuted = false;
  }

  loadURL(url) {
    this.emit('did-start-loading');
    setTimeout(() => {
      this.emit('did-finish-load');
    }, 10);
    return Promise.resolve();
  }

  reload() {
    this.emit('did-start-loading');
    setTimeout(() => {
      this.emit('did-finish-load');
    }, 10);
  }

  goBack() {}
  goForward() {}
  canGoBack() {
    return false;
  }
  canGoForward() {
    return false;
  }

  stop() {
    this.emit('did-stop-loading');
  }

  executeJavaScript(code) {
    return Promise.resolve();
  }

  insertCSS(css) {
    return Promise.resolve();
  }

  send(channel, ...args) {
    this.emit('ipc-message', { channel, args });
  }

  openDevTools() {}
  closeDevTools() {}
  isDevToolsOpened() {
    return false;
  }

  setUserAgent(userAgent) {
    this.userAgent = userAgent;
  }

  getUserAgent() {
    return this.userAgent;
  }

  setZoomLevel(level) {
    this.zoomLevel = level;
  }

  getZoomLevel() {
    return this.zoomLevel;
  }

  setAudioMuted(muted) {
    this.audioMuted = muted;
  }

  isAudioMuted() {
    return this.audioMuted;
  }

  findInPage(text, options = {}) {
    return 1;
  }

  stopFindInPage(action) {}

  print(options = {}) {
    return Promise.resolve();
  }

  printToPDF(options = {}) {
    return Promise.resolve(Buffer.from('mock-pdf'));
  }
}

class MockSession extends EventEmitter {
  constructor() {
    super();
    this.cookies = new MockCookies();
    this.protocol = new MockProtocol();
    this.webRequest = new MockWebRequest();
  }

  clearCache() {
    return Promise.resolve();
  }

  clearStorageData(options = {}) {
    return Promise.resolve();
  }

  setUserAgent(userAgent) {}
  getUserAgent() {
    return 'MockElectron';
  }

  setPermissionRequestHandler(handler) {}
  setCertificateVerifyProc(proc) {}
}

class MockCookies {
  get(filter) {
    return Promise.resolve([]);
  }

  set(details) {
    return Promise.resolve();
  }

  remove(url, name) {
    return Promise.resolve();
  }

  flushStore() {
    return Promise.resolve();
  }
}

class MockProtocol {
  registerStringProtocol(scheme, handler) {
    return true;
  }

  unregisterProtocol(scheme) {
    return true;
  }

  isProtocolRegistered(scheme) {
    return false;
  }
}

class MockWebRequest {
  onBeforeRequest(filter, listener) {}
  onBeforeSendHeaders(filter, listener) {}
  onHeadersReceived(filter, listener) {}
  onCompleted(filter, listener) {}
}

class MockMenu {
  static buildFromTemplate(template) {
    return new MockMenu();
  }

  static setApplicationMenu(menu) {}
  static getApplicationMenu() {
    return null;
  }

  popup(options = {}) {}
  append(menuItem) {}
  insert(pos, menuItem) {}
}

class MockMenuItem {
  constructor(options = {}) {
    this.label = options.label || '';
    this.click = options.click || (() => {});
    this.enabled = options.enabled !== false;
    this.visible = options.visible !== false;
  }
}

class MockTray extends EventEmitter {
  constructor(image) {
    super();
    this.image = image;
    this.tooltip = '';
    this.contextMenu = null;
  }

  setImage(image) {
    this.image = image;
  }

  setToolTip(tooltip) {
    this.tooltip = tooltip;
  }

  setContextMenu(menu) {
    this.contextMenu = menu;
  }

  destroy() {
    this.removeAllListeners();
  }
}

class MockDialog {
  static showMessageBox(options) {
    return Promise.resolve({ response: 0, checkboxChecked: false });
  }

  static showMessageBoxSync(options) {
    return 0;
  }

  static showOpenDialog(options) {
    return Promise.resolve({ canceled: false, filePaths: ['/mock/file.txt'] });
  }

  static showSaveDialog(options) {
    return Promise.resolve({ canceled: false, filePath: '/mock/save.txt' });
  }

  static showErrorBox(title, content) {}
}

class MockGlobalShortcut {
  static register(accelerator, callback) {
    return true;
  }

  static unregister(accelerator) {}
  static unregisterAll() {}
  static isRegistered(accelerator) {
    return false;
  }
}

class MockIpcMain extends EventEmitter {
  handle(channel, handler) {
    this.on(channel, async (event, ...args) => {
      try {
        const result = await handler(event, ...args);
        event.sender.send(`${channel}-reply`, result);
      } catch (error) {
        event.sender.send(`${channel}-error`, error);
      }
    });
  }

  handleOnce(channel, handler) {
    this.handle(channel, handler);
  }

  removeHandler(channel) {
    this.removeAllListeners(channel);
  }
}

class MockIpcRenderer extends EventEmitter {
  send(channel, ...args) {
    process.nextTick(() => {
      this.emit(channel, { sender: this }, ...args);
    });
  }

  invoke(channel, ...args) {
    return new Promise((resolve) => {
      this.once(`${channel}-reply`, (event, result) => {
        resolve(result);
      });
      this.send(channel, ...args);
    });
  }

  sendSync(channel, ...args) {
    return null;
  }

  on(channel, listener) {
    super.on(channel, listener);
    return this;
  }

  once(channel, listener) {
    super.once(channel, listener);
    return this;
  }

  removeListener(channel, listener) {
    super.removeListener(channel, listener);
    return this;
  }

  removeAllListeners(channel) {
    super.removeAllListeners(channel);
    return this;
  }
}

// App mock
const app = new EventEmitter();
Object.assign(app, {
  name: 'InstantCognition',
  version: '1.0.0',
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  quit: () => app.emit('quit'),
  exit: (code = 0) => app.emit('exit', code),
  relaunch: (options = {}) => {},
  focus: () => {},
  hide: () => {},
  show: () => {},
  getPath: (name) => {
    const paths = {
      home: '/home/user',
      appData: '/home/user/.config',
      userData: '/home/user/.config/InstantCognition',
      temp: '/tmp',
      desktop: '/home/user/Desktop',
      documents: '/home/user/Documents',
      downloads: '/home/user/Downloads',
      music: '/home/user/Music',
      pictures: '/home/user/Pictures',
      videos: '/home/user/Videos',
      logs: '/home/user/.config/InstantCognition/logs',
      exe: '/usr/bin/instantcognition',
    };
    return paths[name] || '/mock/path';
  },
  getAppPath: () => '/mock/app/path',
  setPath: (name, path) => {},
  getLocale: () => 'en-US',
  getSystemLocale: () => 'en-US',
  isPackaged: false,
  allowRendererProcessReuse: true,
  commandLine: {
    appendSwitch: (switch_, value) => {},
    hasSwitch: (switch_) => false,
    getSwitchValue: (switch_) => '',
    removeSwitch: (switch_) => {},
  },
  dock: {
    hide: () => {},
    show: () => {},
    isVisible: () => false,
    setMenu: (menu) => {},
    bounce: (type = 'informational') => 1,
    cancelBounce: (id) => {},
    setBadge: (text) => {},
    getBadge: () => '',
    setIcon: (image) => {},
  },
});

// Create singleton instances
const ipcMain = new MockIpcMain();
const ipcRenderer = new MockIpcRenderer();

// Export all mocks
module.exports = {
  app,
  BrowserWindow: MockBrowserWindow,
  WebContents: MockWebContents,
  session: MockSession,
  Menu: MockMenu,
  MenuItem: MockMenuItem,
  Tray: MockTray,
  dialog: MockDialog,
  globalShortcut: MockGlobalShortcut,
  ipcMain,
  ipcRenderer,
  shell: {
    openExternal: (url) => Promise.resolve(),
    showItemInFolder: (path) => {},
    openPath: (path) => Promise.resolve(''),
    beep: () => {},
    writeShortcutLink: (shortcutPath, options) => true,
    readShortcutLink: (shortcutPath) => ({
      target: '/mock/target',
      args: '',
      appUserModelId: '',
      description: '',
      icon: '',
      iconIndex: 0,
      workingDirectory: '',
    }),
  },
  clipboard: {
    readText: () => '',
    writeText: (text) => {},
    readHTML: () => '',
    writeHTML: (html) => {},
    readImage: () => null,
    writeImage: (image) => {},
    clear: () => {},
  },
  nativeImage: {
    createEmpty: () => ({}),
    createFromPath: (path) => ({ path }),
    createFromBuffer: (buffer) => ({ buffer }),
    createFromDataURL: (dataURL) => ({ dataURL }),
  },
  screen: {
    getPrimaryDisplay: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1,
      rotation: 0,
      touchSupport: 'unknown',
    }),
    getAllDisplays: () => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1,
        rotation: 0,
        touchSupport: 'unknown',
      },
    ],
    getDisplayMatching: (rect) => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1,
      rotation: 0,
      touchSupport: 'unknown',
    }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  systemPreferences: {
    isDarkMode: () => false,
    isSwipeTrackingFromScrollEventsEnabled: () => false,
    getAccentColor: () => '0099ff',
    getColor: (color) => '#ffffff',
    getUserDefault: (key, type) => null,
    setUserDefault: (key, type, value) => {},
    isAeroGlassEnabled: () => false,
    isTrustedAccessibilityClient: (prompt) => true,
    getMediaAccessStatus: (mediaType) => 'granted',
    askForMediaAccess: (mediaType) => Promise.resolve(true),
  },
  powerMonitor: new EventEmitter(),
  powerSaveBlocker: {
    start: (type) => 1,
    stop: (id) => {},
    isStarted: (id) => false,
  },
  protocol: MockProtocol,
  net: {
    request: (options) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        process.nextTick(() => {
          req.emit('response', {
            statusCode: 200,
            headers: {},
            on: (event, handler) => {
              if (event === 'data') {
                process.nextTick(() => handler(Buffer.from('mock data')));
              } else if (event === 'end') {
                process.nextTick(handler);
              }
            },
          });
        });
      };
      return req;
    },
  },
  crashReporter: {
    start: (options) => {},
    getLastCrashReport: () => null,
    getUploadedReports: () => [],
    getUploadToServer: () => true,
    setUploadToServer: (uploadToServer) => {},
    addExtraParameter: (key, value) => {},
    removeExtraParameter: (key) => {},
    getParameters: () => ({}),
  },
};
