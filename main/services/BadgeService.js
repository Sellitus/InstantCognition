// BadgeService — aggregates per-origin badge counts from the Badging API
// (`navigator.setAppBadge(n)` / `navigator.clearAppBadge()`) and applies
// the total to the app's dock icon (macOS/Linux) or overlay icon (Windows).
// Optionally folds in the unread notification count from NotificationService.

const { EventEmitter } = require('events');
const { app } = require('electron');

class BadgeService extends EventEmitter {
  constructor() {
    super();
    this._counts = new Map();
    this._notificationUnread = 0;
    this._mainWindow = null;
    this._includeNotifications = true;
  }

  /**
   * @param {Electron.BrowserWindow|null} mainWindow
   * @param {{ notificationService?: typeof import('./NotificationService') }} [deps]
   */
  initialize(mainWindow, { notificationService } = {}) {
    this._mainWindow = mainWindow || null;
    if (notificationService) {
      const recompute = () => {
        try { this._notificationUnread = notificationService.unreadCount(); }
        catch (_) { this._notificationUnread = 0; }
        this._apply();
      };
      notificationService.on('added', recompute);
      notificationService.on('dismissed', recompute);
      notificationService.on('cleared', recompute);
      notificationService.on('read-changed', recompute);
      recompute();
    }
    this._apply();
  }

  setForOrigin(origin, count) {
    const key = origin || '*';
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n === 0) this._counts.delete(key);
    else this._counts.set(key, n);
    this._apply();
  }

  clearForOrigin(origin) {
    this._counts.delete(origin || '*');
    this._apply();
  }

  clearAll() {
    this._counts.clear();
    this._apply();
  }

  total() {
    let sum = 0;
    for (const n of this._counts.values()) sum += n;
    if (this._includeNotifications) sum += this._notificationUnread;
    return sum;
  }

  _apply() {
    const total = this.total();
    try {
      if (process.platform === 'darwin' || process.platform === 'linux') {
        if (typeof app.setBadgeCount === 'function') app.setBadgeCount(total);
      } else if (process.platform === 'win32' && this._mainWindow && !this._mainWindow.isDestroyed()) {
        if (total > 0) this._mainWindow.setOverlayIcon(null, String(total));
        else this._mainWindow.setOverlayIcon(null, '');
      }
    } catch (err) { console.error('BadgeService apply failed:', err); }
    this.emit('changed', { total });
  }
}

module.exports = new BadgeService();
