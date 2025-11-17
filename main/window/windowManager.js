const { BrowserWindow, app, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Configuration loading
function loadWindowConfig() {
  try {
    let configPath;
    
    // Use platform-specific paths
    if (os.platform() === 'darwin') {
      // macOS: ~/.instant-cognition/config.json
      configPath = path.join(os.homedir(), '.instant-cognition', 'config.json');
      ensureConfigDirectory(configPath);
    } else if (app.isPackaged) {
      // Windows/Linux packaged: In the app's resources directory
      configPath = path.join(process.resourcesPath, 'app', 'config.json');
    } else {
      // Development: Project root
      configPath = path.join(__dirname, '..', '..', 'config.json');
    }

    console.log('Loading config from:', configPath);

    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // Ensure state and settings objects exist
      if (!config.state) config.state = {};
      if (!config.settings) config.settings = {};
      return config;
    } else {
      console.log('Config file not found, using defaults');
      return { state: {}, settings: {} };
    }
  } catch (error) {
    console.error('Error loading config:', error);
    return { state: {}, settings: {} };
  }
}

function ensureConfigDirectory(configPath) {
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

function getWindowBounds(config) {
  // Use saved bounds or defaults
  const bounds = (config && config.state && config.state.windowBounds) || {
    width: 1600,
    height: 900,
  };
  console.log('Window bounds:', bounds);
  return bounds;
}

function setupElectronSession() {
  // Cache session for better performance
  const sess = require('electron').session.defaultSession;
  const preloadPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'main', 'preload.js')
    : path.join(__dirname, '..', 'preload.js');

  console.log('Preload script path:', preloadPath);

  // Enable network emulation
  sess.enableNetworkEmulation({ offline: false });

  return { session: sess, preloadPath };
}

function createBrowserWindow(bounds, preloadPath) {
  // Show later to avoid visual flash
  const mainWindow = new BrowserWindow({
    width: bounds.width || 1600,
    height: bounds.height || 900,
    x: bounds.x,
    y: bounds.y,
    show: false,
    ...(os.platform() === 'darwin' && { hasShadow: false }),
    // Allow the window to go into fullscreen
    fullscreenable: true,
    // Ensure the window is user-resizable and movable
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    focusable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'app', 'icons', 'icon.png')
      : path.join(__dirname, '..', '..', 'icons', 'icon.png'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      enableBlinkFeatures: 'OverlayScrollbars',
      scrollBounce: false,
      disableDialogs: true,
      safeDialogs: true,
      safeDialogsMessage: 'Prevented dialog display',
      // Performance optimization
      backgroundThrottling: false,
      // Security
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    // macOS specific options
    titleBarStyle: os.platform() === 'darwin' ? 'default' : undefined,
    trafficLightPosition: os.platform() === 'darwin' ? { x: 15, y: 13 } : undefined,
  });

  return mainWindow;
}

function setupWindowEventHandlers(mainWindow) {
  // Prevent the window from closing; just hide it
  mainWindow.on('close', (event) => {
    const isAppQuitting = global.isAppQuitting || false;
    if (!isAppQuitting) {
      console.log('Preventing window close, hiding instead');
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Handle navigation
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      console.log('Navigation prevented for non-file URL:', url);
      event.preventDefault();
    }
  });

  // Security: Prevent new window creation
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  // Note: Drop/dragover handlers commented out due to TypeScript issues
  // These would normally prevent file drops on the window
}

function setupWindowResizeHandler(mainWindow, config) {
  // Save window bounds when resized
  let resizeTimer;
  mainWindow.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const bounds = mainWindow.getBounds();
      config.state.windowBounds = bounds;
      
      let configPath;
      if (os.platform() === 'darwin') {
        configPath = path.join(os.homedir(), '.instant-cognition', 'config.json');
      } else if (app.isPackaged) {
        configPath = path.join(process.resourcesPath, 'app', 'config.json');
      } else {
        configPath = path.join(__dirname, '..', '..', 'config.json');
      }
      
      try {
        ensureConfigDirectory(configPath);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      } catch (error) {
        console.error('Error saving window bounds:', error);
      }
    }, 500);
  });
}

