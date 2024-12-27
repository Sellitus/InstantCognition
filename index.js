// ##### index.js

// // Automatically update the app every 1 hour
// const { updateElectronApp } = require('update-electron-app');
// updateElectronApp();



const v8 = require('v8');
const { app, BrowserWindow, globalShortcut, Menu, Tray, nativeImage, dialog, ipcRenderer, ipcMain } = require('electron')
const os = require('os');
const path = require('path');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
const fs = require('fs');
// const { autoUpdater } = require('electron-updater');
const { exec } = require('child_process');
const util = require('util');
// const fetch = require('node-fetch'); // Use node-fetch for server-side requests
// Not yet implemented: dns-over-https / dns-over-tls
const dnstls = require('dns-over-tls');
const dns = require('dns');

app.commandLine.appendSwitch('enable-hardware-acceleration');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blacklist');

let log_file_path;
if (os.platform() === 'darwin') {
  let userDataPath = path.join(os.homedir(), '.instant-cognition');
  log_file_path = path.join(userDataPath, 'debug.log');
} else {
  log_file_path = path.join(__dirname, '../../debug.log');
}

// Log console.log() calls to a file
const log_file = fs.createWriteStream(log_file_path, {flags : 'w'});
const log_stdout = process.stdout;
const log_stderr = process.stderr;

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Modify the socket usage to handle errors gracefully
function safeWrite(sock, data) {
  try {
    if (sock && sock.writable) {
      sock.write(data);
    } else {
      console.error('Socket not writable');
    }
  } catch (error) {
    console.error('Error writing to socket:', error);
  }
}


// Override console.log() globally
console.log = function(...args) {
  const currentDate = new Date();
  const currentTime = currentDate.toLocaleString();

  try {
    fs.appendFileSync(log_file_path, currentTime + ' ::: ' + util.format(...args) + '\n\n');
  } catch (err) {
    console.error('Failed to append to log file:', err);
  }

  log_stdout.write(util.format(...args) + '\n\n');
};
// Override console.error() globally
const originalConsoleError = console.error;
console.error = function(...args) {
  const currentDate = new Date();
  const currentTime = currentDate.toLocaleString();

  try {
    fs.appendFileSync(log_file_path, currentTime + ' :X: ' + util.format(...args) + '\n\n');
  } catch (err) {
    originalConsoleError('Failed to append to log file:', err);
  }

  log_stderr.write(util.format(...args) + '\n\n');
  originalConsoleError(...args);
};




// Initial creation of the blocker
let blocker;
let intervalId;
// URL for Hagezi's blocklist (choose the appropriate one for your needs)
let HAGEZI_LIST_URL = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt';
let ONEHOSTS_LIST_URL = 'https://raw.githubusercontent.com/badmojr/1Hosts/master/Lite/hosts.txt';
let OISD_LIST_URL = 'https://big.oisd.nl/';
let ADGUARD_DNS_LIST_URL = 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_15_DnsFilter/filter.txt';
let ADGUARD_TRACKING_LIST_URL = 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_3_Spyware/filter.txt';
let EASYLIST_LIST_URL = 'https://easylist.to/easylist/easylist.txt';
let EASYPRIVACY_LIST_URL = 'https://easylist.to/easylist/easyprivacy.txt';
let STEVEN_BLACK_LIST_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts';



// Optimize adblocker creation by caching the blocker instance
let blockerCache = null;
async function createAndUpdateBlocker(session) {
  if (blockerCache) return blockerCache;
  
  try {
    const cachePath = path.join(
      os.platform() === 'darwin' ? 
      path.join(os.homedir(), '.instant-cognition', 'adblocker_cache.bin') :
      path.join(__dirname, '../../adblocker_cache.bin')
    );

    // Use cached blocker if available
    if (fs.existsSync(cachePath)) {
      const cachedData = await fs.promises.readFile(cachePath);
      blockerCache = await ElectronBlocker.deserialize(cachedData);
    } else {
      blockerCache = await ElectronBlocker.fromLists(fetch, [HAGEZI_LIST_URL], {
        enableCompression: true,
        path: cachePath,
        read: fs.promises.readFile,
        write: fs.promises.writeFile
      });
    }

    const sessions = BrowserWindow.getAllWindows().map(window => window.webContents.session);
    sessions.forEach(session => {
      blockerCache.enableBlockingInSession(session);
    });
    console.log('Adblocker: enabled and updated');
    
    return blockerCache;
  } catch (error) {
    console.error('Adblocker: Failed to enable and update:', error);
  }
}

