// conversationStore — keeps multi-turn agent conversations sharded by scope.
//
// One in-process Map keyed by either '__global__' (the global agent thread)
// or 'tab:<spaceId>' (a per-tab thread bound to a specific browser tab/space).
// spaceId — not webContentsId — is the per-tab key, because the spaceId
// survives webview replacement (e.g. home-reset rebuilds the <webview> but
// keeps the same spaceId), so a tab's conversation does not vanish when its
// page is reloaded.

const GLOBAL_KEY = '__global__';

/** @param {{ scope?: string, tabId?: string|number }} [ref] */
function keyFor({ scope, tabId } = {}) {
  if (scope === 'tab' && tabId) return 'tab:' + String(tabId);
  return GLOBAL_KEY;
}

function createStore() {
  const map = new Map();
  return {
    keyFor,
    get(scopeOrKey) {
      const key = typeof scopeOrKey === 'string' ? scopeOrKey : keyFor(scopeOrKey);
      return map.get(key) || null;
    },
    set(scopeOrKey, convo) {
      const key = typeof scopeOrKey === 'string' ? scopeOrKey : keyFor(scopeOrKey);
      map.set(key, convo);
      return convo;
    },
    has(scopeOrKey) {
      const key = typeof scopeOrKey === 'string' ? scopeOrKey : keyFor(scopeOrKey);
      const c = map.get(key);
      return !!(c && Array.isArray(c.messages) && c.messages.length);
    },
    clear(scopeOrKey) {
      // No args clears EVERY conversation. With a key, clears just that one.
      if (scopeOrKey === undefined) { map.clear(); return; }
      const key = typeof scopeOrKey === 'string' ? scopeOrKey : keyFor(scopeOrKey);
      map.delete(key);
    },
    size() { return map.size; },
  };
}

module.exports = { createStore, keyFor, GLOBAL_KEY };