function setupMemoryManagement(mainWindow) {
  // Memory management constants
  const MEMORY_CHECK_INTERVAL = 120000; // 2 minutes
  const MEMORY_THRESHOLD_MB = 800;
  const HIGH_MEMORY_THRESHOLD_MB = 1200;

  // Memory management
  const memoryInterval = setInterval(() => {
    const memUsage = process.memoryUsage();
    const memoryInMB = memUsage.heapUsed / 1024 / 1024;

    if (memoryInMB > HIGH_MEMORY_THRESHOLD_MB) {
      console.log(`High memory usage detected: ${memoryInMB.toFixed(2)}MB. Performing aggressive cleanup...`);
      // Aggressive cleanup
      mainWindow.webContents.session.clearCache();
      mainWindow.webContents.session.clearStorageData({
        storages: ['caches', 'shadercache', 'websql', 'serviceworkers'],
      });
      global.gc && global.gc();
    } else if (memoryInMB > MEMORY_THRESHOLD_MB) {
      console.log(`Memory usage: ${memoryInMB.toFixed(2)}MB. Clearing caches...`);
      mainWindow.webContents.session.clearCache();
      global.gc && global.gc();
    }
  }, MEMORY_CHECK_INTERVAL);

  // Clear interval on window close
  mainWindow.on('closed', () => {
    clearInterval(memoryInterval);
  });

  // Periodically flush cookie store to prevent buildup
  setInterval(() => {
    mainWindow.webContents.session.cookies.flushStore().catch(console.error);
  }, 300000); // 5 minutes
}

function setupWindowReadyHandlers(mainWindow) {
  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    console.log('Main window ready to show');
    
    // Reset failure count
    const failureCountPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app', '.failure-count')
      : path.join(__dirname, '..', '..', '.failure-count');
    if (fs.existsSync(failureCountPath)) {
      fs.unlinkSync(failureCountPath);
    }
    
    mainWindow.show();
  });

  // Monitor for errors
  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (level === 3) { // Error level
      console.error('Renderer error:', message);
    }
  });

  // Note: Crashed event handler commented out in original code
}

function setupWebviewHandlers(mainWindow) {
  // Webview configuration
  let lastReload = 0;
  let lastTimeout = 0;

  mainWindow.webContents.on('did-attach-webview', (_, contents) => {
    // Prevent file drops in webviews
    contents.on('will-navigate', (event, url) => {
      if (url.startsWith('file://') && url.includes('index.html#')) {
        event.preventDefault();
      }
    });

    contents.on('dom-ready', () => {
      const webviewId = contents.id;
      const now = Date.now();
      if (now - lastTimeout < 2000) {
        console.log('Skipping duplicate timeout recovery');
        return;
      }
      lastTimeout = now;
      mainWindow.webContents.send('webview-timeout-recovery', webviewId);
    });

    contents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3 || errorDescription === 'ERR_ABORTED') {
        return;
      }
      console.error('Webview failed to load:', errorDescription, validatedURL);
      const now = Date.now();
      if (now - lastReload > 1000) {
        lastReload = now;
        setTimeout(() => contents.reload(), 100);
      }
    });

    // Handle window state changes
    contents.on('enter-html-full-screen', () => {
      mainWindow.webContents.send('webview-fullscreen-changed', true);
    });

    contents.on('leave-html-full-screen', () => {
      mainWindow.webContents.send('webview-fullscreen-changed', false);
    });
  });
}

function setupMouseNavigationHandlers(mainWindow) {
  // Handle back/forward navigation with mouse buttons
  mainWindow.on('app-command', (event, cmd) => {
    if (cmd === 'browser-backward') {
      mainWindow.webContents.send('navigateBackActive');
    } else if (cmd === 'browser-forward') {
      mainWindow.webContents.send('navigateForwardActive');
    }
  });

  // Global shortcut for mouse buttons (Windows/Linux)
  if (process.platform !== 'darwin') {
    try {
      globalShortcut.register('mouse4', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('navigateBackActive');
        }
      });
      globalShortcut.register('mouse5', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('navigateForwardActive');
        }
      });
    } catch (error) {
      console.error('Failed to register mouse shortcuts:', error);
    }
  }
}

function loadMainHTML(mainWindow) {
  const indexPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'renderer', 'index.html')
    : path.join(__dirname, '..', '..', 'renderer', 'index.html');

  console.log('Loading HTML from:', indexPath);

  if (fs.existsSync(indexPath)) {
    mainWindow.loadFile(indexPath).catch((error) => {
      console.error('Failed to load index.html:', error);
    });
  } else {
    console.error('index.html not found at:', indexPath);
  }
}

module.exports = {
  loadWindowConfig,
  getWindowBounds,
  setupElectronSession,
  createBrowserWindow,
  setupWindowEventHandlers,
  setupWindowResizeHandler,
  setupMemoryManagement,
  setupWindowReadyHandlers,
  setupWebviewHandlers,
  setupMouseNavigationHandlers,
  loadMainHTML,
  ensureConfigDirectory
};