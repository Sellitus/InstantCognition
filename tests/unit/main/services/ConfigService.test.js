const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock electron at module level with static values
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock/userData'),
    isPackaged: false,
  },
}));

let configService;
let tmpDir;
let configPath;
const DEFAULT_BACKUP_CONFIG = {
  _version: 3,
  settings: { theme: 'light', shortcuts: {} },
  state: { windowBounds: { width: 800, height: 600 } },
  spaces: { custom1: { name: 'Recovered', url: 'https://example.com/', type: 'ai-service' } },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-config-test-'));
  configPath = path.join(tmpDir, 'config.json');

  // Clear module cache to get fresh singleton
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

describe('ConfigService', () => {
  describe('Loading', () => {
    test('returns default config when file does not exist', () => {
      const config = configService.loadConfig();
      expect(config).toBeDefined();
      expect(config.settings).toBeDefined();
      expect(config.state).toBeDefined();
      expect(config.spaces).toBeDefined();
    });

    test('returns default config when file is corrupt JSON', () => {
      fs.writeFileSync(configPath, 'not valid json {{{');
      const config = configService.loadConfig();
      expect(config).toBeDefined();
      expect(config.settings).toBeDefined();
    });

    test('loads existing config from disk', () => {
      const testConfig = {
        _version: 3,
        settings: { theme: 'light', shortcuts: {} },
        state: { windowBounds: { width: 800, height: 600 } },
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
      };
      fs.writeFileSync(configPath, JSON.stringify(testConfig));
      const config = configService.loadConfig();
      expect(config.settings.theme).toBe('light');
      expect(config.state.windowBounds.width).toBe(800);
    });

    test('merges missing keys from defaults into loaded config', () => {
      const minimal = {
        _version: 3,
        settings: { theme: 'light' },
        state: {},
        spaces: {},
      };
      fs.writeFileSync(configPath, JSON.stringify(minimal));
      const config = configService.loadConfig();
      expect(config.settings.theme).toBe('light');
      expect(config.settings.enableAdblocker).toBe(false);
      expect(config.settings.multiSpace).toBe(false);
    });

    test('runs migrateConfig on loaded data (old version gets fresh defaults)', () => {
      const legacy = {
        _version: 1,
        settings: {
          shortcuts: { toggleShortcut: 'Alt+X' },
        },
        state: {},
        baseUrls: {},
      };
      fs.writeFileSync(configPath, JSON.stringify(legacy));
      const config = configService.loadConfig();
      // Old configs (version < 3) get replaced with fresh defaults at current version
      const { CURRENT_CONFIG_VERSION } = require('../../../../shared/configDefaults');
      expect(config.spaces).toBeDefined();
      expect(config._version).toBe(CURRENT_CONFIG_VERSION);
    });

    test('emits "loaded" event after successful load', () => {
      const listener = jest.fn();
      configService.on('loaded', listener);
      configService.loadConfig();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('Saving', () => {
    test('writes valid JSON to config path', () => {
      configService.loadConfig();
      configService.flushSync();
      const data = fs.readFileSync(configPath, 'utf8');
      expect(() => JSON.parse(data)).not.toThrow();
    });

    test('debounces rapid saves (only writes once per 100ms)', (done) => {
      configService.loadConfig();
      const writeSpy = jest.spyOn(configService, '_writeSync');

      configService.set('settings.theme', 'light');
      configService.set('settings.theme', 'dark');
      configService.set('settings.theme', 'system');

      expect(writeSpy).not.toHaveBeenCalled();

      setTimeout(() => {
        expect(writeSpy).toHaveBeenCalledTimes(1);
        writeSpy.mockRestore();
        done();
      }, 150);
    });

    test('creates parent directory if it does not exist', () => {
      const deepPath = path.join(tmpDir, 'deep', 'nested', 'config.json');
      configService._configPath = deepPath;
      configService.loadConfig();
      configService.flushSync();
      expect(fs.existsSync(deepPath)).toBe(true);
    });

    test('emits "saved" event after write', () => {
      configService.loadConfig();
      const listener = jest.fn();
      configService.on('saved', listener);
      configService.flushSync();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    test('dispose clears pending save timers without writing', () => {
      configService.loadConfig();
      configService.set('settings.theme', 'light');

      expect(configService._saveTimer).toBeTruthy();

      configService.dispose();

      expect(configService._saveTimer).toBeNull();
    });
  });

  describe('Dot-notation access', () => {
    beforeEach(() => {
      configService.loadConfig();
    });

    test('get("settings.theme") returns nested value', () => {
      expect(configService.get('settings.theme')).toBe('dark');
    });

    test('get("nonexistent.path") returns undefined', () => {
      expect(configService.get('nonexistent.path')).toBeUndefined();
    });

    test('get("nonexistent.path", "default") returns default value', () => {
      expect(configService.get('nonexistent.path', 'fallback')).toBe('fallback');
    });

    test('set("settings.theme", "light") updates nested value', () => {
      configService.set('settings.theme', 'light');
      expect(configService.get('settings.theme')).toBe('light');
    });

    test('set triggers save', (done) => {
      const writeSpy = jest.spyOn(configService, '_writeSync');
      configService.set('settings.theme', 'light');
      setTimeout(() => {
        expect(writeSpy).toHaveBeenCalled();
        writeSpy.mockRestore();
        done();
      }, 150);
    });

    test('set emits "change" event with path, old value, new value', () => {
      const listener = jest.fn();
      configService.on('change', listener);
      configService.set('settings.theme', 'light');
      expect(listener).toHaveBeenCalledWith({
        path: 'settings.theme',
        oldValue: 'dark',
        newValue: 'light',
      });
    });

    test('get with deep nested path that does not exist', () => {
      expect(configService.get('a.b.c.d.e', 'nope')).toBe('nope');
    });

    test('set creates intermediate objects if needed', () => {
      configService.set('brand.new.path', 42);
      expect(configService.get('brand.new.path')).toBe(42);
    });

    test('set refuses segments that would shadow Object.prototype', () => {
      const writeSpy = jest.spyOn(configService, '_writeSync');
      configService.set('__proto__.polluted', 'yes');
      configService.set('a.constructor.prototype.polluted2', 'yes');
      configService.set('prototype', 'no');
      expect({}.polluted).toBeUndefined();
      expect({}.polluted2).toBeUndefined();
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('Batch operations', () => {
    beforeEach(() => {
      configService.loadConfig();
    });

    test('update({...}) merges multiple keys', () => {
      configService.update({ settings: { theme: 'light' } });
      expect(configService.get('settings.theme')).toBe('light');
      expect(configService.get('settings.enableAdblocker')).toBe(false);
    });

    test('update triggers single save, not one per key', (done) => {
      const writeSpy = jest.spyOn(configService, '_writeSync');
      configService.update({
        settings: { theme: 'light', enableAdblocker: true },
      });
      setTimeout(() => {
        expect(writeSpy).toHaveBeenCalledTimes(1);
        writeSpy.mockRestore();
        done();
      }, 150);
    });

    test('getAll() returns deep clone (mutations do not affect internal state)', () => {
      const clone = configService.getAll();
      clone.settings.theme = 'MUTATED';
      expect(configService.get('settings.theme')).not.toBe('MUTATED');
    });

    test('update() refuses __proto__/constructor/prototype keys (no prototype pollution)', () => {
      const writeSpy = jest.spyOn(configService, '_writeSync');
      configService.update({ __proto__: { polluted: 'yes' }, constructor: { prototype: { polluted2: 'yes' } } });
      expect({}.polluted).toBeUndefined();
      expect({}.polluted2).toBeUndefined();
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('Change notifications', () => {
    beforeEach(() => {
      configService.loadConfig();
    });

    test('emits "change:settings.theme" when theme changes', () => {
      const listener = jest.fn();
      configService.on('change:settings.theme', listener);
      configService.set('settings.theme', 'light');
      expect(listener).toHaveBeenCalledWith('light', 'dark');
    });

    test('does not emit when value is unchanged', () => {
      const listener = jest.fn();
      configService.on('change', listener);
      const currentTheme = configService.get('settings.theme');
      configService.set('settings.theme', currentTheme);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('replaceAll', () => {
    test('replaces entire config', (done) => {
      configService.loadConfig();
      const newConfig = {
        _version: 3,
        settings: { theme: 'replaced' },
        state: {},
        spaces: {},
      };
      configService.replaceAll(newConfig);
      expect(configService.get('settings.theme')).toBe('replaced');
      setTimeout(() => {
        const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(onDisk.settings.theme).toBe('replaced');
        done();
      }, 150);
    });

    test('ignores null/undefined input', () => {
      configService.loadConfig();
      const before = configService.getAll();
      configService.replaceAll(null);
      expect(configService.getAll()).toEqual(before);
    });
  });

  describe('reset', () => {
    test('resets to factory defaults', () => {
      configService.loadConfig();
      configService.set('settings.theme', 'light');
      configService.flushSync();
      configService.reset();
      expect(configService.get('settings.theme')).toBe('dark');
    });

    test('emits "reset" event', () => {
      configService.loadConfig();
      const listener = jest.fn();
      configService.on('reset', listener);
      configService.reset();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('Static path methods', () => {
    test('getConfigPath returns a string ending in config.json', () => {
      const p = configService.constructor.getConfigPath();
      expect(typeof p).toBe('string');
      expect(p.endsWith('config.json')).toBe(true);
    });

    test('getAcceptedCertsPath returns a string ending in trusted_certificates.json', () => {
      const p = configService.constructor.getAcceptedCertsPath();
      expect(typeof p).toBe('string');
      expect(p.endsWith('trusted_certificates.json')).toBe(true);
    });

    test('getAdblockerCachePath returns a string ending in adblocker_cache.bin', () => {
      const p = configService.constructor.getAdblockerCachePath();
      expect(typeof p).toBe('string');
      expect(p.endsWith('adblocker_cache.bin')).toBe(true);
    });

    test('migrateLegacyFile copies the first existing legacy file into the target path', () => {
      const legacyPath = path.join(tmpDir, 'legacy-config.json');
      const targetPath = path.join(tmpDir, 'migrated', 'config.json');

      fs.writeFileSync(legacyPath, '{"settings":{"theme":"light"}}');

      const migratedFrom = configService.constructor.migrateLegacyFile(targetPath, [legacyPath]);

      expect(migratedFrom).toBe(legacyPath);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('{"settings":{"theme":"light"}}');
    });
  });

  describe('Load status', () => {
    test('sets lastLoadStatus to recovered when loading from backup', () => {
      fs.writeFileSync(configPath, 'not valid json {{{');
      fs.writeFileSync(configPath + '.bak', JSON.stringify(DEFAULT_BACKUP_CONFIG));

      const config = configService.loadConfig();

      expect(configService.lastLoadStatus).toBe('recovered');
      expect(config.settings.theme).toBe('light');
    });

    test('sets lastLoadStatus to defaults when falling back after corruption', () => {
      fs.writeFileSync(configPath, 'not valid json {{{');

      const config = configService.loadConfig();

      expect(configService.lastLoadStatus).toBe('defaults');
      expect(config.settings.theme).toBe('dark');
    });
  });
});
