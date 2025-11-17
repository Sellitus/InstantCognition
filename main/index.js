// ##### index.js
console.log('[MAIN] Starting InstantCognition main process...');
console.log('[MAIN] Process argv:', process.argv);
console.log('[MAIN] __dirname:', __dirname);
console.log('[MAIN] process.cwd():', process.cwd());

// Early GPU fix - must be done before loading other modules
// GPU fix moved to after main electron import

// Initialize error handler first
console.log('[MAIN] Loading error handler...');
let errorHandler;
let errorLogPath;
try {
  errorHandler = require('./utils/errorHandler');
  console.log('[MAIN] Error handler loaded successfully');
} catch (error) {
  console.error('[MAIN] Failed to load error handler:', error);
  errorHandler = null;
}

// Initialize recovery mode
console.log('[MAIN] Loading recovery mode...');
let recoveryMode;
try {
  recoveryMode = require('./utils/recovery');
  console.log('[MAIN] Recovery mode loaded successfully');
} catch (error) {
  console.error('[MAIN] Failed to load recovery mode:', error);
  recoveryMode = null;
}

// Debug logging removed - scripts directory simplified
// Use logger.js in main/utils for production logging

// // Automatically update the app every 1 hour
// const { updateElectronApp } = require('update-electron-app');
// updateElectronApp();

console.log('[MAIN] Loading v8...');
const v8 = require('v8');
console.log('[MAIN] Loading electron modules...');
const {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  Tray,
  nativeImage,
  dialog,
  ipcMain,
  shell,
} = require('electron');

// GPU fix for headless environments
app.disableHardwareAcceleration();
// Note: ipcRenderer removed - it's only for renderer process
console.log('[MAIN] Loading node modules...');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
console.log('[MAIN] All core modules loaded');

// Set higher max listeners limit globally
EventEmitter.defaultMaxListeners = 50;

// Event listener tracking system
// const eventListenerTracker = new Map();
// const ipcHandlers = new Map();

// TODO: Re-enable when needed
// function trackEventListener(target, event, handler, options = {}) {
//   if (!eventListenerTracker.has(target)) {
//     eventListenerTracker.set(target, new Map());
//   }
//   const targetEvents = eventListenerTracker.get(target);
//   if (!targetEvents.has(event)) {
//     targetEvents.set(event, new Set());
//   }
//   targetEvents.get(event).add({ handler, options });
//   target.addEventListener(event, handler, options);
// }

// Optimize window background behavior
// TODO: Re-enable when needed
// function optimizeWindowBackground(window) {
//   let throttleTimeout;
//   const THROTTLE_DELAY = 30000; // 30 seconds
//
//   const blurHandler = () => {
//     throttleTimeout = setTimeout(() => {
//       if (!window.isDestroyed() && !window.isFocused()) {
//         window.webContents.setBackgroundThrottling(true);
//         if (global.gc) global.gc();
//       }
//     }, THROTTLE_DELAY);
//   };
//
//   const focusHandler = () => {
//     if (throttleTimeout) {
//       clearTimeout(throttleTimeout);
//     }
//     if (!window.isDestroyed()) {
//       window.webContents.setBackgroundThrottling(false);
//     }
//   };
//
//   trackEventListener(window, 'blur', blurHandler);
//   trackEventListener(window, 'focus', focusHandler);
// }
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
const fs = require('fs');
// const { autoUpdater } = require('electron-updater');
const { execSync } = require('child_process');
const windowManager = require('./window/windowManager');
const configService = require('./services/ConfigService');
// const util = require('util');
// const fetch = require('node-fetch'); // Use node-fetch for server-side requests
// Not yet implemented: dns-over-https / dns-over-tls
// const dnstls = require('dns-over-tls');
// const dns = require('dns');

app.commandLine.appendSwitch('enable-hardware-acceleration');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blacklist');

const logger = require('./utils/logger');

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// global.console.log = (...args) => logger.info(args); // Disabled for headless compatibility
// global.console.error = (...args) => logger.error(args); // Disabled for headless compatibility

// Only override console in production non-headless environments
if (process.env.NODE_ENV === 'production' && !process.argv.includes('--no-sandbox')) {
  global.console.log = (...args) => logger.info(args);
  global.console.error = (...args) => logger.error(args);
}

// Initial creation of the blocker
let blocker;
let intervalId;
let tray = null;
let mainWindow;
// Add cognitizer switching handler
let lastCognitizerSwitch = 0;
// Optimize adblocker creation by caching the blocker instance
let blockerCache = null;
let acceptedCertificates = {};
let acceptedCertificatesPath;
let isAppQuitting = false;

// Save accepted certificates to file
function saveAcceptedCertificates() {
  try {
    if (acceptedCertificatesPath) {
      fs.writeFileSync(acceptedCertificatesPath, JSON.stringify(acceptedCertificates, null, 2));
    }
  } catch (error) {
    console.error('Failed to save accepted certificates:', error);
  }
}

// URL for Hagezi's blocklist (choose the appropriate one for your needs)
// let HAGEZI_LIST_URL = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt';
let HAGEZI_LIST_URL =
  'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.plus.txt';
let OISD_LIST_URL = 'https://big.oisd.nl/';
let HAGEZI_TIF = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/tif.txt';
let HAGEZI_BADWARE =
  'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/hoster.txt';
let HAGEZI_FAKE = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/fake.txt';
let HAGEZI_ABUSED_TLD =
  'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/spam-tlds-adblock.txt';

// let ONEHOSTS_LIST_URL = 'https://raw.githubusercontent.com/badmojr/1Hosts/master/Lite/hosts.txt';
// let ADGUARD_DNS_LIST_URL =
//   'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_15_DnsFilter/filter.txt';
// let ADGUARD_TRACKING_LIST_URL =
//   'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_3_Spyware/filter.txt';
// let EASYLIST_LIST_URL = 'https://easylist.to/easylist/easylist.txt';
// let EASYPRIVACY_LIST_URL = 'https://easylist.to/easylist/easyprivacy.txt';
// let STEVEN_BLACK_LIST_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts';

