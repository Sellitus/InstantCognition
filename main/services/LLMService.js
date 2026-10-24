// LLMService — compatibility shim.
// The lifecycle logic lives in ./llm/LLMManager.js (split out so this file
// stays under the architecture-integrity 265-line cap as backend support
// grows). Re-exported here so existing `require('./services/LLMService')`
// callers — and the test suite — are unaffected by the move.
const manager = require('./llm/LLMManager');

module.exports = manager;
module.exports.LLMManager = manager.LLMManager;
