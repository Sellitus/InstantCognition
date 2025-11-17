let ipcRenderer;
try {
  ({ ipcRenderer } = require('electron'));
} catch (e) {
  // Running in test environment
  ipcRenderer = { send: () => {}, on: () => {} };
}

class ShortcutManager {
  constructor() {
    this.shortcuts = new Map();
    this.defaultShortcuts = new Map();
    this.conflictMap = new Map();
    this.recording = false;
    this.recordingCallback = null;
    this.initializeDefaults();
  }

  initializeDefaults() {
    // Navigation shortcuts
    this.defaultShortcuts.set('navigate.back', { key: 'F3', description: 'Navigate Back' });
    this.defaultShortcuts.set('navigate.forward', { key: 'F4', description: 'Navigate Forward' });
    this.defaultShortcuts.set('navigate.refresh', { key: 'F5', description: 'Refresh Page' });
    this.defaultShortcuts.set('navigate.home', { key: 'F6', description: 'Navigate Home' });
    
    // Cognitizer shortcuts
    this.defaultShortcuts.set('cognitizer.previous', { key: 'F1', description: 'Previous Cognitizer' });
    this.defaultShortcuts.set('cognitizer.next', { key: 'F2', description: 'Next Cognitizer' });
    this.defaultShortcuts.set('cognitizer.close', { key: 'F7', description: 'Close Active' });
    
    // View shortcuts
    this.defaultShortcuts.set('view.toggle', { key: 'F8', description: 'Toggle View' });
    this.defaultShortcuts.set('view.multicognition', { key: 'CmdOrCtrl+M', description: 'Toggle Multi-Cognition' });
    this.defaultShortcuts.set('view.browser', { key: 'CmdOrCtrl+B', description: 'Toggle Browser View' });
    this.defaultShortcuts.set('view.cognitizer', { key: 'CmdOrCtrl+K', description: 'Toggle Cognitizer View' });
    
    // Window shortcuts
    this.defaultShortcuts.set('window.toggle', { key: 'CmdOrCtrl+Space', description: 'Toggle Window' });
    this.defaultShortcuts.set('window.lock', { key: 'CmdOrCtrl+Alt+L', description: 'Lock Shortcuts' });
    
    // Find shortcuts
    this.defaultShortcuts.set('find.toggle', { key: 'CmdOrCtrl+F', description: 'Find in Page' });
    this.defaultShortcuts.set('find.next', { key: 'CmdOrCtrl+G', description: 'Find Next' });
    this.defaultShortcuts.set('find.previous', { key: 'Shift+CmdOrCtrl+G', description: 'Find Previous' });
    
    // Zoom shortcuts
    this.defaultShortcuts.set('zoom.in', { key: 'CmdOrCtrl+=', description: 'Zoom In' });
    this.defaultShortcuts.set('zoom.out', { key: 'CmdOrCtrl+-', description: 'Zoom Out' });
    this.defaultShortcuts.set('zoom.reset', { key: 'CmdOrCtrl+0', description: 'Reset Zoom' });
    
    // Numbered cognitizer shortcuts
    for (let i = 1; i <= 10; i++) {
      // Use Alt+number to avoid conflict with zoom.reset (CmdOrCtrl+0)
      const key = i === 10 ? '0' : i.toString();
      this.defaultShortcuts.set(`cognitizer.select.${i}`, { 
        key: `Alt+${key}`, 
        description: `Select Cognitizer ${i}` 
      });
    }
  }

  loadShortcuts(config) {
    // Load user-defined shortcuts from config
    if (config.settings && config.settings.shortcuts) {
      Object.entries(config.settings.shortcuts).forEach(([action, shortcut]) => {
        if (typeof shortcut === 'string') {
          // Legacy format - convert to new format
          this.shortcuts.set(action, { key: shortcut, description: this.getDescription(action) });
        } else {
          this.shortcuts.set(action, shortcut);
        }
      });
    }
    
    // Fill in any missing shortcuts with defaults
    this.defaultShortcuts.forEach((shortcut, action) => {
      if (!this.shortcuts.has(action)) {
        this.shortcuts.set(action, { ...shortcut });
      }
    });
    
    this.updateConflictMap();
  }

  getDescription(action) {
    const defaultShortcut = this.defaultShortcuts.get(action);
    return defaultShortcut ? defaultShortcut.description : action;
  }

  updateConflictMap() {
    this.conflictMap.clear();
    this.shortcuts.forEach((shortcut, action) => {
      const key = this.normalizeKey(shortcut.key);
      if (!this.conflictMap.has(key)) {
        this.conflictMap.set(key, []);
      }
      this.conflictMap.get(key).push(action);
    });
  }

