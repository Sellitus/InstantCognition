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

    test('should have numbered space shortcuts', () => {
      for (let i = 1; i <= 10; i++) {
        expect(shortcutManager.defaultShortcuts.has(`space.select.${i}`)).toBe(true);
      }
    });

    test('should use Alt+Space as default toggle on macOS', () => {
      const originalPlatform = process.platform;

      Object.defineProperty(process, 'platform', { value: 'darwin' });
      shortcutManager.defaultShortcuts.clear();
      shortcutManager.initializeDefaults();
      expect(shortcutManager.defaultShortcuts.get('window.toggle').key).toBe('Alt+Space');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    test('should use CmdOrCtrl+Space as default toggle on non-macOS', () => {
      const originalPlatform = process.platform;

      Object.defineProperty(process, 'platform', { value: 'win32' });
      shortcutManager.defaultShortcuts.clear();
      shortcutManager.initializeDefaults();
      expect(shortcutManager.defaultShortcuts.get('window.toggle').key).toBe('CmdOrCtrl+Space');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
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

    test('should handle legacy format shortcuts (string values)', () => {
      // Legacy format uses plain strings; ShortcutManager converts to {key, description}
      const config = {
        settings: {
          shortcuts: {
            'window.toggle': 'CmdOrCtrl+Space',
            'window.lock': 'CmdOrCtrl+Alt+L'
          }
        }
      };

      shortcutManager.loadShortcuts(config);

      expect(shortcutManager.shortcuts.get('window.toggle').key).toBe('CmdOrCtrl+Space');
      expect(shortcutManager.shortcuts.get('window.lock').key).toBe('CmdOrCtrl+Alt+L');
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
      // F1 is already assigned to space.previous by default
      const result = shortcutManager.setShortcut('navigate.back', 'F1');
      
      expect(result.success).toBe(false);
      expect(result.conflicts).toContain('space.previous');
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
      // F1 is already assigned to space.previous by default
      const conflicts = shortcutManager.getConflicts('F1');
      expect(conflicts).toHaveLength(1);
      expect(conflicts).toContain('space.previous');
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
      expect(categories).toHaveProperty('space');
      expect(categories).toHaveProperty('view');
      expect(categories).toHaveProperty('window');
      expect(categories).toHaveProperty('find');
      expect(categories).toHaveProperty('zoom');
      
      expect(categories.navigate.length).toBeGreaterThan(0);
      expect(categories.space.length).toBeGreaterThan(0);
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
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    test('should distinguish Cmd from Ctrl on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      // metaKey (⌘) only → Cmd
      expect(shortcutManager.eventToShortcut({
        key: 'a', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false
      })).toBe('Cmd+A');

      // ctrlKey only → Ctrl
      expect(shortcutManager.eventToShortcut({
        key: 'a', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false
      })).toBe('Ctrl+A');

      // both → Cmd+Ctrl
      expect(shortcutManager.eventToShortcut({
        key: ' ', metaKey: true, ctrlKey: true, altKey: false, shiftKey: false
      })).toBe('Cmd+Ctrl+Space');
    });

    test('should use CmdOrCtrl on non-macOS platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      expect(shortcutManager.eventToShortcut({
        key: 'a', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false
      })).toBe('CmdOrCtrl+A');

      // metaKey (Win key) on Windows also maps to CmdOrCtrl
      expect(shortcutManager.eventToShortcut({
        key: 'z', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true
      })).toBe('CmdOrCtrl+Z');
    });

    test('should handle modifier combinations on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      expect(shortcutManager.eventToShortcut({
        key: 'z', ctrlKey: false, altKey: true, shiftKey: true, metaKey: true
      })).toBe('Cmd+Alt+Shift+Z');
    });

    test('should handle modifier combinations on non-macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      expect(shortcutManager.eventToShortcut({
        key: 'z', ctrlKey: true, altKey: true, shiftKey: true, metaKey: false
      })).toBe('CmdOrCtrl+Alt+Shift+Z');
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

  describe('normalizeKey - cross-format conflict detection', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    test('on macOS, Cmd+X and CmdOrCtrl+X should normalize to the same key', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      expect(shortcutManager.normalizeKey('Cmd+Space')).toBe(
        shortcutManager.normalizeKey('CmdOrCtrl+Space')
      );
    });

    test('on macOS, Ctrl+X should be distinct from Cmd+X', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      expect(shortcutManager.normalizeKey('Ctrl+Space')).not.toBe(
        shortcutManager.normalizeKey('Cmd+Space')
      );
    });

    test('on Windows, Ctrl+X and CmdOrCtrl+X should normalize to the same key', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      expect(shortcutManager.normalizeKey('Ctrl+Space')).toBe(
        shortcutManager.normalizeKey('CmdOrCtrl+Space')
      );
    });
  });

  describe('VALID_KEYS', () => {
    test('should export a non-empty array of valid key names', () => {
      const { VALID_KEYS } = require('../../../../renderer/utils/shortcuts');
      expect(Array.isArray(VALID_KEYS)).toBe(true);
      expect(VALID_KEYS.length).toBeGreaterThan(40);
      expect(VALID_KEYS).toContain('Space');
      expect(VALID_KEYS).toContain('A');
      expect(VALID_KEYS).toContain('F1');
      expect(VALID_KEYS).toContain('Enter');
      expect(VALID_KEYS).toContain('Left');
    });
  });

  describe('parseShortcutString', () => {
    test('should parse modifier+key combos', () => {
      expect(shortcutManager.parseShortcutString('Cmd+Space')).toEqual({
        modifiers: ['Cmd'], key: 'Space'
      });
      expect(shortcutManager.parseShortcutString('CmdOrCtrl+Alt+L')).toEqual({
        modifiers: ['CmdOrCtrl', 'Alt'], key: 'L'
      });
      expect(shortcutManager.parseShortcutString('Ctrl+Shift+Z')).toEqual({
        modifiers: ['Ctrl', 'Shift'], key: 'Z'
      });
    });

    test('should parse key-only shortcuts', () => {
      expect(shortcutManager.parseShortcutString('F3')).toEqual({
        modifiers: [], key: 'F3'
      });
      expect(shortcutManager.parseShortcutString('Space')).toEqual({
        modifiers: [], key: 'Space'
      });
    });

    test('should be case-insensitive', () => {
      expect(shortcutManager.parseShortcutString('cmd+space')).toEqual({
        modifiers: ['Cmd'], key: 'Space'
      });
      expect(shortcutManager.parseShortcutString('SHIFT+A')).toEqual({
        modifiers: ['Shift'], key: 'A'
      });
    });

    test('should return null for invalid input', () => {
      expect(shortcutManager.parseShortcutString('')).toBeNull();
      expect(shortcutManager.parseShortcutString('InvalidKey')).toBeNull();
      expect(shortcutManager.parseShortcutString('Cmd+')).toBeNull();
    });

    test('should handle modifiers-only as null (no key)', () => {
      expect(shortcutManager.parseShortcutString('Cmd')).toBeNull();
      expect(shortcutManager.parseShortcutString('Cmd+Alt')).toBeNull();
    });

    test('should handle Command and Control aliases', () => {
      expect(shortcutManager.parseShortcutString('Command+Space')).toEqual({
        modifiers: ['Cmd'], key: 'Space'
      });
      expect(shortcutManager.parseShortcutString('Control+Space')).toEqual({
        modifiers: ['Ctrl'], key: 'Space'
      });
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

  describe('panel + palette defaults', () => {
    test('every hardcoded panel shortcut is a registry default, so Settings lists it', () => {
      shortcutManager.loadShortcuts({ settings: {} });
      const actions = shortcutManager.getAllShortcuts().map((s) => s.action);
      for (const action of [
        'palette.toggle', 'tab.new', 'tab.close', 'panel.chat', 'panel.library',
        'panel.extensions', 'panel.notifications', 'app.settings', 'urlbar.focus', 'chat.council',
      ]) {
        expect(actions).toContain(action);
      }
    });

    test('no two defaults claim the same key', () => {
      shortcutManager.loadShortcuts({ settings: {} });
      const seen = new Map();
      for (const s of shortcutManager.getAllShortcuts()) {
        const key = shortcutManager.normalizeKey(s.key);
        expect(seen.get(key)).toBeUndefined();
        seen.set(key, s.action);
      }
    });

    test('INPUT_SAFE_ACTIONS only names actions that exist', () => {
      const { INPUT_SAFE_ACTIONS } = require('../../../../renderer/utils/shortcuts');
      shortcutManager.loadShortcuts({ settings: {} });
      const actions = new Set(shortcutManager.getAllShortcuts().map((s) => s.action));
      for (const action of INPUT_SAFE_ACTIONS) expect(actions.has(action)).toBe(true);
    });
  });

  describe('view.flip (Mod+E)', () => {
    const originalPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    // Same lookup renderer.js runs on keydown: event → shortcut → normalized match.
    function actionFor(event) {
      const key = shortcutManager.normalizeKey(shortcutManager.eventToShortcut(event));
      const match = shortcutManager.getAllShortcuts().find((s) => shortcutManager.normalizeKey(s.key) === key);
      return match ? match.action : null;
    }
    const press = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

    test('defaults to CmdOrCtrl+E and Cmd+E on macOS resolves to it', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      shortcutManager.loadShortcuts({ settings: {} });
      expect(shortcutManager.getShortcut('view.flip').key).toBe('CmdOrCtrl+E');
      expect(actionFor(press('e', { metaKey: true }))).toBe('view.flip');
    });

    test('Ctrl+E resolves to it off macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      shortcutManager.loadShortcuts({ settings: {} });
      expect(actionFor(press('e', { ctrlKey: true }))).toBe('view.flip');
    });

    test('a remap moves it and frees the old chord', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      shortcutManager.loadShortcuts({ settings: { shortcuts: { 'view.flip': { key: 'CmdOrCtrl+Alt+J', description: 'Flip' } } } });
      expect(actionFor(press('j', { metaKey: true, altKey: true }))).toBe('view.flip');
      expect(actionFor(press('e', { metaKey: true }))).not.toBe('view.flip');
    });

    test('runs inside text fields, like panel.chat', () => {
      const { INPUT_SAFE_ACTIONS } = require('../../../../renderer/utils/shortcuts');
      expect(INPUT_SAFE_ACTIONS.has('view.flip')).toBe(true);
      expect(INPUT_SAFE_ACTIONS.has('panel.chat')).toBe(true);
    });

    test('Cmd+Shift+E stays panel.extensions', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      shortcutManager.loadShortcuts({ settings: {} });
      expect(actionFor(press('E', { metaKey: true, shiftKey: true }))).toBe('panel.extensions');
    });
  });

  // Recording functionality removed — recording is now handled directly in SettingsMenu.js
});
describe('formatShortcut', () => {
  const { formatShortcut } = require('../../../../renderer/utils/shortcuts');

  test('macOS renders modifier glyphs with no separators', () => {
    expect(formatShortcut('CmdOrCtrl+Shift+A', 'darwin')).toBe('⌘⇧A');
    expect(formatShortcut('Alt+Shift+A', 'darwin')).toBe('⌥⇧A');
    expect(formatShortcut('CmdOrCtrl+,', 'darwin')).toBe('⌘,');
  });

  test('other platforms spell modifiers out joined by +', () => {
    expect(formatShortcut('CmdOrCtrl+Shift+Y', 'win32')).toBe('Ctrl+Shift+Y');
    expect(formatShortcut('Option+F', 'linux')).toBe('Alt+F');
  });

  test('a bare key passes through; empty or non-string input yields an empty string', () => {
    expect(formatShortcut('F8', 'darwin')).toBe('F8');
    expect(formatShortcut('', 'darwin')).toBe('');
    expect(formatShortcut(undefined, 'win32')).toBe('');
  });
});