let activeLists = [
  HAGEZI_LIST_URL,
  OISD_LIST_URL,
  HAGEZI_TIF,
  HAGEZI_BADWARE,
  HAGEZI_FAKE,
  HAGEZI_ABUSED_TLD,
];

// Enhanced ad blocker with smart caching and dynamic updates
async function createAndUpdateBlocker() {
  if (blockerCache) return blockerCache;

  try {
    const cachePath = path.join(
      os.platform() === 'darwin'
        ? path.join(os.homedir(), '.instant-cognition', 'adblocker_cache.bin')
        : path.join(__dirname, '../../adblocker_cache.bin')
    );

    let cacheStats;
    let shouldUpdate = true;
    const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

    // Check cache age
    if (fs.existsSync(cachePath)) {
      cacheStats = fs.statSync(cachePath);
      shouldUpdate = Date.now() - cacheStats.mtimeMs > CACHE_MAX_AGE;

      if (!shouldUpdate) {
        const cachedData = await fs.promises.readFile(cachePath);
        try {
          blockerCache = await ElectronBlocker.deserialize(cachedData);
          console.log('Adblocker: Loaded from cache');
        } catch (error) {
          console.error('Cache deserialization failed, forcing update:', error);
          shouldUpdate = true;
        }
      }
    }

    if (shouldUpdate) {
      console.log('Adblocker: Updating filters...');
      const fetchFn = typeof fetch === 'function' ? fetch : fetch.default;
      blockerCache = await ElectronBlocker.fromLists(fetchFn, activeLists, {
        enableCompression: true,
        path: cachePath,
        read: fs.promises.readFile,
        write: fs.promises.writeFile,
        loadNetworkFilters: true,
        loadCosmeticFilters: false, // Disable cosmetic filtering for better performance
        loadExtendedSelectors: false, // Disable extended selectors for better performance
        maxLoadRetries: 2, // Limit retries for failed filter downloads
        integrityCheck: false, // Disable integrity checks for faster loading
      });

      // Save updated cache
      const serialized = await blockerCache.serialize();
      await fs.promises.writeFile(cachePath, serialized);
      console.log('Adblocker: Cache updated');
    }

    // Enable blocking for all sessions
    const sessions = BrowserWindow.getAllWindows()
      .map((window) => window.webContents.session)
      .filter(Boolean); // Filter out any null/undefined sessions

    for (const session of sessions) {
      try {
        blockerCache.enableBlockingInSession(session);
      } catch (error) {
        console.error(`Failed to enable blocking for session:`, error);
      }
    }

    return blockerCache;
  } catch (error) {
    console.error('Adblocker: Critical error:', error);
    throw error; // Propagate error for proper handling
  }
}

// Function to disable the adblocker
function disableAdblocker() {
  if (blocker) {
    const sessions = BrowserWindow.getAllWindows().map((window) => window.webContents.session);
    sessions.forEach((session) => {
      blocker.disableBlockingInSession(session);
    });
    console.log('Adblocker: disabled');

    blocker = null;
    intervalId = null;
  }
}

// Setup main window and all basic elements
if (os.platform() === 'win32') {
  app.setUserTasks([
    {
      program: process.execPath,
      arguments: '--new-window',
      iconPath: path.join(__dirname, '../assets/icon.ico'),
      iconIndex: 0,
      title: 'InstantCognition',
      description: 'InstantCognition',
    },
  ]);

  // Assuming you have a way to capture the user's preference, call this function with true to enable or false to disable
  // setLaunchAtStartup(true); // To enable
  // setLaunchAtStartup(false); // To disable
}

// Example function to set the app to launch at startup
function setLaunchAtStartup(enable) {
  app.setLoginItemSettings({
    openAtLogin: enable,
    openAsHidden: enable,
  });
}

// Helper function to ensure config directory exists
function ensureConfigDirectory(configPath) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      console.log('Created config directory:', dir);
    } catch (error) {
      console.error('Failed to create config directory:', error);
    }
  }
}

