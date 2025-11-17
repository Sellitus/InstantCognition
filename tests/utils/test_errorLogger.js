const { logError } = require('./errorLogger');

describe('errorLogger', () => {
  let originalConsoleError;
  let consoleErrorSpy;

  beforeEach(() => {
    // Save the original console.error and replace it with a Jest spy
    originalConsoleError = console.error;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore the original console.error
    consoleErrorSpy.mockRestore();
    console.error = originalConsoleError;
  });

  test('logError should call console.error with the provided message and error', () => {
    // Arrange
    const message = 'Test error message';
    const error = new Error('Test error');

    // Act
    logError(message, error);

    // Assert
    expect(consoleErrorSpy).toHaveBeenCalledWith(message, error);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  test('logError should handle missing error parameter', () => {
    // Arrange
    const message = 'Test error message';

    // Act
    logError(message);

    // Assert
    expect(consoleErrorSpy).toHaveBeenCalledWith(message, undefined);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});
