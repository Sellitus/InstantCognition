const shortcutManager = require('../../../../renderer/utils/shortcuts');

describe('ShortcutManager', () => {
  beforeEach(() => {
    // Reset shortcuts before each test
    shortcutManager.shortcuts.clear();
    shortcutManager.conflictMap.clear();
    shortcutManager.recording = false;
    shortcutManager.initializeDefaults();
  });

  describe('Initialization', () => {
    test('should initialize with default shortcuts', () => {
      expect(shortcutManager.defaultShortcuts.size).toBeGreaterThan(0);
      expect(shortcutManager.defaultShortcuts.has('navigate.back')).toBe(true);
      expect(shortcutManager.defaultShortcuts.get('navigate.back').key).toBe('F3');
    });

    test('should have all navigation shortcuts', () => {
      expect(shortcutManager.defaultShortcuts.has('navigate.back')).toBe(true);
      expect(shortcutManager.defaultShortcuts.has('navigate.forward')).toBe(true);
      expect(shortcutManager.defaultShortcuts.has('navigate.refresh')).toBe(true);
      expect(shortcutManager.defaultShortcuts.has('navigate.home')).toBe(true);
    });

    test('should have numbered cognitizer shortcuts', () => {
      for (let i = 1; i <= 10; i++) {
        expect(shortcutManager.defaultShortcuts.has(`cognitizer.select.${i}`)).toBe(true);
      }
    });
  });

  describe('loadShortcuts', () => {
    test('should load user-defined shortcuts from config', () => {
      const config = {
        settings: {
          shortcuts: {
            'navigate.back': { key: 'Alt+Left', description: 'Custom Back' },
            'navigate.forward': { key: 'Alt+Right', description: 'Custom Forward' }
          }
        }
      };

      shortcutManager.loadShortcuts(config);
      
      expect(shortcutManager.shortcuts.get('navigate.back').key).toBe('Alt+Left');
      expect(shortcutManager.shortcuts.get('navigate.forward').key).toBe('Alt+Right');
    });

    test('should handle legacy format shortcuts', () => {
      const config = {
        settings: {
          shortcuts: {
            toggleShortcut: 'CmdOrCtrl+Space',
            shortcutLock: 'CmdOrCtrl+Alt+L'
          }
        }
      };

      shortcutManager.loadShortcuts(config);
      
      expect(shortcutManager.shortcuts.get('toggleShortcut').key).toBe('CmdOrCtrl+Space');
      expect(shortcutManager.shortcuts.get('shortcutLock').key).toBe('CmdOrCtrl+Alt+L');
    });

    test('should fill missing shortcuts with defaults', () => {
      const config = {
        settings: {
          shortcuts: {
            'navigate.back': { key: 'Alt+Left', description: 'Custom Back' }
          }
        }
      };

      shortcutManager.loadShortcuts(config);
      
      // Custom shortcut should be loaded
      expect(shortcutManager.shortcuts.get('navigate.back').key).toBe('Alt+Left');
      // Default should be filled for missing
      expect(shortcutManager.shortcuts.get('navigate.forward').key).toBe('F4');
    });
  });

  describe('normalizeKey', () => {
    test('should normalize key combinations', () => {
      // Keys are sorted alphabetically, so 'a' comes before 'ctrl'
      expect(shortcutManager.normalizeKey('CmdOrCtrl+A')).toMatch(/^a\+(cmd|ctrl)$/);
      expect(shortcutManager.normalizeKey('Shift+Alt+F1')).toBe('alt+f1+shift');
      expect(shortcutManager.normalizeKey('ctrl+shift+alt+z')).toBe('alt+ctrl+shift+z');
    });

    test('should handle platform-specific keys', () => {
      const originalPlatform = process.platform;
      
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      expect(shortcutManager.normalizeKey('CmdOrCtrl+A')).toBe('a+cmd');
      
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(shortcutManager.normalizeKey('CmdOrCtrl+A')).toBe('a+ctrl');
      
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });

  describe('setShortcut', () => {
    beforeEach(() => {
      shortcutManager.loadShortcuts({ settings: {} });
    });

    test('should set a new shortcut successfully', () => {
      const result = shortcutManager.setShortcut('navigate.back', 'Alt+Left', 'Go Back');
      
      expect(result.success).toBe(true);
      expect(shortcutManager.shortcuts.get('navigate.back').key).toBe('Alt+Left');
      expect(shortcutManager.shortcuts.get('navigate.back').description).toBe('Go Back');
    });

    test('should detect conflicts', () => {
      // F1 is already assigned to cognitizer.previous by default
      const result = shortcutManager.setShortcut('navigate.back', 'F1');
      
      expect(result.success).toBe(false);
      expect(result.conflicts).toContain('cognitizer.previous');
    });

    test('should allow same shortcut for same action', () => {
      // F3 is already the default for navigate.back
      const result = shortcutManager.setShortcut('navigate.back', 'F3');
      
      expect(result.success).toBe(true);
    });
  });

  describe('resetShortcut', () => {
    beforeEach(() => {
      shortcutManager.loadShortcuts({ settings: {} });
    });

    test('should reset shortcut to default', () => {
      shortcutManager.setShortcut('navigate.back', 'Alt+Left');
      shortcutManager.resetShortcut('navigate.back');
      
      expect(shortcutManager.shortcuts.get('navigate.back').key).toBe('F3');
    });
  });

  describe('getConflicts', () => {
    beforeEach(() => {
      shortcutManager.loadShortcuts({ settings: {} });
    });

    test('should find all conflicting shortcuts', () => {
      // F1 is already assigned to cognitizer.previous by default
      const conflicts = shortcutManager.getConflicts('F1');
      expect(conflicts).toHaveLength(1);
      expect(conflicts).toContain('cognitizer.previous');
    });
  });

  describe('getAllShortcuts', () => {
    test('should return all shortcuts sorted by description', () => {
      shortcutManager.loadShortcuts({ settings: {} });
      const shortcuts = shortcutManager.getAllShortcuts();
      
      expect(shortcuts.length).toBeGreaterThan(0);
      expect(shortcuts[0]).toHaveProperty('action');
      expect(shortcuts[0]).toHaveProperty('key');
      expect(shortcuts[0]).toHaveProperty('description');
      expect(shortcuts[0]).toHaveProperty('isDefault');
      
      // Check sorting
      for (let i = 1; i < shortcuts.length; i++) {
        expect(shortcuts[i].description.localeCompare(shortcuts[i-1].description)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('getShortcutsByCategory', () => {
    test('should categorize shortcuts correctly', () => {
      shortcutManager.loadShortcuts({ settings: {} });
      const categories = shortcutManager.getShortcutsByCategory();
      
      expect(categories).toHaveProperty('navigate');
      expect(categories).toHaveProperty('cognitizer');
      expect(categories).toHaveProperty('view');
      expect(categories).toHaveProperty('window');
      expect(categories).toHaveProperty('find');
      expect(categories).toHaveProperty('zoom');
      
      expect(categories.navigate.length).toBeGreaterThan(0);
      expect(categories.cognitizer.length).toBeGreaterThan(0);
    });
  });

  describe('isDefault', () => {
    beforeEach(() => {
      shortcutManager.loadShortcuts({ settings: {} });
    });

    test('should correctly identify default shortcuts', () => {
      expect(shortcutManager.isDefault('navigate.back')).toBe(true);
      
      shortcutManager.setShortcut('navigate.back', 'Alt+Left');
      expect(shortcutManager.isDefault('navigate.back')).toBe(false);
      
      shortcutManager.resetShortcut('navigate.back');
      expect(shortcutManager.isDefault('navigate.back')).toBe(true);
    });
  });

  describe('eventToShortcut', () => {
    test('should convert keyboard event to shortcut string', () => {
      const event = {
        key: 'a',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false
      };
      
      expect(shortcutManager.eventToShortcut(event)).toBe('CmdOrCtrl+A');
    });

    test('should handle modifier combinations', () => {
      const event = {
        key: 'z',
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
        metaKey: false
      };
      
      expect(shortcutManager.eventToShortcut(event)).toBe('CmdOrCtrl+Alt+Shift+Z');
    });

    test('should handle special keys', () => {
      expect(shortcutManager.eventToShortcut({ key: ' ' })).toBe('Space');
      expect(shortcutManager.eventToShortcut({ key: 'ArrowLeft' })).toBe('Left');
      expect(shortcutManager.eventToShortcut({ key: 'Enter' })).toBe('Enter');
      expect(shortcutManager.eventToShortcut({ key: 'F1' })).toBe('F1');
    });

    test('should ignore unsupported keys', () => {
      expect(shortcutManager.eventToShortcut({ key: 'MediaPlayPause' })).toBe(null);
      expect(shortcutManager.eventToShortcut({ key: 'AudioVolumeUp' })).toBe(null);
    });
  });

  describe('searchShortcuts', () => {
    beforeEach(() => {
      shortcutManager.loadShortcuts({ settings: {} });
    });

    test('should search by action name', () => {
      const results = shortcutManager.searchShortcuts('navigate');
      
      expect(results.length).toBeGreaterThan(0);
      results.forEach(result => {
        expect(result.action.toLowerCase()).toContain('navigate');
      });
    });

    test('should search by description', () => {
      const results = shortcutManager.searchShortcuts('back');
      
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.description.toLowerCase().includes('back'))).toBe(true);
    });

    test('should search by key', () => {
      const results = shortcutManager.searchShortcuts('F3');
      
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.key === 'F3')).toBe(true);
    });

    test('should be case insensitive', () => {
      const results1 = shortcutManager.searchShortcuts('NAVIGATE');
      const results2 = shortcutManager.searchShortcuts('navigate');
      
      expect(results1.length).toBe(results2.length);
    });
  });

  describe('exportShortcuts', () => {
    test('should export shortcuts in correct format', () => {
      shortcutManager.loadShortcuts({ settings: {} });
      shortcutManager.setShortcut('navigate.back', 'Alt+Left');
      
      const exported = shortcutManager.exportShortcuts();
      
      expect(exported).toBeInstanceOf(Object);
      expect(exported['navigate.back']).toEqual({
        key: 'Alt+Left',
        description: expect.any(String)
      });
    });
  });

  describe('Recording functionality', () => {
    test('should start and stop recording', () => {
      const callback = jest.fn();
      
      expect(shortcutManager.recording).toBe(false);
      
      shortcutManager.startRecording(callback);
      expect(shortcutManager.recording).toBe(true);
      expect(shortcutManager.recordingCallback).toBe(callback);
      
      shortcutManager.stopRecording();
      expect(shortcutManager.recording).toBe(false);
      expect(shortcutManager.recordingCallback).toBe(null);
    });
  });
});