// Optimize window creation
function createMainWindow() {
  console.log('Creating main window...');
  // Load window bounds from config
  // Config is now handled by ConfigService
  const config = configService.getAll();
  
  // Ensure state and settings objects exist for backward compatibility
  if (!config.state) config.state = {};
  if (!config.settings) config.settings = {};

  // Use saved bounds or defaults
  const bounds = (config && config.state && config.state.windowBounds) || {
    width: 1600,
    height: 900,
  };
  console.log('Window bounds:', bounds);

  // Cache session for better performance
  const sess = require('electron').session.defaultSession;
  const preloadPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'main', 'preload.js')
    : path.join(__dirname, 'preload.js');

  console.log('Preload script path:', preloadPath);

  // Note: Preload script is now set in webPreferences instead of session
  sess.enableNetworkEmulation({ offline: false });

  mainWindow = new BrowserWindow({
    ...bounds,
    hasShadow: false,
    fullScreenable: false,
    movable: true,
    // Proper Stage Manager behavior
    // Remove collection behavior entirely for macOS to avoid Stage Manager interactions
    collectionBehavior: undefined,
    // Add other window properties that help with Stage Manager integration
    alwaysOnTop: process.platform === 'darwin', // Make it always on top on macOS to avoid Stage Manager issues
    webPreferences: {
      preload: app.isPackaged
        ? path.join(process.resourcesPath, 'app', 'main', 'preload.js')
        : path.join(__dirname, 'preload.js'),
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
    },
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'assets/icon.ico')
      : path.join(__dirname, '../assets/icon.ico'),
    navigateOnDragDrop: false, // Disable file access through drag and drop
    enableFileSystemAccess: false, // Restrict file system access
    // Optimize window performance
    show: false, // Wait until ready-to-show
    paintWhenInitiallyHidden: true,
    backgroundColor: '#1e1e1e',
    // Add window optimizations
    minimizable: true,
    frame: true,
  });

  // Handle window close event
  mainWindow.on('close', (event) => {
    // Only prevent close and hide if we're not actually quitting
    if (!isAppQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Prevent file drop
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:')) {
      event.preventDefault();
    }
  });

  // Prevent opening files
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('file:')) {
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Add drop prevention for the window
  // TODO: Fix TypeScript types for these events
  // mainWindow.webContents.on('drop', (event) => {
  //   event.preventDefault();
  // });

  // mainWindow.webContents.on('dragover', (event) => {
  //   event.preventDefault();
  // });

  // Set higher max listeners specifically for mainWindow
  mainWindow.setMaxListeners(50);

  // Save window bounds when resized
  mainWindow.on(
    'resize',
    debounce(() => {
      const bounds = mainWindow.getBounds();
      
      // Save window bounds to config
      configService.set('state', {
        ...configService.get('state', {}),
        windowBounds: {
          width: bounds.width,
          height: bounds.height,
        }
      });
    }, 100)
  );

  // Optimize memory usage and perform additional cleaning
  // More aggressive memory management with lower threshold and smarter cleanup
  setInterval(async () => {
    try {
      const memoryInfo = await process.getProcessMemoryInfo();
      const memoryThreshold = 800 * 1024 * 1024; // Lower threshold to 800MB
      const criticalThreshold = 1200 * 1024 * 1024; // Critical threshold at 1.2GB

      const workingSetSize = memoryInfo.private || memoryInfo.residentSet || 0;
      if (workingSetSize > memoryThreshold) {
        if (!mainWindow.isVisible() || workingSetSize > criticalThreshold) {
          // Clear non-essential caches first
          await mainWindow.webContents.session.clearCache();
          // Get list of inactive webviews
          mainWindow.webContents.send('get-inactive-webviews');

          // Clear other storage data only if memory usage is still high
          const updatedMemoryInfo = await process.getProcessMemoryInfo();
          const updatedWorkingSetSize = updatedMemoryInfo.private || updatedMemoryInfo.residentSet || 0;
          if (updatedWorkingSetSize > memoryThreshold) {
            await mainWindow.webContents.session.clearStorageData({
              storages: ['appcache', 'shadercache', 'serviceworkers'],
            });
          }

          // Force garbage collection
          if (global.gc) {
            global.gc();
            // Spread out GC passes to reduce impact
            setTimeout(() => global.gc(), 500);
            // Final pass after a delay
            setTimeout(() => global.gc(), 1000);
          }
        }
      }
    } catch (error) {
      console.error('Memory management error:', error);
    }
  }, 120000); // Checks run every 2 minutes

  // Additional cleaning tasks
  setInterval(() => {
    // Clear expired cookies
    mainWindow.webContents.session.cookies.flushStore(() => {
      console.log('Cookies store flushed');
    });
  }, 60 * 60); // 1 hour

  // Show window only when ready
  mainWindow.once('ready-to-show', () => {
    console.log('Window ready to show');
    mainWindow.show();
    console.log('Window shown, visible:', mainWindow.isVisible());
    
    // Reset failure count on successful startup
    setTimeout(() => {
      if (mainWindow.isVisible()) {
        recoveryMode.resetFailureCount();
        console.log('App started successfully, failure count reset');
      }
    }, 5000);
  });
  
  // Handle renderer errors
  // TODO: Fix TypeScript type for crashed event
  // mainWindow.webContents.on('crashed', () => {
  //   recoveryMode.incrementFailureCount();
  //   if (errorHandler && errorHandler.handleError) {
  //     errorHandler.handleError('Renderer Process Crashed', new Error('WebContents crashed'), true);
  //   }
  // });
  
  mainWindow.webContents.on('console-message', (_, level, message, line, sourceId) => {
    if (level === 3) { // Error level
      if (errorHandler && errorHandler.logRendererError) {
        errorHandler.logRendererError({
          message,
          source: `${sourceId}:${line}`,
          level: 'error'
        });
      }
    }
  });

  mainWindow.webContents.on('did-attach-webview', (_, contents) => {
    // Prevent file drops in webviews
    // TODO: Fix TypeScript types for these events
    // contents.on('drop', (event) => {
    //   event.preventDefault();
    // });

    // contents.on('dragover', (event) => {
    //   event.preventDefault();
    // });

    contents.on('will-navigate', (event, url) => {
      if (url.startsWith('file:')) {
        event.preventDefault();
      }
    });

    contents.setWindowOpenHandler((details) => {
      mainWindow.webContents.send('open-url', details.url);
      return { action: 'deny' };
    });

    // Optimize IPC communications
    // const throttledIPC = new Map();
    // TODO: Re-enable when needed
    // function throttleIPC(channel, data, wait = 16) {
    //   if (throttledIPC.has(channel)) return;
    //   mainWindow.webContents.send(channel, data);
    //   throttledIPC.set(channel, true);
    //   setTimeout(() => throttledIPC.delete(channel), wait);
    // }

    // Add timeout detection and refresh handling
    let hasTimedOut = false;

    contents.on('did-fail-load', (_, errorCode, errorDescription) => {
      // if (errorCode) { // Any error code
      if (errorCode === -7) {
        // ERR_TIMED_OUT
        contents.reload();
        hasTimedOut = false;
        console.log(`Page reloaded due to error ${errorCode}: ${errorDescription}`);
      }
    });

    // Listen for any user interaction events (including window show/hide)
    // TODO: Fix interaction event handling
    // const interactionEvents = [
    //   'mousedown',
    //   'keydown',
    //   'touchstart',
    //   'wheel',
    //   'mouseleave',
    //   'mouseover',
    //   'mouseenter',
    // ];
    // interactionEvents.forEach((eventType) => {
    //   contents.on(eventType, () => {
    //     if (hasTimedOut) {
    //       contents.reload();
    //       hasTimedOut = false;
    //     }
    //   });
    // });

    // Listen for window show event to check timeout
    ['show', 'focus', 'restore', 'hide'].forEach((event) => {
      mainWindow.on(event, () => {
        if (hasTimedOut) {
          contents.reload();
          hasTimedOut = false;
        }
      });
    });

    contents.on('did-start-loading', () => {
      hasTimedOut = false;
    });
  });

  // Capture mouse events globally
  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.type === 'mouseDown') {
      const webview = mainWindow.webContents.send('navigateBackCognitizer'); // Get the currently active webview

      // Detect mouse back/forward buttons
      if ('button' in input && input.button === 'back') {
        if (webview && webview.canGoBack()) {
          webview.goBack();
        }
      } else if ('button' in input && input.button === 'forward') {
        if (webview && webview.canGoForward()) {
          webview.goForward();
        }
      }
    }
  });

  const htmlPath = path.join(__dirname, '../index.html');
  console.log('Loading HTML from:', htmlPath);

  if (!fs.existsSync(htmlPath)) {
    console.error('index.html not found at:', htmlPath);
    dialog.showErrorBox('File Not Found', `Cannot find index.html at: ${htmlPath}`);
  } else {
    mainWindow.loadFile(htmlPath).catch((error) => {
      console.error('Failed to load index.html:', error);
      if (errorHandler && errorHandler.handleError) {
        errorHandler.handleError('Failed to load index.html', error, true);
      } else {
        dialog.showErrorBox('Load Error', `Failed to load index.html: ${error.message}`);
      }
    });
  }
}

