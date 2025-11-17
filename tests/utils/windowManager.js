// Extract the window manager functionality for testing
const path = require('path');
const os = require('os');
const fs = require('fs');

// Function to load configuration
function loadConfig() {
  try {
    const configPath =
      os.platform() === 'darwin'
        ? path.join(os.homedir(), '.instant-cognition', 'config.json')
        : path.join(__dirname, '../../config.json');

    return JSON.parse(fs.readFileSync(configPath));
  } catch (error) {
    console.error('Error loading config:', error);
    return { state: {} };
  }
}

// Function to create main window
function createMainWindow() {
  const { BrowserWindow } = require('electron');

  // Load window bounds from config
  let config;
  try {
    const configPath =
      os.platform() === 'darwin'
        ? path.join(os.homedir(), '.instant-cognition', 'config.json')
        : path.join(__dirname, '../../config.json');

    config = JSON.parse(fs.readFileSync(configPath));
  } catch (error) {
    console.error('Error loading config:', error);
    config = { state: {} };
  }

  // Use saved bounds or defaults
  const bounds = config.state.windowBounds || { width: 1600, height: 900 };

  // Cache session for better performance
  const sess = require('electron').session.defaultSession;
  sess.setPreloads([path.join(__dirname, 'preload.js')]);

  // Skip network emulation in test environment to avoid errors
  if (typeof sess.enableNetworkEmulation === 'function') {
    sess.enableNetworkEmulation({ offline: false });
  }

  const mainWindow = new BrowserWindow({
    ...bounds,
    hasShadow: false,
    fullScreenable: false,
    movable: true,
    // Prevent Stage Manager interaction
    collectionBehavior: process.platform === 'darwin' ? 0x0100 : undefined, // NSWindowCollectionBehaviorTransient
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      icon: path.join(__dirname, 'assets/icon.ico'),
      webviewTag: true, // Enable the use of <webview> tag
      contextIsolation: false,
      nodeIntegration: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      enableRemoteModule: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      safeDialogs: true,
      backgroundThrottling: false,
      offscreen: false,
      // Add performance optimizations
      enablePreferredSizeMode: true,
      spellcheck: false, // Disable if not needed
      enableWebSQL: false,
      v8CacheOptions: 'code',
      // Disable file access through drag and drop
      navigateOnDragDrop: false,
      // Restrict file system access
      enableFileSystemAccess: false,
    },
    // Optimize window performance
    show: false, // Wait until ready-to-show
    paintWhenInitiallyHidden: true,
    backgroundColor: '#1e1e1e',
    // Add window optimizations
    minimizable: true,
    frame: true,
  });

  // Save window bounds when resized
  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.on(
      'resize',
      debounce(() => {
        if (mainWindow.isDestroyed()) return;
        const bounds = mainWindow.getBounds();
        config.state.windowBounds = {
          width: bounds.width,
          height: bounds.height,
        };

        // Save to config file
        try {
          const configPath =
            os.platform() === 'darwin'
              ? path.join(os.homedir(), '.instant-cognition', 'config.json')
              : path.join(__dirname, '../../config.json');

          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        } catch (error) {
          console.error('Error saving window bounds to config:', error);
        }
      }, 100)
    );
  }

  return mainWindow;
}

module.exports = {
  loadConfig,
  createMainWindow,
};