  normalizeKey(key) {
    // Normalize key representation for comparison
    return key
      .toLowerCase()
      .replace(/cmdorctrl/gi, process.platform === 'darwin' ? 'cmd' : 'ctrl')
      .replace(/\s+/g, '+')
      .split('+')
      .sort()
      .join('+');
  }

  getShortcut(action) {
    return this.shortcuts.get(action) || this.defaultShortcuts.get(action);
  }

  setShortcut(action, key, description) {
    const normalizedKey = this.normalizeKey(key);
    
    // Check for conflicts
    const conflicts = this.getConflicts(normalizedKey).filter(a => a !== action);
    if (conflicts.length > 0) {
      return { success: false, conflicts };
    }
    
    this.shortcuts.set(action, { key, description: description || this.getDescription(action) });
    this.updateConflictMap();
    return { success: true };
  }

  removeShortcut(action) {
    this.shortcuts.delete(action);
    this.updateConflictMap();
  }

  resetShortcut(action) {
    const defaultShortcut = this.defaultShortcuts.get(action);
    if (defaultShortcut) {
      this.shortcuts.set(action, { ...defaultShortcut });
      this.updateConflictMap();
    }
  }

  resetAllShortcuts() {
    this.shortcuts.clear();
    this.defaultShortcuts.forEach((shortcut, action) => {
      this.shortcuts.set(action, { ...shortcut });
    });
    this.updateConflictMap();
  }

  getConflicts(key) {
    const normalizedKey = this.normalizeKey(key);
    return this.conflictMap.get(normalizedKey) || [];
  }

  getAllShortcuts() {
    const allShortcuts = [];
    this.shortcuts.forEach((shortcut, action) => {
      allShortcuts.push({
        action,
        ...shortcut,
        isDefault: this.isDefault(action)
      });
    });
    return allShortcuts.sort((a, b) => a.description.localeCompare(b.description));
  }

  getShortcutsByCategory() {
    const categories = {
      navigate: [],
      cognitizer: [],
      view: [],
      window: [],
      find: [],
      zoom: [],
      other: []
    };
    
    this.shortcuts.forEach((shortcut, action) => {
      const category = action.split('.')[0];
      const target = categories[category] || categories.other;
      target.push({
        action,
        ...shortcut,
        isDefault: this.isDefault(action)
      });
    });
    
    return categories;
  }

  isDefault(action) {
    const current = this.shortcuts.get(action);
    const defaultShortcut = this.defaultShortcuts.get(action);
    return current && defaultShortcut && current.key === defaultShortcut.key;
  }

  startRecording(callback) {
    // This method is kept for compatibility but no longer used
    // The actual recording is now handled directly in SettingsMenu.js
    // using input elements to bypass global key listeners
    this.recording = true;
    this.recordingCallback = callback;
    
    // For backward compatibility, call the callback immediately with null
    // to indicate the new system is being used
    if (callback) {
      setTimeout(() => callback(null), 0);
    }
  }

  stopRecording() {
    this.recording = false;
    this.recordingCallback = null;
  }

  eventToShortcut(event) {
    const parts = [];
    
    // Add modifiers in consistent order
    if (event.ctrlKey || event.metaKey) parts.push('CmdOrCtrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    
    // Add the key
    let key = event.key;
    
    // Special key mappings
    const keyMap = {
      ' ': 'Space',
      'ArrowLeft': 'Left',
      'ArrowRight': 'Right',
      'ArrowUp': 'Up',
      'ArrowDown': 'Down',
      'Enter': 'Enter',
      'Backspace': 'Backspace',
      'Delete': 'Delete',
      'Tab': 'Tab',
      'Escape': 'Escape'
    };
    
    if (keyMap[key]) {
      key = keyMap[key];
    } else if (key.length === 1) {
      key = key.toUpperCase();
    } else if (key.startsWith('F') && /^F\d{1,2}$/.test(key)) {
      // Function keys
      key = key;
    } else {
      // Ignore other special keys
      return null;
    }
    
    parts.push(key);
    return parts.join('+');
  }

  exportShortcuts() {
    const shortcuts = {};
    this.shortcuts.forEach((shortcut, action) => {
      shortcuts[action] = shortcut;
    });
    return shortcuts;
  }

  searchShortcuts(query) {
    const results = [];
    const lowerQuery = query.toLowerCase();
    
    this.shortcuts.forEach((shortcut, action) => {
      if (
        action.toLowerCase().includes(lowerQuery) ||
        shortcut.description.toLowerCase().includes(lowerQuery) ||
        shortcut.key.toLowerCase().includes(lowerQuery)
      ) {
        results.push({
          action,
          ...shortcut,
          isDefault: this.isDefault(action)
        });
      }
    });
    
    return results;
  }
}

// Create singleton instance
const shortcutManager = new ShortcutManager();

module.exports = shortcutManager;