// Configuration utility for managing app settings
const fs = require('fs');
const path = require('path');
const os = require('os');

class ConfigManager {
  constructor(configPath) {
    this.configPath = configPath || this.getDefaultConfigPath();
    this.config = this.loadConfig();
  }

  getDefaultConfigPath() {
    const homeDir = os.homedir();
    const platform = os.platform();

    if (platform === 'darwin') {
      return path.join(homeDir, '.instant-cognition', 'config.json');
    } else if (platform === 'win32') {
      return path.join(process.env.APPDATA || homeDir, 'InstantCognition', 'config.json');
    } else {
      return path.join(homeDir, '.config', 'instant-cognition', 'config.json');
    }
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading config:', error);
    }
    return this.getDefaultConfig();
  }

  getDefaultConfig() {
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
    };
  }

  saveConfig(config) {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      this.config = config;
      return true;
    } catch (error) {
      console.error('Error saving config:', error);
      return false;
    }
  }

  get(key) {
    return key ? this.config[key] : this.config;
  }

  set(key, value) {
    this.config[key] = value;
    return this.saveConfig(this.config);
  }

  merge(updates) {
    this.config = { ...this.config, ...updates };
    return this.saveConfig(this.config);
  }
}

module.exports = ConfigManager;
