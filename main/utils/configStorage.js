const path = require('path');
const fs = require('fs');
const {
  getAdblockerCachePath,
  getBackupPath,
  getConfigPath,
  getLegacyPathCandidates,
  getTrustedCertificatesPath,
} = require('../../shared/configPaths');

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function shouldSkipDiskPersistence(filePath) {
  return process.env.NODE_ENV === 'test'
    && typeof filePath === 'string'
    && filePath.startsWith('/mock');
}

function getBackupPathForConfig(configPath, defaultConfigPath = getConfigPath()) {
  if (configPath && configPath !== defaultConfigPath) {
    return configPath + '.bak';
  }
  return getBackupPath();
}

function migrateLegacyFile(targetPath, legacyPaths = []) {
  try {
    if (!targetPath || fs.existsSync(targetPath) || shouldSkipDiskPersistence(targetPath)) {
      return null;
    }

    ensureDirectory(targetPath);

    for (const candidate of legacyPaths) {
      if (!candidate || candidate === targetPath || !fs.existsSync(candidate)) continue;
      fs.copyFileSync(candidate, targetPath);
      return candidate;
    }
  } catch (_) {
    return null;
  }

  return null;
}

function migrateLegacyConfigFiles(configPath, defaultConfigPath = getConfigPath()) {
  if (!configPath || configPath !== defaultConfigPath) return;

  migrateLegacyFile(configPath, getLegacyPathCandidates('config.json'));
  migrateLegacyFile(
    getBackupPathForConfig(configPath, defaultConfigPath),
    getLegacyPathCandidates('config.json.bak')
  );
}

module.exports = {
  ensureDirectory,
  getAdblockerCachePath,
  getBackupPathForConfig,
  getConfigPath,
  getLegacyPathCandidates,
  getTrustedCertificatesPath,
  migrateLegacyConfigFiles,
  migrateLegacyFile,
  shouldSkipDiskPersistence,
};
