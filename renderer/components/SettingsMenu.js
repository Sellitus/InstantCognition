let ipcRenderer;
try {
  ({ ipcRenderer } = require('electron'));
} catch (e) {
  // Running in test environment
  ipcRenderer = { send: () => {}, on: () => {} };
}
const shortcutManager = require('../utils/shortcuts');

class SettingsMenu {
  constructor() {
    this.element = null;
    this.tabs = {};
    this.activeTab = 'general';
    this.shortcutElements = new Map();
    this.isVisible = false;
  }

  initialize(config) {
    this.config = config;
    this.createElement();
    
    // Ensure DOM is ready before setting up event listeners
    setTimeout(() => {
      this.setupTabs();
      this.loadSettings();
      this.setupEventListeners();
    }, 0);
  }

  createElement() {
    // Remove existing menu if present
    const existing = document.getElementById('settings-menu');
    if (existing) existing.remove();

    const menuHTML = `
      <div id="settings-menu" class="settings-menu">
        <div class="settings-container">
          <div class="settings-header">
            <h2>Settings</h2>
            <button id="settings-close-button" class="close-button">✕</button>
          </div>
        
        <div class="settings-tabs">
          <button class="tab-button active" data-tab="general">General</button>
          <button class="tab-button" data-tab="shortcuts">Shortcuts</button>
          <button class="tab-button" data-tab="cognitizers">Cognitizers</button>
          <button class="tab-button" data-tab="appearance">Appearance</button>
          <button id="apply-restart-button" class="action-button" style="margin-left: auto; margin-right: 8px; padding: 8px 16px; font-size: 13px;">Apply/Restart</button>
        </div>
        
        <div class="settings-content">
          <!-- General Tab -->
          <div id="general-tab" class="tab-content active">
            <div class="settings-section">
              <h3>Window Behavior</h3>
              <div class="setting-option">
                <label>
                  <input type="checkbox" id="preventMenuExpansion">
                  <span>Prevent Menu Auto-Expansion</span>
                </label>
              </div>
              <div class="setting-option">
                <label>
                  <input type="checkbox" id="launchAtStartup">
                  <span>Launch at System Startup</span>
                </label>
              </div>
            </div>
            
            <div class="settings-section">
              <h3>Browser Settings</h3>
              <div class="setting-option">
                <label>
                  <input type="checkbox" id="enableAdblocker">
                  <span>Enable Ad Blocker</span>
                </label>
              </div>
              <div class="setting-option">
                <label>
                  <input type="checkbox" id="openLinkExternal">
                  <span>Open Links in External Browser</span>
                </label>
              </div>
              <div class="setting-option">
                <span>Browser Home URL:</span>
                <input type="text" id="browserHomeUrl" class="text-input" placeholder="https://www.google.com">
              </div>
            </div>
            
            <div class="settings-section">
              <h3>Default Cognitizer</h3>
              <div class="setting-option">
                <label>
                  <input type="checkbox" id="enableDefaultCognitizer">
                  <span>Enable Default Cognitizer on Startup</span>
                </label>
              </div>
              <div class="setting-option">
                <span>Default Cognitizer:</span>
                <select id="defaultCognitizerSelect" class="select-input"></select>
              </div>
            </div>
            
            <div class="settings-actions">
              <button id="open-config-button" class="action-button">Open Config File</button>
              <button id="restart-app-button" class="action-button">Restart Application</button>
            </div>
          </div>
          
          <!-- Shortcuts Tab -->
          <div id="shortcuts-tab" class="tab-content">
            <div class="shortcuts-header">
              <input type="text" id="shortcut-search" class="search-input" placeholder="Search shortcuts...">
              <button id="reset-all-shortcuts" class="action-button secondary">Reset All</button>
            </div>
            
            <div id="shortcuts-list" class="shortcuts-list">
              <!-- Shortcuts will be populated here -->
            </div>
          </div>
          
          <!-- Cognitizers Tab -->
          <div id="cognitizers-tab" class="tab-content">
            <div class="cognitizers-info">
              <p>Use the up/down buttons to reorder cognitizers. Click to edit names and URLs.</p>
            </div>
            <div id="cognitizers-list" class="cognitizers-list">
              <!-- Cognitizers will be populated here -->
            </div>
            <div class="cognitizers-actions">
              <button id="add-cognitizer" class="action-button">Add Cognitizer</button>
              <button id="reset-cognitizers" class="action-button secondary">Reset to Defaults</button>
            </div>
          </div>
          
          <!-- Appearance Tab -->
          <div id="appearance-tab" class="tab-content">
            <div class="settings-section">
              <h3>Theme</h3>
              <div class="setting-option">
                <label>
                  <input type="radio" name="theme" value="dark" checked>
                  <span>Dark Theme</span>
                </label>
              </div>
              <div class="setting-option">
                <label>
                  <input type="radio" name="theme" value="light">
                  <span>Light Theme</span>
                </label>
              </div>
              <div class="setting-option">
                <label>
                  <input type="radio" name="theme" value="system">
                  <span>Follow System</span>
                </label>
              </div>
            </div>
            
            <div class="settings-section">
              <h3>UI Animations</h3>
              <div class="setting-option">
                <label>
                  <input type="checkbox" id="enableAnimations" checked>
                  <span>Enable UI Animations</span>
                </label>
              </div>
              <div class="setting-option">
                <label>
                  <input type="checkbox" id="enableRippleEffects" checked>
                  <span>Enable Ripple Effects</span>
                </label>
              </div>
            </div>
            
            <div class="settings-section">
              <h3>Layout</h3>
              <div class="setting-option">
                <span>Sidebar Width (Expanded):</span>
                <div style="display: flex; align-items: center; gap: 12px; flex: 1; max-width: 300px;">
                  <input type="range" id="sidebarWidth" min="120" max="200" value="150" style="flex: 1;">
                  <span id="sidebarWidthValue" style="min-width: 50px; text-align: right;">150px</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', menuHTML);
    this.element = document.getElementById('settings-menu');
  }

  setupTabs() {
    const tabButtons = this.element.querySelectorAll('.tab-button');
    const tabContents = this.element.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        const tabId = button.dataset.tab;
        
        // Update active states
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabContents.forEach(content => content.classList.remove('active'));
        
        button.classList.add('active');
        document.getElementById(`${tabId}-tab`).classList.add('active');
        
        this.activeTab = tabId;
        
        // Load tab-specific content
        if (tabId === 'shortcuts') {
          this.loadShortcuts();
        } else if (tabId === 'cognitizers') {
          this.loadCognitizers();
        }
      });
    });
  }

  setupEventListeners() {
    // Use event delegation on the settings menu element
    this.element.addEventListener('click', (e) => {
      // Close if clicking on the overlay
      if (e.target === this.element) {
        this.hide();
        return;
      }

      // Close button
      if (e.target.id === 'settings-close-button') {
        this.hide();
        return;
      }
      
      // Open config button
      if (e.target.id === 'open-config-button') {
        console.log('Open config button clicked via delegation');
        if (ipcRenderer && ipcRenderer.send) {
          ipcRenderer.send('open-config-file');
          console.log('Sent open-config-file IPC message');
        } else {
          console.error('ipcRenderer not available:', ipcRenderer);
        }
        return;
      }
      
      // Restart button
      if (e.target.id === 'restart-app-button') {
        console.log('Restart button clicked via delegation');
        if (ipcRenderer && ipcRenderer.send) {
          ipcRenderer.send('restart-app');
          console.log('Sent restart-app IPC message');
        } else {
          console.error('ipcRenderer not available:', ipcRenderer);
        }
        return;
      }
      
      // Apply/Restart button
      if (e.target.id === 'apply-restart-button') {
        console.log('Apply/Restart button clicked via delegation');
        if (ipcRenderer && ipcRenderer.send) {
          ipcRenderer.send('restart-app');
          console.log('Sent restart-app IPC message');
        } else {
          console.error('ipcRenderer not available:', ipcRenderer);
        }
        return;
      }
      
      // Add cognitizer button
      if (e.target.id === 'add-cognitizer') {
        this.addNewCognitizer();
        return;
      }
      
      // Reset cognitizers button
      if (e.target.id === 'reset-cognitizers') {
        this.confirmResetCognitizers();
        return;
      }
      
      // Reset all shortcuts button
      if (e.target.id === 'reset-all-shortcuts') {
        this.confirmResetAllShortcuts();
        return;
      }
    });

    // General settings
    document.getElementById('preventMenuExpansion').addEventListener('change', (e) => {
      this.updateSetting('preventMenuExpansion', e.target.checked);
    });

    document.getElementById('enableAdblocker').addEventListener('change', (e) => {
      this.updateSetting('enableAdblocker', e.target.checked);
    });

    document.getElementById('launchAtStartup').addEventListener('change', (e) => {
      this.updateSetting('launchAtStartup', e.target.checked);
    });

    document.getElementById('openLinkExternal').addEventListener('change', (e) => {
      this.updateSetting('openLinkExternal', e.target.checked);
    });

    document.getElementById('browserHomeUrl').addEventListener('change', (e) => {
      this.updateSetting('browserHomeUrl', e.target.value);
    });

    document.getElementById('enableDefaultCognitizer').addEventListener('change', (e) => {
      this.updateSetting('enableDefaultCognitizer', e.target.checked);
    });

    document.getElementById('defaultCognitizerSelect').addEventListener('change', (e) => {
      this.updateSetting('defaultCognitizer', e.target.value);
    });

    // Action buttons are handled via event delegation above

    // Shortcuts tab
    document.getElementById('shortcut-search').addEventListener('input', (e) => {
      this.filterShortcuts(e.target.value);
    });

    // Shortcuts and cognitizers buttons are handled via event delegation above

    // Appearance settings
    document.querySelectorAll('input[name="theme"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.updateSetting('theme', e.target.value);
        this.applyTheme(e.target.value);
      });
    });

    document.getElementById('enableAnimations').addEventListener('change', (e) => {
      this.updateSetting('enableAnimations', e.target.checked);
      document.body.classList.toggle('no-animations', !e.target.checked);
    });

    document.getElementById('enableRippleEffects').addEventListener('change', (e) => {
      this.updateSetting('enableRippleEffects', e.target.checked);
    });

    document.getElementById('sidebarWidth').addEventListener('input', (e) => {
      const value = e.target.value;
      document.getElementById('sidebarWidthValue').textContent = `${value}px`;
      this.updateSetting('sidebarExpandedWidth', parseInt(value));
    });

    // ESC to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    });
  }

  loadSettings() {
    // General settings
    document.getElementById('preventMenuExpansion').checked = this.config.settings.preventMenuExpansion || false;
    document.getElementById('enableAdblocker').checked = this.config.settings.enableAdblocker || false;
    document.getElementById('launchAtStartup').checked = this.config.settings.launchAtStartup || false;
    document.getElementById('openLinkExternal').checked = this.config.settings.openLinkExternal || false;
    document.getElementById('browserHomeUrl').value = this.config.settings.browserHomeUrl || 'https://www.google.com';
    document.getElementById('enableDefaultCognitizer').checked = this.config.settings.enableDefaultCognitizer || false;

    // Load cognitizer options
    const select = document.getElementById('defaultCognitizerSelect');
    select.innerHTML = '';
    Object.entries(this.config.baseUrls).forEach(([key, cognitizer]) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = cognitizer.name;
      select.appendChild(option);
    });
    select.value = this.config.settings.defaultCognitizer || 'custom1';

    // Appearance settings
    const theme = this.config.settings.theme || 'dark';
    document.querySelector(`input[name="theme"][value="${theme}"]`).checked = true;
    document.getElementById('enableAnimations').checked = this.config.settings.enableAnimations !== false;
    document.getElementById('enableRippleEffects').checked = this.config.settings.enableRippleEffects !== false;
    document.getElementById('sidebarWidth').value = this.config.settings.sidebarExpandedWidth || 150;
    document.getElementById('sidebarWidthValue').textContent = `${this.config.settings.sidebarExpandedWidth || 150}px`;
  }

  loadShortcuts() {
    const container = document.getElementById('shortcuts-list');
    container.innerHTML = '';

    const categories = shortcutManager.getShortcutsByCategory();
    
    Object.entries(categories).forEach(([category, shortcuts]) => {
      if (shortcuts.length === 0) return;

      const section = document.createElement('div');
      section.className = 'shortcut-category';
      
      const title = document.createElement('h3');
      title.textContent = category.charAt(0).toUpperCase() + category.slice(1);
      section.appendChild(title);

      shortcuts.forEach(shortcut => {
        const item = this.createShortcutItem(shortcut);
        section.appendChild(item);
      });

      container.appendChild(section);
    });
  }

  createShortcutItem(shortcut) {
    const item = document.createElement('div');
    item.className = 'shortcut-item';
    item.dataset.action = shortcut.action;

    const info = document.createElement('div');
    info.className = 'shortcut-info';
    
    const description = document.createElement('span');
    description.className = 'shortcut-description';
    description.textContent = shortcut.description;
    info.appendChild(description);

    if (!shortcut.isDefault) {
      const modified = document.createElement('span');
      modified.className = 'shortcut-modified';
      modified.textContent = '(modified)';
      info.appendChild(modified);
    }

    const controls = document.createElement('div');
    controls.className = 'shortcut-controls';

    const keyDisplay = document.createElement('span');
    keyDisplay.className = 'shortcut-key';
    keyDisplay.textContent = shortcut.key;
    controls.appendChild(keyDisplay);

    const editButton = document.createElement('button');
    editButton.className = 'shortcut-edit';
    editButton.textContent = 'Edit';
    editButton.addEventListener('click', () => this.editShortcut(shortcut.action));
    controls.appendChild(editButton);

    const resetButton = document.createElement('button');
    resetButton.className = 'shortcut-reset';
    resetButton.textContent = 'Reset';
    resetButton.disabled = shortcut.isDefault;
    resetButton.addEventListener('click', () => this.resetShortcut(shortcut.action));
    controls.appendChild(resetButton);

    item.appendChild(info);
    item.appendChild(controls);

    this.shortcutElements.set(shortcut.action, item);
    return item;
  }

  editShortcut(action) {
    const item = this.shortcutElements.get(action);
    if (!item) {
      return;
    }

    const keyDisplay = item.querySelector('.shortcut-key');

    // Create a temporary input field for shortcut capture
    const input = document.createElement('input');
    input.type = 'text';
    input.value = '';
    input.placeholder = 'Press key combination...';
    input.style.cssText = keyDisplay.style.cssText;
    input.className = keyDisplay.className + ' shortcut-input-capture';
    
    // Replace the key display with the input
    keyDisplay.style.display = 'none';
    keyDisplay.parentNode.insertBefore(input, keyDisplay);
    
    // Add visual indicators
    item.classList.add('editing');
    document.body.classList.add('recording-shortcut');
    
    // Focus the input
    input.focus();
    input.select();
    
    // Set up key capture on the input
    const handleKeyDown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      
      // Handle escape to cancel
      if (event.key === 'Escape') {
        cleanup();
        return;
      }
      
      // Convert the event to shortcut string
      const newKey = shortcutManager.eventToShortcut(event);
      if (newKey && newKey !== 'Escape') {
        // Try to set the shortcut
        const result = shortcutManager.setShortcut(action, newKey);
        
        if (result.success) {
          keyDisplay.textContent = newKey;
          const resetButton = item.querySelector('.shortcut-reset');
          if (resetButton) resetButton.disabled = false;
          
          const modifiedSpan = item.querySelector('.shortcut-modified');
          if (modifiedSpan) {
            modifiedSpan.style.display = 'inline';
          } else {
            // Create modified indicator if it doesn't exist
            const info = item.querySelector('.shortcut-info');
            const modified = document.createElement('span');
            modified.className = 'shortcut-modified';
            modified.textContent = '(modified)';
            info.appendChild(modified);
          }
          
          // Save to config
          this.saveShortcuts();
          cleanup();
        } else {
          // Show conflict dialog
          this.showConflictDialog(action, newKey, result.conflicts);
          cleanup();
        }
      }
    };
    
    const handleBlur = () => {
      // Cancel if input loses focus
      cleanup();
    };
    
    const cleanup = () => {
      // Remove event listeners
      input.removeEventListener('keydown', handleKeyDown);
      input.removeEventListener('blur', handleBlur);
      
      // Remove input and restore key display
      if (input.parentNode) {
        input.parentNode.removeChild(input);
      }
      keyDisplay.style.display = '';
      
      // Remove visual indicators
      item.classList.remove('editing');
      document.body.classList.remove('recording-shortcut');
    };
    
    // Add event listeners
    input.addEventListener('keydown', handleKeyDown);
    input.addEventListener('blur', handleBlur);
  }

  resetShortcut(action) {
    shortcutManager.resetShortcut(action);
    this.saveShortcuts();
    
    // Reload the shortcut display
    const shortcut = shortcutManager.getShortcut(action);
    const item = this.shortcutElements.get(action);
    if (item && shortcut) {
      item.querySelector('.shortcut-key').textContent = shortcut.key;
      item.querySelector('.shortcut-reset').disabled = true;
      const modified = item.querySelector('.shortcut-modified');
      if (modified) modified.style.display = 'none';
    }
  }

  confirmResetAllShortcuts() {
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
      <div class="confirm-content">
        <h3>Reset All Shortcuts?</h3>
        <p>This will restore all keyboard shortcuts to their default values.</p>
        <div class="confirm-actions">
          <button class="action-button secondary" id="confirm-cancel">Cancel</button>
          <button class="action-button primary" id="confirm-reset">Reset All</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    document.getElementById('confirm-cancel').addEventListener('click', () => {
      dialog.remove();
    });

    document.getElementById('confirm-reset').addEventListener('click', () => {
      shortcutManager.resetAllShortcuts();
      this.saveShortcuts();
      this.loadShortcuts();
      dialog.remove();
    });
  }

  showConflictDialog(action, key, conflicts) {
    const conflictDescriptions = conflicts.map(a => {
      const s = shortcutManager.getShortcut(a);
      return s ? s.description : a;
    }).join(', ');

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
      <div class="confirm-content">
        <h3>Shortcut Conflict</h3>
        <p>The key "${key}" is already assigned to: ${conflictDescriptions}</p>
        <div class="confirm-actions">
          <button class="action-button primary" id="conflict-ok">OK</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    document.getElementById('conflict-ok').addEventListener('click', () => {
      dialog.remove();
    });
  }

  filterShortcuts(query) {
    if (!query) {
      this.loadShortcuts();
      return;
    }

    const results = shortcutManager.searchShortcuts(query);
    const container = document.getElementById('shortcuts-list');
    container.innerHTML = '';

    if (results.length === 0) {
      container.innerHTML = '<p class="no-results">No shortcuts found</p>';
      return;
    }

    const section = document.createElement('div');
    section.className = 'shortcut-category';
    
    results.forEach(shortcut => {
      const item = this.createShortcutItem(shortcut);
      section.appendChild(item);
    });

    container.appendChild(section);
  }

  loadCognitizers() {
    const container = document.getElementById('cognitizers-list');
    container.innerHTML = '';

    const entries = Object.entries(this.config.baseUrls);
    entries.forEach(([key, cognitizer], index) => {
      const item = this.createCognitizerItem(key, cognitizer);
      
      // Disable up button for first item
      if (index === 0) {
        item.querySelector('.cognitizer-move-up').disabled = true;
      }
      
      // Disable down button for last item
      if (index === entries.length - 1) {
        item.querySelector('.cognitizer-move-down').disabled = true;
      }
      
      container.appendChild(item);
    });
  }

  createCognitizerItem(key, cognitizer) {
    const item = document.createElement('div');
    item.className = 'cognitizer-item';
    item.dataset.key = key;

    item.innerHTML = `
      <div class="cognitizer-sort-buttons">
        <button class="cognitizer-move-up" title="Move up">▲</button>
        <button class="cognitizer-move-down" title="Move down">▼</button>
      </div>
      <div class="cognitizer-info">
        <input type="text" class="cognitizer-name" value="${cognitizer.name}" placeholder="Name">
        <input type="text" class="cognitizer-url" value="${cognitizer.url}" placeholder="URL">
      </div>
      <button class="cognitizer-remove">✕</button>
    `;

    // Event listeners
    item.querySelector('.cognitizer-name').addEventListener('change', (e) => {
      this.updateCognitizer(key, 'name', e.target.value);
    });

    item.querySelector('.cognitizer-url').addEventListener('change', (e) => {
      this.updateCognitizer(key, 'url', e.target.value);
    });

    item.querySelector('.cognitizer-remove').addEventListener('click', () => {
      this.removeCognitizer(key);
    });

    item.querySelector('.cognitizer-move-up').addEventListener('click', () => {
      this.moveCognitizer(key, 'up');
    });

    item.querySelector('.cognitizer-move-down').addEventListener('click', () => {
      this.moveCognitizer(key, 'down');
    });

    return item;
  }

  // Removed drag-and-drop functionality - now using up/down buttons

  updateSidebarOrder() {
    // Update the sidebar to reflect the new cognitizer order
    const cognitizerSection = document.querySelector('.cognitizer-dropdown-section');
    if (!cognitizerSection) return;
    
    // Get all cognitizer buttons
    const buttons = Array.from(cognitizerSection.querySelectorAll('div'));
    
    // Sort buttons based on new baseUrls order
    const sortedButtons = [];
    Object.keys(this.config.baseUrls).forEach(key => {
      const button = buttons.find(b => b.id === `${key}button`);
      if (button) {
        sortedButtons.push(button);
      }
    });
    
    // Remove all buttons and re-add in new order
    sortedButtons.forEach(button => {
      cognitizerSection.appendChild(button);
    });
  }

  moveCognitizer(key, direction) {
    const keys = Object.keys(this.config.baseUrls);
    const currentIndex = keys.indexOf(key);
    
    if (currentIndex === -1) return;
    
    let newIndex;
    if (direction === 'up' && currentIndex > 0) {
      newIndex = currentIndex - 1;
    } else if (direction === 'down' && currentIndex < keys.length - 1) {
      newIndex = currentIndex + 1;
    } else {
      return; // Can't move further
    }
    
    // Reorder the keys array
    const [movedKey] = keys.splice(currentIndex, 1);
    keys.splice(newIndex, 0, movedKey);
    
    // Create new baseUrls object in the new order
    const newBaseUrls = {};
    keys.forEach((k, index) => {
      const newKey = `custom${index + 1}`;
      newBaseUrls[newKey] = this.config.baseUrls[k];
    });
    
    // Update config and save
    this.config.baseUrls = newBaseUrls;
    this.saveSettings();
    
    // Reload the cognitizers list to reflect new order
    this.loadCognitizers();
    
    // Update sidebar order
    this.updateSidebarOrder();
  }

  updateCognitizer(key, field, value) {
    if (!this.config.baseUrls[key]) {
      this.config.baseUrls[key] = {};
    }
    this.config.baseUrls[key][field] = value;
    this.saveSettings();
  }

  removeCognitizer(key) {
    delete this.config.baseUrls[key];
    this.saveSettings();
    this.loadCognitizers();
  }

  addNewCognitizer() {
    // Find the next available custom key
    let newKey = 'custom1';
    let index = 1;
    while (this.config.baseUrls[newKey]) {
      index++;
      newKey = `custom${index}`;
    }

    // Add new cognitizer with default values
    this.config.baseUrls[newKey] = {
      name: `New Cognitizer ${index}`,
      url: 'https://example.com'
    };

    this.saveSettings();
    this.loadCognitizers();
  }

  confirmResetCognitizers() {
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
      <div class="confirm-content">
        <h3>Reset Cognitizers?</h3>
        <p>This will restore all cognitizers to their default values. Your custom cognitizers will be lost.</p>
        <div class="confirm-actions">
          <button class="action-button secondary" id="confirm-cancel">Cancel</button>
          <button class="action-button primary" id="confirm-reset">Reset</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    document.getElementById('confirm-cancel').addEventListener('click', () => {
      dialog.remove();
    });

    document.getElementById('confirm-reset').addEventListener('click', () => {
      // Reset to default cognitizers
      this.config.baseUrls = {
        custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
        custom2: { name: 'Claude', url: 'https://claude.ai/new' },
        custom3: { name: 'Gemini', url: 'https://gemini.google.com/' },
        custom4: { name: 'Mistral', url: 'https://chat.mistral.ai/chat' },
        custom5: { name: 'Copilot', url: 'https://copilot.microsoft.com/' },
        custom6: { name: 'Perplexity', url: 'https://www.perplexity.ai/' },
        custom7: { name: 'PoeCom', url: 'https://www.poe.com/' },
        custom8: { name: 'YouCom', url: 'https://www.you.com/' },
        custom9: { name: 'Perplexity Labs', url: 'https://labs.perplexity.ai/' },
        custom10: { name: 'HuggingFace', url: 'https://huggingface.co/chat/' },
        custom11: { name: 'OpenRouter', url: 'https://openrouter.ai/chat' },
        custom12: { name: 'TextGenWebUI', url: 'http://127.0.0.1:7860' },
        custom13: { name: 'Scholar', url: 'https://scholar.google.com/' },
        custom14: { name: 'YoutubeMusic', url: 'https://music.youtube.com/' },
        custom15: { name: 'Google', url: 'https://www.google.com/' }
      };
      
      this.saveSettings();
      this.loadCognitizers();
      dialog.remove();
    });
  }

  updateSetting(key, value) {
    this.config.settings[key] = value;
    this.saveSettings();
    
    // Apply setting immediately if needed
    if (key === 'preventMenuExpansion') {
      window.sidebar.setPreventExpansion(value);
    } else if (key === 'enableAdblocker') {
      ipcRenderer.send(value ? 'call-createAndUpdateaAblocker' : 'call-disableAdblocker');
    } else if (key === 'launchAtStartup') {
      ipcRenderer.send(value ? 'call-enableLaunchAtStartup' : 'call-disableLaunchAtStartup');
    }
  }

  saveSettings() {
    window.saveSettings(this.config);
  }

  saveShortcuts() {
    this.config.settings.shortcuts = shortcutManager.exportShortcuts();
    this.saveSettings();
    
    // Re-register shortcuts to apply changes immediately
    if (typeof window.reregisterKeyboardShortcuts === 'function') {
      window.reregisterKeyboardShortcuts();
    }
  }

  applyTheme(theme) {
    document.body.classList.remove('theme-light', 'theme-dark');
    if (theme !== 'system') {
      document.body.classList.add(`theme-${theme}`);
    }
  }

  show() {
    this.element.classList.add('visible');
    this.isVisible = true;
    document.body.classList.add('settings-open');
  }

  hide() {
    this.element.classList.remove('visible');
    this.isVisible = false;
    document.body.classList.remove('settings-open');
  }

  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }
}

// Create singleton instance
const settingsMenu = new SettingsMenu();

module.exports = settingsMenu;