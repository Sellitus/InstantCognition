// Quick launcher IPC. launcher:submit {text} opens a launcher-sourced session
// and streams a chat answer into the launcher window as 'launcher:stream'
// {sessionId, type:'chunk'|'done'|'error', delta?, error?}; the turn is
// persisted to the session like any chat-lane turn. launcher:open-in-assistant
// {sessionId} hands the session to the main window as 'app-mode:set'.
// Also owns the launcher's global hotkey (main/launcher/launcherHotkey).
const { app, ipcMain, globalShortcut } = require('electron');
const chatStream = require('../services/ChatStreamService');
const { assertSessionId } = require('../agent/sessions/sessionStore');
const { getLauncherWindow } = require('../launcher/launcherWindow');
const { runLauncherAnswer } = require('../launcher/launcherAnswer');
const { createLauncherHotkey, bindLauncherHotkey } = require('../launcher/launcherHotkey');

const MAX_TEXT = 100000;
const TITLE_CHARS = 80;
const errText = (err) => (err instanceof Error && err.message) || String(err);
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
  try { return await fn(arg && typeof arg === 'object' ? arg : {}); } catch (err) { return { ok: false, error: errText(err) }; }
});

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {object} services
 * @param {{ launcher?: any, globalShortcut?: any }} [deps] test seams for the Electron window/shortcut boundary
 */
function register(mainWindow, services, deps = {}) {
  const store = services && services.sessionStore;
  if (!store) return null;
  const { sessionManager, configService, notificationService } = services;
  const mainAlive = () => !!mainWindow && !mainWindow.isDestroyed();
  const sendMain = (channel, payload) => { if (mainAlive()) mainWindow.webContents.send(channel, payload); };
  const notify = (tag, title, body) => {
    if (notificationService) notificationService.add({ origin: 'instantcognition://launcher', tag, title, body });
  };
  const launcher = deps.launcher || getLauncherWindow({
    getTheme: () => (configService ? configService.get('settings.theme', 'dark') : 'dark'),
    onOpenUrl: (url) => sendMain('open-new-tab', url),
    // Hand focus back to the app the user came from when nothing else of ours is on screen.
    onHide: () => { if (process.platform === 'darwin' && !(mainAlive() && mainWindow.isVisible())) app.hide(); },
    onError: (err) => {
      console.error('[launcher] window failed to load:', errText(err));
      notify('launcher-load', 'Quick launcher failed to open', errText(err));
    },
  });
  const answerDeps = {
    chat: chatStream, store,
    artifactStore: () => services.artifactStore || require('../agent/artifacts/artifactStore').getDefaultArtifactStore(),
    onSessionEvent: (sid, channel, payload) => { if (sessionManager) sessionManager.emitEvent(sid, channel, payload); },
  };

  handle('launcher:submit', ({ text }) => {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error('invalid_text');
    const meta = store.create({ title: text.trim().slice(0, TITLE_CHARS), source: 'launcher' });
    // Held until the answer is persisted, so "open in assistant" cannot start a second writer on it.
    if (sessionManager) sessionManager.claim(meta.id);
    runLauncherAnswer(answerDeps, meta.id, text, (type, extra) => launcher.send('launcher:stream', { sessionId: meta.id, type, ...extra }))
      .finally(() => { if (sessionManager) sessionManager.release(meta.id); });
    return { ok: true, sessionId: meta.id };
  });

  handle('launcher:open-in-assistant', ({ sessionId }) => {
    if (!store.exists(assertSessionId(sessionId))) throw new Error('session_not_found');
    if (!mainAlive()) throw new Error('main_window_unavailable');
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    launcher.hide();
    sendMain('app-mode:set', { mode: 'assistant', sessionId });
    return { ok: true };
  });

  handle('launcher:hide', () => { launcher.hide(); return { ok: true }; });

  if (configService) {
    const hotkey = createLauncherHotkey({
      globalShortcut: deps.globalShortcut || globalShortcut,
      configService,
      onTrigger: () => launcher.toggle(),
      onFailure: ({ hotkey: combo, error }) => {
        console.error(`[launcher] could not register hotkey "${combo}": ${error}`);
        sendMain('shortcut:register-failed', { shortcut: combo });
        notify('launcher-hotkey', 'Quick launcher hotkey unavailable',
          `"${combo}" could not be registered (${error}). Another app or the system may own it; choose a different launcher hotkey.`);
      },
    });
    bindLauncherHotkey({ ipcMain, configService, hotkey });
  }
  return launcher;
}

module.exports = { register };
