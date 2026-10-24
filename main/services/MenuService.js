const { Menu, app, shell } = require('electron');
const { MENU_ACCELERATORS } = require('../../shared/navigationInput');
const pageOutput = require('./pageOutput');
const passwordService = require('./PasswordService');

// Cmd/Ctrl+Shift+P is the assistant panel's persona-lock key (PersonaControl).
const NEW_PRIVATE_TAB_ACCELERATOR = 'CmdOrCtrl+Alt+P';

class MenuService {
  constructor() {
    this.mainWindow = null;
    this.trayService = null;
    this.shortcutService = null;
    this._isAppQuitting = false;
  }

  initialize(mainWindow, trayService, shortcutService) {
    this.mainWindow = mainWindow;
    this.trayService = trayService;
    this.shortcutService = shortcutService;
  }

  setAppQuitting(value) { this._isAppQuitting = value; }
  get isAppQuitting() { return this._isAppQuitting; }
  _sendToRenderer(channel, ...args) { if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.webContents.send(channel, ...args); }

  buildAndSetMenus() {
    if (!this.mainWindow) return;

    const ss = this.shortcutService;
    const mw = this.mainWindow;

    // Build tray context menu
    if (this.trayService && this.trayService.tray) {
      const trayMenu = Menu.buildFromTemplate(this._buildTrayTemplate(ss, mw));
      this.trayService.setContextMenu(trayMenu);
    }

    // Build application menu
    const menuTemplate = this._buildAppMenuTemplate(ss, mw);
    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
  }

  /**
   * Set up the webview context menu handler.
   */
  setupWebviewContextMenu() {
    if (!this.mainWindow) return;

    this.mainWindow.webContents.on('did-attach-webview', (_, contents) => {
      contents.on('context-menu', (_, params) => {
        const mw = this.mainWindow;
        /** @type {Electron.MenuItemConstructorOptions[]} */
        const template = [
          { label: 'Copy', role: 'copy' },
          { label: 'Paste', role: 'paste' },
          { label: 'Cut', role: 'cut' },
          { type: 'separator' },
          { label: 'Select All', role: 'selectAll' },
          { type: 'separator' },
          { label: 'Print…', click: () => pageOutput.printPage(contents, mw) },
          { label: 'Save Page as PDF…', click: () => pageOutput.savePageAsPdf(contents, mw) },
          { type: 'separator' },
          {
            label: 'Find in Page',
            accelerator: 'CmdOrCtrl+F',
            click: () => {
              mw.webContents.send('focusWebviewByWebContents', contents.id);
              mw.webContents.send('toggleFindBar');
            },
          },
          { type: 'separator' },
          {
            label: 'Close',
            click: () => mw.webContents.send('closeWebviewByWebContents', contents.id),
          },
          { label: 'Inspect Element', accelerator: process.platform === 'darwin' ? 'Cmd+Alt+I' : 'F12', click: () => { try { if (contents.inspectElement && params.x != null) contents.inspectElement(params.x, params.y); else if (contents.openDevTools) contents.openDevTools({ mode: 'detach' }); } catch (err) { console.error('Inspect Element failed:', err); } } },
          { type: 'separator' },
          { label: 'Back', click: () => { contents.navigationHistory.goBack(); } },
          { label: 'Forward', click: () => { contents.navigationHistory.goForward(); } },
          { label: 'Refresh', click: () => contents.reload() },
          { label: 'Home', click: () => mw.webContents.send('navigateHomeForWebContents', contents.id) },
          { type: 'separator' },
        ];

        if (params.mediaType === 'video') {
          template.push({ label: 'Picture in Picture', click: () => {
            const sj = JSON.stringify(params.srcURL || '');
            contents.executeJavaScript(`(function(){const vs=Array.from(document.querySelectorAll('video'));const v=vs.find(x=>x.currentSrc===${sj})||vs.find(x=>!x.paused)||vs[0];if(v&&v.requestPictureInPicture)v.requestPictureInPicture().catch(e=>console.error('PiP request failed:',e));})();`).catch((e)=>console.error('PiP failed:',e));
          } });
          template.push({ type: 'separator' });
        }

        // Add search/open link options based on selection
        if (params.selectionText) {
          template.push({
            label: `Search "${params.selectionText.substring(0, 30)}${params.selectionText.length > 30 ? '...' : ''}"`,
            click: () => {
              mw.webContents.send('open-url', `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`);
            },
          });
        }

        if (params.linkURL) {
          template.push({
            label: 'Open Link',
            click: () => mw.webContents.send('open-url', params.linkURL),
          });
        }

        template.push(...passwordService.contextMenuItems(contents));
        const contextMenu = Menu.buildFromTemplate(template);
        contextMenu.popup({ window: mw, x: params.x, y: params.y });
      });
    });
  }

