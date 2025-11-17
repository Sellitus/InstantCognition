// Mock configuration service for testing

const path = require('path');
const { createMockConfig } = require('./testUtils');

class MockConfigService {
  constructor(initialConfig = {}) {
    this.config = createMockConfig(initialConfig);
    this.configPath = path.join(process.cwd(), 'config.json');
    this.saveCallback = null;
  }

  load() {
    return Promise.resolve(this.config);
  }

  loadSync() {
    return this.config;
  }

  save(config) {
    this.config = { ...this.config, ...config };
    if (this.saveCallback) {
      this.saveCallback(this.config);
    }
    return Promise.resolve();
  }

  saveSync(config) {
    this.config = { ...this.config, ...config };
    if (this.saveCallback) {
      this.saveCallback(this.config);
    }
  }

  get(key) {
    return key ? this.config[key] : this.config;
  }

  set(key, value) {
    if (typeof key === 'object') {
      this.config = { ...this.config, ...key };
    } else {
      this.config[key] = value;
    }
  }

  reset() {
    this.config = createMockConfig();
  }

  onSave(callback) {
    this.saveCallback = callback;
  }

  // Helper methods for testing
  setTheme(theme) {
    this.config.theme = theme;
  }

  setHotkey(hotkey) {
    this.config.hotkey = hotkey;
  }

  addCognitizer(cognitizer) {
    this.config.cognitizers.push(cognitizer);
  }

  removeCognitizer(name) {
    this.config.cognitizers = this.config.cognitizers.filter((c) => c.name !== name);
  }

  setActiveCognitizer(name) {
    this.config.cognitizers.forEach((c) => {
      c.active = c.name === name;
    });
  }

  addBrowser(browser) {
    this.config.browsers.push(browser);
  }

  removeBrowser(name) {
    this.config.browsers = this.config.browsers.filter((b) => b.name !== name);
  }

  setActiveBrowser(name) {
    this.config.browsers.forEach((b) => {
      b.active = b.name === name;
    });
  }
}

// Factory function to create config service mock
function createConfigServiceMock(initialConfig = {}) {
  return new MockConfigService(initialConfig);
}

// Mock the config module
function mockConfigModule() {
  const mockService = createConfigServiceMock();

  jest.mock('../../configService', () => ({
    loadConfig: jest.fn(() => mockService.load()),
    saveConfig: jest.fn((config) => mockService.save(config)),
    getConfig: jest.fn((key) => mockService.get(key)),
    setConfig: jest.fn((key, value) => mockService.set(key, value)),
    configPath: mockService.configPath,
    __mockService: mockService,
  }));

  return mockService;
}

module.exports = {
  MockConfigService,
  createConfigServiceMock,
  mockConfigModule,
};
