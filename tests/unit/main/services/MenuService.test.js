jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock'),
    isPackaged: false,
    relaunch: jest.fn(),
    quit: jest.fn(),
  },
  Menu: {
    buildFromTemplate: jest.fn((template) => ({ items: template, popup: jest.fn() })),
    setApplicationMenu: jest.fn(),
  },
  shell: {
    openExternal: jest.fn(),
  },
  dialog: { showSaveDialog: jest.fn() },
}));

const { Menu, app, shell } = require('electron');

let menuService;

const createMockShortcutService = () => ({
  toggleShortcut: 'CmdOrCtrl+Space',
  lockShortcut: 'CmdOrCtrl+Alt+L',
  quitShortcut: 'CmdOrCtrl+Q',
  toggleLocked: false,
  toggleWindow: jest.fn(),
  registerToggle: jest.fn(),
  unregisterToggle: jest.fn(),
});

const createMockMainWindow = () => ({
  isVisible: jest.fn(() => false),
  isDestroyed: jest.fn(() => false),
  show: jest.fn(),
  hide: jest.fn(),
  webContents: {
    send: jest.fn(),
    on: jest.fn(),
  },
});

const createMockTrayService = () => ({
  tray: { setToolTip: jest.fn(), setContextMenu: jest.fn() },
  setContextMenu: jest.fn(),
});

beforeEach(() => {
  jest.clearAllMocks();
  menuService = require('../../../../main/services/MenuService');
  menuService.mainWindow = null;
  menuService.trayService = null;
  menuService.shortcutService = null;
  menuService._isAppQuitting = false;
});

