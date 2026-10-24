// Tests for keyboard shortcut functionality

describe('Keyboard Shortcuts Integration', () => {
  let shortcutManager;
  let mockEvent;

  beforeEach(() => {
    shortcutManager = require('../../../renderer/utils/shortcuts');
    
    // Reset shortcuts
    shortcutManager.shortcuts.clear();
    shortcutManager.loadShortcuts({ settings: {} });
    
    // Mock keyboard event
    mockEvent = {
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      key: '',
      keyCode: 0,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false
    };
  });

  // Recording tests removed — recording is now handled directly in SettingsMenu.js

  describe('Key Capture', () => {
    test('should capture key combination via eventToShortcut', () => {
      const event = {
        ...mockEvent,
        key: 'a',
        ctrlKey: true,
        type: 'keydown'
      };

      const key = shortcutManager.eventToShortcut(event);

      if (process.platform === 'darwin') {
        expect(key).toContain('Ctrl');
      } else {
        expect(key).toContain('CmdOrCtrl');
      }
      expect(key).toContain('A');
    });

    test('should handle Escape key', () => {
      const event = {
        ...mockEvent,
        key: 'Escape',
        type: 'keydown'
      };

      const key = shortcutManager.eventToShortcut(event);
      expect(key).toBe('Escape');
    });

    test('Cmd/Meta + Space serializes Space as a named key, not a literal space char', () => {
      const event = { ...mockEvent, key: ' ', metaKey: true, type: 'keydown' };
      const key = shortcutManager.eventToShortcut(event);
      const expected = process.platform === 'darwin' ? 'Cmd+Space' : 'CmdOrCtrl+Space';
      expect(key).toBe(expected);
    });
  });

  describe('Malformed config tolerance', () => {
    test('loadShortcuts ignores entries without a string .key', () => {
      shortcutManager.shortcuts.clear();
      // Simulates the orphan a prior bug left in user configs:
      // configBridge.set('settings.shortcuts.window.toggle', value) split on '.'
      // and wrote `shortcuts.window.toggle` (nested) instead of the flat
      // dotted key. The resulting entry has no `.key` and used to crash
      // updateConflictMap via normalizeKey(undefined).
      const config = {
        settings: {
          shortcuts: {
            'window.toggle': { key: 'Alt+Space', description: 'Toggle Window' },
            window: { toggle: 'Ctrl+ ' },
          },
        },
      };
      expect(() => shortcutManager.loadShortcuts(config)).not.toThrow();
      expect(shortcutManager.getShortcut('window.toggle').key).toBe('Alt+Space');
      // The orphan was dropped entirely (no shortcut named 'window').
      expect(shortcutManager.shortcuts.has('window')).toBe(false);
    });
  });

  describe('Shortcut Validation', () => {
    test('should detect conflicts correctly', () => {
      // F1 is assigned to space.previous by default
      const conflicts = shortcutManager.getConflicts('F1');
      
      expect(conflicts).toContain('space.previous');
    });

    test('should allow non-conflicting shortcuts', () => {
      const result = shortcutManager.setShortcut('test.action', 'F12', 'Test Action');
      
      expect(result.success).toBe(true);
      expect(shortcutManager.getShortcut('test.action').key).toBe('F12');
    });

    test('should prevent conflicting shortcuts', () => {
      const result = shortcutManager.setShortcut('test.action', 'F1', 'Test Action');
      
      expect(result.success).toBe(false);
      expect(result.conflicts).toContain('space.previous');
    });
  });

  describe('Shortcut Categories', () => {
    test('should organize shortcuts by category', () => {
      const categories = shortcutManager.getShortcutsByCategory();
      
      expect(categories).toHaveProperty('navigate');
      expect(categories).toHaveProperty('space');
      expect(categories).toHaveProperty('view');
      expect(categories).toHaveProperty('window');
      expect(categories).toHaveProperty('find');
      expect(categories).toHaveProperty('zoom');
    });

    test('should categorize custom shortcuts', () => {
      shortcutManager.setShortcut('custom.test', 'F12', 'Custom Test');

      const categories = shortcutManager.getShortcutsByCategory();

      // Custom shortcuts go into "other" since there is no dedicated "custom" category
      expect(categories.other).toBeDefined();
      expect(categories.other.length).toBeGreaterThan(0);
      expect(categories.other.some(s => s.action === 'custom.test')).toBe(true);
    });
  });

  describe('Shortcut Export/Import', () => {
    test('should export shortcuts', () => {
      shortcutManager.setShortcut('test.export', 'F12', 'Test Export');
      
      const exported = shortcutManager.exportShortcuts();
      
      expect(exported['test.export']).toBeDefined();
      expect(exported['test.export'].key).toBe('F12');
    });

    test('should import shortcuts', () => {
      const shortcuts = {
        'test.import': { key: 'F11', description: 'Test Import' }
      };
      
      shortcutManager.loadShortcuts({ settings: { shortcuts } });
      
      const shortcut = shortcutManager.getShortcut('test.import');
      expect(shortcut.key).toBe('F11');
    });
  });

  describe('Default Shortcuts', () => {
    test('should have all default navigation shortcuts', () => {
      expect(shortcutManager.getShortcut('navigate.back')).toBeTruthy();
      expect(shortcutManager.getShortcut('navigate.forward')).toBeTruthy();
      expect(shortcutManager.getShortcut('navigate.refresh')).toBeTruthy();
      expect(shortcutManager.getShortcut('navigate.home')).toBeTruthy();
    });

    test('should have all default space shortcuts', () => {
      expect(shortcutManager.getShortcut('space.previous')).toBeTruthy();
      expect(shortcutManager.getShortcut('space.next')).toBeTruthy();
      expect(shortcutManager.getShortcut('space.close')).toBeTruthy();
    });

    test('should have zoom shortcuts', () => {
      expect(shortcutManager.getShortcut('zoom.in')).toBeTruthy();
      expect(shortcutManager.getShortcut('zoom.out')).toBeTruthy();
      expect(shortcutManager.getShortcut('zoom.reset')).toBeTruthy();
    });
  });
});