// Function to disable the adblocker
function disableAdblocker() {
  if (blocker) {
    const sessions = BrowserWindow.getAllWindows().map(window => window.webContents.session);
    sessions.forEach(session => {
      blocker.disableBlockingInSession(session);
    });
    console.log('Adblocker: disabled');

    blocker = null;
    intervalId = null;
  }
}











ipcMain.handle('call-isLaunchAtStartupEnabled', () => {
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
});


ipcMain.on('call-createAndUpdateaAblocker', (eventß) => {
  createAndUpdateBlocker().then(result => {
    blocker = result;
  });
  // Set up automatic updates (e.g., every 1 hour)
  if (!intervalId) {
    const UPDATE_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
    intervalId = setInterval(() => {
      createAndUpdateBlocker().then(result => {
        if (result) {
          blocker = result;
        }
      });
    }, UPDATE_INTERVAL);
  }
});

ipcMain.on('call-disableAdblocker', (event) => {
  disableAdblocker();
  clearInterval(intervalId);
});


ipcMain.on('call-enableLaunchAtStartup', (event) => {
  setLaunchAtStartup(true);
});

ipcMain.on('call-disableLaunchAtStartup', (event) => {
  setLaunchAtStartup(false);
});

ipcMain.on('toggleCognitizerView', () => {
  mainWindow.webContents.send('toggleCognitizerView');
});




let tray = null
let mainWindow;






// Setup main window and all basic elements


if (os.platform() === 'win32') {
  app.setUserTasks([
    {
      program: process.execPath,
      arguments: '--new-window',
      iconPath: process.execPath,
      iconIndex: 0,
      title: 'InstantCognition',
      description: 'InstantCognition'
    }
  ]);

  // Assuming you have a way to capture the user's preference, call this function with true to enable or false to disable
  // setLaunchAtStartup(true); // To enable
  // setLaunchAtStartup(false); // To disable
}


// Example function to set the app to launch at startup
function setLaunchAtStartup(enable) {
  app.setLoginItemSettings({
    openAtLogin: enable,
    // For macOS, you can also control if the app is hidden on launch
    openAsHidden: enable, // This is optional and macOS only
    // For Windows, you can specify arguments to launch the app with
    // args: [
    //   '--your-argument-here'
    // ]
  });
}


// Optimize window creation
function createMainWindow() {
  // Load window bounds from config
  let config;
  try {
    const configPath = os.platform() === 'darwin' 
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
  sess.enableNetworkEmulation({ offline: false });
  
  mainWindow = new BrowserWindow({
    ...bounds,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      icon: path.join(__dirname, 'assets/icon.ico'),
      webviewTag: true,  // Enable the use of <webview> tag
      contextIsolation: false,
      nodeIntegration: true,

      // contextIsolation: true,
      // nodeIntegration: false, 
      // sandbox: true,
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
    // Optimize window performance
    show: false, // Wait until ready-to-show
    paintWhenInitiallyHidden: true,
    backgroundColor: '#1e1e1e',
    // Add window optimizations
    minimizable: true,
    frame: true,
  });

  // Save window bounds when resized
  mainWindow.on('resize', debounce(() => {
    const bounds = mainWindow.getBounds();
    config.state.windowBounds = {
      width: bounds.width,
      height: bounds.height
    };
    
    // Save to config file
    try {
      const configPath = os.platform() === 'darwin'
        ? path.join(os.homedir(), '.instant-cognition', 'config.json')
        : path.join(__dirname, '../../config.json');
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Error saving window bounds to config:', error);
    }
  }, 100));

  // Optimize memory usage and perform additional cleaning
  setInterval(async () => {
    const memoryInfo = await process.getProcessMemoryInfo();
    if (memoryInfo.workingSetSize > 500 * 1024 * 1024) { // 500MB
      if (!mainWindow.isVisible()) {
        mainWindow.webContents.session.clearCache();
        mainWindow.webContents.session.clearStorageData({
          storages: ['appcache', 'shadercache', 'serviceworkers', 'caches', 'localstorage', 'indexdb', 'websql']
        });
        global.gc && global.gc();
      }
    }
  }, 30000);

  // Additional cleaning tasks
  setInterval(() => {
    // Clear expired cookies
    mainWindow.webContents.session.cookies.flushStore(() => {
      console.log('Cookies store flushed');
    });
  }, 1 * 60 * 60 * 1); // 1 hour

  // Show window only when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Optimize IPC communications
  const throttledIPC = new Map();
  function throttleIPC(channel, data, wait = 16) {
    if (throttledIPC.has(channel)) return;
    mainWindow.webContents.send(channel, data);
    throttledIPC.set(channel, true);
    setTimeout(() => throttledIPC.delete(channel), wait);
  }

  mainWindow.webContents.on('did-attach-webview', (_, contents) => {
    contents.setWindowOpenHandler((details) => {
      mainWindow.webContents.send('open-url', details.url);
      return { action: 'deny' }
    })
  })




  // Capture mouse events globally
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'mouseDown') {
      const webview = mainWindow.webContents.send('navigateBackCognitizer') // Get the currently active webview

      // Detect mouse back/forward buttons
      if (input.button === 'back') {
        if (webview && webview.canGoBack()) {
          webview.goBack();
        }
      } else if (input.button === 'forward') {
        if (webview && webview.canGoForward()) {
          webview.goForward();
        }
      }
    }
  });

  

  mainWindow.loadFile('index.html');




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
    mainWindow.webContents.send('navigateHomeActive');
  });

  // Handle CTRL + F to show the find bar
  ipcMain.on('show-toggle-bar', () => {
    mainWindow.webContents.send('toggleFindBar');
  });

  // // Handle swipe gestures (MacOS)
  // mainWindow.on('swipe', (event) => {
  //   const webview = getActiveWebview();
  //   if (event.direction === 'left') {
  //     if (webview && webview.canGoForward()) {
  //       mainWindow.webContents.send('navigateForwardActive');
  //     }
  //   } else if (event.direction === 'right') {
  //     if (webview && webview.canGoBack()) {
  //       mainWindow.webContents.send('navigateBackActive');
  //     }
  //   }
  // });

  // Forward the close-find-bar event to the renderer process
  ipcMain.on('close-find-bar', () => {
    mainWindow.webContents.send('close-find-bar');
  });





  mainWindow.on('close', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });
  
}





