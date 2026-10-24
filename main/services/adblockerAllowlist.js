// Helpers for the AdblockerService site allowlist. Kept in a separate file
// to keep AdblockerService under the architecture-integrity line cap.
const configService = require('./ConfigService');

// uBO-style exception filter: trust everything served from `host`.
function allowlistFilterFor(host) { return '@@||' + host + '^'; }

function loadAllowlistFromConfig() {
  const list = configService.get('settings.siteAllowlist', []);
  return Array.isArray(list) ? list.filter((h) => typeof h === 'string' && h) : [];
}

// Compute the minimal { added, removed } filter-rule diff between two
// host arrays (previous applied state vs desired new state). Returns
// arrays of filter strings ready to feed to engine.updateFromDiff().
function diffAllowlist(prev, next) {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const added = next.filter((h) => !prevSet.has(h)).map(allowlistFilterFor);
  const removed = prev.filter((h) => !nextSet.has(h)).map(allowlistFilterFor);
  return { added, removed };
}

module.exports = { allowlistFilterFor, loadAllowlistFromConfig, diffAllowlist };
