const { globalShortcut } = require('electron');
const os = require('os');
const { execFileSync } = require('child_process');
const configService = require('./ConfigService');
const { errMsg } = require('../../shared/errMsg');

// Detect macOS version for Spotlight shortcut conflict warning
const isNewerMacOS = (() => {
  if (process.platform !== 'darwin') return false;
  try {
    const release = os.release().split('.');
    return parseInt(release[0], 10) >= 23; // macOS 14 Sonoma+
  } catch (_) {
    return false;
  }
})();

const isMacOS = process.platform === 'darwin';

class ShortcutService {
  constructor() {
    this.mainWindow = null;
    this.rebuildMenus = null;
    this.toggleShortcut = isMacOS ? 'Alt+Space' : 'CmdOrCtrl+Space';
    this.lockShortcut = 'CmdOrCtrl+Alt+L';
    this.voiceShortcut = 'CmdOrCtrl+Shift+V';
    this.quitShortcut = 'CmdOrCtrl+Q';
    this.toggleLocked = false;
    this._lastToggleTime = 0;
    this._lastLockTime = 0;
    this._lastVoiceTime = 0;
  }

  /**
   * Must be called after mainWindow is created.
   * @param {import('electron').BrowserWindow} mainWindow
   * @param {Function} [rebuildMenus] - called after shortcut changes
   */
  initialize(mainWindow, rebuildMenus) {
    this.mainWindow = mainWindow;
    this.rebuildMenus = rebuildMenus || (() => {});

    // Load shortcuts from config if available
    const config = configService.getAll();
    if (config.settings && config.settings.shortcuts) {
      const s = config.settings.shortcuts;
      if (s['window.toggle'] && s['window.toggle'].key) {
        this.toggleShortcut = s['window.toggle'].key;
      }
      if (s['window.lock'] && s['window.lock'].key) {
        this.lockShortcut = s['window.lock'].key;
      }
    }

    this.registerToggle();
    this.registerLock();
    this.registerVoice();
  }

  // Register the voice-input global hotkey. Fires on press; the renderer
  // toggles the VoiceCaptureOverlay (tap-to-start, tap-or-silence to stop).
  // Press-to-talk semantics aren't available via Electron's globalShortcut
  // (no release event); the in-window keyup listener in the overlay handles
  // press-to-talk when the window already has focus.
  registerVoice() {
    const success = globalShortcut.register(this.voiceShortcut, () => {
      if (Date.now() - this._lastVoiceTime < 50) return;
      this._lastVoiceTime = Date.now();
      if (this.mainWindow && !this.mainWindow.isVisible()) { try { this.mainWindow.show(); } catch (err) { console.warn('[SHORTCUT] voice hotkey: mainWindow.show() failed:', errMsg(err)); } }
      try { this.mainWindow && this.mainWindow.webContents && this.mainWindow.webContents.send('voice:hotkey-toggle'); } catch (err) { console.warn('[SHORTCUT] voice hotkey: send(voice:hotkey-toggle) failed:', errMsg(err)); }
    });
    if (!success) {
      console.warn(`[SHORTCUT] Failed to register voice shortcut "${this.voiceShortcut}"`);
      this.notifyRegisterFailure(this.voiceShortcut);
    }
    return success;
  }

  /**
   * Tell the renderer that a global shortcut could not be registered (the
   * combo is owned by the OS or another app) so it can surface a conflict
   * indicator instead of the hotkey silently dying. No-op while the window
   * is absent; a destroyed contents throws and is caught and logged.
   */
  notifyRegisterFailure(key) {
    try {
      this.mainWindow && this.mainWindow.webContents && this.mainWindow.webContents.send('shortcut:register-failed', { shortcut: key });
    } catch (err) {
      console.warn(`[SHORTCUT] send(shortcut:register-failed) failed:`, err instanceof Error ? err.message : err);
    }
  }

