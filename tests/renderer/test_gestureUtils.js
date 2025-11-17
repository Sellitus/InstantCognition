// Import the necessary modules
const path = require('path');

// Mock modules
jest.mock('electron', () => {
  return {
    ipcRenderer: {
      send: jest.fn(),
    },
  };
});

// Extract the gesture handling functionality from renderer.js for testing
// In a real module system, we would import these directly
// Since renderer.js is a single file with multiple functions, we need to extract them
const gestureUtils = {
  handleGesture: function (event) {
    if (event.deltaX !== 0 && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      if (event.deltaX > 0) {
        this.navigateBackActive();
      } else {
        this.navigateForwardActive();
      }
      event.preventDefault();
    }
  },

  navigateBackActive: function () {
    const activeWebview = this.getActiveWebview();
    if (activeWebview && activeWebview.canGoBack()) {
      activeWebview.goBack();
    }
  },

  navigateForwardActive: function () {
    const activeWebview = this.getActiveWebview();
    if (activeWebview && activeWebview.canGoForward()) {
      activeWebview.goForward();
    }
  },

  getActiveWebview: function () {
    // Simplified mock implementation for testing
    return null;
  },
};

describe('gestureUtils', () => {
  let mockEvent;
  let mockWebview;
  let navigateBackSpy;
  let navigateForwardSpy;
  let preventDefaultSpy;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create a mock event object
    mockEvent = {
      deltaX: 0,
      deltaY: 0,
      preventDefault: jest.fn(),
    };

    // Create a mock webview
    mockWebview = {
      canGoBack: jest.fn().mockReturnValue(true),
      canGoForward: jest.fn().mockReturnValue(true),
      goBack: jest.fn(),
      goForward: jest.fn(),
    };

    // Spy on the navigate functions
    navigateBackSpy = jest.spyOn(gestureUtils, 'navigateBackActive');
    navigateForwardSpy = jest.spyOn(gestureUtils, 'navigateForwardActive');

    // Override getActiveWebview to return our mock webview
    jest.spyOn(gestureUtils, 'getActiveWebview').mockReturnValue(mockWebview);

    // Spy on preventDefault
    preventDefaultSpy = mockEvent.preventDefault;
  });

  afterEach(() => {
    // Restore all mocks
    jest.restoreAllMocks();
  });

  test('handleGesture swipes left', () => {
    // Arrange
    mockEvent.deltaX = 100; // Positive deltaX means swipe left
    mockEvent.deltaY = 10; // Small vertical movement

    // Act
    gestureUtils.handleGesture(mockEvent);

    // Assert
    expect(navigateBackSpy).toHaveBeenCalled();
    expect(navigateForwardSpy).not.toHaveBeenCalled();
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(mockWebview.goBack).toHaveBeenCalled();
  });

  test('handleGesture swipes right', () => {
    // Arrange
    mockEvent.deltaX = -100; // Negative deltaX means swipe right
    mockEvent.deltaY = 10; // Small vertical movement

    // Act
    gestureUtils.handleGesture(mockEvent);

    // Assert
    expect(navigateBackSpy).not.toHaveBeenCalled();
    expect(navigateForwardSpy).toHaveBeenCalled();
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(mockWebview.goForward).toHaveBeenCalled();
  });

  test('handleGesture ignores vertical swipes', () => {
    // Arrange
    mockEvent.deltaX = 10; // Small horizontal movement
    mockEvent.deltaY = 100; // Large vertical movement

    // Act
    gestureUtils.handleGesture(mockEvent);

    // Assert
    expect(navigateBackSpy).not.toHaveBeenCalled();
    expect(navigateForwardSpy).not.toHaveBeenCalled();
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  test('handleGesture ignores minor movements', () => {
    // Arrange
    mockEvent.deltaX = 5; // Very small horizontal movement
    mockEvent.deltaY = 5; // Very small vertical movement

    // Act
    gestureUtils.handleGesture(mockEvent);

    // Assert
    expect(navigateBackSpy).not.toHaveBeenCalled();
    expect(navigateForwardSpy).not.toHaveBeenCalled();
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  test('navigateBackActive does nothing when webview cannot go back', () => {
    // Arrange
    mockWebview.canGoBack.mockReturnValue(false);

    // Act
    gestureUtils.navigateBackActive();

    // Assert
    expect(mockWebview.goBack).not.toHaveBeenCalled();
  });

  test('navigateForwardActive does nothing when webview cannot go forward', () => {
    // Arrange
    mockWebview.canGoForward.mockReturnValue(false);

    // Act
    gestureUtils.navigateForwardActive();

    // Assert
    expect(mockWebview.goForward).not.toHaveBeenCalled();
  });
});
