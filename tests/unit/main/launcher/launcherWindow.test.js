// launcherWindow — the quick launcher's BrowserWindow lifecycle. Only the
// Electron boundary (BrowserWindow, screen) is replaced.
const { EventEmitter } = require('events');
const { createLauncherWindow, centeredBounds, WIDTH } = require('../../../../main/launcher/launcherWindow');

function makeMockBrowserWindow({ loadResult = Promise.resolve() } = {}) {
  const created = [];
  class MockBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.focused = false;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        send: jest.fn(),
        setWindowOpenHandler: jest.fn((fn) => { this.openHandler = fn; }),
      });
      this.setAlwaysOnTop = jest.fn();
      this.setVisibleOnAllWorkspaces = jest.fn();
      this.setBounds = jest.fn();
      this.loadFile = jest.fn(() => loadResult);
      created.push(this);
    }
    show() { this.visible = true; }
    hide() { this.visible = false; this.focused = false; }
    focus() { this.focused = true; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  return { MockBrowserWindow, created };
}

const mockScreen = {
  getCursorScreenPoint: () => ({ x: 2500, y: 100 }),
  getDisplayNearestPoint: jest.fn(() => ({ workArea: { x: 1920, y: 0, width: 2560, height: 1440 } })),
};

function setup(overrides = {}) {
  const { MockBrowserWindow, created } = makeMockBrowserWindow(overrides);
  const deps = {
    BrowserWindow: MockBrowserWindow, getScreen: () => mockScreen, htmlPath: '/app/launcher.html',
    platform: 'darwin', getTheme: () => 'light', onOpenUrl: jest.fn(), onHide: jest.fn(), onError: jest.fn(),
    ...overrides.deps,
  };
  return { launcher: createLauncherWindow(deps), created, deps };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('launcherWindow', () => {
  test('builds no window until the first show, then reuses it across shows', () => {
    const { launcher, created } = setup();
    expect(created).toHaveLength(0);
    expect(launcher.isBuilt()).toBe(false);
    launcher.show();
    launcher.hide();
    launcher.show();
    expect(created).toHaveLength(1);
    expect(created[0].loadFile).toHaveBeenCalledWith('/app/launcher.html');
    expect(launcher.isVisible()).toBe(true);
  });

  test('is frameless, always on top, sandboxed without Node behind the shell preload, and transparent on macOS', () => {
    const { launcher, created } = setup();
    launcher.show();
    const o = created[0].options;
    expect(o).toMatchObject({ frame: false, alwaysOnTop: true, transparent: true, skipTaskbar: true, show: false });
    expect(o.webPreferences).toMatchObject({
      webviewTag: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: require('path').join(__dirname, '../../../../main/preload/shell.js'),
    });
    expect(created[0].setAlwaysOnTop).toHaveBeenCalledWith(true, 'pop-up-menu');
  });

  test('its page passes the IPC sender check as the app', async () => {
    const handlers = new Map();
    const ipc = { emit() {}, handle: (ch, fn) => handlers.set(ch, fn) };
    require('../../../../main/utils/ipcSenderPolicy').install(ipc);
    ipc.handle('launcher:ask', () => 'ok');
    const { launcher, created } = setup();
    launcher.show();
    const event = { sender: created[0].webContents, senderFrame: { url: 'file:///app/launcher.html', parent: null } };
    expect(handlers.get('launcher:ask')(event)).toBe('ok');
  });

  test('stays opaque off macOS, where transparent windows render black without a GPU', () => {
    const { launcher, created } = setup({ deps: { platform: 'win32' } });
    launcher.show();
    expect(created[0].options.transparent).toBe(false);
    expect(created[0].options.backgroundColor).toBe('#11151c');
    expect(created[0].setAlwaysOnTop).not.toHaveBeenCalled();
  });

  test('centers on the display under the cursor', () => {
    const { launcher, created } = setup();
    launcher.show();
    expect(created[0].setBounds).toHaveBeenCalledWith(centeredBounds({ x: 1920, y: 0, width: 2560, height: 1440 }));
    expect(centeredBounds({ x: 1920, y: 0, width: 2560, height: 1440 }).x).toBe(1920 + (2560 - WIDTH) / 2);
  });

  test('clamps to a work area smaller than the launcher', () => {
    const b = centeredBounds({ x: 0, y: 0, width: 500, height: 300 });
    expect(b).toMatchObject({ x: 0, width: 500, height: 300 });
  });

  test('hides on blur and runs onHide', () => {
    const { launcher, created, deps } = setup();
    launcher.show();
    created[0].emit('blur');
    expect(launcher.isVisible()).toBe(false);
    expect(deps.onHide).toHaveBeenCalledTimes(1);
  });

  test('hides on Esc and swallows the key', () => {
    const { launcher, created } = setup();
    launcher.show();
    const event = { preventDefault: jest.fn() };
    created[0].webContents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(launcher.isVisible()).toBe(false);
  });

  test('other keys do not hide the launcher', () => {
    const { launcher, created } = setup();
    launcher.show();
    const event = { preventDefault: jest.fn() };
    created[0].webContents.emit('before-input-event', event, { type: 'keyDown', key: 'a' });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(launcher.isVisible()).toBe(true);
  });

  test('hide while already hidden does not run onHide', () => {
    const { launcher, deps } = setup();
    launcher.hide();
    launcher.show();
    launcher.hide();
    launcher.hide();
    expect(deps.onHide).toHaveBeenCalledTimes(1);
  });

  test('toggle shows when hidden and hides when focused', () => {
    const { launcher } = setup();
    launcher.toggle();
    expect(launcher.isVisible()).toBe(true);
    launcher.toggle();
    expect(launcher.isVisible()).toBe(false);
  });

  test('sends launcher:shown with the theme after load, and on every later show', () => {
    const { launcher, created } = setup();
    launcher.show();
    expect(created[0].webContents.send).not.toHaveBeenCalled();
    created[0].webContents.emit('did-finish-load');
    expect(created[0].webContents.send).toHaveBeenCalledWith('launcher:shown', { theme: 'light' });
    launcher.hide();
    launcher.show();
    expect(created[0].webContents.send).toHaveBeenCalledTimes(2);
  });

  test('refuses navigation; http(s) links go to onOpenUrl, anything else is dropped', () => {
    const { launcher, created, deps } = setup();
    launcher.show();
    const nav = { preventDefault: jest.fn() };
    created[0].webContents.emit('will-navigate', nav, 'https://example.com/a');
    created[0].webContents.emit('will-navigate', nav, 'file:///etc/passwd');
    expect(nav.preventDefault).toHaveBeenCalledTimes(2);
    expect(deps.onOpenUrl).toHaveBeenCalledTimes(1);
    expect(deps.onOpenUrl).toHaveBeenCalledWith('https://example.com/a');
    expect(created[0].openHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(created[0].openHandler({ url: 'http://example.com' })).toEqual({ action: 'deny' });
    expect(deps.onOpenUrl).toHaveBeenLastCalledWith('http://example.com');
  });

  test('a failed load destroys the window, reports through onError, and the next show rebuilds', async () => {
    const { launcher, created, deps } = setup({ loadResult: Promise.reject(new Error('ERR_FILE_NOT_FOUND')) });
    launcher.show();
    await flush();
    expect(deps.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'ERR_FILE_NOT_FOUND' }));
    expect(created[0].destroyed).toBe(true);
    expect(launcher.isBuilt()).toBe(false);
    launcher.show();
    expect(created).toHaveLength(2);
  });

  test('send is a no-op before the window exists and after destroy', () => {
    const { launcher, created } = setup();
    launcher.send('launcher:stream', {});
    launcher.show();
    launcher.send('launcher:stream', { a: 1 });
    expect(created[0].webContents.send).toHaveBeenCalledWith('launcher:stream', { a: 1 });
    launcher.destroy();
    expect(created[0].destroyed).toBe(true);
    launcher.send('launcher:stream', { a: 2 });
    expect(created[0].webContents.send).toHaveBeenCalledTimes(1);
  });
});
