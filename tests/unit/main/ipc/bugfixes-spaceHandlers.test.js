const { ipcMain, webContents } = require('electron');

// Mock electron with webContents.fromId
jest.mock('electron', () => {
  const mockIpcMain = {
    on: jest.fn(),
    handle: jest.fn(),
    removeHandler: jest.fn(),
  };

  const mockWebContentsInstance = {
    setBackgroundThrottling: jest.fn(),
    id: 99,
  };

  return {
    ipcMain: mockIpcMain,
    webContents: {
      fromId: jest.fn((id) => {
        if (id === 99) return mockWebContentsInstance;
        return null;
      }),
    },
    _mockWebContentsInstance: mockWebContentsInstance,
  };
});

const { register } = require('../../../../main/ipc/spaceHandlers');

describe('spaceHandlers bug fixes', () => {
  let spaceStates;
  let handlers;
  let mainWindow;

  beforeEach(() => {
    spaceStates = new Map();
    mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: jest.fn(),
        setBackgroundThrottling: jest.fn(),
      },
    };

    // Clear ipcMain.on mock
    const { ipcMain } = require('electron');
    ipcMain.on.mockClear();

    register(mainWindow, { spaceStates });

    // Collect registered handlers
    handlers = {};
    ipcMain.on.mock.calls.forEach(([channel, handler]) => {
      handlers[channel] = handler;
    });
  });

  // ================================================================
  // MEDIUM #3: space-activity must throttle the correct webContents
  // Spec: event.sender is always the main window's webContents, not the
  // webview's. The fix sends webContentsId from the renderer and uses
  // webContents.fromId() to target the correct webview.
  // ================================================================
  describe('MEDIUM: space-activity targets correct webContents', () => {
    test('resolves the webview webContents by id rather than event.sender', () => {
      const { webContents: wcModule } = require('electron');
      const mockSender = { setBackgroundThrottling: jest.fn() };

      handlers['space-activity']({ sender: mockSender }, {
        spaceId: 'custom1',
        isActive: true,
        webContentsId: 99,
      });

      expect(wcModule.fromId).toHaveBeenCalledWith(99);
      expect(spaceStates.get('custom1')).toMatchObject({ isActive: true });
    });

    test('tolerates a missing webContentsId', () => {
      const mockSender = { setBackgroundThrottling: jest.fn() };

      expect(() => handlers['space-activity']({ sender: mockSender }, {
        spaceId: 'custom2',
        isActive: true,
      })).not.toThrow();
      expect(spaceStates.get('custom2')).toMatchObject({ isActive: true });
    });

    test('tolerates an unresolvable webContentsId', () => {
      const mockSender = { setBackgroundThrottling: jest.fn() };

      expect(() => handlers['space-activity']({ sender: mockSender }, {
        spaceId: 'custom3',
        isActive: true,
        webContentsId: 999, // fromId returns null
      })).not.toThrow();
      expect(spaceStates.get('custom3')).toMatchObject({ isActive: true });
    });

    // Regression guard. setBackgroundThrottling on an already-hidden guest
    // force-clears Chromium's is_hidden_ flag; the FrameEvictor then evicts the
    // compositor frames on its ~5 min timer and the pane renders blank until the
    // app restarts. Neither the webview's webContents nor event.sender may be
    // touched, on any code path or timer.
    test('never throttles any webContents, however much time passes', () => {
      jest.useFakeTimers();
      try {
        const { _mockWebContentsInstance } = require('electron');
        _mockWebContentsInstance.setBackgroundThrottling.mockClear();
        const mockSender = { setBackgroundThrottling: jest.fn() };

        handlers['space-activity']({ sender: mockSender }, {
          spaceId: 'custom1', isActive: false, webContentsId: 99,
        });
        handlers['space-activity']({ sender: mockSender }, {
          spaceId: 'custom1', isActive: true, webContentsId: 99,
        });
        jest.advanceTimersByTime(60 * 60 * 1000);

        expect(_mockWebContentsInstance.setBackgroundThrottling).not.toHaveBeenCalled();
        expect(mockSender.setBackgroundThrottling).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
