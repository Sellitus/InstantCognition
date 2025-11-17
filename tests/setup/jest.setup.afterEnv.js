// Jest setup after environment - runs after test framework is set up
beforeEach(() => {
  // Reset all mocks before each test
  jest.clearAllMocks();
  jest.resetModules();

  // Reset global test state
  if (global.testState) {
    global.testState = {};
  }

  // Clear any test timers
  jest.clearAllTimers();
});

afterEach(() => {
  // Clean up any pending promises
  if (global.gc) {
    global.gc();
  }

  // Verify no unhandled promise rejections
  if (global.unhandledRejections && global.unhandledRejections.length > 0) {
    const errors = global.unhandledRejections;
    global.unhandledRejections = [];
    throw new Error(`Unhandled promise rejections: ${errors.map((e) => e.toString()).join(', ')}`);
  }
});

// Track unhandled promise rejections
global.unhandledRejections = [];
process.on('unhandledRejection', (reason) => {
  global.unhandledRejections.push(reason);
});

// Add custom Jest matchers
expect.extend({
  toBeWithinRange(received, floor, ceiling) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () => `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      };
    }
  },

  toHaveBeenCalledWithMatch(received, ...expectedArgs) {
    const calls = received.mock.calls;
    const pass = calls.some((call) =>
      expectedArgs.every((expectedArg, index) => {
        if (typeof expectedArg === 'function') {
          return expectedArg(call[index]);
        }
        return expect(call[index]).toEqual(expectedArg);
      })
    );

    if (pass) {
      return {
        message: () => `expected ${received} not to have been called with matching arguments`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to have been called with matching arguments`,
        pass: false,
      };
    }
  },

  toBeValidUrl(received) {
    let isValid = false;
    try {
      new URL(received);
      isValid = true;
    } catch (e) {
      isValid = false;
    }

    if (isValid) {
      return {
        message: () => `expected ${received} not to be a valid URL`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be a valid URL`,
        pass: false,
      };
    }
  },

  toBeElectronEvent(received) {
    const hasRequiredProps =
      received &&
      typeof received.sender === 'object' &&
      (typeof received.reply === 'function' || typeof received.returnValue !== 'undefined');

    if (hasRequiredProps) {
      return {
        message: () => `expected ${received} not to be an Electron IPC event`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be an Electron IPC event`,
        pass: false,
      };
    }
  },
});

// Performance monitoring for tests
let testStartTime;

beforeEach(() => {
  testStartTime = Date.now();
});

afterEach(() => {
  const testEndTime = Date.now();
  const duration = testEndTime - testStartTime;

  // Warn if test takes too long
  if (duration > 1000) {
    console.warn(`Test took ${duration}ms to complete`);
  }
});

// Memory leak detection helpers
if (global.gc) {
  afterEach(() => {
    global.gc();
  });
}
