// launcherHotkey — registration follows settings.assistant.launcher; only
// Electron's globalShortcut is replaced, ConfigService is a plain emitter.
const { EventEmitter } = require('events');
const {
  createLauncherHotkey, bindLauncherHotkey, readLauncherSettings, DEFAULT_HOTKEY,
} = require('../../../../main/launcher/launcherHotkey');

function makeConfig(launcher) {
  const cfg = new EventEmitter();
  cfg.value = launcher;
  cfg.get = (key, fallback) => (key === 'settings.assistant.launcher' && cfg.value !== undefined ? cfg.value : fallback);
  return cfg;
}

function makeShortcuts({ taken = [], throwsOn = [] } = {}) {
  const held = new Map();
  return {
    held,
    register: jest.fn((accel, fn) => {
      if (throwsOn.includes(accel)) throw new Error(`Failed to parse accelerator ${accel}`);
      if (taken.includes(accel)) return false;
      held.set(accel, fn);
      return true;
    }),
    unregister: jest.fn((accel) => { held.delete(accel); }),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('readLauncherSettings', () => {
  test('defaults to enabled with Alt+Shift+Space', () => {
    expect(readLauncherSettings(makeConfig(undefined))).toEqual({ enabled: true, hotkey: DEFAULT_HOTKEY });
    expect(DEFAULT_HOTKEY).toBe('Alt+Shift+Space');
  });
  test('a blank or non-string hotkey falls back to the default', () => {
    expect(readLauncherSettings(makeConfig({ hotkey: '  ' })).hotkey).toBe(DEFAULT_HOTKEY);
    expect(readLauncherSettings(makeConfig({ hotkey: 42 })).hotkey).toBe(DEFAULT_HOTKEY);
  });
});

describe('createLauncherHotkey', () => {
  test('registers the configured hotkey and fires onTrigger', () => {
    const gs = makeShortcuts();
    const onTrigger = jest.fn();
    const hk = createLauncherHotkey({ globalShortcut: gs, configService: makeConfig({ enabled: true, hotkey: 'Ctrl+Alt+K' }), onTrigger, onFailure: jest.fn() });
    expect(hk.sync()).toEqual({ ok: true, hotkey: 'Ctrl+Alt+K' });
    gs.held.get('Ctrl+Alt+K')();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test('launcher disabled registers no hotkey at all', () => {
    const gs = makeShortcuts();
    const hk = createLauncherHotkey({ globalShortcut: gs, configService: makeConfig({ enabled: false, hotkey: 'Ctrl+Alt+K' }), onTrigger: jest.fn(), onFailure: jest.fn() });
    expect(hk.sync()).toEqual({ ok: true, hotkey: null });
    expect(gs.register).not.toHaveBeenCalled();
    expect(hk.current()).toBeNull();
  });

  test('sync is idempotent while settings are unchanged', () => {
    const gs = makeShortcuts();
    const hk = createLauncherHotkey({ globalShortcut: gs, configService: makeConfig({}), onTrigger: jest.fn(), onFailure: jest.fn() });
    hk.sync();
    hk.sync();
    expect(gs.register).toHaveBeenCalledTimes(1);
    expect(gs.unregister).not.toHaveBeenCalled();
  });

  test('a changed hotkey releases the old combo before taking the new one', () => {
    const gs = makeShortcuts();
    const cfg = makeConfig({ hotkey: 'Ctrl+Alt+K' });
    const hk = createLauncherHotkey({ globalShortcut: gs, configService: cfg, onTrigger: jest.fn(), onFailure: jest.fn() });
    hk.sync();
    cfg.value = { hotkey: 'Ctrl+Alt+J' };
    hk.sync();
    expect(gs.unregister).toHaveBeenCalledWith('Ctrl+Alt+K');
    expect([...gs.held.keys()]).toEqual(['Ctrl+Alt+J']);
  });

  test('disabling releases a held hotkey', () => {
    const gs = makeShortcuts();
    const cfg = makeConfig({ enabled: true });
    const hk = createLauncherHotkey({ globalShortcut: gs, configService: cfg, onTrigger: jest.fn(), onFailure: jest.fn() });
    hk.sync();
    cfg.value = { enabled: false };
    hk.sync();
    expect(gs.held.size).toBe(0);
  });

  test('an accelerator taken by another app is surfaced through onFailure, once per combo', () => {
    const gs = makeShortcuts({ taken: [DEFAULT_HOTKEY] });
    const onFailure = jest.fn();
    const hk = createLauncherHotkey({ globalShortcut: gs, configService: makeConfig({}), onTrigger: jest.fn(), onFailure });
    expect(hk.sync()).toEqual({ ok: false, hotkey: null, error: 'accelerator_unavailable' });
    expect(onFailure).toHaveBeenCalledWith({ hotkey: DEFAULT_HOTKEY, error: 'accelerator_unavailable' });
    hk.sync();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(gs.register).toHaveBeenCalledTimes(1);
  });

  test('a malformed accelerator (register throws) is surfaced with the thrown message', () => {
    const gs = makeShortcuts({ throwsOn: ['Nope+'] });
    const onFailure = jest.fn();
    const hk = createLauncherHotkey({ globalShortcut: gs, configService: makeConfig({ hotkey: 'Nope+' }), onTrigger: jest.fn(), onFailure });
    const res = hk.sync();
    expect(res.ok).toBe(false);
    expect(onFailure).toHaveBeenCalledWith({ hotkey: 'Nope+', error: 'Failed to parse accelerator Nope+' });
  });

  test('re-enabling after a failure retries the combo', () => {
    const gs = makeShortcuts({ taken: [DEFAULT_HOTKEY] });
    const cfg = makeConfig({});
    const onFailure = jest.fn();
    const hk = createLauncherHotkey({ globalShortcut: gs, configService: cfg, onTrigger: jest.fn(), onFailure });
    hk.sync();
    cfg.value = { enabled: false };
    hk.sync();
    cfg.value = { enabled: true };
    hk.sync();
    expect(onFailure).toHaveBeenCalledTimes(2);
  });
});

describe('bindLauncherHotkey', () => {
  function bind(cfg, gs) {
    const ipcMain = new EventEmitter();
    const hotkey = createLauncherHotkey({ globalShortcut: gs, configService: cfg, onTrigger: jest.fn(), onFailure: jest.fn() });
    const unbind = bindLauncherHotkey({ ipcMain, configService: cfg, hotkey });
    return { ipcMain, unbind };
  }

  test('registers immediately and re-registers when a launcher setting is set', async () => {
    const gs = makeShortcuts();
    const cfg = makeConfig({ hotkey: 'Ctrl+Alt+K' });
    bind(cfg, gs);
    expect(gs.held.has('Ctrl+Alt+K')).toBe(true);
    cfg.value = { hotkey: 'Ctrl+Alt+J' };
    cfg.emit('change', { path: 'settings.assistant.launcher.hotkey' });
    await tick();
    expect([...gs.held.keys()]).toEqual(['Ctrl+Alt+J']);
  });

  test('re-syncs after bulk config:update / config:replace writes, which emit no change event', async () => {
    const gs = makeShortcuts();
    const cfg = makeConfig({ enabled: true });
    const { ipcMain } = bind(cfg, gs);
    cfg.value = { enabled: false };
    ipcMain.emit('config:update', {}, { settings: {} });
    await tick();
    expect(gs.held.size).toBe(0);
    cfg.value = { enabled: true };
    ipcMain.emit('config:replace', {}, {});
    await tick();
    expect(gs.held.has(DEFAULT_HOTKEY)).toBe(true);
  });

  test('unrelated setting changes do not touch the registration', async () => {
    const gs = makeShortcuts();
    const cfg = makeConfig({});
    bind(cfg, gs);
    cfg.value = { enabled: false };
    cfg.emit('change', { path: 'settings.theme' });
    await tick();
    expect(gs.held.has(DEFAULT_HOTKEY)).toBe(true);
  });

  test('unbind stops following settings', async () => {
    const gs = makeShortcuts();
    const cfg = makeConfig({});
    const { ipcMain, unbind } = bind(cfg, gs);
    unbind();
    cfg.value = { enabled: false };
    ipcMain.emit('config:update', {}, {});
    cfg.emit('reset');
    await tick();
    expect(gs.held.has(DEFAULT_HOTKEY)).toBe(true);
  });
});
