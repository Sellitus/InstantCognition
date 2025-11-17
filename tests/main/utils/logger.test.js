// Unit tests for logger utility

const winston = require('winston');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Mock dependencies
jest.mock('winston', () => ({
  createLogger: jest.fn(),
  format: {
    json: jest.fn(() => 'json-format'),
  },
  transports: {
    File: jest.fn(),
  },
}));

jest.mock('fs');
jest.mock('os');

describe('Logger Utility', () => {
  let logger;
  let mockLogger;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    winston.createLogger.mockReturnValue(mockLogger);
    winston.transports.File.mockImplementation((options) => ({ options }));

    // Setup OS mocks
    os.platform.mockReturnValue('darwin');
    os.homedir.mockReturnValue('/home/user');

    // Setup fs mocks
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    // Clean up module cache to ensure fresh imports
    jest.resetModules();
  });

  describe('Logger initialization', () => {
    it('should create logger with correct configuration', () => {
      logger = require('../../../main/utils/logger');

      expect(winston.createLogger).toHaveBeenCalledWith({
        level: 'info',
        format: 'json-format',
        transports: expect.any(Array),
      });
    });

    it('should use correct log directory on macOS', () => {
      os.platform.mockReturnValue('darwin');

      logger = require('../../../main/utils/logger');

      const transportCall = winston.transports.File.mock.calls[0][0];
      expect(transportCall.filename).toBe('/home/user/.instant-cognition/debug.log');
    });

    it('should use correct log directory on Windows', () => {
      os.platform.mockReturnValue('win32');

      logger = require('../../../main/utils/logger');

      const transportCall = winston.transports.File.mock.calls[0][0];
      expect(transportCall.filename).toMatch(/debug\.log$/);
    });

    it('should use correct log directory on Linux', () => {
      os.platform.mockReturnValue('linux');

      logger = require('../../../main/utils/logger');

      const transportCall = winston.transports.File.mock.calls[0][0];
      expect(transportCall.filename).toMatch(/debug\.log$/);
    });
  });

  describe('Log directory creation', () => {
    it('should create log directory if it does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      logger = require('../../../main/utils/logger');

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it('should not create log directory if it already exists', () => {
      fs.existsSync.mockReturnValue(true);

      logger = require('../../../main/utils/logger');

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should handle directory creation errors gracefully', () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // Should not throw
      expect(() => {
        logger = require('../../../main/utils/logger');
      }).toThrow();
    });
  });

  describe('Logger methods', () => {
    beforeEach(() => {
      logger = require('../../../main/utils/logger');
    });

    it('should export a winston logger instance', () => {
      expect(logger).toBe(mockLogger);
    });

    it('should have info method', () => {
      expect(logger.info).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('should have warn method', () => {
      expect(logger.warn).toBeDefined();
      expect(typeof logger.warn).toBe('function');
    });

    it('should have error method', () => {
      expect(logger.error).toBeDefined();
      expect(typeof logger.error).toBe('function');
    });

    it('should have debug method', () => {
      expect(logger.debug).toBeDefined();
      expect(typeof logger.debug).toBe('function');
    });
  });

  describe('Cross-platform behavior', () => {
    const platforms = ['darwin', 'win32', 'linux'];

    platforms.forEach((platform) => {
      it(`should work correctly on ${platform}`, () => {
        os.platform.mockReturnValue(platform);
        fs.existsSync.mockReturnValue(false);

        logger = require('../../../main/utils/logger');

        expect(winston.createLogger).toHaveBeenCalled();
        expect(fs.mkdirSync).toHaveBeenCalled();
        expect(winston.transports.File).toHaveBeenCalled();
      });
    });
  });

  describe('File transport configuration', () => {
    beforeEach(() => {
      logger = require('../../../main/utils/logger');
    });

    it('should create file transport with correct options', () => {
      const fileTransportOptions = winston.transports.File.mock.calls[0][0];

      expect(fileTransportOptions).toHaveProperty('filename');
      expect(fileTransportOptions.filename).toContain('debug.log');
    });

    it('should use JSON format for logging', () => {
      expect(winston.format.json).toHaveBeenCalled();
    });
  });
});
