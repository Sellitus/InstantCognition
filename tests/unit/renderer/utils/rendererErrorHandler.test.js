/**
 * @jest-environment jsdom
 */

// The global error toast is the only signal a user gets for an uncaught
// renderer error. It fires once per session, so the counter it gates on must
// count uncaught errors only — counting console.error too silenced the toast
// for the whole session within seconds of startup.

jest.mock('electron', () => ({ ipcRenderer: { send: jest.fn() } }));
jest.mock('../../../../renderer/components/Toast', () => ({ error: jest.fn() }));

describe('rendererErrorHandler', () => {
  let handler;
  let toast;
  let originalConsoleError;

  beforeEach(() => {
    // resetModules gives each test a fresh handler instance (its uncaught
    // counter is per-instance) and a fresh Toast mock, so both must be
    // required after the reset.
    jest.resetModules();
    originalConsoleError = console.error;
    toast = require('../../../../renderer/components/Toast');
    handler = require('../../../../renderer/utils/rendererErrorHandler');
  });

  afterEach(() => {
    // The module replaces console.error on construction.
    console.error = originalConsoleError;
  });

  test('console.error alone never raises the toast', () => {
    console.error('adblocker cache miss');
    console.error('another routine failure');
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('the first uncaught error still toasts after console.error noise', () => {
    console.error('routine failure');
    console.error('another routine failure');

    handler.handleError({ type: 'JavaScript Error', message: 'boom' });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][0]).toBe('boom');
  });

  test('unhandled rejections count as uncaught', () => {
    handler.handleError({ type: 'Unhandled Promise Rejection', message: 'rejected' });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  test('only the first uncaught error toasts', () => {
    handler.handleError({ type: 'JavaScript Error', message: 'first' });
    handler.handleError({ type: 'JavaScript Error', message: 'second' });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
