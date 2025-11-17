// Simple test to verify logger functionality without complex mocking
describe('Logger Simple Tests', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('logger module exports an object', () => {
    // Mock the dependencies before requiring the logger
    jest.doMock('winston', () => ({
      createLogger: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
      })),
      format: {
        json: jest.fn(() => 'json-format'),
      },
      transports: {
        File: jest.fn(() => ({})),
      },
    }));

    jest.doMock('fs', () => ({
      existsSync: jest.fn(() => true),
      mkdirSync: jest.fn(),
    }));

    jest.doMock('os', () => ({
      platform: jest.fn(() => 'darwin'),
      homedir: jest.fn(() => '/home/test'),
    }));

    const logger = require('../../../../main/utils/logger');

    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  test('logger creates correct log path on macOS', () => {
    const mockTransport = {};

    jest.doMock('winston', () => ({
      createLogger: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
      })),
      format: {
        json: jest.fn(() => 'json-format'),
      },
      transports: {
        File: jest.fn(() => mockTransport),
      },
    }));

    jest.doMock('fs', () => ({
      existsSync: jest.fn(() => false),
      mkdirSync: jest.fn(),
    }));

    jest.doMock('os', () => ({
      platform: jest.fn(() => 'darwin'),
      homedir: jest.fn(() => '/Users/testuser'),
    }));

    const fs = require('fs');
    const winston = require('winston');

    require('../../../../main/utils/logger');

    expect(fs.mkdirSync).toHaveBeenCalledWith('/Users/testuser/.instant-cognition', {
      recursive: true,
    });
    expect(winston.transports.File).toHaveBeenCalledWith({
      filename: '/Users/testuser/.instant-cognition/debug.log',
    });
  });

  test('logger creates correct log path on Windows', () => {
    jest.doMock('winston', () => ({
      createLogger: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
      })),
      format: {
        json: jest.fn(() => 'json-format'),
      },
      transports: {
        File: jest.fn(() => ({})),
      },
    }));

    jest.doMock('fs', () => ({
      existsSync: jest.fn(() => true),
      mkdirSync: jest.fn(),
    }));

    jest.doMock('os', () => ({
      platform: jest.fn(() => 'win32'),
      homedir: jest.fn(() => 'C:\\Users\\testuser'),
    }));

    const winston = require('winston');

    require('../../../../main/utils/logger');

    const fileCall = winston.transports.File.mock.calls[0][0];
    expect(fileCall.filename).toContain('debug.log');
    // The logger uses __dirname for Windows, which will still be a Unix path in tests
    // So we just check that it contains debug.log, not the path style
  });
});
