// Global hotkey for the quick launcher, driven by settings.assistant.launcher
// {enabled, hotkey}. sync() converges the registration on the current
// settings and is idempotent, so it runs on every settings write. A combo
// that cannot be registered (owned by the OS or another app, or not a valid
// accelerator) is reported through onFailure once per attempted combo rather
// than retried on every unrelated settings write.
const DEFAULT_HOTKEY = 'Alt+Shift+Space';
const SETTINGS_KEY = 'settings.assistant.launcher';

/** {enabled, hotkey} from config; a missing or blank hotkey falls back to the default. */
function readLauncherSettings(configService) {
  const raw = configService.get(SETTINGS_KEY, null);
  const s = raw && typeof raw === 'object' ? raw : {};
  const hotkey = typeof s.hotkey === 'string' && s.hotkey.trim() ? s.hotkey.trim() : DEFAULT_HOTKEY;
  return { enabled: s.enabled !== false, hotkey };
}

/**
 * @param {{ globalShortcut: any, configService: any, onTrigger: () => void,
 *   onFailure: (info: { hotkey: string, error: string }) => void }} deps
 */
function createLauncherHotkey({ globalShortcut, configService, onTrigger, onFailure }) {
  let registered = null;
  let failed = null;

  function release() {
    if (registered) globalShortcut.unregister(registered);
    registered = null;
  }

  /** @returns {{ ok: boolean, hotkey: string|null, error?: string }} */
  function sync() {
    const { enabled, hotkey } = readLauncherSettings(configService);
    const want = enabled ? hotkey : null;
    if (want === null) {
      release();
      failed = null;
      return { ok: true, hotkey: null };
    }
    if (want === registered) return { ok: true, hotkey: registered };
    if (want === failed) return { ok: false, hotkey: null, error: 'accelerator_unavailable' };
    release();
    failed = null;
    let ok = false;
    let error = 'accelerator_unavailable';
    try {
      ok = globalShortcut.register(want, onTrigger) === true;
    } catch (err) {
      // Electron throws on a malformed accelerator string.
      error = (err instanceof Error && err.message) || String(err);
    }
    if (!ok) {
      failed = want;
      onFailure({ hotkey: want, error });
      return { ok: false, hotkey: null, error };
    }
    registered = want;
    return { ok: true, hotkey: want };
  }

  return { sync, release, current: () => registered };
}

/**
 * Keeps the hotkey in step with settings. ConfigService only emits per-path
 * 'change' events from set(); the renderer's bulk config:update /
 * config:replace writes emit nothing there, so those IPC messages are
 * observed too. The resync is deferred a microtask so it reads the config
 * after configHandlers has applied the write, whatever the listener order.
 * @param {{ ipcMain: any, configService: any, hotkey: ReturnType<typeof createLauncherHotkey> }} deps
 * @returns {() => void} unsubscribe
 */
function bindLauncherHotkey({ ipcMain, configService, hotkey }) {
  const resync = () => queueMicrotask(() => hotkey.sync());
  const onChange = (e) => {
    const p = e && typeof e.path === 'string' ? e.path : '';
    if (p === 'settings' || p === 'settings.assistant' || p.startsWith('settings.assistant.launcher')) resync();
  };
  configService.on('change', onChange);
  configService.on('reset', resync);
  ipcMain.on('config:update', resync);
  ipcMain.on('config:replace', resync);
  hotkey.sync();
  return () => {
    configService.removeListener('change', onChange);
    configService.removeListener('reset', resync);
    ipcMain.removeListener('config:update', resync);
    ipcMain.removeListener('config:replace', resync);
  };
}

module.exports = { createLauncherHotkey, bindLauncherHotkey, readLauncherSettings, DEFAULT_HOTKEY };
