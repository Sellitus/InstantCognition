// ShellStore — assistant-shell state: validation, width clamping, and the
// settings.assistant hydrate/persist contract. The bridge stands in for
// configBridge (the renderer's IPC boundary to main's config).

const { ShellStore, clampWidth, resolveStartMode, WIDTH_BOUNDS } = require('../../../../renderer/core/ShellStore');

function mockBridge(assistant) {
  const writes = [];
  return {
    writes,
    get: jest.fn((path, fallback) => (path === 'settings.assistant' && assistant !== undefined ? assistant : fallback)),
    set: jest.fn((path, value) => { writes.push([path, value]); }),
  };
}

describe('clampWidth', () => {
  test.each([
    ['NaN', NaN, WIDTH_BOUNDS.sidebarWidth.fallback],
    ['negative', -5, WIDTH_BOUNDS.sidebarWidth.fallback],
    ['zero', 0, WIDTH_BOUNDS.sidebarWidth.fallback],
    ['Infinity', Infinity, WIDTH_BOUNDS.sidebarWidth.fallback],
    ['a non-numeric string', 'wide', WIDTH_BOUNDS.sidebarWidth.fallback],
    ['null', null, WIDTH_BOUNDS.sidebarWidth.fallback],
    ['a boolean', true, WIDTH_BOUNDS.sidebarWidth.fallback],
    ['huge', 99999, WIDTH_BOUNDS.sidebarWidth.max],
    ['below the floor', 10, WIDTH_BOUNDS.sidebarWidth.min],
  ])('sidebarWidth %s → bounded value', (_label, input, expected) => {
    expect(clampWidth('sidebarWidth', input)).toBe(expected);
  });

  test('a valid width passes through rounded; numeric strings are accepted', () => {
    expect(clampWidth('dockWidth', 600.6)).toBe(601);
    expect(clampWidth('dockWidth', '700')).toBe(700);
  });

  test('dock bounds are independent of the sidebar bounds', () => {
    expect(clampWidth('dockWidth', 99999)).toBe(WIDTH_BOUNDS.dockWidth.max);
    expect(clampWidth('dockWidth', -1)).toBe(WIDTH_BOUNDS.dockWidth.fallback);
  });

  test('an unknown width key throws instead of guessing bounds', () => {
    expect(() => clampWidth('railWidth', 100)).toThrow(TypeError);
  });
});

describe('resolveStartMode', () => {
  test('"last" restores the persisted mode', () => {
    expect(resolveStartMode('last', 'assistant')).toBe('assistant');
    expect(resolveStartMode('last', 'browser')).toBe('browser');
  });
  test('"browser" and "assistant" pin the mode regardless of the last one', () => {
    expect(resolveStartMode('browser', 'assistant')).toBe('browser');
    expect(resolveStartMode('assistant', 'browser')).toBe('assistant');
  });
  test('an invalid lastMode or startMode falls back to browser', () => {
    expect(resolveStartMode('last', 'sideways')).toBe('browser');
    expect(resolveStartMode('bogus', undefined)).toBe('browser');
    expect(resolveStartMode(undefined, 'assistant')).toBe('assistant');
  });
});

describe('ShellStore', () => {
  test('starts in browser mode with everything closed', () => {
    const store = new ShellStore({ bridge: mockBridge() });
    expect(store.snapshot()).toEqual({
      appMode: 'browser', sidebarOpen: false, sidebarWidth: 420, dockOpen: false, dockWidth: 520,
      dockUserCollapsed: false, historyRailOpen: false, sidePane: null, annotating: false, recording: false,
    });
  });

  test('hydrate reads settings.assistant: startMode last + lastMode + widths', () => {
    const bridge = mockBridge({ startMode: 'last', lastMode: 'assistant', sidebarWidth: 500, dockWidth: 640 });
    const store = new ShellStore({ bridge });
    store.hydrate();
    expect(store.get('appMode')).toBe('assistant');
    expect(store.get('sidebarWidth')).toBe(500);
    expect(store.get('dockWidth')).toBe(640);
    // Hydration never writes back.
    expect(bridge.set).not.toHaveBeenCalled();
  });

  test('hydrate: startMode browser / assistant pin the mode', () => {
    const a = new ShellStore({ bridge: mockBridge({ startMode: 'browser', lastMode: 'assistant' }) });
    a.hydrate();
    expect(a.get('appMode')).toBe('browser');
    const b = new ShellStore({ bridge: mockBridge({ startMode: 'assistant', lastMode: 'browser' }) });
    b.hydrate();
    expect(b.get('appMode')).toBe('assistant');
  });

  test('hydrate: corrupt widths fall back to defaults, huge ones clamp', () => {
    const store = new ShellStore({ bridge: mockBridge({ sidebarWidth: 'NaN', dockWidth: 99999 }) });
    store.hydrate();
    expect(store.get('sidebarWidth')).toBe(420);
    expect(store.get('dockWidth')).toBe(WIDTH_BOUNDS.dockWidth.max);
  });

  test('hydrate with no settings.assistant block uses defaults', () => {
    const store = new ShellStore({ bridge: mockBridge() });
    store.hydrate();
    expect(store.get('appMode')).toBe('browser');
    expect(store.get('sidebarWidth')).toBe(420);
    expect(store.get('dockWidth')).toBe(520);
  });

  test('setting appMode persists lastMode and emits change events', () => {
    const bridge = mockBridge();
    const store = new ShellStore({ bridge });
    const seen = [];
    store.on('change:appMode', (v) => seen.push(v));
    expect(store.set('appMode', 'assistant')).toBe(true);
    expect(seen).toEqual(['assistant']);
    expect(bridge.writes).toEqual([['settings.assistant.lastMode', 'assistant']]);
  });

  test('setting the same value is a no-op: no event, no write', () => {
    const bridge = mockBridge();
    const store = new ShellStore({ bridge });
    const listener = jest.fn();
    store.on('change', listener);
    expect(store.set('appMode', 'browser')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(bridge.set).not.toHaveBeenCalled();
  });

  test('widths clamp on set and persist only on commitWidth', () => {
    const bridge = mockBridge();
    const store = new ShellStore({ bridge });
    store.set('sidebarWidth', 99999);
    store.set('sidebarWidth', -5);
    expect(store.get('sidebarWidth')).toBe(420);
    store.set('sidebarWidth', 610);
    expect(bridge.set).not.toHaveBeenCalled();
    store.commitWidth('sidebarWidth');
    expect(bridge.writes).toEqual([['settings.assistant.sidebarWidth', 610]]);
  });

  test('commitWidth rejects a non-width key', () => {
    const store = new ShellStore({ bridge: mockBridge() });
    expect(() => store.commitWidth('appMode')).toThrow(TypeError);
  });

  test('invalid values throw and leave state untouched', () => {
    const store = new ShellStore({ bridge: mockBridge() });
    expect(() => store.set('appMode', 'sideways')).toThrow(TypeError);
    expect(() => store.set('sidebarOpen', 'yes')).toThrow(TypeError);
    expect(() => store.set('sidePane', 'drawer')).toThrow(TypeError);
    expect(() => store.set('nonsense', true)).toThrow(TypeError);
    expect(store.get('appMode')).toBe('browser');
    expect(store.get('sidebarOpen')).toBe(false);
    expect(store.get('sidePane')).toBeNull();
  });

  test('sidePane accepts the known panes and null', () => {
    const store = new ShellStore({ bridge: mockBridge() });
    store.set('sidePane', 'inbox');
    expect(store.get('sidePane')).toBe('inbox');
    store.set('sidePane', null);
    expect(store.get('sidePane')).toBeNull();
  });
});
