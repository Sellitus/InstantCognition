// configBridge — granular ipcRenderer wrapper around ConfigService.
// Test surface: get/set/update/replace + onChange/onPathChange + _onIncomingChange.

jest.mock('electron', () => {
  const handlers = new Map();
  return {
    ipcRenderer: {
      send: jest.fn(),
      on: jest.fn((channel, fn) => { handlers.set(channel, fn); }),
      sendSync: jest.fn(() => ({ config: null, resetReason: null })),
      invoke: jest.fn(() => Promise.resolve(null)),
      _trigger: (channel, payload) => { const fn = handlers.get(channel); if (fn) fn({}, payload); },
    },
  };
});

const { ipcRenderer } = require('electron');

function freshBridge() {
  let bridge;
  jest.isolateModules(() => { bridge = require('../../../../renderer/core/configBridge'); });
  return bridge;
}

const sampleConfig = {
  settings: {
    theme: 'dark',
    enableAnimations: true,
    notifications: { enabled: true, maxInbox: 200 },
    spellCheck: { enabled: false, languages: ['en-US'] },
  },
  spaces: { custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/' } },
};

describe('configBridge', () => {
  beforeEach(() => {
    ipcRenderer.send.mockClear();
    ipcRenderer.on.mockClear();
    ipcRenderer.sendSync.mockClear();
  });

  test('initialize() seeds the cache and wires the change listener once', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    expect(bridge.snapshot()).toEqual(sampleConfig);
    expect(ipcRenderer.on).toHaveBeenCalledWith('config:changed', expect.any(Function));
    // Idempotent: a second initialize should not re-register.
    const calls = ipcRenderer.on.mock.calls.filter((c) => c[0] === 'config:changed').length;
    bridge.initialize(sampleConfig);
    const callsAfter = ipcRenderer.on.mock.calls.filter((c) => c[0] === 'config:changed').length;
    expect(callsAfter).toBe(calls);
  });

  test('initialize() deep-clones the input so external mutations never leak in', () => {
    const bridge = freshBridge();
    const cfg = JSON.parse(JSON.stringify(sampleConfig));
    bridge.initialize(cfg);
    cfg.settings.theme = 'mutated';
    expect(bridge.get('settings.theme')).toBe('dark');
  });

  test('get() resolves dotted paths and falls back when missing', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    expect(bridge.get('settings.theme')).toBe('dark');
    expect(bridge.get('settings.notifications.maxInbox')).toBe(200);
    expect(bridge.get('settings.spellCheck.languages')).toEqual(['en-US']);
    expect(bridge.get('settings.does.not.exist', 'fb')).toBe('fb');
    expect(bridge.get('', 'fb')).toBe('fb');
  });

  test('set() writes to the local cache AND emits config:set IPC', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    bridge.set('settings.theme', 'light');
    expect(bridge.get('settings.theme')).toBe('light');
    expect(ipcRenderer.send).toHaveBeenCalledWith('config:set', { path: 'settings.theme', value: 'light' });
  });

  test('set() creates nested paths that did not exist', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    bridge.set('settings.brandNew.deep.path', 42);
    expect(bridge.get('settings.brandNew.deep.path')).toBe(42);
  });

  test('set() refuses segments that would shadow Object.prototype', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    ipcRenderer.send.mockClear();
    bridge.set('__proto__.polluted', 'yes');
    bridge.set('a.constructor.prototype.polluted2', 'yes');
    bridge.set('prototype', 'no');
    expect({}.polluted).toBeUndefined();
    expect({}.polluted2).toBeUndefined();
    expect(ipcRenderer.send).not.toHaveBeenCalled();
  });

  test('update() deep-merges into the cache and emits config:update', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    bridge.update({ settings: { notifications: { maxInbox: 999 } } });
    expect(bridge.get('settings.notifications.maxInbox')).toBe(999);
    // Deep merge — sibling keys preserved.
    expect(bridge.get('settings.notifications.enabled')).toBe(true);
    expect(ipcRenderer.send).toHaveBeenCalledWith('config:update', { settings: { notifications: { maxInbox: 999 } } });
  });

  test('update() refuses __proto__/constructor/prototype keys (no prototype pollution)', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    bridge.update({ __proto__: { polluted: 'yes' }, constructor: { prototype: { polluted2: 'yes' } } });
    expect({}.polluted).toBeUndefined();
    expect({}.polluted2).toBeUndefined();
  });

  test('replace() clones and overwrites the cache, emits config:replace', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    const fresh = { settings: { theme: 'system' }, spaces: {} };
    bridge.replace(fresh);
    expect(bridge.snapshot()).toEqual(fresh);
    fresh.settings.theme = 'mutated';
    expect(bridge.get('settings.theme')).toBe('system'); // clone defended
    expect(ipcRenderer.send).toHaveBeenCalledWith('config:replace', expect.any(Object));
  });

  test('onChange() listeners fire on incoming config:changed broadcast', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    const listener = jest.fn();
    bridge.onChange(listener);
    ipcRenderer._trigger('config:changed', { kind: 'set', path: 'settings.theme', oldValue: 'dark', newValue: 'light' });
    expect(listener).toHaveBeenCalled();
    expect(bridge.get('settings.theme')).toBe('light');
  });

  test('onPathChange() listeners fire only for matching paths', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    const themeListener = jest.fn();
    const animsListener = jest.fn();
    bridge.onPathChange('settings.theme', themeListener);
    bridge.onPathChange('settings.enableAnimations', animsListener);

    ipcRenderer._trigger('config:changed', { kind: 'set', path: 'settings.theme', newValue: 'light', oldValue: 'dark' });
    expect(themeListener).toHaveBeenCalledWith('light', 'dark');
    expect(animsListener).not.toHaveBeenCalled();
  });

  test('onChange() returns an unsubscribe function', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    const listener = jest.fn();
    const off = bridge.onChange(listener);
    off();
    ipcRenderer._trigger('config:changed', { kind: 'set', path: 'settings.theme', newValue: 'x' });
    expect(listener).not.toHaveBeenCalled();
  });

  test('bulk replace payload re-fires per-path listeners for changed leaves', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    const themeListener = jest.fn();
    const inboxListener = jest.fn();
    bridge.onPathChange('settings.theme', themeListener);
    bridge.onPathChange('settings.notifications.maxInbox', inboxListener);
    ipcRenderer.sendSync.mockReturnValueOnce({
      config: { settings: { theme: 'system', notifications: { maxInbox: 200 } } },
    });
    ipcRenderer._trigger('config:changed', { kind: 'replace' });
    // The changed leaf fires with new/old values; the unchanged one stays quiet.
    expect(themeListener).toHaveBeenCalledWith('system', 'dark');
    expect(inboxListener).not.toHaveBeenCalled();
    // The cache itself is refreshed so reads stay accurate.
    expect(bridge.get('settings.theme')).toBe('system');
  });

  test('bulk update payload re-fires per-path listeners for changed leaves', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    const listener = jest.fn();
    bridge.onPathChange('settings.notifications.maxInbox', listener);
    ipcRenderer.sendSync.mockReturnValueOnce({
      config: { settings: { notifications: { maxInbox: 999 } } },
    });
    ipcRenderer._trigger('config:changed', { kind: 'update', partial: { settings: { notifications: { maxInbox: 999 } } } });
    expect(listener).toHaveBeenCalledWith(999, 200);
  });

  test('bulk payload with no change does not re-fire per-path listeners', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    const listener = jest.fn();
    bridge.onPathChange('settings.theme', listener);
    // sendSync default returns { config: null } — cache untouched, nothing changed.
    ipcRenderer._trigger('config:changed', { kind: 'replace' });
    expect(listener).not.toHaveBeenCalled();
  });

  test('refresh() re-reads via sendSync', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    ipcRenderer.sendSync.mockReturnValueOnce({ config: { settings: { theme: 'fresh' } } });
    const snap = bridge.refresh();
    expect(snap.settings.theme).toBe('fresh');
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith('config:get-sync');
  });

  test('null/invalid args are no-ops (set/update/replace)', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    ipcRenderer.send.mockClear();
    bridge.set('', 1);
    bridge.update(null);
    bridge.update('not an object');
    bridge.replace(null);
    expect(ipcRenderer.send).not.toHaveBeenCalled();
  });

  test('a send that IPC rejects reaches the caller and leaves the cache untouched', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    const cloneError = new Error('An object could not be cloned.');
    ipcRenderer.send.mockImplementation(() => { throw cloneError; });
    try {
      expect(() => bridge.set('settings.theme', 'light')).toThrow(cloneError);
      expect(() => bridge.update({ settings: { theme: 'light' } })).toThrow(cloneError);
      expect(() => bridge.replace({ settings: { theme: 'light' } })).toThrow(cloneError);
    } finally {
      ipcRenderer.send.mockImplementation(() => {});
    }
    expect(bridge.get('settings.theme')).toBe('dark');
  });

  test('a throwing listener does not starve the others and its error is rethrown', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    const boom = new Error('listener boom');
    const pathA = jest.fn(() => { throw boom; });
    const pathB = jest.fn();
    const any = jest.fn();
    bridge.onPathChange('settings.theme', pathA);
    bridge.onPathChange('settings.theme', pathB);
    bridge.onChange(any);
    expect(() => ipcRenderer._trigger('config:changed', {
      kind: 'set', path: 'settings.theme', newValue: 'light', oldValue: 'dark',
    })).toThrow(boom);
    expect(pathB).toHaveBeenCalledWith('light', 'dark');
    expect(any).toHaveBeenCalledTimes(1);
    expect(bridge.get('settings.theme')).toBe('light');
  });

  test('several failing listeners surface together as an AggregateError', () => {
    const bridge = freshBridge();
    bridge.initialize(sampleConfig);
    bridge.onPathChange('settings.theme', () => { throw new Error('a'); });
    bridge.onChange(() => { throw new Error('b'); });
    let caught;
    try {
      ipcRenderer._trigger('config:changed', { kind: 'set', path: 'settings.theme', newValue: 'light', oldValue: 'dark' });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors.map((e) => e.message)).toEqual(['a', 'b']);
  });
});
