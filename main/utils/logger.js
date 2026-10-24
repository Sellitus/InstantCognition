const winston = require('winston');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Resolve a writable log directory for both packaged and dev runs. Prefer
// Electron's userData path; fall back to ~/.instant-cognition when electron
// isn't yet ready or this module is loaded outside an Electron context.
function resolveLogDir() {
  try {
    const electron = require('electron');
    const app = electron && electron.app;
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'logs');
    }
  } catch (_) { /* electron not available */ }
  return path.join(os.homedir(), '.instant-cognition', 'logs');
}

const logDir = resolveLogDir();
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const VALID_LEVELS = ['error', 'warn', 'info', 'debug'];

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.File({ filename: path.join(logDir, 'debug.log') })],
});

// Allow runtime level updates from configService (settings.logLevel).
/** @type {any} */ (logger).setLevel = function setLevel(level) {
  if (typeof level !== 'string') return;
  const lc = level.toLowerCase();
  if (!VALID_LEVELS.includes(lc)) return;
  logger.level = lc;
  for (const t of logger.transports || []) { try { /** @type {any} */ (t).level = lc; } catch (_) { /* ignore */ } }
};

module.exports = logger;
