/**
 * backgroundWindows.js — preloaded into the app's main process by AppHarness
 * (an Electron -r argument) so an E2E run never takes over the desktop: every
 * window shows without activating the app, stays fully transparent and lets
 * clicks through to whatever the person at the machine is using. Playwright
 * drives the page over CDP, so input, screenshots and capturePage still work.
 *
 * IC_E2E_VISIBLE=1 skips this, for watching a run.
 */

const { app } = require('electron');

if (process.platform === 'darwin' && app.dock) app.dock.hide();

app.on('browser-window-created', (_event, win) => {
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.show = () => { if (!win.isDestroyed()) win.showInactive(); };
  win.focus = () => {};
  win.moveTop = () => {};
  win.setAlwaysOnTop = () => {};
});

app.focus = () => {};
