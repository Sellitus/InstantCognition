
const VALID_KEYS = [
  'Space',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  'Enter','Backspace','Delete','Tab','Escape',
  'Left','Right','Up','Down',
  'Home','End','PageUp','PageDown',
  '=','-','[',']','\\',';',"'",',','.','/',
];

const MODIFIER_NAMES = {
  'cmd': 'Cmd',
  'command': 'Cmd',
  'ctrl': 'Ctrl',
  'control': 'Ctrl',
  'cmdorctrl': 'CmdOrCtrl',
  'commandorcontrol': 'CmdOrCtrl',
  'alt': 'Alt',
  'option': 'Alt',
  'shift': 'Shift',
};

const VALID_KEYS_LOWER = new Map(VALID_KEYS.map(k => [k.toLowerCase(), k]));

// Actions that stay live while a text field has focus — panel and tab
// switching must work mid-typing, everything else yields to the field.
const INPUT_SAFE_ACTIONS = new Set([
  'palette.toggle',
  'tab.new',
  'tab.close',
  'panel.chat',
  'view.flip',
  'panel.library',
  'panel.extensions',
  'panel.notifications',
  'app.settings',
  'window.toggle',
]);

class ShortcutManager {
  constructor() {
    this.shortcuts = new Map();
    this.defaultShortcuts = new Map();
    this.conflictMap = new Map();
    this.initializeDefaults();
  }

  initializeDefaults() {
    // Navigation shortcuts
    this.defaultShortcuts.set('navigate.back', { key: 'F3', description: 'Navigate Back' });
    this.defaultShortcuts.set('navigate.forward', { key: 'F4', description: 'Navigate Forward' });
    this.defaultShortcuts.set('navigate.refresh', { key: 'F5', description: 'Refresh Page' });
    this.defaultShortcuts.set('navigate.home', { key: 'F6', description: 'Navigate Home' });
    
    // Space shortcuts
    this.defaultShortcuts.set('space.previous', { key: 'F1', description: 'Previous Space' });
    this.defaultShortcuts.set('space.next', { key: 'F2', description: 'Next Space' });
    this.defaultShortcuts.set('space.close', { key: 'F7', description: 'Close Active' });
    
    // View shortcuts
    this.defaultShortcuts.set('view.toggle', { key: 'F8', description: 'Toggle View' });
    this.defaultShortcuts.set('view.multiSpace', { key: 'CmdOrCtrl+M', description: 'Toggle Multi-Space' });
    this.defaultShortcuts.set('view.browser', { key: 'CmdOrCtrl+B', description: 'Toggle Browser View' });
    this.defaultShortcuts.set('view.space', { key: 'CmdOrCtrl+Shift+S', description: 'Toggle Space View' });
    this.defaultShortcuts.set('view.agent', { key: 'Alt+Shift+A', description: 'Toggle Agent Workspace' });
    this.defaultShortcuts.set('view.flip', { key: 'CmdOrCtrl+E', description: 'Flip Assistant / Browser View' });
    
    // Window shortcuts
    this.defaultShortcuts.set('window.toggle', {
      key: process.platform === 'darwin' ? 'Alt+Space' : 'CmdOrCtrl+Space',
      description: 'Toggle Window'
    });
    this.defaultShortcuts.set('window.lock', { key: 'CmdOrCtrl+Alt+L', description: 'Lock Shortcuts' });
    
    // Find shortcuts
    this.defaultShortcuts.set('find.toggle', { key: 'CmdOrCtrl+F', description: 'Find in Page' });
    this.defaultShortcuts.set('find.next', { key: 'CmdOrCtrl+G', description: 'Find Next' });
    this.defaultShortcuts.set('find.previous', { key: 'Shift+CmdOrCtrl+G', description: 'Find Previous' });
    
    // Zoom shortcuts
    this.defaultShortcuts.set('zoom.in', { key: 'CmdOrCtrl+=', description: 'Zoom In' });
    this.defaultShortcuts.set('zoom.out', { key: 'CmdOrCtrl+-', description: 'Zoom Out' });
    this.defaultShortcuts.set('zoom.reset', { key: 'CmdOrCtrl+0', description: 'Reset Zoom' });
    
    // Panels, tabs and the command palette. These were hardcoded in the
    // renderer listener and so never appeared in Settings; they are registry
    // entries now, which also makes them remappable.
    this.defaultShortcuts.set('palette.toggle', { key: 'CmdOrCtrl+K', description: 'Command Palette' });
    this.defaultShortcuts.set('tab.new', { key: 'CmdOrCtrl+T', description: 'New Tab' });
    this.defaultShortcuts.set('tab.close', { key: 'CmdOrCtrl+W', description: 'Close Tab' });
    this.defaultShortcuts.set('panel.chat', { key: 'CmdOrCtrl+Shift+A', description: 'Chat Panel' });
    this.defaultShortcuts.set('panel.library', { key: 'CmdOrCtrl+Shift+Y', description: 'Library' });
    this.defaultShortcuts.set('panel.extensions', { key: 'CmdOrCtrl+Shift+E', description: 'Extensions' });
    this.defaultShortcuts.set('panel.notifications', { key: 'CmdOrCtrl+Shift+N', description: 'Notifications' });
    this.defaultShortcuts.set('app.settings', { key: 'CmdOrCtrl+,', description: 'Settings' });
    this.defaultShortcuts.set('urlbar.focus', { key: 'CmdOrCtrl+L', description: 'Focus URL Bar' });
    this.defaultShortcuts.set('chat.council', { key: 'CmdOrCtrl+Shift+B', description: 'Ask All Spaces' });

    // Numbered space shortcuts
    for (let i = 1; i <= 10; i++) {
      // Use Alt+number to avoid conflict with zoom.reset (CmdOrCtrl+0)
      const key = i === 10 ? '0' : i.toString();
      this.defaultShortcuts.set(`space.select.${i}`, { 
        key: `Alt+${key}`, 
        description: `Select Space ${i}` 
      });
    }
  }

