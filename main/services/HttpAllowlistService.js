const configService = require('./ConfigService');

class HttpAllowlistService {
  constructor() {
    this._appliedOrigins = new Set();
  }

  /**
   * Extract HTTP origins from spaces config.
   * @param {object} spaces - config.spaces
   * @returns {Set<string>} e.g. Set(["http://127.0.0.1:7860"])
   */
  static computeHttpOrigins(spaces) {
    const origins = new Set();
    if (!spaces || typeof spaces !== 'object') return origins;
    for (const entry of Object.values(spaces)) {
      if (!entry || !entry.url) continue;
      try {
        const parsed = new URL(entry.url);
        if (parsed.protocol === 'http:') {
          origins.add(parsed.origin);
        }
      } catch (_) {
        // Malformed URL, skip
      }
    }
    return origins;
  }

  /**
   * Apply Chromium command-line switch for HTTP origins.
   * MUST be called before app.whenReady().
   * @param {Electron.App} app
   */
  applyStartupSwitch(app) {
    const spaces = configService.get('spaces', {});
    const origins = HttpAllowlistService.computeHttpOrigins(spaces);
    this._appliedOrigins = origins;
    if (origins.size > 0) {
      const originList = [...origins].join(',');
      app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', originList);
      console.log('[HttpAllowlist] Whitelisted HTTP origins:', originList);
    }
  }

  get appliedOrigins() {
    return this._appliedOrigins;
  }
}

module.exports = new HttpAllowlistService();
