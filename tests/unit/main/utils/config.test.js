// Tests for ConfigManager utility
describe('ConfigManager Tests', () => {
  let ConfigManager;
  let mockFs;
  let mockOs;
  let mockPath;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    // Mock fs
    mockFs = {
      existsSync: jest.fn(),
      readFileSync: jest.fn(),
      writeFileSync: jest.fn(),
      mkdirSync: jest.fn(),
    };

    // Mock os
    mockOs = {
      homedir: jest.fn(() => '/home/test'),
      platform: jest.fn(() => 'darwin'),
    };

    // Mock path - use actual path module
    mockPath = require('path');

    jest.doMock('fs', () => mockFs);
    jest.doMock('os', () => mockOs);
    jest.doMock('path', () => mockPath);

    ConfigManager = require('../../../../main/utils/config');
  });

  describe('Constructor and Initialization', () => {
    test('should create instance with default config path', () => {
      mockFs.existsSync.mockReturnValue(false);

      const config = new ConfigManager();

      expect(config.configPath).toBe('/home/test/.instant-cognition/config.json');
      expect(config.config).toEqual(
        expect.objectContaining({
          cognitizers: expect.any(Array),
          multiCognitionActive: false,
          activeCognitizer: 0,
        })
      );
    });

    test('should load existing config from file', () => {
      const existingConfig = {
        cognitizers: [{ name: 'Test', url: 'https://test.com', active: true }],
        multiCognitionActive: true,
        activeCognitizer: 1,
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingConfig));

      const config = new ConfigManager();

      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        '/home/test/.instant-cognition/config.json',
        'utf8'
      );
      expect(config.config).toEqual(existingConfig);
    });

    test('should handle config load errors gracefully', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const config = new ConfigManager();

      expect(config.config).toEqual(config.getDefaultConfig());
      expect(consoleSpy).toHaveBeenCalledWith('Error loading config:', expect.any(Error));

      consoleSpy.mockRestore();
    });
  });

  describe('Platform-specific Config Paths', () => {
    test('should use correct path on macOS', () => {
      mockOs.platform.mockReturnValue('darwin');
      mockOs.homedir.mockReturnValue('/Users/testuser');
      mockFs.existsSync.mockReturnValue(false);

      const config = new ConfigManager();

      expect(config.configPath).toBe('/Users/testuser/.instant-cognition/config.json');
    });

    test('should use correct path on Windows', () => {
      mockOs.platform.mockReturnValue('win32');
      mockOs.homedir.mockReturnValue('C:\\Users\\testuser');
      process.env.APPDATA = 'C:\\Users\\testuser\\AppData\\Roaming';
      mockFs.existsSync.mockReturnValue(false);

      const config = new ConfigManager();

      expect(config.configPath).toBe(
        mockPath.join('C:\\Users\\testuser\\AppData\\Roaming', 'InstantCognition', 'config.json')
      );
    });

    test('should use correct path on Linux', () => {
      mockOs.platform.mockReturnValue('linux');
      mockOs.homedir.mockReturnValue('/home/testuser');
      mockFs.existsSync.mockReturnValue(false);

      const config = new ConfigManager();

      expect(config.configPath).toBe('/home/testuser/.config/instant-cognition/config.json');
    });
  });

  describe('Config Operations', () => {
    let config;

    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(false);
      config = new ConfigManager();
    });

    test('should get entire config when no key provided', () => {
      const result = config.get();

      expect(result).toEqual(config.config);
    });

    test('should get specific config value by key', () => {
      const result = config.get('multiCognitionActive');

      expect(result).toBe(false);
    });

    test('should set config value and save', () => {
      mockFs.existsSync.mockReturnValue(true);

      config.set('multiCognitionActive', true);

      expect(config.config.multiCognitionActive).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        config.configPath,
        JSON.stringify(config.config, null, 2)
      );
    });

    test('should merge config updates', () => {
      mockFs.existsSync.mockReturnValue(true);

      const updates = {
        activeCognitizer: 2,
        openExternalLinks: true,
      };

      config.merge(updates);

      expect(config.config.activeCognitizer).toBe(2);
      expect(config.config.openExternalLinks).toBe(true);
      expect(config.config.multiCognitionActive).toBe(false); // unchanged
    });

    test('should create directory if it does not exist when saving', () => {
      mockFs.existsSync.mockReturnValue(false);

      config.saveConfig(config.config);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/home/test/.instant-cognition', {
        recursive: true,
      });
    });

    test('should handle save errors gracefully', () => {
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('Write error');
      });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const result = config.set('test', 'value');

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith('Error saving config:', expect.any(Error));

      consoleSpy.mockRestore();
    });
  });

  describe('Default Config', () => {
    test('should provide sensible defaults', () => {
      mockFs.existsSync.mockReturnValue(false);
      const config = new ConfigManager();
      const defaults = config.getDefaultConfig();

      expect(defaults.cognitizers).toHaveLength(3);
      expect(defaults.cognitizers[0].name).toBe('ChatGPT');
      expect(defaults.multiCognitionActive).toBe(false);
      expect(defaults.activeCognitizer).toBe(0);
      expect(defaults.openExternalLinks).toBe(false);
      expect(defaults.adBlockerEnabled).toBe(true);
      expect(defaults.hotkeyLocked).toBe(false);
      expect(defaults.windowBounds).toEqual({
        x: 100,
        y: 100,
        width: 1200,
        height: 800,
      });
    });
  });
});