  loadShortcuts(config) {
    // Load user-defined shortcuts from config. Tolerate malformed entries —
    // historically a path-split bug in the recorder could leave nested
    // garbage like `shortcuts.window = { toggle: 'Ctrl+ ' }` under the
    // dotted-key action names; entries without a string `.key` are skipped
    // so defaults can backfill.
    if (config.settings && config.settings.shortcuts) {
      Object.entries(config.settings.shortcuts).forEach(([action, shortcut]) => {
        if (typeof shortcut === 'string') {
          this.shortcuts.set(action, { key: shortcut, description: this.getDescription(action) });
        } else if (shortcut && typeof shortcut === 'object' && typeof shortcut.key === 'string') {
          this.shortcuts.set(action, { key: shortcut.key, description: shortcut.description || this.getDescription(action) });
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
      if (!shortcut || typeof shortcut.key !== 'string') return;
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
      space: [],
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

  eventToShortcut(event) {
    const parts = [];
    
    // Add modifiers in consistent order.
    // On macOS, distinguish Cmd (⌘) from Ctrl so users can bind to either key.
    // On other platforms, both map to CmdOrCtrl for cross-platform compatibility.
    if (process.platform === 'darwin') {
      if (event.metaKey) parts.push('Cmd');
      if (event.ctrlKey) parts.push('Ctrl');
    } else {
      if (event.ctrlKey || event.metaKey) parts.push('CmdOrCtrl');
    }
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

  parseShortcutString(str) {
    if (!str || typeof str !== 'string') return null;

    const parts = str.split('+').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;

    const modifiers = [];
    let key = null;

    for (const part of parts) {
      const modName = MODIFIER_NAMES[part.toLowerCase()];
      if (modName) {
        modifiers.push(modName);
      } else {
        const matchedKey = VALID_KEYS_LOWER.get(part.toLowerCase());
        if (matchedKey) {
          key = matchedKey;
        } else {
          return null;
        }
      }
    }

    if (!key) return null;

    return { modifiers, key };
  }
}

// Human-readable form of an accelerator for menus and tooltips. macOS uses
// the modifier glyphs (⌘⇧A); other platforms spell them out (Ctrl+Shift+A).
function formatShortcut(key, platform = process.platform) {
  if (!key || typeof key !== 'string') return '';
  const mac = platform === 'darwin';
  const glyphs = { CmdOrCtrl: '⌘', Cmd: '⌘', Command: '⌘', Ctrl: '⌃', Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' };
  const words = { CmdOrCtrl: 'Ctrl', Cmd: 'Ctrl', Command: 'Ctrl', Control: 'Ctrl', Option: 'Alt' };
  const parts = key.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  const last = parts.pop();
  const mods = parts.map((m) => (mac ? (glyphs[m] || m) : (words[m] || m)));
  return mac ? mods.join('') + last : [...mods, last].join('+');
}

// Create singleton instance
const shortcutManager = new ShortcutManager();

module.exports = shortcutManager;
module.exports.VALID_KEYS = VALID_KEYS;
module.exports.INPUT_SAFE_ACTIONS = INPUT_SAFE_ACTIONS;
module.exports.formatShortcut = formatShortcut;