  /** @returns {Electron.MenuItemConstructorOptions[]} */
  _buildTrayTemplate(ss, mw) {
    return [
      { label: 'InstantCognition', click: () => { if (mw.isVisible()) mw.hide(); else mw.show(); } },
      { type: 'separator' },
      { label: 'Toggle Window', accelerator: ss.toggleShortcut, click: () => ss.toggleWindow() },
      { type: 'separator' },
      {
        label: 'Toggle Lock',
        accelerator: ss.lockShortcut,
        click: () => {
          if (ss.toggleLocked) {
            ss.toggleLocked = false;
            ss.registerToggle();
          } else {
            ss.toggleLocked = true;
            ss.unregisterToggle();
          }
        },
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { type: 'separator' },
      {
        label: 'Restart InstantCognition',
        click: () => { this._isAppQuitting = true; app.relaunch(); app.quit(); },
      },
      {
        label: 'Quit',
        accelerator: ss.quitShortcut,
        click: () => { this._isAppQuitting = true; app.quit(); },
      },
    ];
  }

  /** @returns {Electron.MenuItemConstructorOptions[]} */
  _buildAppMenuTemplate(ss, mw) {
    return [
      {
        label: 'File',
        submenu: [
          // Menu accelerators still fire while a page has focus; the renderer's shortcut listener does not.
          { label: 'New Private Tab', accelerator: NEW_PRIVATE_TAB_ACCELERATOR, click: () => this._sendToRenderer('tabs:new-private') },
          { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => this._sendToRenderer('tabs:reopen-closed') },
          { type: 'separator' },
          { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => this._sendToRenderer('page:print-active') },
          { label: 'Save Page as PDF…', click: () => this._sendToRenderer('page:save-pdf-active') },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => this._sendToRenderer('menu:open-settings') },
          { label: 'Restart App', click: () => { this._isAppQuitting = true; app.relaunch(); app.quit(); } },
          { label: 'Quit', accelerator: ss.quitShortcut, click: () => { this._isAppQuitting = true; app.quit(); } },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { type: 'separator' },
          { label: 'Find', accelerator: 'CmdOrCtrl + F', click: () => mw.webContents.send('toggleFindBar') },
          { label: 'Find Next', accelerator: 'CmdOrCtrl + G', click: () => mw.webContents.send('findBarForward') },
          { label: 'Find Previous', accelerator: 'Shift + CmdOrCtrl + G', click: () => mw.webContents.send('findBarBack') },
          { type: 'separator' },
          { role: 'selectAll' },
          { type: 'separator' },
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'toggleSpellChecker' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Toggle Window', accelerator: ss.toggleShortcut, click: () => ss.toggleWindow() },
          { type: 'separator' },
          {
            label: 'Toggle Lock', accelerator: ss.lockShortcut,
            click: () => {
              if (ss.toggleLocked) { ss.toggleLocked = false; ss.registerToggle(); }
              else { ss.toggleLocked = true; ss.unregisterToggle(); }
            },
          },
          { type: 'separator' },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl + =', click: () => mw.webContents.send('zoomInActive') },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl + -', click: () => mw.webContents.send('zoomOutActive') },
          { label: 'Zoom Reset', accelerator: 'CmdOrCtrl + 0', click: () => mw.webContents.send('zoomResetActive') },
          { type: 'separator' },
          { label: 'Toggle View', accelerator: 'F8', click: () => mw.webContents.send('toggleView') },
          { label: 'Close Browser', click: () => mw.webContents.send('closeBrowser') },
          { label: 'Close Space', click: () => mw.webContents.send('closeActiveSpace') },
          { type: 'separator' },
          { label: 'Toggle MultiSpace', click: () => mw.webContents.send('toggleMultiSpace') },
          { label: 'Toggle Space', click: () => mw.webContents.send('toggleSpaceView') },
          { label: 'Toggle Browser', click: () => mw.webContents.send('toggleBrowserView') },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'toggleDevTools' },
        ],
      },
      {
        label: 'Navigation',
        submenu: [
          { label: 'Previous Space', accelerator: 'F1', click: () => mw.webContents.send('select-previous-space') },
          { label: 'Next Space', accelerator: 'F2', click: () => mw.webContents.send('select-next-space') },
          { type: 'separator' },
          { label: 'Back', accelerator: 'F3', click: () => mw.webContents.send('navigateBackActive') },
          { label: 'Forward', accelerator: 'F4', click: () => mw.webContents.send('navigateForwardActive') },
          // Hidden accelerators for Cmd+[/Cmd+] (macOS standard, Logitech mouse drivers)
          { label: 'Back', accelerator: MENU_ACCELERATORS.BACK, visible: false, click: () => mw.webContents.send('navigateBackActive') },
          { label: 'Forward', accelerator: MENU_ACCELERATORS.FORWARD, visible: false, click: () => mw.webContents.send('navigateForwardActive') },
          { type: 'separator' },
          { label: 'Refresh', accelerator: 'F5', click: () => mw.webContents.send('refreshActive') },
          { label: 'Home', accelerator: 'F6', click: () => mw.webContents.send('navigateHomeReset') },
          { type: 'separator' },
        ],
      },
      {
        label: 'Window',
        role: 'windowMenu',
        submenu: [
          {
            label: 'Toggle Lock', accelerator: ss.lockShortcut,
            click: () => {
              if (ss.toggleLocked) { ss.toggleLocked = false; ss.registerToggle(); }
              else { ss.toggleLocked = true; ss.unregisterToggle(); }
            },
          },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'minimize' },
          { role: 'close' },
        ],
      },
      {
        label: 'Help',
        role: 'help',
        submenu: [
          { label: 'Keyboard Shortcuts…', accelerator: 'CmdOrCtrl+/', click: () => this._sendToRenderer('menu:open-shortcuts') },
          { type: 'separator' },
          { label: 'InstantCognition GitHub', click: async () => { await shell.openExternal('https://github.com/daemon-summoner/InstantCognition'); } },
          { label: 'Create a Bug Report', click: async () => { await shell.openExternal('https://github.com/daemon-summoner/InstantCognition/issues'); } },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'forceReload' },
          { type: 'separator' },
          { label: 'Restart InstantCognition', click: () => { this._isAppQuitting = true; app.relaunch(); app.quit(); } },
        ],
      },
    ];
  }
}

module.exports = new MenuService();
