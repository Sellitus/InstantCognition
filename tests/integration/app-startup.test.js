// Test app startup and window visibility
const { Application } = require('spectron');
const path = require('path');
const fs = require('fs');

describe('App Startup', () => {
  let app;

  beforeEach(async () => {
    // Path to electron executable
    const electronPath = require('electron');
    const appPath = path.join(__dirname, '../..');
    
    app = new Application({
      path: electronPath,
      args: [appPath],
      env: {
        ELECTRON_IS_DEV: '0',
        NODE_ENV: 'test'
      }
    });
    
    await app.start();
  });

  afterEach(async () => {
    if (app && app.isRunning()) {
      await app.stop();
    }
  });

  test('should start the application', async () => {
    expect(app.isRunning()).toBe(true);
  });

  test('should create main window', async () => {
    const windowCount = await app.client.getWindowCount();
    expect(windowCount).toBeGreaterThan(0);
  });

  test('should show window on ready', async () => {
    // Wait for window to be ready
    await app.client.waitUntilWindowLoaded();
    
    const isVisible = await app.browserWindow.isVisible();
    expect(isVisible).toBe(true);
  });

  test('should create tray icon', async () => {
    // Check if tray was created (via IPC)
    const hasTray = await app.electron.ipcRenderer.sendSync('has-tray');
    expect(hasTray).toBe(true);
  });

  test('should load index.html', async () => {
    const title = await app.client.getTitle();
    expect(title).toBeTruthy();
    
    const url = await app.client.getUrl();
    expect(url).toContain('index.html');
  });

  test('should register keyboard shortcuts', async () => {
    const shortcuts = await app.electron.globalShortcut.getRegisteredShortcuts();
    expect(shortcuts).toContain('CmdOrCtrl+Space');
  });

  test('should have correct window dimensions', async () => {
    const bounds = await app.browserWindow.getBounds();
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });

  test('should load required assets', async () => {
    // Check if icon files exist
    const iconPathWin = path.join(__dirname, '../../assets/icon.ico');
    const iconPathMac = path.join(__dirname, '../../assets/icon.png');
    
    expect(fs.existsSync(iconPathWin) || fs.existsSync(iconPathMac)).toBe(true);
  });
});