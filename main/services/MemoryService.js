/**
 * MemoryService - Periodic memory monitoring and cleanup.
 * Monitors process memory usage and triggers cleanup at thresholds.
 */
const DEFAULT_MEMORY_MB = 800;
const DEFAULT_CRITICAL_MB = 1200;

class MemoryService {
  constructor() {
    this.mainWindow = null;
    this.memoryInterval = null;
    this.cookieInterval = null;
    this._gcSuspended = false;
    this.MEMORY_CHECK_INTERVAL = 120000; // 2 minutes
    this.COOKIE_FLUSH_INTERVAL = 3600000; // 1 hour
    // Defaults preserved for tests; runtime values come from configService
    // via _memoryThreshold() / _criticalThreshold() once bound.
    this.MEMORY_THRESHOLD = DEFAULT_MEMORY_MB * 1024 * 1024;
    this.CRITICAL_THRESHOLD = DEFAULT_CRITICAL_MB * 1024 * 1024;
    this._configService = null;
  }

  bindConfig(cs) { this._configService = cs; }

  _memoryThreshold() {
    if (!this._configService || typeof this._configService.get !== 'function') return this.MEMORY_THRESHOLD;
    const mb = this._configService.get('settings.memorySaverThresholdMB', DEFAULT_MEMORY_MB);
    return Number.isFinite(mb) && mb > 0 ? Math.floor(mb) * 1024 * 1024 : this.MEMORY_THRESHOLD;
  }

  _criticalThreshold() {
    if (!this._configService || typeof this._configService.get !== 'function') return this.CRITICAL_THRESHOLD;
    const mb = this._configService.get('settings.memoryCriticalThresholdMB', DEFAULT_CRITICAL_MB);
    return Number.isFinite(mb) && mb > 0 ? Math.floor(mb) * 1024 * 1024 : this.CRITICAL_THRESHOLD;
  }

  start(mainWindow) {
    this.mainWindow = mainWindow;
    this._startMemoryMonitoring();
    this._startCookieFlush();
    if (typeof this._visibilityUnsub !== 'function') {
      try {
        const vis = require('./visibilityThrottling');
        if (vis && typeof vis.onSuspend === 'function' && typeof vis.onResume === 'function') {
          const offSuspend = vis.onSuspend(() => { this._gcSuspended = true; });
          const offResume = vis.onResume(() => { this._gcSuspended = false; });
          this._visibilityUnsub = () => { offSuspend(); offResume(); };
        }
      } catch (_) { /* visibility hooks optional */ }
    }
  }

  cleanup() {
    if (this.memoryInterval) {
      clearInterval(this.memoryInterval);
      this.memoryInterval = null;
    }
    if (this.cookieInterval) {
      clearInterval(this.cookieInterval);
      this.cookieInterval = null;
    }
  }

  _startMemoryMonitoring() {
    this.memoryInterval = setInterval(async () => {
      try {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

        const memoryInfo = process.memoryUsage();
        const workingSetSize = memoryInfo.rss || 0;

        const memThreshold = this._memoryThreshold();
        const critThreshold = this._criticalThreshold();

        if (workingSetSize > memThreshold) {
          console.log(`Memory cleanup triggered: ${Math.round(workingSetSize / 1024 / 1024)}MB`);

          try {
            if (!this.mainWindow.isDestroyed()) {
              await this.mainWindow.webContents.session.clearCache();
            }
          } catch (cacheErr) {
            console.error('Cache clear failed:', cacheErr);
          }
        }

        if (workingSetSize > critThreshold) {
          console.log(`Critical memory cleanup: ${Math.round(workingSetSize / 1024 / 1024)}MB`);

          try {
            if (!this.mainWindow.isDestroyed()) {
              // Service workers are deliberately NOT cleared: deregistering one
              // out from under an already-loaded SPA (ChatGPT, Claude, Gemini)
              // breaks that tab until it is reloaded by hand.
              await this.mainWindow.webContents.session.clearStorageData({
                storages: ['appcache', 'shadercache'],
              });
            }
          } catch (storageErr) {
            console.error('Storage data clear failed:', storageErr);
          }
        }

        // Force garbage collection if available (only when above threshold AND
        // the window is visible). A forced GC is a synchronous main-thread
        // stall — bad enough to hurt a fullscreen game running in the foreground
        // when InstantCognition is hiding.
        if (global.gc && workingSetSize > memThreshold && !this._gcSuspended) {
          global.gc();
          setTimeout(() => {
            if (global.gc && !this._gcSuspended) global.gc();
          }, 500);
        }
      } catch (error) {
        console.error('Memory monitoring error:', error);
      }
    }, this.MEMORY_CHECK_INTERVAL);
    if (typeof this.memoryInterval.unref === 'function') this.memoryInterval.unref();
  }

  _startCookieFlush() {
    this.cookieInterval = setInterval(async () => {
      try {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          await this.mainWindow.webContents.session.cookies.flushStore();
          console.log('Cookie store flushed');
        }
      } catch (error) {
        console.error('Cookie flush error:', error);
      }
    }, this.COOKIE_FLUSH_INTERVAL);
    if (typeof this.cookieInterval.unref === 'function') this.cookieInterval.unref();
  }
}

module.exports = new MemoryService();