// Prevent a second instance from running
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  process.exit(0);
}

// Show currently open app if a second instance run is attempted
app.on('second-instance', (event, commandLine, workingDirectory) => {
  // Someone tried to run a second instance, we should show and focus our window.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    if (!mainWindow.isFocused()) mainWindow.focus();
  }
});





let toggleShortcut = 'Ctrl+Space';
let shortcutLock = 'Ctrl+Alt+L';



let shortcutsRegistered = false;
let currentTimestampShortcut = Date.now();
// Register a single global shortcut to toggle the window
const registerToggleShortcut = () => {
  globalShortcut.register(toggleShortcut, () => {
    if (Date.now() - currentTimestampShortcut < 100) return;

    if (mainWindow.isVisible()) {
      if (mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.focus();
      }
    } else {
      mainWindow.show();
    }
    currentTimestampShortcut = Date.now();
  });
  shortcutsRegistered = true;
};

function unregisterToggleShortcut() {
  globalShortcut.unregister(toggleShortcut);
  shortcutsRegistered = false;
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
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
};

app.whenReady().then(() => {

  // Optimize V8
  v8.setFlagsFromString('--max-old-space-size=4096');
  v8.setFlagsFromString('--optimize-for-size');

  const acceptedCertificatesPath = os.platform() === 'darwin' 
      ? path.join(os.homedir(), '.instant-cognition', 'trusted_certificates.json')
      : path.join(__dirname, '../../trusted_certificates.json');

  const acceptedCertificatesPathOrig = path.join(os.homedir(), '.instant-cognition', 'trusted_certificates.json');
  let acceptedCertificates = {};

  // Load accepted certificates on app start
  function loadAcceptedCertificates() {
    try {
      if (fs.existsSync(acceptedCertificatesPath)) {
        const data = fs.readFileSync(acceptedCertificatesPath);
        acceptedCertificates = JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load accepted certificates:', error);
    }
  }

  // Save accepted certificates to file
  function saveAcceptedCertificates() {
    try {
      fs.writeFileSync(acceptedCertificatesPath, JSON.stringify(acceptedCertificates, null, 2));
    } catch (error) {
      console.error('Failed to save accepted certificates:', error);
    }
  }

  loadAcceptedCertificates();

  // Handle certificate errors
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
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
          detail: `The certificate presented by the site does not match the one previously accepted.\n\nError: ${error}\n\nCertificate:\nIssuer: ${certificate.issuerName}\nSubject: ${certificate.subjectName}\nFingerprint: ${certFingerprint}`
        };
  
        dialog.showMessageBox(null, options).then(result => {
          if (result.response === 1) { // Accept
            acceptedCertificates[domain] = certFingerprint;
            saveAcceptedCertificates();
            callback(true);
          } else { // Decline
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
      detail: `Error: ${error}\n\nCertificate:\nIssuer: ${certificate.issuerName}\nSubject: ${certificate.subjectName}\nFingerprint: ${certFingerprint}`
    };
  
    dialog.showMessageBox(null, options).then(result => {
      if (result.response === 1) { // Accept
        acceptedCertificates[domain] = certFingerprint;
        saveAcceptedCertificates();
        callback(true);
      } else { // Decline
        callback(false);
      }
    });
  });

  app.on('before-quit', () => {
    // Clear caches
    mainWindow.webContents.session.clearCache();
    mainWindow.webContents.session.clearStorageData({
      storages: ['appcache', 'shadercache', 'serviceworkers']
    });
    
    // Release memory
    global.gc && global.gc();
  
    process.exit(0);
  });

  createMainWindow();

  

  // Check for app updates
  // checkForUpdates();

  // blocker.enableBlockingInSession(mainWindow.webContents.session);



  registerToggleShortcut();
  registerShortcutLock();


  app.setName('InstantCognition');




  // Create tray icon for the windows system tray / macos tray
  // Define the icon path based on the platform
  let iconPath = path.join(__dirname, 'assets/icon');
  if (os.platform() === 'win32') {
    iconPath += '.ico';  // Use .ico format for Windows
    const trayIcon = nativeImage.createFromPath(iconPath);
    tray = new Tray(trayIcon);
  } else {
    iconPath += '.png';  // Use .png format for macOS
    const trayIcon = nativeImage.createFromPath(iconPath);
    tray = new Tray(trayIcon.resize({ width: 22, height: 22 }));
  }

  mainWindow.webContents.on('did-attach-webview', (_, contents) => {
    contents.on('context-menu', (_, params) => {
      const contextMenuRightClick = Menu.buildFromTemplate([
        {
          label: 'Copy',
          role: 'copy'
        },
        {
          label: 'Paste',
          role: 'paste'
        },
        {
          label: 'Search / Open',
          click: () => {
            let searchText = contents.executeJavaScript('window.getSelection().toString().trim()');
            searchText.then((result) => {
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
            }).catch((error) => { console.error(error); });
          }
        },
        {
          label: 'Find',
          accelerator: 'Ctrl+F', // Display the keyboard shortcut in the menu
          click: () => {
            // Send IPC message to show the find bar
            mainWindow.webContents.send('toggleFindBar');
          }
        },
        { type: 'separator' },
        {
          label: 'Back',
          click: () => {
            mainWindow.webContents.send('navigateBackActive');
        }},
        {
          label: 'Forward',
          click: () => {
            mainWindow.webContents.send('navigateForwardActive');
        }},
        {
          label: 'Refresh',
          click: () => {
            mainWindow.webContents.send('refreshActive');
        }},
        {
          label: 'Home',
          click: () => {
            mainWindow.webContents.send('navigateHomeActive');
        }},
        { type: 'separator' },
        {
          label: 'Inspect',
          click: () => {
            contents.inspectElement(params.x, params.y);
          }
        },
        { type: 'separator' },
        { label: 'Reset View', click: () => { mainWindow.webContents.send('resetView'); } },
        {
          label: 'Toggle View',
          click: () => {
            mainWindow.webContents.send('toggleView');
        }},
        {
          label: 'Close Browser',
          click: () => {
            mainWindow.webContents.send('navigateHomeBrowser');
            mainWindow.webContents.send('closeBrowser');
        }},
        { type: 'separator' },
        { label: 'Toggle Cognitizer', click: () => { mainWindow.webContents.send('toggleCognitizerView'); } },
        { label: 'Toggle Browser', click: () => { mainWindow.webContents.send('toggleBrowserView'); } }
      ]);

      contextMenuRightClick.popup({
        window: mainWindow,
        x: params.x,
        y: params.y
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
      }
    },
    // add a seperator
    { type: 'separator' },
    {
      label: 'Toggle Lock (Ctrl+Alt+L)',
      click: () => {
      if (toggleLocked) {
        toggleLocked = false;
        registerToggleShortcut();
      } else {
        toggleLocked = true;
        unregisterToggleShortcut();
      }
      }
    },
    { type: 'separator' },
    {
      label: 'Reload',
      click: () => {
        app.relaunch();
        app.quit();
      }
    },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    },
  ]);

  tray.setToolTip('InstantCognition');
  tray.setContextMenu(contextMenuTrayIcon);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  // // Set up IPC handler for the extension button click
  // ipcMain.on('toggle-extension', async (event) => {
  //   try {
  //     const extensionId = 'ffppmilmeaekegkpckebkeahjgmhggpj'; // Replace with your extension ID
  //     const extensionPath = download(extensionId);
  //     const extension = await session.defaultSession.loadExtension(extensionPath);
  //     console.log('Extension loaded:', extension.id);
  //     event.reply('extension-loaded', true);
  //   } catch (error) {
  //     console.error('Failed to load extension:', error);
  //     event.reply('extension-loaded', false);
  //   }
  // });

  // // Add button click handler to preload.js
  // mainWindow.webContents.executeJavaScript(`
  //   document.getElementById('complexity').addEventListener('click', () => {
  //     window.ipcRenderer.send('toggle-extension');
  //   });
    
  //   window.ipcRenderer.on('extension-loaded', (event, success) => {
  //     if (success) {
  //       console.log('Extension loaded successfully');
  //     } else {
  //       console.log('Failed to load extension'); 
  //     }
  //   });
  // `);

  mainWindow.focus();

  // Create a menu template
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload',
          click: () => {
            app.relaunch();
            app.quit();
          }
        },
        {
          label: 'Quit',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        // { role: 'delete' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl + F', click: () => { mainWindow.webContents.send('toggleFindBar'); } },
        { label: 'Find Next', accelerator: 'CmdOrCtrl + G', click: () => { mainWindow.webContents.send('findBarForward'); } },
        { label: 'Find Previous', accelerator: 'Shift + CmdOrCtrl + G', click: () => { mainWindow.webContents.send('findBarBack'); } },
        { type: 'separator' },
        { role: 'selectAll' },
        { type: 'separator' },
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'toggleSpellChecker' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomin', accelerator: 'CmdOrCtrl + =' },
        { role: 'zoomout' },
        { role: 'resetzoom' },
        { type: 'separator' },
        { label: 'Reset View', click: () => { mainWindow.webContents.send('resetView'); } },
        { label: 'Toggle View', click: () => { mainWindow.webContents.send('toggleView'); } },
        { label: 'Close Browser', click: () => { mainWindow.webContents.send('closeBrowser'); } },
        { type: 'separator' },
        { label: 'Toggle Cognitizer', click: () => { mainWindow.webContents.send('toggleCognitizerView'); } },
        { label: 'Toggle Browser', click: () => { mainWindow.webContents.send('toggleBrowserView'); } },
        { type: 'separator' },
        { label: 'Toggle Lock (Ctrl+Alt+L)', click: () => {
          if (toggleLocked) {
            toggleLocked = false;
            registerToggleShortcut();
          } else {
            toggleLocked = true;
            unregisterToggleShortcut();
          }
        }},
        { role: 'togglefullscreen' },
        { role: 'toggledevtools' },
      ]
    },
    {
      label: 'Navigation',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => { mainWindow.webContents.send('navigateBackActive'); } },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => { mainWindow.webContents.send('navigateForwardActive'); } },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forcereload' },
      ]
    },
    {
      label: 'Window',
      role: 'windowMenu',
      submenu: [
        { label: 'Toggle Lock (Ctrl+Alt+L)', click: () => {
          if (toggleLocked) {
            toggleLocked = false;
            registerToggleShortcut();
          } else {
            toggleLocked = true;
            unregisterToggleShortcut();
          }
        }},
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'minimize' },
        { role: 'close' },
      ]
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
          }
        },
        {
          label: 'Create a Bug Report',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com/Sellitus/InstantCognition/issues');
          }
        },
        { type: 'separator' },
        {
          label: 'Reload InstantCognition',
          click: () => {
            app.relaunch();
            app.quit();
          }
        }
      ]
    }
  ];

  // Build the menu from the template
  const menu = Menu.buildFromTemplate(menuTemplate);

  // Set the application menu
  Menu.setApplicationMenu(menu);
});


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});




function cleanupEventListeners() {
  const webviews = document.querySelectorAll('webview');
  webviews.forEach(webview => {
      webview.removeEventListener('found-in-page', handleFoundInPage);
      webview.removeEventListener('dom-ready', () => {});
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanupEventListeners();
});

app.on('browser-window-created', (_, window) => {
  window.on('minimize', () => {
    window.webContents.setBackgroundThrottling(true);
  });
  
  window.on('restore', () => {
    window.webContents.setBackgroundThrottling(false);
  });
});

const ipcQueue = new Map();
const IPC_BATCH_INTERVAL = 16; // ms

function batchIPCSend(channel, data) {
  if (!ipcQueue.has(channel)) {
    ipcQueue.set(channel, []);
    setTimeout(() => {
      const batchedData = ipcQueue.get(channel);
      if (batchedData.length) {
        mainWindow.webContents.send(channel, batchedData);
        ipcQueue.delete(channel);
      }
    }, IPC_BATCH_INTERVAL);
  }
  ipcQueue.get(channel).push(data);
}



