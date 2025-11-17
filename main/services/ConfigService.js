const { app } = require('electron');
const path = require('path');
const fs = require('fs');

class ConfigService {
  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'config.json');
    this.config = null;
    this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        this.config = JSON.parse(data);
        console.log('[ConfigService] Config loaded successfully');
      } else {
        console.log('[ConfigService] Config file not found, using defaults');
        this.config = this.getDefaultConfig();
        this.saveConfig();
      }
    } catch (error) {
      console.error('[ConfigService] Error loading config:', error);
      this.config = this.getDefaultConfig();
    }
  }

  getDefaultConfig() {
    return {
      sidebarCollapsed: false,
      rightSidebarCollapsed: false,
      promptSelectorMinimized: false,
      darkMode: false,
      theme: 'light',
      quickbuttonContainer: true,
      dualPane: false,
      blankLineAfterResponse: true,
      showSummarizeButton: true,
      recentColors: [],
      alwaysOnTop: false,
      chatLayout: 'default',
      lastMemoryCleanup: Date.now()
    };
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
      console.log('[ConfigService] Config saved successfully');
    } catch (error) {
      console.error('[ConfigService] Error saving config:', error);
    }
  }

  get(key, defaultValue = null) {
    if (!this.config) {
      this.loadConfig();
    }
    return this.config.hasOwnProperty(key) ? this.config[key] : defaultValue;
  }

  set(key, value) {
    if (!this.config) {
      this.loadConfig();
    }
    this.config[key] = value;
    this.saveConfig();
  }

  update(updates) {
    if (!this.config) {
      this.loadConfig();
    }
    Object.assign(this.config, updates);
    this.saveConfig();
  }

  getAll() {
    if (!this.config) {
      this.loadConfig();
    }
    return { ...this.config };
  }

  reset() {
    this.config = this.getDefaultConfig();
    this.saveConfig();
  }

  // Helper methods for specific config values
  getSidebarState() {
    return {
      left: this.get('sidebarCollapsed', false),
      right: this.get('rightSidebarCollapsed', false)
    };
  }

  setSidebarState(left, right) {
    this.update({
      sidebarCollapsed: left,
      rightSidebarCollapsed: right
    });
  }

  getTheme() {
    return this.get('theme', 'light');
  }

  setTheme(theme) {
    this.set('theme', theme);
    this.set('darkMode', theme === 'dark');
  }

  isAlwaysOnTop() {
    return this.get('alwaysOnTop', false);
  }

  setAlwaysOnTop(value) {
    this.set('alwaysOnTop', value);
  }
}

// Export singleton instance
module.exports = new ConfigService();