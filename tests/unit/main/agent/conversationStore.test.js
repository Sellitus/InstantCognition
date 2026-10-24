const { createStore, keyFor, GLOBAL_KEY } = require('../../../../main/agent/conversationStore');

describe('conversationStore.keyFor', () => {
  test('defaults to global', () => {
    expect(keyFor()).toBe(GLOBAL_KEY);
    expect(keyFor({})).toBe(GLOBAL_KEY);
    expect(keyFor({ scope: 'global' })).toBe(GLOBAL_KEY);
  });

  test('builds tab keys from scope + tabId', () => {
    expect(keyFor({ scope: 'tab', tabId: 'chatgpt' })).toBe('tab:chatgpt');
    expect(keyFor({ scope: 'tab', tabId: 42 })).toBe('tab:42');
  });

  test('falls back to global when scope is tab but tabId is missing', () => {
    // Otherwise we would silently shard tabless requests under a single
    // bucket that no one can address — global is the only sane fallback.
    expect(keyFor({ scope: 'tab' })).toBe(GLOBAL_KEY);
    expect(keyFor({ scope: 'tab', tabId: '' })).toBe(GLOBAL_KEY);
  });
});

describe('conversationStore (Map-keyed)', () => {
  let store;
  beforeEach(() => { store = createStore(); });

  test('get/set/has by scope object', () => {
    expect(store.has({ scope: 'global' })).toBe(false);
    store.set({ scope: 'global' }, { messages: [{ role: 'system', content: 's' }] });
    expect(store.has({ scope: 'global' })).toBe(true);
    expect(store.get({ scope: 'global' }).messages).toHaveLength(1);
  });

  test('global and tab scopes are independent', () => {
    store.set({ scope: 'global' }, { messages: ['G1'] });
    store.set({ scope: 'tab', tabId: 'a' }, { messages: ['A1'] });
    store.set({ scope: 'tab', tabId: 'b' }, { messages: ['B1'] });
    expect(store.get({ scope: 'global' }).messages).toEqual(['G1']);
    expect(store.get({ scope: 'tab', tabId: 'a' }).messages).toEqual(['A1']);
    expect(store.get({ scope: 'tab', tabId: 'b' }).messages).toEqual(['B1']);
    expect(store.size()).toBe(3);
  });

  test('clear with no args wipes every conversation', () => {
    store.set({ scope: 'global' }, { messages: ['x'] });
    store.set({ scope: 'tab', tabId: 'a' }, { messages: ['y'] });
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.has({ scope: 'global' })).toBe(false);
    expect(store.has({ scope: 'tab', tabId: 'a' })).toBe(false);
  });

  test('clear with scope leaves other scopes untouched', () => {
    store.set({ scope: 'global' }, { messages: ['G'] });
    store.set({ scope: 'tab', tabId: 'a' }, { messages: ['A'] });
    store.set({ scope: 'tab', tabId: 'b' }, { messages: ['B'] });
    store.clear({ scope: 'tab', tabId: 'a' });
    expect(store.has({ scope: 'tab', tabId: 'a' })).toBe(false);
    expect(store.has({ scope: 'tab', tabId: 'b' })).toBe(true);
    expect(store.has({ scope: 'global' })).toBe(true);
  });

  test('has returns false for empty conversation entries', () => {
    // A scope key that's set but holds an empty messages array shouldn't
    // count as a "real" conversation — otherwise startTask would treat the
    // very first turn as a follow-up.
    store.set({ scope: 'global' }, { messages: [] });
    expect(store.has({ scope: 'global' })).toBe(false);
  });
});
