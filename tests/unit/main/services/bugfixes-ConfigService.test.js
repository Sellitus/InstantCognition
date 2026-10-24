const path = require('path');
const fs = require('fs');
const os = require('os');

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock/userData'),
    isPackaged: false,
  },
}));

let configService;
let tmpDir;
let configPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-config-bugfix-'));
  configPath = path.join(tmpDir, 'config.json');

  jest.resetModules();
  jest.mock('electron', () => ({
    app: {
      getPath: jest.fn(() => '/mock/userData'),
      isPackaged: false,
    },
  }));

  configService = require('../../../../main/services/ConfigService');
  configService._configPath = configPath;
  configService.config = null;
  configService._saveTimer = null;
  configService.removeAllListeners();
});

afterEach(() => {
  if (configService && configService._saveTimer) {
    clearTimeout(configService._saveTimer);
    configService._saveTimer = null;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

describe('ConfigService bug fixes', () => {
  // ================================================================
  // HIGH #1: set() crashes when intermediate path value is null
  // Spec: typeof null === 'object' in JS, so null intermediates passed
  // the old guard and caused TypeError on next property access.
  // Fix: use == null to catch both null and undefined.
  // ================================================================
  describe('HIGH: set() crash on null intermediate values', () => {
    test('set does not crash when intermediate path value is null', () => {
      configService.loadConfig();
      // Set an intermediate to null
      configService.config.settings.shortcuts = null;

      expect(() => {
        configService.set('settings.shortcuts.window.toggle', 'Ctrl+Space');
      }).not.toThrow();

      // The value should be set correctly
      expect(configService.get('settings.shortcuts.window.toggle')).toBe('Ctrl+Space');
    });

    test('set replaces null intermediate with object and sets value', () => {
      configService.loadConfig();
      configService.config.brand = null;

      configService.set('brand.new.key', 'value');
      expect(configService.get('brand.new.key')).toBe('value');
    });

    test('set still creates intermediate objects when they are undefined', () => {
      configService.loadConfig();

      configService.set('completely.new.deep.path', 42);
      expect(configService.get('completely.new.deep.path')).toBe(42);
    });

    test('set does not crash on deeply nested null', () => {
      configService.loadConfig();
      configService.config.a = { b: null };

      expect(() => {
        configService.set('a.b.c.d', 'deep');
      }).not.toThrow();

      expect(configService.get('a.b.c.d')).toBe('deep');
    });
  });
});
