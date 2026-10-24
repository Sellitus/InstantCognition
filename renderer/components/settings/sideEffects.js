// sideEffects — what happens after a registry row's value is persisted.
//
// A row names its effect with `sideEffect: '<name>'`; SettingsView calls
// runSideEffect() after configBridge.set(). Effects push the new value into
// the live app (appearance re-apply, IPC to main). An unknown name throws so
// a typo in the registry surfaces as a visible row error instead of a silent
// no-op; registry tests assert every row names a known effect.

const { ipcRenderer } = require('electron');
const configBridge = require('../../core/configBridge');

const APPEARANCE_EFFECTS = ['applyTheme', 'applyAnimations', 'applySidebarWidth', 'applyAppearance', 'applyPageZoom', 'applyUIDensity'];

function reapplyAppearance() {
  const cfg = configBridge.snapshot();
  const w = /** @type {any} */ (window);
  if (cfg && cfg.settings && typeof w.applyAppearanceSettings === 'function') w.applyAppearanceSettings(cfg.settings);
}

async function confirmResetAll() {
  const { confirm } = require('../ConfirmDialog');
  const ok = await confirm({
    title: 'Reset all settings?',
    message: 'Every setting will return to its factory default. This cannot be undone.',
    confirmLabel: 'Reset',
    confirmKind: 'danger',
  });
  if (ok) ipcRenderer.send('settings:reset-all');
}

/**
 * name → (value, ctx) => void | Promise<void>. `ctx.hideSettings()` closes the
 * settings panel for effects that open another surface.
 * @type {Record<string, (value: any, ctx: { hideSettings: () => void }) => (void | Promise<void>)>}
 */
const EFFECTS = {
  ...Object.fromEntries(APPEARANCE_EFFECTS.map((name) => [name, () => reapplyAppearance()])),
  applyChromeLayout: (value) => {
    const w = /** @type {any} */ (window);
    if (w.appState && typeof w.appState.set === 'function') w.appState.set('chromeLayout', value);
    reapplyAppearance();
  },
  applyAdblocker: (value) => ipcRenderer.send(value ? 'call-createAndUpdateaAblocker' : 'call-disableAdblocker'),
  applyDns: () => ipcRenderer.send('dns:apply'),
  applyLaunchAtStartup: (value) => ipcRenderer.send(value ? 'call-enableLaunchAtStartup' : 'call-disableLaunchAtStartup'),
  applyAutoDenyCertErrors: (value) => ipcRenderer.send('set-auto-deny-cert-errors', !!value),
  applyPrivateIpCertRanges: () => {
    const cfg = configBridge.snapshot() || {};
    const ranges = (cfg.settings && cfg.settings.autoAcceptCertsForPrivateIps) || {};
    ipcRenderer.send('set-private-ip-cert-ranges', { ...ranges });
  },
  applySpellCheck: () => ipcRenderer.send('settings:apply-spellcheck'),
  applyLogLevel: (value) => ipcRenderer.send('settings:set-log-level', String(value || 'info')),
  setDefaultBrowser: () => ipcRenderer.send('settings:set-default-browser'),
  checkForUpdates: () => ipcRenderer.send('updater:check-now'),
  checkForEngineUpdates: () => ipcRenderer.send('engine-updater:check-now'),
  resetAllSettings: () => confirmResetAll(),
  openBrowserDataPanel: (_value, ctx) => {
    const w = /** @type {any} */ (window);
    if (!w.browserDataPanel || typeof w.browserDataPanel.toggle !== 'function') {
      throw new Error('The browsing-data panel is not available in this window.');
    }
    ctx.hideSettings();
    setTimeout(() => w.browserDataPanel.toggle(), 80);
  },
  openConfigFile: () => ipcRenderer.send('open-config-file'),
  restartApp: () => ipcRenderer.send('restart-app'),
};

/**
 * Run a named side effect. Throws on an unknown name; returns the effect's
 * promise (if any) so callers can surface async failures.
 */
function runSideEffect(name, value, ctx) {
  if (!name) return undefined;
  const fn = EFFECTS[name];
  if (typeof fn !== 'function') throw new Error(`Unknown settings side effect "${name}"`);
  return fn(value, ctx);
}

module.exports = { runSideEffect, SIDE_EFFECT_NAMES: Object.freeze(Object.keys(EFFECTS)) };