describe('MenuService', () => {
  describe('Application menu', () => {
    test('sets application menu on buildAndSetMenus', () => {
      const ss = createMockShortcutService();
      const mw = createMockMainWindow();
      const ts = createMockTrayService();

      menuService.initialize(mw, ts, ss);
      menuService.buildAndSetMenus();

      expect(Menu.buildFromTemplate).toHaveBeenCalled();
      expect(Menu.setApplicationMenu).toHaveBeenCalled();
    });

    test('menu template has File, Edit, View, Navigation, Window, Help submenus', () => {
      const ss = createMockShortcutService();
      const mw = createMockMainWindow();
      const ts = createMockTrayService();

      menuService.initialize(mw, ts, ss);
      menuService.buildAndSetMenus();

      const templateCall = Menu.buildFromTemplate.mock.calls;
      // Second call should be the app menu (first is tray)
      const appTemplate = templateCall[1][0];
      const labels = appTemplate.map((item) => item.label);
      expect(labels).toContain('File');
      expect(labels).toContain('Edit');
      expect(labels).toContain('View');
      expect(labels).toContain('Navigation');
      expect(labels).toContain('Window');
      expect(labels).toContain('Help');
    });

    test('View submenu includes zoom controls', () => {
      const ss = createMockShortcutService();
      const mw = createMockMainWindow();
      const ts = createMockTrayService();

      menuService.initialize(mw, ts, ss);
      menuService.buildAndSetMenus();

      const appTemplate = Menu.buildFromTemplate.mock.calls[1][0];
      const viewMenu = appTemplate.find((m) => m.label === 'View');
      const viewLabels = viewMenu.submenu.map((i) => i.label).filter(Boolean);
      expect(viewLabels).toContain('Zoom In');
      expect(viewLabels).toContain('Zoom Out');
      expect(viewLabels).toContain('Zoom Reset');
    });

    test('Navigation submenu keeps Cmd+[ as Back and Cmd+] as Forward', () => {
      const ss = createMockShortcutService();
      const mw = createMockMainWindow();
      const ts = createMockTrayService();

      menuService.initialize(mw, ts, ss);
      menuService.buildAndSetMenus();

      const appTemplate = Menu.buildFromTemplate.mock.calls[1][0];
      const navigationMenu = appTemplate.find((m) => m.label === 'Navigation');
      const hiddenNavItems = navigationMenu.submenu.filter((item) => item.visible === false);
      const backItem = hiddenNavItems.find((item) => item.label === 'Back');
      const forwardItem = hiddenNavItems.find((item) => item.label === 'Forward');

      expect(backItem.accelerator).toBe('CmdOrCtrl+[');
      expect(forwardItem.accelerator).toBe('CmdOrCtrl+]');
    });

    test('Edit submenu includes copy, paste, cut', () => {
      const ss = createMockShortcutService();
      const mw = createMockMainWindow();
      const ts = createMockTrayService();

      menuService.initialize(mw, ts, ss);
      menuService.buildAndSetMenus();

      const appTemplate = Menu.buildFromTemplate.mock.calls[1][0];
      const editMenu = appTemplate.find((m) => m.label === 'Edit');
      const roles = editMenu.submenu.map((i) => i.role).filter(Boolean);
      expect(roles).toContain('cut');
      expect(roles).toContain('copy');
      expect(roles).toContain('paste');
    });

    test('does nothing when mainWindow is null', () => {
      menuService.mainWindow = null;
      expect(() => menuService.buildAndSetMenus()).not.toThrow();
      expect(Menu.setApplicationMenu).not.toHaveBeenCalled();
    });
  });

  describe('Tray menu', () => {
    test('builds tray context menu with Show/Hide and Quit', () => {
      const ss = createMockShortcutService();
      const mw = createMockMainWindow();
      const ts = createMockTrayService();

      menuService.initialize(mw, ts, ss);
      menuService.buildAndSetMenus();

      // First buildFromTemplate call is the tray menu
      const trayTemplate = Menu.buildFromTemplate.mock.calls[0][0];
      const labels = trayTemplate.map((i) => i.label).filter(Boolean);
      expect(labels).toContain('InstantCognition');
      expect(labels).toContain('Quit');
      expect(labels).toContain('Toggle Window');
    });

    test('sets tray context menu via trayService', () => {
      const ss = createMockShortcutService();
      const mw = createMockMainWindow();
      const ts = createMockTrayService();

      menuService.initialize(mw, ts, ss);
      menuService.buildAndSetMenus();

      expect(ts.setContextMenu).toHaveBeenCalled();
    });
  });

  describe('isAppQuitting state', () => {
    test('setAppQuitting updates state', () => {
      expect(menuService.isAppQuitting).toBe(false);
      menuService.setAppQuitting(true);
      expect(menuService.isAppQuitting).toBe(true);
    });
  });

  describe('Webview context menu', () => {
    test('registers did-attach-webview listener', () => {
      const mw = createMockMainWindow();
      menuService.mainWindow = mw;
      menuService.setupWebviewContextMenu();
      expect(mw.webContents.on).toHaveBeenCalledWith('did-attach-webview', expect.any(Function));
    });

    test('does nothing when mainWindow is null', () => {
      menuService.mainWindow = null;
      expect(() => menuService.setupWebviewContextMenu()).not.toThrow();
    });

    // Helper: attach the webview context menu, capture the did-attach-webview
    // callback, fake a contents object, fire context-menu with params, and
    // return the built template so we can drive each menu item's click().
    function buildContextTemplate(params, contentsOverrides = {}) {
      const onCalls = {};
      const mw = {
        isDestroyed: () => false,
        webContents: {
          send: jest.fn(),
          on: jest.fn((ev, fn) => { onCalls[ev] = fn; }),
        },
      };
      menuService.mainWindow = mw;
      menuService.setupWebviewContextMenu();

      const contentsOn = {};
      const contents = {
        id: 77,
        on: jest.fn((ev, fn) => { contentsOn[ev] = fn; }),
        reload: jest.fn(),
        navigationHistory: { goBack: jest.fn(), goForward: jest.fn() },
        executeJavaScript: jest.fn(() => Promise.resolve()),
        inspectElement: jest.fn(),
        openDevTools: jest.fn(),
        ...contentsOverrides,
      };

      onCalls['did-attach-webview'](null, contents);
      // The most recent buildFromTemplate call is the context menu.
      contentsOn['context-menu'](null, params);
      const calls = Menu.buildFromTemplate.mock.calls;
      const template = calls[calls.length - 1][0];
      return { template, contents, mw };
    }

    function clickByLabel(template, label) {
      const item = template.find((i) => i.label === label);
      expect(item).toBeTruthy();
      item.click();
      return item;
    }

    test('Find in Page sends focus + toggle for the right webContents', () => {
      const { template, contents, mw } = buildContextTemplate({ x: 5, y: 6 });
      clickByLabel(template, 'Find in Page');
      expect(mw.webContents.send).toHaveBeenCalledWith('focusWebviewByWebContents', contents.id);
      expect(mw.webContents.send).toHaveBeenCalledWith('toggleFindBar');
    });

    test('Close sends closeWebviewByWebContents with the contents id', () => {
      const { template, contents, mw } = buildContextTemplate({ x: 1, y: 2 });
      clickByLabel(template, 'Close');
      expect(mw.webContents.send).toHaveBeenCalledWith('closeWebviewByWebContents', contents.id);
    });

    test('Inspect Element uses inspectElement when coordinates are present', () => {
      const { template, contents } = buildContextTemplate({ x: 12, y: 34 });
      clickByLabel(template, 'Inspect Element');
      expect(contents.inspectElement).toHaveBeenCalledWith(12, 34);
    });

    test('Inspect Element falls back to openDevTools when inspectElement is absent', () => {
      const { template, contents } = buildContextTemplate(
        { x: 0, y: 0 },
        { inspectElement: undefined },
      );
      clickByLabel(template, 'Inspect Element');
      expect(contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    });

    test('Back / Forward / Refresh / Home drive navigation', () => {
      const { template, contents, mw } = buildContextTemplate({ x: 0, y: 0 });
      clickByLabel(template, 'Back');
      expect(contents.navigationHistory.goBack).toHaveBeenCalled();
      clickByLabel(template, 'Forward');
      expect(contents.navigationHistory.goForward).toHaveBeenCalled();
      clickByLabel(template, 'Refresh');
      expect(contents.reload).toHaveBeenCalled();
      clickByLabel(template, 'Home');
      expect(mw.webContents.send).toHaveBeenCalledWith('navigateHomeForWebContents', contents.id);
    });

    test('video media type adds a Picture in Picture item that runs a script', () => {
      const { template, contents } = buildContextTemplate({
        x: 0, y: 0, mediaType: 'video', srcURL: 'https://v/clip.mp4',
      });
      const pip = template.find((i) => i.label === 'Picture in Picture');
      expect(pip).toBeTruthy();
      pip.click();
      expect(contents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('requestPictureInPicture'),
      );
    });

    test('non-video params do not include a Picture in Picture item', () => {
      const { template } = buildContextTemplate({ x: 0, y: 0 });
      expect(template.find((i) => i.label === 'Picture in Picture')).toBeFalsy();
    });

    test('selectionText adds a truncated Search item that opens a Google query', () => {
      const longSel = 'x'.repeat(60);
      const { template, mw } = buildContextTemplate({ x: 0, y: 0, selectionText: longSel });
      const search = template.find((i) => typeof i.label === 'string' && i.label.startsWith('Search '));
      expect(search).toBeTruthy();
      // 30 chars + ellipsis when selection exceeds 30 chars.
      expect(search.label).toContain('...');
      search.click();
      expect(mw.webContents.send).toHaveBeenCalledWith(
        'open-url',
        `https://www.google.com/search?q=${encodeURIComponent(longSel)}`,
      );
    });

    test('short selectionText is not truncated with an ellipsis', () => {
      const { template } = buildContextTemplate({ x: 0, y: 0, selectionText: 'hello' });
      const search = template.find((i) => typeof i.label === 'string' && i.label.startsWith('Search '));
      expect(search.label).toBe('Search "hello"');
    });

    test('linkURL adds an Open Link item that forwards the url', () => {
      const { template, mw } = buildContextTemplate({ x: 0, y: 0, linkURL: 'https://link.test/a' });
      clickByLabel(template, 'Open Link');
      expect(mw.webContents.send).toHaveBeenCalledWith('open-url', 'https://link.test/a');
    });

    test('Print… prints the right-clicked page, not the active tab', async () => {
      const print = jest.fn((_o, cb) => cb(true, ''));
      const { template, mw } = buildContextTemplate({ x: 0, y: 0 }, { isDestroyed: () => false, print });
      await template.find((i) => i.label === 'Print…').click();
      expect(print).toHaveBeenCalledTimes(1);
      expect(print).toHaveBeenCalledWith({}, expect.any(Function));
      expect(mw.webContents.send).not.toHaveBeenCalledWith('page:print-active');
    });

    test('Print… failure on the right-clicked page surfaces to the shell', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const print = jest.fn((_o, cb) => cb(false, 'Print job failed'));
      const { template, mw } = buildContextTemplate({ x: 0, y: 0 }, { isDestroyed: () => false, print });
      await template.find((i) => i.label === 'Print…').click();
      expect(mw.webContents.send).toHaveBeenCalledWith('page:action-failed', { title: 'Print', message: 'Printing failed: Print job failed.' });
      errorSpy.mockRestore();
    });

    test('Save Page as PDF… renders the right-clicked page', async () => {
      const { dialog } = require('electron');
      dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
      const { template, mw } = buildContextTemplate({ x: 0, y: 0 }, { isDestroyed: () => false, getTitle: () => 'Right Clicked' });
      await template.find((i) => i.label === 'Save Page as PDF…').click();
      expect(dialog.showSaveDialog).toHaveBeenCalledWith(mw, expect.objectContaining({
        defaultPath: expect.stringContaining('Right Clicked.pdf'),
      }));
    });

    test('no selection and no link omit Search and Open Link items', () => {
      const { template } = buildContextTemplate({ x: 0, y: 0 });
      expect(template.find((i) => typeof i.label === 'string' && i.label.startsWith('Search '))).toBeFalsy();
      expect(template.find((i) => i.label === 'Open Link')).toBeFalsy();
    });

    describe('Fill saved password', () => {
      // fs and safeStorage are the boundaries; the real password store backs the menu.
      const store = require('../../../../main/services/passwords/passwordStore');
      beforeEach(() => {
        const files = new Map();
        store._setFs({
          existsSync: (p) => files.has(p) || p === '/pw',
          readFileSync: (p) => files.get(p),
          writeFileSync: (p, c) => files.set(p, c),
          renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
          mkdirSync: () => {},
        });
        store._setFilePath('/pw/passwords.json');
        store._setSafeStorage({
          isEncryptionAvailable: () => true,
          getSelectedStorageBackend: () => 'unknown',
          encryptString: (s) => Buffer.from('E' + s),
          decryptString: (b) => b.toString().slice(1),
        });
        store._entries = [];
        store._neverSave = [];
        store._loaded = true;
        const certService = require('../../../../main/services/CertificateService');
        certService._certErrorHosts.clear();
        require('../../../../main/services/PasswordService').bind({ certificateService: certService });
      });

      const guest = (origin) => ({ isDestroyed: () => false, session: { isPersistent: () => true }, mainFrame: { origin, send: jest.fn() } });

      test('appears for a page whose origin has a saved login and fills it on click', () => {
        store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
        const { template, contents } = buildContextTemplate({ x: 0, y: 0 }, guest('https://a.test'));
        clickByLabel(template, 'Fill saved password (alice)');
        expect(contents.mainFrame.send).toHaveBeenCalledWith('passwords:fill', { origin: 'https://a.test', username: 'alice', password: 'pw' });
      });

      test('is absent when the page origin has no saved login', () => {
        store.save({ origin: 'https://a.test', username: 'alice', password: 'pw' });
        const { template } = buildContextTemplate({ x: 0, y: 0 }, guest('https://b.test'));
        expect(template.find((i) => typeof i.label === 'string' && i.label.startsWith('Fill saved password'))).toBeFalsy();
      });
    });
  });

  describe('menu click handlers', () => {
    function appMenu() {
      const ss = createMockShortcutService();
      const mw = createMockMainWindow();
      const ts = createMockTrayService();
      menuService.initialize(mw, ts, ss);
      menuService.buildAndSetMenus();
      const template = Menu.buildFromTemplate.mock.calls[1][0];
      return { template, ss, mw };
    }

    function sub(template, label) {
      return template.find((m) => m.label === label).submenu;
    }
    function click(items, label) {
      const item = items.find((i) => i.label === label);
      expect(item).toBeTruthy();
      item.click();
      return item;
    }

    test('File > Settings… and Quit drive renderer + app', () => {
      const { template, mw } = appMenu();
      const file = sub(template, 'File');
      click(file, 'Settings…');
      expect(mw.webContents.send).toHaveBeenCalledWith('menu:open-settings');
      click(file, 'Quit');
      expect(menuService.isAppQuitting).toBe(true);
      expect(app.quit).toHaveBeenCalled();
    });

    // Menu accelerators fire even while a page has keyboard focus, where the
    // renderer's own shortcut listener never sees the keydown.
    test.each([
      ['New Private Tab', 'CmdOrCtrl+Alt+P', 'tabs:new-private'],
      ['Reopen Closed Tab', 'CmdOrCtrl+Shift+T', 'tabs:reopen-closed'],
      ['Print…', 'CmdOrCtrl+P', 'page:print-active'],
      ['Save Page as PDF…', undefined, 'page:save-pdf-active'],
    ])('File > %s (%s) sends %s to the shell', (label, accelerator, channel) => {
      const { template, mw } = appMenu();
      const item = click(sub(template, 'File'), label);
      expect(item.accelerator).toBe(accelerator);
      expect(mw.webContents.send.mock.calls).toEqual([[channel]]);
    });

    test('File menu tab and page items stay quiet once the window is destroyed', () => {
      const { template, mw } = appMenu();
      mw.isDestroyed.mockReturnValue(true);
      const file = sub(template, 'File');
      for (const label of ['New Private Tab', 'Reopen Closed Tab', 'Print…', 'Save Page as PDF…']) click(file, label);
      expect(mw.webContents.send).not.toHaveBeenCalled();
    });

    test('File > Restart App relaunches and quits', () => {
      const { template } = appMenu();
      click(sub(template, 'File'), 'Restart App');
      expect(app.relaunch).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
      expect(menuService.isAppQuitting).toBe(true);
    });

    test('Edit > Find / Find Next / Find Previous send find IPC', () => {
      const { template, mw } = appMenu();
      const edit = sub(template, 'Edit');
      click(edit, 'Find');
      expect(mw.webContents.send).toHaveBeenCalledWith('toggleFindBar');
      click(edit, 'Find Next');
      expect(mw.webContents.send).toHaveBeenCalledWith('findBarForward');
      click(edit, 'Find Previous');
      expect(mw.webContents.send).toHaveBeenCalledWith('findBarBack');
    });

    test('View > Toggle Window calls shortcutService.toggleWindow', () => {
      const { template, ss } = appMenu();
      click(sub(template, 'View'), 'Toggle Window');
      expect(ss.toggleWindow).toHaveBeenCalled();
    });

    test('View > Toggle Lock locks (unregister) when unlocked, unlocks when locked', () => {
      const { template, ss } = appMenu();
      const view = sub(template, 'View');
      // Initially unlocked -> click locks it and unregisters toggle.
      ss.toggleLocked = false;
      click(view, 'Toggle Lock');
      expect(ss.toggleLocked).toBe(true);
      expect(ss.unregisterToggle).toHaveBeenCalled();
      // Now locked -> click unlocks it and re-registers toggle.
      click(view, 'Toggle Lock');
      expect(ss.toggleLocked).toBe(false);
      expect(ss.registerToggle).toHaveBeenCalled();
    });

    test('View zoom + view-mode items send the matching IPC channels', () => {
      const { template, mw } = appMenu();
      const view = sub(template, 'View');
      const map = {
        'Zoom In': 'zoomInActive',
        'Zoom Out': 'zoomOutActive',
        'Zoom Reset': 'zoomResetActive',
        'Toggle View': 'toggleView',
        'Close Browser': 'closeBrowser',
        'Close Space': 'closeActiveSpace',
        'Toggle MultiSpace': 'toggleMultiSpace',
        'Toggle Space': 'toggleSpaceView',
        'Toggle Browser': 'toggleBrowserView',
      };
      for (const [label, channel] of Object.entries(map)) {
        click(view, label);
        expect(mw.webContents.send).toHaveBeenCalledWith(channel);
      }
    });

    test('Navigation items send navigation IPC including hidden Back/Forward', () => {
      const { template, mw } = appMenu();
      const nav = sub(template, 'Navigation');
      click(nav, 'Previous Space');
      expect(mw.webContents.send).toHaveBeenCalledWith('select-previous-space');
      click(nav, 'Next Space');
      expect(mw.webContents.send).toHaveBeenCalledWith('select-next-space');
      click(nav, 'Refresh');
      expect(mw.webContents.send).toHaveBeenCalledWith('refreshActive');
      click(nav, 'Home');
      expect(mw.webContents.send).toHaveBeenCalledWith('navigateHomeReset');
      // Two "Back" entries (visible F3 + hidden Cmd+[). Fire all of them.
      nav.filter((i) => i.label === 'Back').forEach((i) => i.click());
      nav.filter((i) => i.label === 'Forward').forEach((i) => i.click());
      expect(mw.webContents.send).toHaveBeenCalledWith('navigateBackActive');
      expect(mw.webContents.send).toHaveBeenCalledWith('navigateForwardActive');
    });

    test('Window > Toggle Lock toggles via shortcutService', () => {
      const { template, ss } = appMenu();
      ss.toggleLocked = false;
      click(sub(template, 'Window'), 'Toggle Lock');
      expect(ss.toggleLocked).toBe(true);
      expect(ss.unregisterToggle).toHaveBeenCalled();
    });

    test('Help > Keyboard Shortcuts… opens shortcuts in renderer', () => {
      const { template, mw } = appMenu();
      click(sub(template, 'Help'), 'Keyboard Shortcuts…');
      expect(mw.webContents.send).toHaveBeenCalledWith('menu:open-shortcuts');
    });

    test('Help > GitHub / Bug Report open external URLs', async () => {
      const { template } = appMenu();
      const help = sub(template, 'Help');
      await help.find((i) => i.label === 'InstantCognition GitHub').click();
      await help.find((i) => i.label === 'Create a Bug Report').click();
      expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/daemon-summoner/InstantCognition');
      expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/daemon-summoner/InstantCognition/issues');
    });

    test('Help > Restart InstantCognition relaunches + quits', () => {
      const { template } = appMenu();
      click(sub(template, 'Help'), 'Restart InstantCognition');
      expect(app.relaunch).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });

    test('_sendToRenderer is a no-op when window is destroyed', () => {
      const { template } = appMenu();
      menuService.mainWindow.isDestroyed = () => true;
      const sendSpy = menuService.mainWindow.webContents.send;
      sendSpy.mockClear();
      click(sub(template, 'File'), 'Settings…');
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe('tray menu click handlers', () => {
    function trayMenu() {
      const ss = createMockShortcutService();
      const mw = createMockMainWindow();
      const ts = createMockTrayService();
      menuService.initialize(mw, ts, ss);
      menuService.buildAndSetMenus();
      return { template: Menu.buildFromTemplate.mock.calls[0][0], ss, mw };
    }

    test('InstantCognition item hides a visible window', () => {
      const { template, mw } = trayMenu();
      mw.isVisible.mockReturnValue(true);
      template.find((i) => i.label === 'InstantCognition').click();
      expect(mw.hide).toHaveBeenCalled();
    });

    test('InstantCognition item shows a hidden window', () => {
      const { template, mw } = trayMenu();
      mw.isVisible.mockReturnValue(false);
      template.find((i) => i.label === 'InstantCognition').click();
      expect(mw.show).toHaveBeenCalled();
    });

    test('Toggle Window delegates to shortcutService', () => {
      const { template, ss } = trayMenu();
      template.find((i) => i.label === 'Toggle Window').click();
      expect(ss.toggleWindow).toHaveBeenCalled();
    });

    test('Toggle Lock locks then unlocks across two clicks', () => {
      const { template, ss } = trayMenu();
      const lock = template.find((i) => i.label === 'Toggle Lock');
      ss.toggleLocked = false;
      lock.click();
      expect(ss.toggleLocked).toBe(true);
      expect(ss.unregisterToggle).toHaveBeenCalled();
      lock.click();
      expect(ss.toggleLocked).toBe(false);
      expect(ss.registerToggle).toHaveBeenCalled();
    });

    test('Restart InstantCognition relaunches + quits and sets quitting flag', () => {
      const { template } = trayMenu();
      template.find((i) => i.label === 'Restart InstantCognition').click();
      expect(menuService.isAppQuitting).toBe(true);
      expect(app.relaunch).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });

    test('Quit sets quitting flag and quits', () => {
      const { template } = trayMenu();
      template.find((i) => i.label === 'Quit').click();
      expect(menuService.isAppQuitting).toBe(true);
      expect(app.quit).toHaveBeenCalled();
    });
  });

  describe('buildAndSetMenus guards', () => {
    test('skips the tray menu when trayService has no tray', () => {
      const ss = createMockShortcutService();
      const mw = createMockMainWindow();
      menuService.initialize(mw, { tray: null, setContextMenu: jest.fn() }, ss);
      menuService.buildAndSetMenus();
      // Only the application menu is built (no tray template).
      expect(Menu.setApplicationMenu).toHaveBeenCalled();
      expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    });
  });
});
