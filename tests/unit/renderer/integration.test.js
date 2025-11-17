// Integration tests for renderer components working together

describe('Renderer Integration', () => {
  beforeEach(() => {
    // Clean DOM
    document.body.innerHTML = '';
    
    // Mock electron
    global.require = jest.fn((module) => {
      if (module === 'electron') {
        return {
          ipcRenderer: {
            send: jest.fn(),
            on: jest.fn(),
            removeListener: jest.fn(),
            removeAllListeners: jest.fn()
          },
          shell: {
            openExternal: jest.fn()
          }
        };
      }
      return jest.requireActual(module);
    });
    
    // Mock window functions
    window.saveSettings = jest.fn();
    window.fullNames = {
      custom1: 'ChatGPT',
      custom2: 'Claude',
      custom3: 'Gemini'
    };
  });

  describe('Component Initialization', () => {
    test('should initialize all components without errors', () => {
      expect(() => {
        const shortcutManager = require('../../../renderer/utils/shortcuts');
        const sidebar = require('../../../renderer/components/Sidebar');
        const settingsMenu = require('../../../renderer/components/SettingsMenu');
        
        const config = {
          settings: {
            shortcuts: {},
            preventMenuExpansion: false
          },
          baseUrls: {}
        };
        
        shortcutManager.loadShortcuts(config);
        sidebar.initialize(config);
        settingsMenu.initialize(config);
      }).not.toThrow();
    });
  });

  describe('Component Communication', () => {
    test('should handle settings updates across components', () => {
      const shortcutManager = require('../../../renderer/utils/shortcuts');
      const sidebar = require('../../../renderer/components/Sidebar');
      const settingsMenu = require('../../../renderer/components/SettingsMenu');
      
      const config = {
        settings: {
          shortcuts: {},
          preventMenuExpansion: false
        },
        baseUrls: {}
      };
      
      // Initialize components
      shortcutManager.loadShortcuts(config);
      sidebar.initialize(config);
      settingsMenu.initialize(config);
      
      // Update a setting
      settingsMenu.updateSetting('preventMenuExpansion', true);
      
      // Verify it propagates
      expect(window.saveSettings).toHaveBeenCalled();
      expect(window.sidebar.setPreventExpansion).toHaveBeenCalledWith(true);
    });
  });

  describe('Keyboard Shortcuts', () => {
    test('should register keyboard shortcuts', () => {
      const shortcutManager = require('../../../renderer/utils/shortcuts');
      
      const config = {
        settings: {
          shortcuts: {}
        }
      };
      
      shortcutManager.loadShortcuts(config);
      
      // Verify default shortcuts are loaded
      expect(shortcutManager.getShortcut('navigate.back')).toBeTruthy();
      expect(shortcutManager.getShortcut('cognitizer.previous')).toBeTruthy();
    });
  });

  describe('Theme Support', () => {
    test('should apply theme changes', () => {
      const settingsMenu = require('../../../renderer/components/SettingsMenu');
      
      const config = {
        settings: {
          theme: 'dark'
        },
        baseUrls: {}
      };
      
      settingsMenu.initialize(config);
      settingsMenu.applyTheme('light');
      
      expect(document.body.classList.contains('theme-light')).toBe(true);
    });
  });
});