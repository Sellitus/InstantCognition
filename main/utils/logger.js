const winston = require('winston');
const path = require('path');
const os = require('os');
const fs = require('fs');

const logDir =
  os.platform() === 'darwin'
    ? path.join(os.homedir(), '.instant-cognition')
    : path.join(__dirname, '../../');

if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.File({ filename: path.join(logDir, 'debug.log') })],
});

module.exports = logger;
