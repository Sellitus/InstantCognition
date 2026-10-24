/**
 * Platform-specific config path resolution.
 * Prefers Electron's userData directory when available.
 */
const path = require('path');
const os = require('os');

function getFallbackConfigDir() {
  return path.join(os.homedir(), '.instant-cognition');
}

function getConfigDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch (_) {}

  return getFallbackConfigDir();
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

function getBackupPath() {
  return getConfigPath() + '.bak';
}

function getTrustedCertificatesPath() {
  return path.join(getConfigDir(), 'trusted_certificates.json');
}

function getAdblockerCachePath() {
  return path.join(getConfigDir(), 'adblocker_cache.bin');
}

function getLegacyPathCandidates(fileName) {
  const candidates = [
    path.join(getFallbackConfigDir(), fileName),
    path.join(__dirname, '..', fileName),
  ];

  if (typeof process !== 'undefined' && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app', fileName));
  }

  return [...new Set(candidates)];
}

module.exports = {
  getAdblockerCachePath,
  getBackupPath,
  getConfigDir,
  getConfigPath,
  getLegacyPathCandidates,
  getTrustedCertificatesPath,
};
