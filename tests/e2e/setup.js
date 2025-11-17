const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Test configuration
const TEST_CONFIG = {
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
};

class ElectronAppHelper {
  constructor() {
    this.app = null;
    this.window = null;
    this.context = null;
  }

  async launch(options = {}) {
    // Create test config directory
    const testConfigDir = path.join(os.tmpdir(), 'instant-cognition-test');
    if (!fs.existsSync(testConfigDir)) {
      fs.mkdirSync(testConfigDir, { recursive: true });
    }

    // Write test config
    const configPath = path.join(testConfigDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(TEST_CONFIG, null, 2));

    // Set environment variable to use test config
    process.env.INSTANT_COGNITION_CONFIG_PATH = configPath;

    // Launch Electron app
    this.app = await electron.launch({
      args: [path.join(__dirname, '../../index.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INSTANT_COGNITION_CONFIG_PATH: configPath,
      },
      ...options,
    });

    // Get the first window
    this.window = await this.app.firstWindow();

    // Wait for app to be ready
    await this.window.waitForLoadState('domcontentloaded');
    await this.window.waitForTimeout(1000); // Give app time to initialize

    return this;
  }

  async close() {
    if (this.app) {
      await this.app.close();
    }

    // Clean up test config
    const testConfigDir = path.join(os.tmpdir(), 'instant-cognition-test');
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    }
  }

  async screenshot(name) {
    if (this.window) {
      const screenshotPath = path.join(__dirname, 'screenshots', `${name}.png`);
      const screenshotDir = path.dirname(screenshotPath);

      if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
      }

      await this.window.screenshot({ path: screenshotPath });
      return screenshotPath;
    }
  }

  async getWebview(id) {
    return await this.window.$(`webview#${id}`);
  }

  async waitForWebview(id, timeout = 5000) {
    return await this.window.waitForSelector(`webview#${id}`, { timeout });
  }

  async clickCognitizer(id) {
    await this.window.click(`#${id}button`);
  }

  async toggleMenu() {
    await this.window.click('#toggle-button');
  }

  async navigateBack() {
    await this.window.click('#backbutton');
  }

  async navigateForward() {
    await this.window.click('#forwardbutton');
  }

  async refresh() {
    await this.window.click('#refreshbutton');
  }

  async navigateHome() {
    await this.window.click('#homebutton');
  }

  async toggleMultiCognition() {
    await this.window.click('#multi-cognitionbutton');
  }

  async toggleFindBar() {
    await this.window.click('#find-barbutton');
  }

  async toggleBrowserView() {
    await this.window.click('#browser-viewbutton');
  }

  async toggleCognitizerView() {
    await this.window.click('#cognitizer-viewbutton');
  }

  async toggleExternalLinks() {
    await this.window.click('#open-link-externalbutton');
  }

  async findInPage(text) {
    await this.toggleFindBar();
    await this.window.fill('#find-input', text);
    await this.window.keyboard.press('Enter');
  }

  async findNext() {
    await this.window.click('#find-next');
  }

  async findPrevious() {
    await this.window.click('#find-previous');
  }

  async closeFindBar() {
    await this.window.click('#find-close');
  }

  async openSettings() {
    await this.toggleMenu();
    // The config button is now in the settings menu
    await this.window.click('#open-config-button');
  }

  async restartApp() {
    await this.toggleMenu();
    // Use the restart button in the settings menu instead
    await this.window.click('#apply-restart-button');
  }

  async getCognitizerCount() {
    const cognitizers = await this.window.$$('.cognitizer-dropdown-section > div');
    return cognitizers.length;
  }

  async isWebviewActive(id) {
    const webview = await this.getWebview(id);
    if (!webview) return false;

    const isActive = await webview.evaluate((el) => el.classList.contains('active'));
    const isVisible = await webview.evaluate((el) => el.style.display !== 'none');

    return isActive && isVisible;
  }

  async getActiveWebviews() {
    const webviews = await this.window.$$('webview.active');
    return webviews;
  }

  async simulateMemoryPressure() {
    await this.window.evaluate(() => {
      if (window.electron) {
        window.electron.send('memory-pressure', 'critical');
      }
    });
  }

  async simulateNetworkOffline() {
    await this.window.context().setOffline(true);
  }

  async simulateNetworkOnline() {
    await this.window.context().setOffline(false);
  }

  async getMemoryUsage() {
    return await this.app.evaluate(() => process.memoryUsage());
  }

  async waitForEvent(eventName, timeout = 5000) {
    return await this.window.evaluate((name) => {
      return new Promise((resolve) => {
        window.addEventListener(name, resolve, { once: true });
      });
    }, eventName);
  }

  async typeInWebview(webviewId, text) {
    const webview = await this.getWebview(webviewId);
    if (webview) {
      await webview.focus();
      await this.window.keyboard.type(text);
    }
  }

  async pressKey(key) {
    await this.window.keyboard.press(key);
  }

  async pressShortcut(shortcut) {
    const keys = shortcut.split('+');
    const modifiers = [];
    let key = '';

    keys.forEach((k) => {
      switch (k.toLowerCase()) {
        case 'cmd':
        case 'command':
        case 'meta':
          modifiers.push('Meta');
          break;
        case 'ctrl':
        case 'control':
          modifiers.push('Control');
          break;
        case 'alt':
          modifiers.push('Alt');
          break;
        case 'shift':
          modifiers.push('Shift');
          break;
        default:
          key = k;
      }
    });

    // Press modifiers
    for (const modifier of modifiers) {
      await this.window.keyboard.down(modifier);
    }

    // Press key
    await this.window.keyboard.press(key);

    // Release modifiers
    for (const modifier of modifiers.reverse()) {
      await this.window.keyboard.up(modifier);
    }
  }
}

module.exports = {
  ElectronAppHelper,
  TEST_CONFIG,
};
