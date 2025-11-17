const path = require('path');
const fs = require('fs');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');

// Mock modules
jest.mock('fs', () => {
  const originalFs = jest.requireActual('fs');
  return {
    ...originalFs,
    existsSync: jest.fn(),
    statSync: jest.fn(),
    promises: {
      readFile: jest.fn(),
      writeFile: jest.fn(),
    },
  };
});

jest.mock('electron', () => {
  return {
    BrowserWindow: {
      getAllWindows: jest.fn(),
    },
  };
});

jest.mock('cross-fetch');
jest.mock('os', () => ({
  homedir: jest.fn(() => '/mock-home'),
  platform: jest.fn(() => 'darwin'),
}));

jest.mock('@cliqz/adblocker-electron', () => {
  return {
    ElectronBlocker: {
      fromLists: jest.fn(),
      deserialize: jest.fn(),
    },
  };
});

// Import the function under test
const { createAndUpdateBlocker } = require('../utils/adblockerService');

describe('adblockerService', () => {
  // Reset mocks before each test
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock session objects
    const mockSession1 = { enableBlockingInSession: jest.fn() };
    const mockSession2 = { enableBlockingInSession: jest.fn() };

    // Mock windows with sessions
    const mockWindow1 = { webContents: { session: mockSession1 } };
    const mockWindow2 = { webContents: { session: mockSession2 } };

    // Setup getAllWindows mock
    require('electron').BrowserWindow.getAllWindows.mockReturnValue([mockWindow1, mockWindow2]);
  });

  test('createAndUpdateBlocker with fresh cache', async () => {
    // Setup mocks for fresh cache scenario
    const cachePath = path.join('/mock-home', '.instant-cognition', 'adblocker_cache.bin');
    const mockCacheStats = { mtimeMs: Date.now() }; // Recent file
    const mockCacheData = Buffer.from('mock-serialized-data');
    const mockBlocker = { enableBlockingInSession: jest.fn() };

    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue(mockCacheStats);
    fs.promises.readFile.mockResolvedValue(mockCacheData);
    ElectronBlocker.deserialize.mockResolvedValue(mockBlocker);

    // Call the function
    const result = await createAndUpdateBlocker();

    // Assertions
    expect(fs.existsSync).toHaveBeenCalledWith(cachePath);
    expect(fs.statSync).toHaveBeenCalledWith(cachePath);
    expect(fs.promises.readFile).toHaveBeenCalledWith(cachePath);
    expect(ElectronBlocker.deserialize).toHaveBeenCalledWith(mockCacheData);
    expect(result).toBe(mockBlocker);

    // Verify that blocking is enabled for all sessions
    const sessions = require('electron')
      .BrowserWindow.getAllWindows()
      .map((window) => window.webContents.session);
    expect(mockBlocker.enableBlockingInSession).toHaveBeenCalledTimes(sessions.length);
    sessions.forEach((session) => {
      expect(mockBlocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    });
  });

  test('createAndUpdateBlocker with existing cache but too old', async () => {
    // Setup mocks for old cache scenario
    const cachePath = path.join('/mock-home', '.instant-cognition', 'adblocker_cache.bin');
    const oneDayInMs = 24 * 60 * 60 * 1000;
    const mockCacheStats = { mtimeMs: Date.now() - (oneDayInMs + 1000) }; // Older than 24 hours
    const mockBlocker = {
      enableBlockingInSession: jest.fn(),
      serialize: jest.fn().mockResolvedValue(Buffer.from('new-serialized-data')),
    };

    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue(mockCacheStats);
    ElectronBlocker.fromLists.mockResolvedValue(mockBlocker);

    // Call the function
    const result = await createAndUpdateBlocker();

    // Assertions
    expect(fs.existsSync).toHaveBeenCalledWith(cachePath);
    expect(fs.statSync).toHaveBeenCalledWith(cachePath);
    expect(ElectronBlocker.fromLists).toHaveBeenCalled();
    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      cachePath,
      Buffer.from('new-serialized-data')
    );
    expect(result).toBe(mockBlocker);
  });

  test('createAndUpdateBlocker without existing cache', async () => {
    // Setup mocks for no cache scenario
    const cachePath = path.join('/mock-home', '.instant-cognition', 'adblocker_cache.bin');
    const mockBlocker = {
      enableBlockingInSession: jest.fn(),
      serialize: jest.fn().mockResolvedValue(Buffer.from('new-serialized-data')),
    };

    fs.existsSync.mockReturnValue(false);
    ElectronBlocker.fromLists.mockResolvedValue(mockBlocker);

    // Call the function
    const result = await createAndUpdateBlocker();

    // Assertions
    expect(fs.existsSync).toHaveBeenCalledWith(cachePath);
    expect(ElectronBlocker.fromLists).toHaveBeenCalled();
    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      cachePath,
      Buffer.from('new-serialized-data')
    );
    expect(result).toBe(mockBlocker);
  });
});
