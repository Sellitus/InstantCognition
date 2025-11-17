/**
 * Simple mock utility for testing error logging
 */
function logError(message, error) {
  console.error(message, error);
}

module.exports = {
  logError,
};