// Prevent a second instance from running
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('Another instance is already running');
  process.exit(0);
} else {
  console.log('Got single instance lock');
}

let shortcutToggleWindow = 'CmdOrCtrl+Space';
let shortcutLock = 'CmdOrCtrl+Alt+L';
let quitAppShortcut = 'CmdOrCtrl+Q';

// Add this function to load shortcuts from config
function loadShortcuts() {
  try {
    let configPath;
    if (app.isPackaged) {
      configPath = path.join(app.getPath('userData'), 'config.json');
    } else {
      configPath =
        os.platform() === 'darwin'
          ? path.join(os.homedir(), '.instant-cognition', 'config.json')
          : path.join(__dirname, '..', 'config.json');
    }

    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    // Load shortcuts with defaults if not found
    // Handle both legacy format (string) and new format (object with key property)
    const loadShortcutKey = (shortcutData) => {
      if (typeof shortcutData === 'string') {
        return shortcutData;
      } else if (shortcutData && typeof shortcutData === 'object' && shortcutData.key) {
        return shortcutData.key;
      }
      return null;
    };

    const toggleShortcutFromConfig = 
      config?.settings?.shortcuts?.toggleShortcut || 
      config?.settings?.shortcuts?.['window.toggle'];
    shortcutToggleWindow = loadShortcutKey(toggleShortcutFromConfig) || shortcutToggleWindow;
    
    const lockShortcutFromConfig = 
      config?.settings?.shortcuts?.shortcutLock || 
      config?.settings?.shortcuts?.['window.lock'];
    shortcutLock = loadShortcutKey(lockShortcutFromConfig) || shortcutLock;

    // Save defaults if they weren't in config
    if (!config) config = { state: {}, settings: {} };
    if (!config.settings) config.settings = {};
    if (!config.settings.shortcuts) {
      config.settings.shortcuts = {};
    }
    
    // Only save legacy shortcuts if neither legacy nor new format exists
    let configChanged = false;
    if (!config.settings.shortcuts.toggleShortcut && !config.settings.shortcuts['window.toggle']) {
      config.settings.shortcuts['window.toggle'] = {
        key: shortcutToggleWindow,
        description: 'Toggle Window'
      };
      configChanged = true;
    }
    if (!config.settings.shortcuts.shortcutLock && !config.settings.shortcuts['window.lock']) {
      config.settings.shortcuts['window.lock'] = {
        key: shortcutLock,
        description: 'Lock Shortcuts'
      };
      configChanged = true;
    }
    
    if (configChanged) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  } catch (error) {
    console.error('Error loading shortcuts:', error);
    // Use defaults if loading fails
    shortcutToggleWindow = shortcutToggleWindow;
    shortcutLock = shortcutLock;
  }
}

const toggleWindow = () => {
  if (mainWindow.isVisible()) {
    if (process.platform === 'darwin') {
      // On macOS, check if Stage Manager is enabled
      let stageManagerEnabled = false;

      try {
        // Try to read Stage Manager setting
        const result = execSync('defaults read com.apple.WindowManager GloballyEnabled')
          .toString()
          .trim();
        stageManagerEnabled = result === '1';
      } catch (error) {
        // If command fails, assume Stage Manager is not enabled
        console.log('Could not detect Stage Manager status:', error);
      }

      if (stageManagerEnabled) {
        // If Stage Manager is enabled, just hide the window to avoid issues
        mainWindow.hide();
      } else {
        // If Stage Manager is not enabled, use normal toggle behavior
        if (mainWindow.isFocused()) {
          mainWindow.hide();
        } else {
          mainWindow.focus();
        }
      }
    } else {
      // On other platforms, maintain the focus/hide toggle behavior
      if (mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.focus();
      }
    }
  } else {
    mainWindow.show();
  }
};

// let shortcutsRegistered = false;
let currentTimestampShortcut = Date.now();
// Register a single global shortcut to toggle the window
const registerToggleShortcut = () => {
  globalShortcut.register(shortcutToggleWindow, () => {
    if (Date.now() - currentTimestampShortcut < 50) return;

    toggleWindow();

    currentTimestampShortcut = Date.now();
  });
  // shortcutsRegistered = true;
};

function unregisterToggleShortcut() {
  globalShortcut.unregister(shortcutToggleWindow);
  // shortcutsRegistered = false;
}

