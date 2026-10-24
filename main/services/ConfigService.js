const EventEmitter = require('events');
const fs = require('fs');
const { DEFAULT_CONFIG, migrateConfig } = require('../../shared/configDefaults');
const {
  getAdblockerCachePath,
  getConfigPath,
  getLegacyPathCandidates,
  getTrustedCertificatesPath,
  getBackupPathForConfig,
  migrateLegacyConfigFiles,
  migrateLegacyFile,
  ensureDirectory,
  shouldSkipDiskPersistence,
} = require('../utils/configStorage');

class ConfigService extends EventEmitter {
  constructor() {
    super();
    this.config = null;
    this._saveTimer = null;
    this._configPath = null;
    this.lastLoadStatus = null;
  }

  get configPath() {
    if (this._configPath) return this._configPath;
    this._configPath = ConfigService.getConfigPath();
    return this._configPath;
  }

  static getConfigPath() {
    return getConfigPath();
  }

  static getAcceptedCertsPath() {
    return getTrustedCertificatesPath();
  }

  static getAdblockerCachePath() {
    return getAdblockerCachePath();
  }

  static getLegacyPathCandidates(fileName) {
    return getLegacyPathCandidates(fileName);
  }

  static migrateLegacyFile(targetPath, legacyPaths = []) {
    return migrateLegacyFile(targetPath, legacyPaths);
  }

  loadConfig() {
    this.lastLoadStatus = null;

    try {
      const configPath = this.configPath;
      const backupPath = this._getBackupPath();
      migrateLegacyConfigFiles(configPath, ConfigService.getConfigPath());
      if (!shouldSkipDiskPersistence(configPath)) {
        ensureDirectory(configPath);
      }

      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf8');
        const parsedConfig = JSON.parse(data);
        const configSnapshot = JSON.stringify(parsedConfig);
        this.config = parsedConfig;
        this.config = migrateConfig(this.config, process.platform);
        if (JSON.stringify(this.config) !== configSnapshot) {
          this._writeSync();
        }
        try {
          if (this.config.state && this.config.state.windowBounds && this.config.state.windowBounds.x !== undefined) {
            fs.writeFileSync(backupPath, data);
          }
        } catch (err) {
          console.error('[ConfigService] backup write failed:', (err instanceof Error && err.message) || err);
        }
      } else {
        this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        this.config = migrateConfig(this.config, process.platform);
        if (!shouldSkipDiskPersistence(configPath)) {
          this._writeSync();
        }
      }
    } catch (error) {
      console.error('[ConfigService] Error loading config:', error);
      const backupPath = this._getBackupPath();
      try {
        if (fs.existsSync(backupPath)) {
          console.log('[ConfigService] Recovering from backup config');
          const backupData = fs.readFileSync(backupPath, 'utf8');
          this.config = JSON.parse(backupData);
          this.config = migrateConfig(this.config, process.platform);
          this.lastLoadStatus = 'recovered';
          this._writeSync();
          this.emit('loaded');
          return this.config;
        }
      } catch (backupError) {
        console.error('[ConfigService] Backup recovery also failed:', backupError);
      }
      this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      this.config = migrateConfig(this.config, process.platform);
      this.lastLoadStatus = 'defaults';
      if (!shouldSkipDiskPersistence(this.configPath)) {
        this._writeSync();
      }
    }
    this.emit('loaded');
    return this.config;
  }

  get(keyPath, defaultValue) {
    if (!this.config) this.loadConfig();

    if (!keyPath) return defaultValue;
    const parts = keyPath.split('.');
    let current = this.config;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return defaultValue;
      }
      current = current[part];
    }
    return current !== undefined ? current : defaultValue;
  }

  set(keyPath, value) {
    if (!this.config) this.loadConfig();

    const parts = keyPath.split('.');
    // Refuse path segments that would create own properties shadowing Object.prototype.
    // These segments are inert for ordinary config keys; rejecting them here costs nothing.
    for (const part of parts) {
      if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
        return;
      }
    }
    let current = this.config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }

    const lastKey = parts[parts.length - 1];
    const oldValue = current[lastKey];
    current[lastKey] = value;

    if (oldValue !== value) {
      this.emit('change', { path: keyPath, oldValue, newValue: value });
      this.emit(`change:${keyPath}`, value, oldValue);
    }

    this._scheduleSave();
  }

  update(updates) {
    if (!this.config) this.loadConfig();

    const deepMerge = (target, source) => {
      for (const key of Object.keys(source)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (
          source[key] &&
          typeof source[key] === 'object' &&
          !Array.isArray(source[key]) &&
          target[key] &&
          typeof target[key] === 'object' &&
          !Array.isArray(target[key])
        ) {
          deepMerge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
    };

    deepMerge(this.config, updates);
    this._scheduleSave();
  }

  replaceAll(newConfig) {
    if (!newConfig || typeof newConfig !== 'object') return;
    this.config = migrateConfig(JSON.parse(JSON.stringify(newConfig)), process.platform);
    this._scheduleSave();
  }

  getAll() {
    if (!this.config) this.loadConfig();
    return JSON.parse(JSON.stringify(this.config));
  }

  reset() {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.config = migrateConfig(this.config, process.platform);
    this._writeSync();
    this.emit('reset');
  }

  _scheduleSave() {
    if (shouldSkipDiskPersistence(this.configPath)) return;

    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._writeSync();
      this._saveTimer = null;
    }, 100);
    if (this._saveTimer && typeof this._saveTimer.unref === 'function') {
      this._saveTimer.unref();
    }
  }

  flushSync() {
    this.dispose();
    this._writeSync();
  }

  dispose() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  }

  _writeSync() {
    try {
      const configPath = this.configPath;
      if (shouldSkipDiskPersistence(configPath)) {
        this.emit('saved');
        return;
      }

      ensureDirectory(configPath);
      const data = JSON.stringify(this.config, null, 2);
      const tmpPath = configPath + '.tmp';
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, configPath);
      this.emit('saved');
    } catch (error) {
      console.error('[ConfigService] Error saving config:', error);
    }
  }

  _getBackupPath() {
    return getBackupPathForConfig(this._configPath || this.configPath, ConfigService.getConfigPath());
  }
}

module.exports = new ConfigService();
