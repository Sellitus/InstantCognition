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

  describe('Shortcut Recording', () => {
    test('should start recording mode', () => {
      const callback = jest.fn();
      
      shortcutManager.startRecording(callback);
      
      expect(shortcutManager.recording).toBe(true);
      expect(shortcutManager.recordingCallback).toBe(callback);
    });

    test('should stop recording mode', () => {
      shortcutManager.startRecording(jest.fn());
      
      shortcutManager.stopRecording();
      
      expect(shortcutManager.recording).toBe(false);
      expect(shortcutManager.recordingCallback).toBeNull();
    });

    test('should capture key combination', () => {
      const callback = jest.fn();
      shortcutManager.startRecording(callback);
      
      // Simulate Ctrl+A
      const event = {
        ...mockEvent,
        key: 'a',
        ctrlKey: true,
        type: 'keydown'
      };
      
      // Call the record handler directly
      const key = shortcutManager.eventToShortcut(event);
      
      expect(key).toContain('CmdOrCtrl');
      expect(key).toContain('A');
    });

    test('should cancel recording on Escape', () => {
      const callback = jest.fn();
      shortcutManager.startRecording(callback);
      
      const event = {
        ...mockEvent,
        key: 'Escape',
        type: 'keydown'
      };
      
      const key = shortcutManager.eventToShortcut(event);
      
      expect(key).toBe('Escape');
    });
  });

  describe('Shortcut Validation', () => {
    test('should detect conflicts correctly', () => {
      // F1 is assigned to cognitizer.previous by default
      const conflicts = shortcutManager.getConflicts('F1');
      
      expect(conflicts).toContain('cognitizer.previous');
    });

    test('should allow non-conflicting shortcuts', () => {
      const result = shortcutManager.setShortcut('test.action', 'F12', 'Test Action');
      
      expect(result.success).toBe(true);
      expect(shortcutManager.getShortcut('test.action').key).toBe('F12');
    });

    test('should prevent conflicting shortcuts', () => {
      const result = shortcutManager.setShortcut('test.action', 'F1', 'Test Action');
      
      expect(result.success).toBe(false);
      expect(result.conflicts).toContain('cognitizer.previous');
    });
  });

  describe('Shortcut Categories', () => {
    test('should organize shortcuts by category', () => {
      const categories = shortcutManager.getShortcutsByCategory();
      
      expect(categories).toHaveProperty('navigate');
      expect(categories).toHaveProperty('cognitizer');
      expect(categories).toHaveProperty('view');
      expect(categories).toHaveProperty('window');
      expect(categories).toHaveProperty('find');
      expect(categories).toHaveProperty('zoom');
    });

    test('should categorize custom shortcuts', () => {
      shortcutManager.setShortcut('custom.test', 'F12', 'Custom Test');
      
      const categories = shortcutManager.getShortcutsByCategory();
      
      expect(categories.custom).toBeDefined();
      expect(categories.custom.length).toBeGreaterThan(0);
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

    test('should have all default cognitizer shortcuts', () => {
      expect(shortcutManager.getShortcut('cognitizer.previous')).toBeTruthy();
      expect(shortcutManager.getShortcut('cognitizer.next')).toBeTruthy();
      expect(shortcutManager.getShortcut('cognitizer.close')).toBeTruthy();
    });

    test('should have zoom shortcuts', () => {
      expect(shortcutManager.getShortcut('zoom.in')).toBeTruthy();
      expect(shortcutManager.getShortcut('zoom.out')).toBeTruthy();
      expect(shortcutManager.getShortcut('zoom.reset')).toBeTruthy();
    });
  });
});