let toggleLocked = false;
let currentTimestampShortcutLock = Date.now();
// Register shortcut lock
const registerShortcutLock = () => {
  globalShortcut.register(shortcutLock, () => {
    if (Date.now() - currentTimestampShortcutLock < 100) return;

    if (toggleLocked) {
      toggleLocked = false;
      registerToggleShortcut();
    } else {
      toggleLocked = true;
      unregisterToggleShortcut();
    }

    currentTimestampShortcutLock = Date.now();
  });
};

// Optimize event listeners by debouncing
const debounce = (func, wait) => {
  let timeout;
  return function (...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), wait);
  };
};

app.whenReady().then(async () => {
  // Check if we should start in recovery mode
  if (recoveryMode.checkRecoveryMode()) {
    console.log('Starting in recovery mode...');
    recoveryMode.createRecoveryWindow();
    recoveryMode.setupRecoveryHandlers();
    return; // Don't start normal app
  }
  
  // Initialize error handler
  try {
    errorLogPath = errorHandler.initialize();
    console.log('Error logging initialized:', errorLogPath);
  } catch (error) {
    console.error('Failed to initialize error handler:', error);
  }
  
  console.log('App ready, packaged:', app.isPackaged);
  console.log('App path:', app.getAppPath());
  console.log('Resources path:', process.resourcesPath);
  console.log('__dirname:', __dirname);

  // Temporarily disable updater to debug startup
  /*
  try {
    // Run npm package updater
    const updaterPath = path.join(__dirname, '../updater.js');
    const { runUpdater } = require(updaterPath);
    console.log('Running npm package updater...');
    await runUpdater();
    console.log('npm package update complete');
  } catch (error) {
    console.error('Failed to update npm packages:', error);
  }
  */
  console.log('[MAIN] Skipping updater for debugging');

  // Load shortcuts before registering them
  loadShortcuts();

  // Optimize V8
  v8.setFlagsFromString('--max-old-space-size=4096');
  v8.setFlagsFromString('--optimize-for-size');

  acceptedCertificatesPath =
    os.platform() === 'darwin'
      ? path.join(os.homedir(), '.instant-cognition', 'trusted_certificates.json')
      : path.join(__dirname, '../../trusted_certificates.json');

  // acceptedCertificatesPathOrig removed - unused variable

  // Load accepted certificates on app start
  function loadAcceptedCertificates() {
    try {
      if (fs.existsSync(acceptedCertificatesPath)) {
        const data = fs.readFileSync(acceptedCertificatesPath, 'utf8');
        acceptedCertificates = JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load accepted certificates:', error);
    }
  }

  loadAcceptedCertificates();

  try {
    createMainWindow();
  } catch (error) {
    console.error('Failed to create main window:', error);
    recoveryMode.incrementFailureCount();
    if (errorHandler && errorHandler.handleError) {
      errorHandler.handleError('Window Creation Failed', error, true);
    } else {
      dialog.showErrorBox('Window Creation Error', `Failed to create window: ${error instanceof Error ? error.message : String(error)}`);
    }
    isAppQuitting = true;
    app.quit();
  }

  registerToggleShortcut();
  registerShortcutLock();

  app.setName('InstantCognition');
  console.log('App name set to:', app.getName());

  // Create tray icon for the windows system tray / macos tray
  // Define the icon path based on the platform
  let iconPath = path.join(__dirname, '../assets/icon');
  if (os.platform() === 'win32') {
    iconPath += '.ico'; // Use .ico format for Windows
  } else {
    iconPath += '.png'; // Use .png format for macOS
  }

  console.log('Loading tray icon from:', iconPath);

  if (!fs.existsSync(iconPath)) {
    console.error('Tray icon not found at:', iconPath);
    // Try alternative path for packaged app
    const alternativePath = app.isPackaged
      ? path.join(process.resourcesPath, 'assets', path.basename(iconPath))
      : iconPath;
    console.log('Trying alternative path:', alternativePath);
    if (fs.existsSync(alternativePath)) {
      iconPath = alternativePath;
    }
  }

  try {
    const trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      console.error('Failed to load tray icon - image is empty');
    } else {
      if (os.platform() === 'win32') {
        tray = new Tray(trayIcon);
      } else {
        tray = new Tray(trayIcon.resize({ width: 22, height: 22 }));
      }
      console.log('Tray icon created successfully');
    }
  } catch (error) {
    console.error('Error creating tray icon:', error);
  }

  mainWindow.webContents.on('did-attach-webview', (_, contents) => {
    contents.on('context-menu', (_, params) => {
      const contextMenuRightClick = Menu.buildFromTemplate([
        {
          label: 'Copy',
          role: 'copy',
        },
        {
          label: 'Paste',
          role: 'paste',
        },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F', // Display the keyboard shortcut in the menu
          click: () => {
            // Send IPC message to show the find bar
            mainWindow.webContents.send('toggleFindBar');
          },
        },
        { type: 'separator' },
        {
          label: 'Close',
          accelerator: 'F7',
          click: () => {
            mainWindow.webContents.send('closeActiveWebview');
          },
        },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: 'F3',
          click: () => {
            mainWindow.webContents.send('navigateBackActive');
          },
        },
        {
          label: 'Forward',
          accelerator: 'F4',
          click: () => {
            mainWindow.webContents.send('navigateForwardActive');
          },
        },
        {
          label: 'Refresh',
          accelerator: 'F5',
          click: () => {
            mainWindow.webContents.send('refreshActive');
          },
        },
        {
          label: 'Home',
          accelerator: 'F6',
          click: () => {
            mainWindow.webContents.send('navigateHomeReset');
          },
        },
        { type: 'separator' },
        {
          label: 'Search / Open',
          click: () => {
            let searchText = contents.executeJavaScript('window.getSelection().toString().trim()');
            searchText
              .then((result) => {
                if (result === '') {
                  let url = contents.getURL();
                  mainWindow.webContents.send('open-url', url);
                } else if (result.startsWith('http://') || result.startsWith('https://')) {
                  mainWindow.webContents.send('open-url', result);
                } else {
                  let searchParams = new URLSearchParams();
                  searchParams.append('q', result);
                  let url = `https://www.google.com/search?${searchParams.toString()}`;
                  mainWindow.webContents.send('open-url', url);
                }
              })
              .catch((error) => {
                console.error(error);
              });
          },
        },
        {
          label: 'Google',
          click: () => {
            mainWindow.webContents.send('navigate-to-url', { url: 'https://www.google.com' });
          },
        },
        {
          label: 'Visit URL',
          click: () => {
            // Get the cognitizer ID from the webview
            require('electron-prompt')({
              title: 'Visit URL',
              label: 'Enter URL to visit:',
              value: 'https://',
              inputAttrs: {
                type: 'text',
              },
              type: 'input',
            })
              .then((url) => {
                if (url) {
                  mainWindow.webContents.send('navigate-to-url', { url });
                }
              })
              .catch(console.error);
          },
        },
        { type: 'separator' },
        // { label: 'Reset View', click: () => { mainWindow.webContents.send('resetView'); } },
        {
          label: 'Toggle View',
          accelerator: 'F8',
          click: () => {
            mainWindow.webContents.send('toggleView');
          },
        },
        { type: 'separator' },
        {
          label: 'Toggle Cognitizer',
          click: () => {
            mainWindow.webContents.send('toggleCognitizerView');
          },
        },
        {
          label: 'Toggle Browser',
          click: () => {
            mainWindow.webContents.send('toggleBrowserView');
          },
        },
        { type: 'separator' },
        {
          label: 'Inspect',
          click: () => {
            contents.inspectElement(params.x, params.y);
          },
        },
      ]);

      contextMenuRightClick.popup({
        window: mainWindow,
        x: params.x,
        y: params.y,
      });
    });
  });

  // Optimize tray icon context menu creation
  const contextMenuTrayIcon = Menu.buildFromTemplate([
    {
      label: 'InstantCognition',
      enabled: true,
      click: () => {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
        }
      },
    },
    // add a seperator
    { type: 'separator' },
    {
      label: 'Toggle Window',
      accelerator: shortcutToggleWindow,
      click: () => {
        toggleWindow();
      },
    },
    { type: 'separator' },
    {
      label: 'Toggle Lock',
      accelerator: shortcutLock,
      click: () => {
        if (toggleLocked) {
          toggleLocked = false;
          registerToggleShortcut();
        } else {
          toggleLocked = true;
          unregisterToggleShortcut();
        }
      },
    },
    { type: 'separator' },
    { role: 'reload' },
    { role: 'forceReload' },
    { type: 'separator' },
    {
      label: 'Restart InstantCognition',
      click: () => {
        isAppQuitting = true;
        app.relaunch();
        app.quit();
      },
    },
    {
      label: 'Quit',
      accelerator: quitAppShortcut,
      click: () => {
        isAppQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('InstantCognition');
  tray.setContextMenu(contextMenuTrayIcon);

  mainWindow.focus();

  // Create a menu template
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Restart App',
          click: () => {
            isAppQuitting = true;
            app.relaunch();
            app.quit();
          },
        },
        {
          label: 'Quit',
          accelerator: quitAppShortcut,
          click: () => {
            isAppQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        // { role: 'delete' },
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl + F',
          click: () => {
            mainWindow.webContents.send('toggleFindBar');
          },
        },
        {
          label: 'Find Next',
          accelerator: 'CmdOrCtrl + G',
          click: () => {
            mainWindow.webContents.send('findBarForward');
          },
        },
        {
          label: 'Find Previous',
          accelerator: 'Shift + CmdOrCtrl + G',
          click: () => {
            mainWindow.webContents.send('findBarBack');
          },
        },
        { type: 'separator' },
        { role: 'selectAll' },
        { type: 'separator' },
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'toggleSpellChecker' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Window',
          accelerator: shortcutToggleWindow,
          click: () => {
            toggleWindow();
          },
        },
        { type: 'separator' },
        {
          label: 'Toggle Lock',
          accelerator: shortcutLock,
          click: () => {
            if (toggleLocked) {
              toggleLocked = false;
              registerToggleShortcut();
            } else {
              toggleLocked = true;
              unregisterToggleShortcut();
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl + =',
          click: () => {
            mainWindow.webContents.send('zoomInActive');
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl + -',
          click: () => {
            mainWindow.webContents.send('zoomOutActive');
          },
        },
        {
          label: 'Zoom Reset',
          accelerator: 'CmdOrCtrl + 0',
          click: () => {
            mainWindow.webContents.send('zoomResetActive');
          },
        },
        { type: 'separator' },
        // { label: 'Reset View', click: () => { mainWindow.webContents.send('resetView'); } },
        {
          label: 'Toggle View',
          accelerator: 'F8',
          click: () => {
            mainWindow.webContents.send('toggleView');
          },
        },
        {
          label: 'Close Browser',
          click: () => {
            mainWindow.webContents.send('closeBrowser');
          },
        },
        {
          label: 'Close Cognitizer',
          click: () => {
            mainWindow.webContents.send('closeActiveCognitizer');
          },
        },
        { type: 'separator' },
        {
          label: 'Toggle MultiCognition',
          click: () => {
            mainWindow.webContents.send('toggleMultiCognition');
          },
        },
        {
          label: 'Toggle Cognitizer',
          click: () => {
            mainWindow.webContents.send('toggleCognitizerView');
          },
        },
        {
          label: 'Toggle Browser',
          click: () => {
            mainWindow.webContents.send('toggleBrowserView');
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggledevtools' },
      ],
    },
    {
      label: 'Navigation',
      submenu: [
        {
          label: 'Previous Cognitizer',
          accelerator: 'F1',
          click: () => {
            mainWindow.webContents.send('select-previous-cognitizer');
          },
        },
        {
          label: 'Next Cognitizer',
          accelerator: 'F2',
          click: () => {
            mainWindow.webContents.send('select-next-cognitizer');
          },
        },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: 'F3',
          click: () => {
            mainWindow.webContents.send('navigateBackActive');
          },
        },
        {
          label: 'Forward',
          accelerator: 'F4',
          click: () => {
            mainWindow.webContents.send('navigateForwardActive');
          },
        },
        { type: 'separator' },
        {
          label: 'Refresh',
          accelerator: ['F5', 'CmdOrCtrl + R'],
          click: () => {
            mainWindow.webContents.send('refreshActive');
          },
        },
        {
          label: 'Home',
          accelerator: 'F6',
          click: () => {
            mainWindow.webContents.send('navigateHomeReset');
          },
        },
        { type: 'separator' },
      ],
    },
    {
      label: 'Window',
      role: 'windowMenu',
      submenu: [
        {
          label: 'Toggle Lock',
          accelerator: shortcutLock,
          click: () => {
            if (toggleLocked) {
              toggleLocked = false;
              registerToggleShortcut();
            } else {
              toggleLocked = true;
              unregisterToggleShortcut();
            }
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        {
          label: 'InstantCognition GitHub',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com/Sellitus/InstantCognition');
          },
        },
        {
          label: 'Create a Bug Report',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com/Sellitus/InstantCognition/issues');
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        {
          label: 'Restart InstantCognition',
          click: () => {
            isAppQuitting = true;
            app.relaunch();
            app.quit();
          },
        },
      ],
    },
  ];

  // Build the menu from the template
  const menu = Menu.buildFromTemplate(menuTemplate);

  // Set the application menu
  Menu.setApplicationMenu(menu);
});

function cleanupEventListeners() {
  // Cleanup is handled in renderer process
  // This function is kept for compatibility
}

// Handle certificate errors
app.on('certificate-error', (event, _, url, error, certificate, callback) => {
  event.preventDefault();

  const domain = new URL(url).hostname;
  const certFingerprint = certificate.fingerprint;

  if (acceptedCertificates[domain]) {
    if (acceptedCertificates[domain] === certFingerprint) {
      callback(true);
      return;
    } else {
      const options = {
        type: 'warning',
        buttons: ['Decline', 'Accept'],
        defaultId: 0,
        title: 'WARNING: Certificate Mismatch',
        message: `WARNING: Certificate mismatch for ${domain}`,
        detail: `The certificate presented by the site does not match the one previously accepted.\n\nError: ${error}\n\nCertificate:\nIssuer: ${certificate.issuerName}\nSubject: ${certificate.subjectName}\nFingerprint: ${certFingerprint}`,
      };

      dialog.showMessageBox(null, options).then((result) => {
        if (result.response === 1) {
          // Accept
          acceptedCertificates[domain] = certFingerprint;
          saveAcceptedCertificates();
          callback(true);
        } else {
          // Decline
          callback(false);
        }
      });
      return;
    }
  }

  const options = {
    type: 'warning',
    buttons: ['Decline', 'Accept'],
    defaultId: 1,
    title: 'Certificate Error',
    message: `Certificate error for ${domain}`,
    detail: `Error: ${error}\n\nCertificate:\nIssuer: ${certificate.issuerName}\nSubject: ${certificate.subjectName}\nFingerprint: ${certFingerprint}`,
  };

  dialog.showMessageBox(null, options).then((result) => {
    if (result.response === 1) {
      // Accept
      acceptedCertificates[domain] = certFingerprint;
      saveAcceptedCertificates();
      callback(true);
    } else {
      // Decline
      callback(false);
    }
  });
});

app.on('before-quit', async () => {
  isAppQuitting = true;
  try {
    // Clear caches
    await mainWindow.webContents.session.clearCache();
    await mainWindow.webContents.session.clearStorageData({
      storages: ['appcache', 'shadercache', 'serviceworkers'],
    });

    // Release memory
    global.gc && global.gc();

    // Check if we need to run the updater
    const updaterPath = path.join(app.getAppPath(), 'updater.js');
    if (fs.existsSync(updaterPath)) {
      const { spawn } = require('child_process');
      // Run the updater in a detached process
      spawn(process.execPath, [updaterPath], {
        detached: true,
        stdio: 'inherit',
      }).unref();
    }
  } catch (error) {
    console.error('Error during shutdown:', error);
  }
  process.exit(0);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

// Show currently open app if a second instance run is attempted
app.on('second-instance', () => {
  // Someone tried to run a second instance, we should show and focus our window.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    if (!mainWindow.isFocused()) mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isAppQuitting = true;
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanupEventListeners();
});

app.on('browser-window-created', (_, window) => {
  // Multi-cognition resource management
  const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes
  const cognitizerStates = new Map();

  function freezeCognitizer(webContents) {
    if (!webContents || webContents.isDestroyed()) return;

    webContents.setBackgroundThrottling(true);
    if (global.gc) global.gc();
    console.log('Cognitizer frozen due to inactivity');
  }

  function unfreezeCognitizer(webContents) {
    if (!webContents || webContents.isDestroyed()) return;

    webContents.setBackgroundThrottling(false);
    console.log('Cognitizer unfrozen');
  }

  // Handle cognitizer activity tracking
  ipcMain.on('cognitizer-activity', (event, { cognitizerId, isActive }) => {
    const webContents = event.sender;
    const state = cognitizerStates.get(cognitizerId) || {};

    if (isActive) {
      // Clear any existing timeout
      if (state.timeoutId) {
        clearTimeout(state.timeoutId);
      }
      unfreezeCognitizer(webContents);
      state.lastActivity = Date.now();
    } else {
      // Set timeout to freeze after inactivity
      state.timeoutId = setTimeout(() => {
        freezeCognitizer(webContents);
      }, INACTIVITY_TIMEOUT);
    }

    cognitizerStates.set(cognitizerId, state);
  });

  // Cleanup when cognitizer is closed
  ipcMain.on('cognitizer-closed', (_, { cognitizerId }) => {
    const state = cognitizerStates.get(cognitizerId);
    if (state && state.timeoutId) {
      clearTimeout(state.timeoutId);
    }
    cognitizerStates.delete(cognitizerId);
  });

  window.on('minimize', () => {
    window.webContents.setBackgroundThrottling(true);
  });

  window.on('restore', () => {
    window.webContents.setBackgroundThrottling(false);
  });
});

ipcMain.handle('call-isLaunchAtStartupEnabled', () => {
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
});

ipcMain.on('call-createAndUpdateaAblocker', () => {
  createAndUpdateBlocker().then((result) => {
    blocker = result;
  });
  // Set up automatic updates (e.g., every 1 hour)
  if (!intervalId) {
    const UPDATE_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
    intervalId = setInterval(() => {
      createAndUpdateBlocker().then((result) => {
        if (result) {
          blocker = result;
        }
      });
    }, UPDATE_INTERVAL);
  }
});

ipcMain.on('call-disableAdblocker', () => {
  disableAdblocker();
  clearInterval(intervalId);
});

ipcMain.on('call-enableLaunchAtStartup', () => {
  setLaunchAtStartup(true);
});

ipcMain.on('call-disableLaunchAtStartup', () => {
  setLaunchAtStartup(false);
});

ipcMain.on('toggleCognitizerView', () => {
  mainWindow.webContents.send('toggleCognitizerView');
});

ipcMain.on('toggleMultiCognition', () => {
  mainWindow.webContents.send('toggleMultiCognition');
});

ipcMain.on('open-config-file', () => {
  console.log('[MAIN] Received open-config-file IPC message');
  let configPath;
  
  // Use platform-specific paths
  if (os.platform() === 'darwin') {
    // macOS: ~/.instant-cognition/config.json
    configPath = path.join(os.homedir(), '.instant-cognition', 'config.json');
  } else if (app.isPackaged) {
    // Windows/Linux packaged: In the app's resources directory
    configPath = path.join(process.resourcesPath, 'app', 'config.json');
  } else {
    // Development: Project root
    configPath = path.join(__dirname, '..', 'config.json');
  }

  console.log('[MAIN] Opening config file:', configPath);
  console.log('[MAIN] File exists:', fs.existsSync(configPath));
  
  // Ensure the file exists before trying to open it
  if (fs.existsSync(configPath)) {
    shell.openPath(configPath).then(() => {
      console.log('[MAIN] Config file opened successfully');
    }).catch((err) => {
      console.error('[MAIN] Failed to open config file:', err);
      dialog.showErrorBox('Error', 'Failed to open config file: ' + err.message);
    });
  } else {
    console.error('[MAIN] Config file not found at:', configPath);
    dialog.showErrorBox('Config File Not Found', `Config file not found at: ${configPath}`);
  }
});

ipcMain.on('select-previous-cognitizer', () => {
  mainWindow.webContents.send('select-previous-cognitizer');
});

ipcMain.on('select-next-cognitizer', () => {
  mainWindow.webContents.send('select-next-cognitizer');
});

ipcMain.on('switch-cognitizer', (_, index) => {
  // Add timestamp check with 100ms cooldown
  const now = Date.now();
  if (now - lastCognitizerSwitch < 100) {
    return;
  }
  lastCognitizerSwitch = now;

  const cognitizerId = index === 0 ? 'custom10' : `custom${index}`;
  if (mainWindow) {
    mainWindow.webContents.send('selectCognitizer', cognitizerId);
  }
});

// Handle back navigation
ipcMain.on('navigate-back', () => {
  mainWindow.webContents.send('navigateBackActive');
});

// Handle forward navigation
ipcMain.on('navigate-forward', () => {
  mainWindow.webContents.send('navigateForwardActive');
});

// Handle refresh navigation
ipcMain.on('navigate-refresh', () => {
  mainWindow.webContents.send('refreshActive');
});

// Handle refresh navigation
ipcMain.on('navigate-home', () => {
  mainWindow.webContents.send('navigateHomeReset');
});

// Handle CTRL + F to show the find bar
ipcMain.on('show-toggle-bar', () => {
  mainWindow.webContents.send('toggleFindBar');
});

// Forward the close-find-bar event to the renderer process
ipcMain.on('close-find-bar', () => {
  mainWindow.webContents.send('close-find-bar');
});
ipcMain.on('refreshActive', () => {
  mainWindow.webContents.send('refreshActive');
});
ipcMain.on('quitApp', () => {
  isAppQuitting = true;
  app.quit();
});
ipcMain.on('zoomInActive', () => {
  mainWindow.webContents.send('zoomInActive');
});
ipcMain.on('zoomOutActive', () => {
  mainWindow.webContents.send('zoomInActive');
});
ipcMain.on('zoomResetActive', () => {
  mainWindow.webContents.send('zoomInActive');
});
ipcMain.on('restart-app', () => {
  console.log('[MAIN] Received restart-app IPC message');
  isAppQuitting = true;
  console.log('[MAIN] Relaunching app...');
  app.relaunch();
  console.log('[MAIN] Quitting app...');
  app.quit();
});


// Add IPC handler for renderer errors
ipcMain.on('renderer-error', (_, errorInfo) => {
  if (errorHandler && errorHandler.logRendererError) {
    errorHandler.logRendererError(errorInfo);
  }
});

// Add IPC handler for showing URL prompt
ipcMain.on('show-url-prompt', (event) => {
  require('electron-prompt')({
    title: 'Visit URL',
    label: 'Enter the URL to visit:',
    value: 'https://',
    inputAttrs: {
      type: 'url',
    },
    type: 'input',
  })
    .then((url) => {
      if (url) {
        event.sender.send('navigate-to-url', { url });
      }
    })
    .catch(console.error);
});
