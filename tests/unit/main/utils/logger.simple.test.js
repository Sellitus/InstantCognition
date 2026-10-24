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

  test('logger writes into Electron userData/logs when app is available', () => {
    const mockTransport = {};

    jest.doMock('winston', () => ({
      createLogger: jest.fn(() => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() })),
      format: { json: jest.fn(() => 'json-format') },
      transports: { File: jest.fn(() => mockTransport) },
    }));
    jest.doMock('fs', () => ({ existsSync: jest.fn(() => false), mkdirSync: jest.fn() }));
    jest.doMock('electron', () => ({ app: { getPath: jest.fn(() => '/Users/testuser/Library/Application Support/InstantCognition') } }));

    const fs = require('fs');
    const winston = require('winston');
    require('../../../../main/utils/logger');

    expect(fs.mkdirSync).toHaveBeenCalledWith('/Users/testuser/Library/Application Support/InstantCognition/logs', { recursive: true });
    expect(winston.transports.File).toHaveBeenCalledWith({
      filename: '/Users/testuser/Library/Application Support/InstantCognition/logs/debug.log',
    });
  });

  test('logger falls back to ~/.instant-cognition/logs when electron unavailable', () => {
    jest.doMock('winston', () => ({
      createLogger: jest.fn(() => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() })),
      format: { json: jest.fn(() => 'json-format') },
      transports: { File: jest.fn(() => ({})) },
    }));
    jest.doMock('fs', () => ({ existsSync: jest.fn(() => true), mkdirSync: jest.fn() }));
    jest.doMock('os', () => ({ platform: jest.fn(() => 'win32'), homedir: jest.fn(() => '/home/u') }));
    jest.doMock('electron', () => { throw new Error('electron not available'); });

    const winston = require('winston');
    require('../../../../main/utils/logger');

    const fileCall = winston.transports.File.mock.calls[0][0];
    expect(fileCall.filename).toBe('/home/u/.instant-cognition/logs/debug.log');
  });
});