  toggleWindow() {
    if (!this.mainWindow) return;

    if (this.mainWindow.isVisible()) {
      if (process.platform === 'darwin') {
        let stageManagerEnabled = false;
        try {
          // Read Stage Manager system setting (hardcoded command, not user input)
          const result = execFileSync('defaults', ['read', 'com.apple.WindowManager', 'GloballyEnabled'])
            .toString()
            .trim();
          stageManagerEnabled = result === '1';
        } catch (err) { console.warn('[SHORTCUT] Stage Manager detection failed, assuming disabled:', errMsg(err)); }

        if (stageManagerEnabled) {
          this.mainWindow.hide();
        } else {
          if (this.mainWindow.isFocused()) {
            this.mainWindow.hide();
          } else {
            this.mainWindow.focus();
          }
        }
      } else {
        if (this.mainWindow.isFocused()) {
          this.mainWindow.hide();
        } else {
          this.mainWindow.focus();
        }
      }
    } else {
      this.mainWindow.show();
    }
  }

  registerToggle() {
    const success = globalShortcut.register(this.toggleShortcut, () => {
      if (Date.now() - this._lastToggleTime < 50) return;
      this._lastToggleTime = Date.now();
      this.toggleWindow();
    });
    if (!success) {
      console.warn(
        `[SHORTCUT] Failed to register toggle shortcut "${this.toggleShortcut}"` +
          (isNewerMacOS ? ' — macOS system shortcut conflict likely.' : '.') +
          ' Menu accelerator will be used as fallback.'
      );
      this.notifyRegisterFailure(this.toggleShortcut);
    } else {
      console.log(`[SHORTCUT] Toggle shortcut registered: "${this.toggleShortcut}"`);
    }
    return success;
  }

  unregisterToggle() {
    globalShortcut.unregister(this.toggleShortcut);
  }

  registerLock() {
    const success = globalShortcut.register(this.lockShortcut, () => {
      if (Date.now() - this._lastLockTime < 100) return;

      if (this.toggleLocked) {
        this.toggleLocked = false;
        this.registerToggle();
      } else {
        this.toggleLocked = true;
        this.unregisterToggle();
      }

      this._lastLockTime = Date.now();
    });
    if (!success) {
      console.warn(
        `[SHORTCUT] Failed to register lock shortcut "${this.lockShortcut}"` +
          (isNewerMacOS ? ' — macOS system shortcut conflict likely.' : '.') +
          ' Menu accelerator will be used as fallback.'
      );
      this.notifyRegisterFailure(this.lockShortcut);
    } else {
      console.log(`[SHORTCUT] Lock shortcut registered: "${this.lockShortcut}"`);
    }
    return success;
  }

  /**
   * Update a shortcut binding.
   * @param {string} action - 'register', 'unregister', 'window.toggle', or 'window.lock'
   * @param {string} key - accelerator string
   * @returns {{ success: boolean }}
   */
  updateShortcut(action, key) {
    if (action === 'register' || action === 'window.toggle') {
      globalShortcut.unregister(this.toggleShortcut);
      this.toggleShortcut = key;

      const config = configService.getAll();
      if (!config.settings) config.settings = {};
      if (!config.settings.shortcuts) config.settings.shortcuts = {};
      config.settings.shortcuts['window.toggle'] = { key, description: 'Toggle Window' };
      configService.replaceAll(config);

      const success = this.registerToggle();
      if (this.rebuildMenus) this.rebuildMenus();
      return { success };
    } else if (action === 'window.lock') {
      globalShortcut.unregister(this.lockShortcut);
      this.lockShortcut = key;

      const config = configService.getAll();
      if (!config.settings) config.settings = {};
      if (!config.settings.shortcuts) config.settings.shortcuts = {};
      config.settings.shortcuts['window.lock'] = { key, description: 'Lock Shortcuts' };
      configService.replaceAll(config);

      const success = this.registerLock();
      if (this.rebuildMenus) this.rebuildMenus();
      return { success };
    } else if (action === 'unregister') {
      globalShortcut.unregister(key);
      return { success: true };
    }
    return { success: false };
  }

  unregisterAll() {
    globalShortcut.unregisterAll();
  }

  get isLocked() {
    return this.toggleLocked;
  }
}

module.exports = new ShortcutService();
