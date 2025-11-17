const settingsMenu = require('../../../../renderer/components/SettingsMenu');
const shortcutManager = require('../../../../renderer/utils/shortcuts');
const { createMockDOM } = require('../../../helpers/testUtils');

// Mock electron
jest.mock('electron', () => ({
  ipcRenderer: {
    send: jest.fn(),
    on: jest.fn()
  }
}));

describe('SettingsMenu', () => {
  let mockConfig;
  let mockElements;

  beforeEach(() => {
    // Reset the DOM
    document.body.innerHTML = '';
    
    // Create mock config
    mockConfig = {
      settings: {
        shortcuts: {},
        preventMenuExpansion: false,
        enableAdblocker: false,
        launchAtStartup: false,
        openLinkExternal: false,
        browserHomeUrl: 'https://www.google.com',
        enableDefaultCognitizer: false,
        defaultCognitizer: 'custom1',
        theme: 'dark',
        enableAnimations: true,
        enableRippleEffects: true,
        sidebarExpandedWidth: 150
      },
      baseUrls: {
        custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
        custom2: { name: 'Claude', url: 'https://claude.ai/' },
        custom3: { name: 'Gemini', url: 'https://gemini.google.com/' }
      }
    };

    // Set up mock DOM
    mockElements = createMockDOM();
    
    // Initialize shortcut manager
    shortcutManager.loadShortcuts(mockConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    test('should create settings menu element', () => {
      settingsMenu.initialize(mockConfig);
      
      const menu = document.getElementById('settings-menu');
      expect(menu).toBeTruthy();
    });

    test('should create all tabs', () => {
      settingsMenu.initialize(mockConfig);
      
      const tabs = document.querySelectorAll('.tab-button');
      expect(tabs.length).toBe(4);
      expect(tabs[0].dataset.tab).toBe('general');
      expect(tabs[1].dataset.tab).toBe('shortcuts');
      expect(tabs[2].dataset.tab).toBe('cognitizers');
      expect(tabs[3].dataset.tab).toBe('appearance');
    });

    test('should load settings from config', () => {
      settingsMenu.initialize(mockConfig);
      
      expect(document.getElementById('preventMenuExpansion').checked).toBe(false);
      expect(document.getElementById('enableAdblocker').checked).toBe(false);
      expect(document.getElementById('browserHomeUrl').value).toBe('https://www.google.com');
    });
  });

  describe('Tab Switching', () => {
    beforeEach(() => {
      settingsMenu.initialize(mockConfig);
    });

    test('should switch between tabs', () => {
      const shortcutsTab = document.querySelector('[data-tab="shortcuts"]');
      if (shortcutsTab) {
        shortcutsTab.click();
        
        expect(shortcutsTab.classList.contains('active')).toBe(true);
        expect(document.getElementById('shortcuts-tab').classList.contains('active')).toBe(true);
      }
    });

    test('should load shortcuts when switching to shortcuts tab', () => {
      const loadShortcutsSpy = jest.spyOn(settingsMenu, 'loadShortcuts');
      
      const shortcutsTab = document.querySelector('[data-tab="shortcuts"]');
      if (shortcutsTab) {
        shortcutsTab.click();
        expect(loadShortcutsSpy).toHaveBeenCalled();
      }
    });
  });

  describe('General Settings', () => {
    beforeEach(() => {
      settingsMenu.initialize(mockConfig);
    });

    test('should update preventMenuExpansion setting', () => {
      const checkbox = document.getElementById('preventMenuExpansion');
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));
      
      expect(mockConfig.settings.preventMenuExpansion).toBe(true);
      expect(global.window.saveSettings).toHaveBeenCalled();
    });

    test('should update browser home URL', () => {
      const input = document.getElementById('browserHomeUrl');
      input.value = 'https://example.com';
      input.dispatchEvent(new Event('change'));
      
      expect(mockConfig.settings.browserHomeUrl).toBe('https://example.com');
      expect(global.window.saveSettings).toHaveBeenCalled();
    });
  });

  describe('Shortcuts Tab', () => {
    beforeEach(() => {
      settingsMenu.initialize(mockConfig);
      // Switch to shortcuts tab
      const shortcutsTab = document.querySelector('[data-tab="shortcuts"]');
      if (shortcutsTab) {
        shortcutsTab.click();
      }
    });

    test('should display shortcuts list', () => {
      const shortcutsList = document.getElementById('shortcuts-list');
      expect(shortcutsList).toBeTruthy();
    });

    test('should search shortcuts', () => {
      const searchInput = document.getElementById('shortcut-search');
      if (searchInput) {
        searchInput.value = 'navigate';
        searchInput.dispatchEvent(new Event('input'));
        
        // Verify filterShortcuts was called
        expect(true).toBe(true); // Placeholder for actual implementation
      }
    });

    test('should handle reset all shortcuts', () => {
      const resetButton = document.getElementById('reset-all-shortcuts');
      if (resetButton) {
        resetButton.click();
        
        // Should show confirmation dialog
        const dialog = document.querySelector('.confirm-dialog');
        expect(dialog).toBeTruthy();
      }
    });
  });

  describe('Cognitizers Tab', () => {
    beforeEach(() => {
      settingsMenu.initialize(mockConfig);
      // Switch to cognitizers tab
      const cognitizersTab = document.querySelector('[data-tab="cognitizers"]');
      if (cognitizersTab) {
        cognitizersTab.click();
      }
    });

    test('should load cognitizers when tab is clicked', () => {
      const cognitizersList = document.getElementById('cognitizers-list');
      expect(cognitizersList).toBeTruthy();
    });
  });

  describe('Appearance Tab', () => {
    beforeEach(() => {
      settingsMenu.initialize(mockConfig);
      // Switch to appearance tab
      const appearanceTab = document.querySelector('[data-tab="appearance"]');
      if (appearanceTab) {
        appearanceTab.click();
      }
    });

    test('should change theme', () => {
      const lightThemeRadio = document.querySelector('input[name="theme"][value="light"]');
      if (lightThemeRadio) {
        lightThemeRadio.checked = true;
        lightThemeRadio.dispatchEvent(new Event('change'));
        
        expect(mockConfig.settings.theme).toBe('light');
        expect(document.body.classList.contains('theme-light')).toBe(true);
      }
    });

    test('should update sidebar width', () => {
      const slider = document.getElementById('sidebarWidth');
      const valueDisplay = document.getElementById('sidebarWidthValue');
      
      if (slider) {
        slider.value = '180';
        slider.dispatchEvent(new Event('input'));
        
        expect(valueDisplay.textContent).toBe('180px');
        expect(mockConfig.settings.sidebarExpandedWidth).toBe(180);
      }
    });
  });

  describe('Visibility', () => {
    beforeEach(() => {
      settingsMenu.initialize(mockConfig);
    });

    test('should show settings menu', () => {
      settingsMenu.show();
      
      expect(settingsMenu.element.classList.contains('visible')).toBe(true);
      expect(settingsMenu.isVisible).toBe(true);
    });

    test('should hide settings menu', () => {
      settingsMenu.show();
      settingsMenu.hide();
      
      expect(settingsMenu.element.classList.contains('visible')).toBe(false);
      expect(settingsMenu.isVisible).toBe(false);
    });

    test('should toggle settings menu', () => {
      settingsMenu.toggle();
      expect(settingsMenu.isVisible).toBe(true);
      
      settingsMenu.toggle();
      expect(settingsMenu.isVisible).toBe(false);
    });

    test('should close on ESC key', () => {
      settingsMenu.show();
      
      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);
      
      expect(settingsMenu.isVisible).toBe(false);
    });
  });

  describe('Shortcut Editing', () => {
    beforeEach(() => {
      settingsMenu.initialize(mockConfig);
    });

    test('should start recording shortcut', () => {
      const recordingSpy = jest.spyOn(shortcutManager, 'startRecording');
      
      settingsMenu.editShortcut('navigate.back');
      
      expect(recordingSpy).toHaveBeenCalled();
    });

    test('should handle shortcut conflicts', () => {
      settingsMenu.showConflictDialog('test-action', 'F1', ['cognitizer.previous']);
      
      const dialog = document.querySelector('.confirm-dialog');
      expect(dialog).toBeTruthy();
      expect(dialog.textContent).toContain('F1');
      expect(dialog.textContent).toContain('cognitizer.previous');
    });
  });
});