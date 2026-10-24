// ##### renderer.js — InstantCognition Renderer Bootstrap
// Orchestrates the renderer process: loads config, initializes state + managers,
// sets up IPC bridge, registers shortcuts, and connects to DOM.

const { ipcRenderer } = require('electron');
const { DEFAULT_CONFIG, migrateConfig } = require('../shared/configDefaults');
const { errMsg } = require('../shared/errMsg');

// Import components
const { ensureSpriteInstalled } = require('./components/Icon');
const toast = require('./components/Toast');
const shortcutManager = require('./utils/shortcuts');
const { INPUT_SAFE_ACTIONS } = require('./utils/shortcuts');
const { deriveAccentVars, ACCENT_KEYS } = require('./utils/accentColor');
const { attachHistoryRecorder } = require('./utils/historyRecorder');
// Settings UI: registry-driven SettingsView is the only menu now.
const settingsMenu = require('./components/settings/SettingsView');
const commandPalette = require('./components/CommandPalette');
const agentPanel = require('./components/AgentPanel');
const libraryWindow = require('./components/LibraryWindow');
const readerView = require('./components/ReaderView');
const permissionPrompt = require('./components/PermissionPrompt');
const siteBlockedPrompt = require('./components/SiteBlockedPrompt');
const passwordSaveBar = require('./components/PasswordSaveBar');
const tabBar = require('./components/TabBar');
const TabChromeStrip = require('./components/TabChromeStrip');
const newTabPicker = require('./components/NewTabPicker');
const welcomeOverlay = require('./components/WelcomeOverlay');
const chromeBar = require('./components/ChromeBar');
const fx = require('./fx');


// Import new architecture
const AppState = require('./core/AppState');
const configBridge = require('./core/configBridge');
const NavigationManager = require('./managers/NavigationManager');
const FindBarManager = require('./managers/FindBarManager');
const BrowserViewManager = require('./managers/BrowserViewManager');
const SpaceManager = require('./managers/SpaceManager');
const LayoutManager = require('./managers/LayoutManager');
const AgentWorkspaceManager = require('./managers/AgentWorkspaceManager');
const { ShellStore } = require('./core/ShellStore');
const { ViewShellManager } = require('./managers/ViewShellManager');
const { handleAppModeSet } = require('./launcher/appModeBridge');
const ipcBridge = require('./ipc/ipcBridge');

// --- Config loading ---
let _configResetReason = null; // Set when config falls back to backup or defaults
// What main has already been told, seeded at startup and advanced on every
// save. The legacy `config` object is mutated in place but never learns about
// granular writes that land through the v2 settings registry (configBridge →
// main's configService), so shipping it wholesale via config:replace would roll
// those writes back. Saves diff against this snapshot and send only the delta.
// The snapshot must advance: a value edited and then returned to its startup
// value still differs from what main holds, and a stale baseline hides it.
let _settingsBaseline = null;
// Marker for a key the legacy tree no longer carries (e.g. a closed ad-hoc
// tab's state.adHocSpaces entry). A deep-merge cannot express a removal, so
// any diff containing one takes the full-replace path instead.
const _DELETED = Symbol('config.deleted');

function createFallbackConfig() {
  return migrateConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), process.platform);
}

function loadSettings() {
  try {
    const result = ipcRenderer.sendSync('config:get-sync');
    if (result && result.config) {
      _configResetReason = result.resetReason || null;
      _settingsBaseline = JSON.parse(JSON.stringify(result.config));
      return result.config;
    }
  } catch (error) {
    console.error('Error loading config from main process:', errMsg(error));
  }

  _configResetReason = 'defaults';
  const fallback = createFallbackConfig();
  _settingsBaseline = JSON.parse(JSON.stringify(fallback));
  return fallback;
}

function saveSettings(config) {
  if (!_settingsBaseline) {
    // No startup snapshot to diff against (should not happen at this point in
    // the bootstrap): fall back to the legacy full-replace rather than drop
    // the save silently.
    ipcRenderer.send('config:replace', JSON.parse(JSON.stringify(config)));
    _settingsBaseline = JSON.parse(JSON.stringify(config));
    return;
  }
  const changed = _diffConfigs(_settingsBaseline, config);
  if (Object.keys(changed).length === 0) return;
  if (!_diffHasDeletes(changed)) {
    // Granular update: main deep-merges the delta into its live config, so
    // writes made after startup (v2 registry, main-side services) survive.
    ipcRenderer.send('config:update', changed);
    _settingsBaseline = JSON.parse(JSON.stringify(config));
    return;
  }
  // Deletes need a full tree. Ground it in main's current state so a
  // post-startup granular write survives, then apply the delta on top.
  const base = configBridge.refresh() || JSON.parse(JSON.stringify(config));
  _mergeInto(base, changed);
  ipcRenderer.send('config:replace', base);
  _settingsBaseline = JSON.parse(JSON.stringify(config));
}

// Keys whose value differs between two config trees, recursing through
// plain objects; arrays ship whole on change. Keys the second tree stopped
// carrying get the _DELETED marker.
function _diffConfigs(baseline, current) {
  const diff = {};
  if (!baseline || typeof baseline !== 'object'
    || !current || typeof current !== 'object') return diff;
  for (const key of Object.keys(current)) {
    const b = baseline[key];
    const c = current[key];
    if (b === c || c === undefined) continue; // undefined is not a real value (JSON drops it)
    if (b && c && typeof b === 'object' && typeof c === 'object'
      && !Array.isArray(b) && !Array.isArray(c)) {
      const sub = _diffConfigs(b, c);
      if (Object.keys(sub).length > 0) diff[key] = sub;
    } else if (JSON.stringify(b) !== JSON.stringify(c)) {
      diff[key] = c;
    }
  }
  for (const key of Object.keys(baseline)) {
    if (!(key in current)) diff[key] = _DELETED;
  }
  return diff;
}

function _diffHasDeletes(node) {
  for (const value of Object.values(node)) {
    if (value === _DELETED) return true;
    if (value && typeof value === 'object' && !Array.isArray(value) && _diffHasDeletes(value)) return true;
  }
  return false;
}

// Apply a diff (with _DELETED markers) onto a target tree, in place.
function _mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value === _DELETED) { delete target[key]; continue; }
    if (value && typeof value === 'object' && !Array.isArray(value)
      && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      _mergeInto(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function _showConfigResetNotification(reason) {
  const banner = document.createElement('div');
  banner.id = 'config-reset-banner';
  banner.className = 'config-reset-banner';

  const title = reason === 'recovered'
    ? 'Settings Restored from Backup'
    : 'Settings Were Reset to Defaults';
  const message = reason === 'recovered'
    ? 'Your config file was corrupted (likely from a crash). Settings were restored from the last known backup. Some recent changes may be missing.'
    : 'Your config file was corrupted and no backup was available. All settings have been reset to defaults.';
  const tips = reason === 'defaults'
    ? '<br><br><b>Recovery tips:</b><ul style="margin:4px 0 0 16px;padding:0">'
      + '<li>Check Time Machine or other backups for <code>~/.instant-cognition/config.json</code></li>'
      + '<li>Your space list, shortcuts, and appearance settings will need to be reconfigured</li></ul>'
    : '';

  banner.innerHTML = `
    <div style="flex:1"><strong>${title}</strong><br>${message}${tips}</div>
    <button id="config-reset-dismiss">Dismiss</button>
  `;


  document.body.appendChild(banner);
  document.getElementById('config-reset-dismiss').addEventListener('click', () => banner.remove());
}

// --- Initialize ---
const config = loadSettings();
// Seed the bridge before anything reads it: ShellStore.hydrate() below reads
// settings.assistant.* through it, long before SettingsView initializes.
configBridge.initialize(config);

// Create AppState and initialize from config
const state = new AppState();
state.initFromConfig(config);
state.set('config', config);
if (typeof window !== 'undefined') window.appState = state;

// Initialize loadedSpaces
const loadedSpaces = {};
Object.keys(config.spaces).forEach((key) => { loadedSpaces[key] = false; });
state.set('loadedSpaces', loadedSpaces);

// Build fullNames map (consumed by SettingsMenu space editor + command palette)
const fullNames = {};
const orderedKeys = config.spaceOrder || Object.keys(config.spaces);
orderedKeys.forEach((key) => {
  const space = config.spaces[key];
  if (space) fullNames[key] = space.name;
});
state.set('fullNames', fullNames);

// Create managers
const navigationManager = new NavigationManager(state);
const findBarManager = new FindBarManager(state, navigationManager);
const layoutManager = new LayoutManager(state);
const browserViewManager = new BrowserViewManager(state, navigationManager);
const spaceManager = new SpaceManager(state, navigationManager, layoutManager);
spaceManager.setSaveCallback(saveSettings);
spaceManager.setFindBarManager(findBarManager);
layoutManager.setSpaceManager(spaceManager);
navigationManager.setFindBarManager(findBarManager);
browserViewManager.setFindBarManager(findBarManager);
navigationManager.setFindBarManager(findBarManager);

const agentWorkspaceManager = new AgentWorkspaceManager({ state });
agentWorkspaceManager.initialize();
window.agentWorkspaceManager = agentWorkspaceManager;

// Assistant shell: browser mode ⇄ assistant mode, persisted under settings.assistant.
const shellStore = new ShellStore({ bridge: configBridge });
shellStore.hydrate();
const viewShellManager = new ViewShellManager({
  store: shellStore,
  ipc: ipcRenderer,
  getContext: () => ({ navigationManager, browserViewManager, state }),
  getMotionLevel: () => fx.getLevel(),
});
agentPanel.setViewShell(viewShellManager);

// Main forwards these chords while a webview has keyboard focus, since the
// guest's keydown never reaches this document. Anything else is rejected.
const FORWARDABLE_SHORTCUTS = new Set(['view.flip', 'panel.chat']);
function handleForwardedShortcut(payload) {
  const action = payload && payload.action;
  if (typeof action !== 'string' || !FORWARDABLE_SHORTCUTS.has(action)) {
    console.warn('[shortcuts] ignored forwarded shortcut:', action);
    return;
  }
  if (document.body.classList.contains('recording-shortcut')) return;
  executeShortcutAction(action);
}

// Main mutates the space library and the tab model directly (spaces:add /
// spaces:remove / rename in the settings editor, persisted to config by
// configService). configBridge refreshes its own cache on those broadcasts,
// but the renderer consumers (NewTabPicker, TabBar labels, per-tab home URL,
// agent title lookups, SpaceManager reconciler) read the boot-time config
// snapshot, so push the fresh values into AppState here. cfg is the bridge's
// up-to-date cache (set writes are applied to it before listeners fire).
// Content guards keep the handler idempotent: a spaces:remove reaches the
// renderer through both the settings handler's broadcast and configHandlers'
// change re-broadcast, and the renderer's own saves echo back.
configBridge.onChange((payload, cfg) => {
  const kind = payload && payload.kind;
  const path = payload && payload.path;
  const relevant = kind === 'update' || kind === 'replace'
    || (kind === 'set' && path
      && (path === 'spaces' || path.startsWith('spaces.')
        || path === 'state' || path.startsWith('state.')));
  if (!relevant || !cfg || typeof cfg !== 'object') return;
  try {
    _syncSpaceModel(cfg);
  } catch (error) {
    console.error('[renderer] space-model sync from config:changed failed:', errMsg(error));
  }
});

function _syncSpaceModel(cfg) {
  const spaces = JSON.parse(JSON.stringify(cfg.spaces || {}));
  if (JSON.stringify(spaces) !== JSON.stringify(state.get('spaces') || {})) {
    // Deep-copy into the boot-time config tree so saveSettings' diff stays
    // grounded in the live tree (not an alias of the bridge cache).
    config.spaces = JSON.parse(JSON.stringify(spaces));
    state.set('spaces', spaces);
  }
  const st = cfg.state;
  if (!st || typeof st !== 'object') return;
  const liveOpen = state.get('openTabs') || [];
  // Config never holds private tabs; their absence is not a main-side close.
  const open = Array.isArray(st.openTabs) ? spaceManager.withPrivateTabs(st.openTabs) : null;
  if (open && JSON.stringify(open) !== JSON.stringify(liveOpen)) {
    const removed = liveOpen.filter((id) => !open.includes(id));
    config.state.openTabs = st.openTabs.slice();
    state.set('openTabs', open);
    if (Array.isArray(st.hiddenTabs)) {
      config.state.hiddenTabs = st.hiddenTabs.slice();
      state.set('hiddenTabs', st.hiddenTabs.slice());
    }
    if (Array.isArray(st.pinnedTabs)) {
      config.state.pinnedTabs = st.pinnedTabs.slice();
      state.set('pinnedTabs', st.pinnedTabs.slice());
    }
    if (removed.length > 0) {
      // Re-point focus BEFORE prune: _deactivate focuses currentSpaceId as
      // part of teardown, so it must already point at a surviving tab.
      if (removed.includes(state.get('currentSpaceId'))) {
        // Mirror main's re-point when it lands on a surviving tab; a stale or
        // removed persisted currentSpaceId falls back to the first open tab.
        let nextCurrent = null;
        if (typeof st.currentSpaceId === 'string' && st.openTabs.includes(st.currentSpaceId)) {
          nextCurrent = st.currentSpaceId;
        }
        if (!nextCurrent) nextCurrent = st.openTabs[0];
        if (nextCurrent) state.set('currentSpaceId', nextCurrent);
      }
      spaceManager.pruneRemovedTabs(removed);
      // spaces:remove has no last-tab floor (unlike SpaceManager.closeTab).
      // Deleting the last open space would otherwise leave a blank pane —
      // recover like boot does by opening the default space.
      if ((state.get('openTabs') || []).length === 0) {
        let initialSpace = config.settings.enableDefaultSpace
          ? (config.settings.defaultSpace || 'custom1')
          : 'custom1';
        // The default may have been the very space that was just deleted;
        // fall back to any surviving library entry so the pane is not blank.
        if (!(config.spaces || {})[initialSpace]) {
          initialSpace = Object.keys(config.spaces || {})[0];
        }
        if (initialSpace) spaceManager.openTab(initialSpace);
      }
    }
  } else {
    // Open set unchanged but the library edited in main: mirror hidden/pinned
    // so a main-side write can't desync them from the live tab model.
    if (Array.isArray(st.hiddenTabs)
      && JSON.stringify(st.hiddenTabs) !== JSON.stringify(state.get('hiddenTabs') || [])) {
      config.state.hiddenTabs = st.hiddenTabs.slice();
      state.set('hiddenTabs', st.hiddenTabs.slice());
    }
    if (Array.isArray(st.pinnedTabs)
      && JSON.stringify(st.pinnedTabs) !== JSON.stringify(state.get('pinnedTabs') || [])) {
      config.state.pinnedTabs = st.pinnedTabs.slice();
      state.set('pinnedTabs', st.pinnedTabs.slice());
    }
  }
}

// Apply settings from config
if (config.settings.multiSpace) {
  state.set('multiSpace', true);
}
if (config.settings.openLinkExternal) {
  state.set('openLinkExternal', true);
}
// The link handler reads this mirror on every click, so a Settings toggle has
// to reach it without a restart.
configBridge.onPathChange('settings.openLinkExternal', (value) => {
  config.settings.openLinkExternal = !!value;
  state.set('openLinkExternal', !!value);
});

// Legacy sidebar helpers removed. ChromeBar owns chrome.

// Initial view state
document.getElementById('browser-container').classList.remove('active');
document.getElementById('browser-container').classList.add('inactive');
document.getElementById('space-container').style.flex = '1';
document.getElementById('browser-container').style.flex = '0';

// --- Apply appearance settings ---
let _systemThemeListener = null;

function applyAppearanceSettings(settings) {
  const theme = settings.theme || 'dark';
  document.body.classList.remove('theme-light', 'theme-dark');

  // Remove previous system theme listener if any
  if (_systemThemeListener) {
    window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', _systemThemeListener);
    _systemThemeListener = null;
  }

  if (theme === 'system') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    document.body.classList.add(mq.matches ? 'theme-dark' : 'theme-light');
    // Live-update when OS theme changes
    _systemThemeListener = (e) => {
      document.body.classList.remove('theme-light', 'theme-dark');
      document.body.classList.add(e.matches ? 'theme-dark' : 'theme-light');
    };
    mq.addEventListener('change', _systemThemeListener);
  } else {
    document.body.classList.add(`theme-${theme}`);
  }
  // forceReducedMotion forces no-animations regardless of enableAnimations.
  const animationsOff = settings.enableAnimations === false || settings.forceReducedMotion === true;
  document.body.classList.toggle('no-animations', animationsOff);
  document.body.classList.toggle('no-ripples', settings.enableRippleEffects === false);
  fx.applySettings(settings);
  document.body.classList.toggle('theme-high-contrast', settings.highContrast === true);
  // UI density: data attribute consumed by the design tokens.
  document.body.dataset.uiDensity = settings.uiDensity === 'compact' ? 'compact' : 'comfortable';
  // Accent override: inline vars on <body> win over the theme's :root/.theme-*
  // accent tokens for all descendants. Cleared (null/invalid) → theme default.
  const accentVars = deriveAccentVars(settings.accentColor);
  if (accentVars) {
    for (const [k, v] of Object.entries(accentVars)) document.body.style.setProperty(k, v);
  } else {
    for (const k of ACCENT_KEYS) document.body.style.removeProperty(k);
  }
  const width = settings.sidebarExpandedWidth || 220;
  document.documentElement.style.setProperty('--sidebar-expanded-width', `${width}px`);
  // Default page zoom — propagate to every webview live.
  if (typeof settings.pageZoomDefault === 'number') {
    const zf = Math.max(0.5, Math.min(2.0, settings.pageZoomDefault));
    document.documentElement.style.setProperty('--page-zoom-default', String(zf));
    try {
      ipcRenderer.send('webviews:set-zoom-default', zf);
    } catch (_) { /* ignore in tests */ }
    // Apply to all currently-attached webviews in this renderer too.
    try {
      const wvs = /** @type {NodeListOf<any>} */ (document.querySelectorAll('webview'));
      wvs.forEach((wv) => {
        if (typeof wv.setZoomFactor === 'function') wv.setZoomFactor(zf);
      });
    } catch (_) { /* ignore */ }
  }
}
// Exposed so SettingsView._reapplyAppearance() can live-preview theme/density/
// accent changes the moment they're toggled, without an app reload.
if (typeof window !== 'undefined') window.applyAppearanceSettings = applyAppearanceSettings;

function applySettings(settings) {
  if (settings.enableAdblocker) {
    ipcRenderer.send('call-createAndUpdateaAblocker');
  } else {
    ipcRenderer.send('call-disableAdblocker');
  }
  if (settings.launchAtStartup) {
    ipcRenderer.invoke('call-isLaunchAtStartupEnabled').then((isEnabled) => {
      if (!isEnabled) ipcRenderer.send('call-enableLaunchAtStartup');
    }).catch(console.error);
  } else {
    ipcRenderer.invoke('call-isLaunchAtStartupEnabled').then((isEnabled) => {
      if (isEnabled) ipcRenderer.send('call-disableLaunchAtStartup');
    }).catch(console.error);
  }
}

// --- Keyboard shortcuts ---
let currentShortcutListener = null;

function registerKeyboardShortcuts() {
  if (currentShortcutListener) {
    document.removeEventListener('keydown', currentShortcutListener);
  }
  const listener = (event) => {
    const target = event.target;

    // DevTools answers to two bindings (F12 everywhere, Cmd+Alt+I on macOS),
    // which the one-key-per-action registry cannot express.
    const isDevToolsKey = event.key === 'F12'
      || ((event.metaKey || event.ctrlKey) && event.altKey && event.key.toLowerCase() === 'i');
    if (isDevToolsKey) {
      event.preventDefault();
      try {
        const wv = navigationManager.getActiveWebview();
        const id = wv && typeof wv.getWebContentsId === 'function' ? wv.getWebContentsId() : null;
        ipcRenderer.send('view:open-devtools', id);
      } catch (_) { ipcRenderer.send('view:open-devtools', null); }
      return;
    }

    // The recorder in Settings owns every keystroke while it is capturing.
    if (document.body.classList.contains('recording-shortcut')) return;

    const shortcutKey = shortcutManager.eventToShortcut(event);
    if (!shortcutKey) return;

    const normalizedKey = shortcutManager.normalizeKey(shortcutKey);
    const shortcuts = shortcutManager.getAllShortcuts();
    const match = shortcuts.find((s) => shortcutManager.normalizeKey(s.key) === normalizedKey);
    if (!match) return;

    const inTextField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.contentEditable === 'true';
    if (inTextField && !INPUT_SAFE_ACTIONS.has(match.action)) return;

    event.preventDefault();
    event.stopPropagation();
    // A held flip chord would toggle the layout on every key repeat.
    if (event.repeat && match.action === 'view.flip') return;
    executeShortcutAction(match.action);
  };
  currentShortcutListener = listener;
  document.addEventListener('keydown', listener);
}

function executeShortcutAction(action) {
  switch (action) {
    case 'navigate.back': ipcRenderer.send('navigate-back'); break;
    case 'navigate.forward': ipcRenderer.send('navigate-forward'); break;
    case 'navigate.refresh': ipcRenderer.send('navigate-refresh'); break;
    case 'navigate.home': ipcRenderer.send('navigate-home'); break;
    case 'space.previous': spaceManager.previous(); break;
    case 'space.next': spaceManager.next(); break;
    case 'space.close': spaceManager.close(); break;
    case 'view.toggle': browserViewManager.toggleView(); break;
    case 'view.browser': browserViewManager.toggle(); break;
    case 'view.multiSpace': spaceManager.toggleMulti(); break;
    case 'view.space': browserViewManager.toggleSpace(); break;
    case 'view.agent': spaceManager.toggleViewMode(); break;
    case 'find.toggle': findBarManager.toggle(); break;
    case 'find.next': findBarManager.findNext(); break;
    case 'find.previous': findBarManager.findPrev(); break;
    case 'zoom.in': navigationManager.zoomIn(); break;
    case 'zoom.out': navigationManager.zoomOut(); break;
    case 'zoom.reset': navigationManager.zoomReset(); break;
    case 'window.toggle': ipcRenderer.send('toggle-window'); break;
    case 'window.lock': ipcRenderer.send('toggle-shortcuts-lock'); break;
    case 'palette.toggle': commandPalette.toggle(); break;
    case 'tab.new': newTabPicker.toggle(); break;
    case 'tab.close': spaceManager.close(); break;
    case 'panel.chat': agentPanel.toggle(); break;
    case 'view.flip': viewShellManager.requestFlip(); break;
    case 'panel.library': libraryWindow.toggle({ tab: 'ask' }); break;
    case 'panel.extensions': libraryWindow.open({ tab: 'extensions' }); break;
    case 'panel.notifications': libraryWindow.open({ tab: 'notifications' }); break;
    case 'app.settings': settingsMenu.toggle(); break;
    case 'chat.council': agentPanel.openChat({ prefill: '/council ' }); break;
    case 'urlbar.focus': {
      const wv = navigationManager.getActiveWebview();
      const wrapper = wv && wv.closest ? wv.closest('.space-webview-wrapper') : null;
      const strip = wrapper && wrapper._chromeStrip;
      if (strip && typeof strip.focus === 'function') strip.focus();
      break;
    }
    default:
      if (action.startsWith('space.select.')) {
        ipcRenderer.send('switch-space', parseInt(action.split('.')[2]));
      }
      break;
  }
}

// --- Checkbox initialization ---
function initializeCheckboxes() {
  const checkboxes = {
    preventMenuExpansion: config.settings.preventMenuExpansion,
    enableAdblocker: config.settings.enableAdblocker,
    launchAtStartup: config.settings.launchAtStartup,
    enableDefaultSpace: config.settings.enableDefaultSpace,
    openLinkExternal: config.settings.openLinkExternal,
    autoDenyCertErrors: config.settings.autoDenyCertErrors,
  };
  Object.entries(checkboxes).forEach(([id, value]) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    if (el) el.checked = !!value;
  });
}

// --- Utility ---
function debounce(func, wait) {
  let timeout;
  return /** @this {unknown} */ function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// --- Webview event wiring (find, gestures, click tracking) ---
// Tracks which webviews have already been wired to avoid duplicate listeners.
const _wiredWebviews = new WeakSet();

const _gestureHandler = debounce((event) => {
  const GESTURE_THRESHOLD = 750;
  const GESTURE_DIRECTION_THRESHOLD = 2.0;
  const deltaX = event.deltaX;
  const deltaY = event.deltaY;

  if (Math.abs(deltaX) > GESTURE_THRESHOLD &&
      Math.abs(deltaX) / Math.max(Math.abs(deltaY), 1) > GESTURE_DIRECTION_THRESHOLD) {
    if (deltaX > 0) {
      navigationManager.forward();
    } else {
      navigationManager.back();
    }
  }
}, 10);

/**
 * Look up a tab's display name for the per-tab agent panel header. Falls back
 * to spaceId so the strip never renders an empty title.
 */
function _getTabTitle(spaceId) {
  const cfg = state.get('config') || {};
  const meta = (cfg.spaces && cfg.spaces[spaceId]) || (state.get('adHocSpaces') || {})[spaceId];
  return (meta && meta.name) || spaceId;
}

/**
 * Mount or re-bind the per-tab chrome strip on a space wrapper. Skips the
 * standalone browser-webview (no wrapper). Called every time wireWebviewEvents
 * runs, including after NavigationManager._homeReset replaces the webview.
 */
function _mountChromeStripFor(webview) {
  if (!webview || webview.id === 'browser-webview') return;
  const wrapper = webview.closest && webview.closest('.space-webview-wrapper');
  if (!wrapper) return;
  if (wrapper._chromeStrip) {
    wrapper._chromeStrip.rebind(webview);
    return;
  }
  const strip = new TabChromeStrip({
    spaceId: webview.id,
    agentPanel,
    readerView,
    getTabTitle: _getTabTitle,
    // Resolve the per-tab "home" URL: predefined spaces (custom1=ChatGPT,
    // custom2=Claude, etc.) live in config.spaces; ad-hoc tabs (Cmd+click,
    // user-typed URLs, agent-opened links) live in state.adHocSpaces.
    // Returns null when neither has the spaceId, which disables the button.
    getHomeUrl: (sid) => {
      const cfg = state.get('config') || {};
      const sp = (cfg.spaces && cfg.spaces[sid]) || null;
      if (sp && sp.url) return sp.url;
      const ah = (state.get('adHocSpaces') || {})[sid];
      if (ah && ah.url) return ah.url;
      return null;
    },
    // Search settings come from the bridge's live cache (AppState's config is
    // the boot snapshot), so an engine or suggestion toggle applies at once.
    getSearchEngine: () => configBridge.get('settings.defaultSearchEngine', 'google') || 'google',
    getCustomEngines: () => configBridge.get('settings.customSearchEngines', []) || [],
    getSettings: () => configBridge.get('settings', {}) || {},
  });
  strip.mount(wrapper, webview);
  wrapper._chromeStrip = strip;
}

/**
 * Opt-in content capture for "Ask your browsing": extract the readable body so
 * terms in the page text match, not just title/URL. The main side no-ops unless
 * settings.askBrowsing.indexContent is on. Failures are logged only: a missed
 * extract just means the page text is unsearchable until the next visit.
 */
function _captureReadableContent(webview, url) {
  const { buildReadableScript } = require('../main/agent/readableExtractor');
  webview.executeJavaScript(buildReadableScript({ maxMainText: 8000 }), true).then((page) => {
    if (page && page.mainText) {
      ipcRenderer.invoke('browsing:capture-content', { url, text: page.mainText }).catch((err) => { console.error('[renderer] browsing:capture-content failed:', err instanceof Error ? err.message : String(err)); });
    }
  }).catch((err) => { console.error('[renderer] readable extract failed:', err instanceof Error ? err.message : String(err)); });
}

/**
 * Wire up event listeners on a webview for find-in-page, gestures, and click tracking.
 * Safe to call multiple times — skips already-wired webviews.
 */
function wireWebviewEvents(webview) {
  // Always (re)bind the per-tab strip — the WeakSet skip below would prevent
  // it from running on a webview that was already wired then replaced via
  // home-reset, but the strip rebind still needs to fire.
  _mountChromeStripFor(webview);
  if (_wiredWebviews.has(webview)) return;
  _wiredWebviews.add(webview);

  // Find-in-page result filtering (scoped to target webview + requestId)
  webview.addEventListener('found-in-page', (e) => {
    if (e.result) findBarManager.handleFoundInPage(webview, e.result);
  });

  // Gesture/trackpad navigation
  webview.addEventListener('wheel', _gestureHandler, { passive: true });

  // Browsing history. Only user panes reach wireWebviewEvents; agent-workspace
  // webviews are wired elsewhere so agent browsing never enters user history.
  attachHistoryRecorder(webview, {
    invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
    onCommit: (url) => _captureReadableContent(webview, url),
  });

  // Inject thin scrollbar CSS and click tracking into webview content
  webview.addEventListener('dom-ready', () => {
    // Fade out loading overlay
    const wrapper = webview.closest('.space-webview-wrapper');
    if (wrapper) {
      const overlay = wrapper.querySelector('.webview-loading-overlay');
      if (overlay) {
        overlay.classList.add('fade-out');
        setTimeout(() => overlay.remove(), 300);
      }
    }

    // Re-emit space-activity now that the guest WebContents is attached —
    // the initial emission from SpaceManager._activate often runs before
    // getWebContentsId() can return a valid id, leaving tabRegistry empty.
    try {
      const spaceId = webview.id;
      const wcId = webview.getWebContentsId ? webview.getWebContentsId() : null;
      if (spaceId && wcId) {
        const isActive = webview.classList.contains('active');
        ipcRenderer.send('space-activity', { spaceId, isActive, webContentsId: wcId });
      }
    } catch (_) { /* webview not ready */ }

    webview.insertCSS(`
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.4); border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.7); }
    `).catch((err) => { console.error('[renderer] insertCSS failed:', err instanceof Error ? err.message : String(err)); });
    webview.executeJavaScript(`
      document.addEventListener('click', (e) => {
        window.lastClickY = e.pageY;
      });
    `).catch((err) => { console.error('[renderer] lastClickY listener failed:', err instanceof Error ? err.message : String(err)); });
    navigationManager.restoreZoomLevel(webview);
  });
}

/**
 * Wire events for all existing webviews (called at startup).
 */
function initializeWebviewEvents() {
  document.querySelectorAll('webview').forEach(wireWebviewEvents);
}

// Expose so SpaceManager can call it when creating new webviews
window._wireWebviewEvents = wireWebviewEvents;

// --- Register IPC bridge ---
ipcBridge.registerAll({
  navigationManager,
  findBarManager,
  browserViewManager,
  spaceManager,
  layoutManager,
  agentWorkspaceManager,
  state,
});

// Settings menu toggle (Sidebar sends IPC, main bounces back)
ipcRenderer.on('toggle-settings-menu', () => settingsMenu.toggle());

// --- DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', () => {
  ensureSpriteInstalled();
  // Swipe/mouse-button navigation and the host keys, as webview pages get them.
  require('../shared/hostInput').install((channel, ...args) => ipcRenderer.send(channel, ...args), window);

  // Help menu → Keyboard Shortcuts opens Settings on the Shortcuts tab
  ipcRenderer.on('menu:open-shortcuts', () => {
    if (settingsMenu && typeof settingsMenu.showTab === 'function') settingsMenu.showTab('shortcuts');
  });

  // App menu → Preferences… (macOS Cmd+, / Linux+Win Settings…)
  ipcRenderer.on('menu:open-settings', () => {
    if (settingsMenu && typeof settingsMenu.toggle === 'function') settingsMenu.toggle();
  });

  // Download completion notifications (surfaces activity the user can't see when in another space)
  ipcRenderer.on('downloads:done', (_e, item) => {
    if (!item) return;
    const name = item.filename || item.name || 'file';
    toast.success(`Download complete: ${name}`, { title: 'Download' });
  });

  // Local LLM engine failures (spawn failure, mid-session crash after restarts
  // are exhausted) otherwise surface nowhere — fail loud so the user can act.
  ipcRenderer.on('llm:error', (_e, payload) => {
    const message = (payload && payload.message) || 'Local LLM engine error';
    toast.error(message, { title: 'LLM engine', timeout: 8000 });
  });

  // App updates download and install silently; only "Check for updates"
  // (Settings → Updates, payloads tagged manual) reports each step. The one
  // background notice is 'update-available' with manualDownload, sent when
  // this build cannot replace itself, so the toast links the release instead.
  // Held so the download notice can be replaced by the result rather than
  // stacking a second toast on top of it.
  let downloadToastId = null;
  const clearDownloadToast = () => {
    if (downloadToastId) { toast.dismiss(downloadToastId); downloadToastId = null; }
  };
  const showReleaseLink = (r) => toast.info(`Update available: v${r.version}${r.prerelease ? ' (beta)' : ''}`, {
    title: 'Updates',
    timeout: 0,
    action: { label: 'View release', onClick: () => ipcRenderer.send('open-external-url', r.url) },
  });
  ipcRenderer.on('updater:result', (_e, r) => {
    // Background results stay quiet; a release this build has to download
    // reaches the user through the toolbar Update pill (updater:nudge).
    if (r && !r.manual) {
      if (!r.ok) console.warn('[updater] background check failed:', r.error);
      return;
    }
    if (!r || !r.ok) {
      clearDownloadToast();
      toast.error((r && r.error) || 'Update check failed.', { title: 'Updates', timeout: 8000 });
    } else if (r.status === 'update-available') {
      clearDownloadToast();
      showReleaseLink(r);
    } else if (r.status === 'downloading') {
      // Progress arrives many times per second; one standing notice covers it.
      if (!downloadToastId) {
        downloadToastId = toast.info(`Downloading update${r.version ? ` v${r.version}` : ''} in the background...`, {
          title: 'Updates',
          timeout: 0,
        });
      }
    } else if (r.status === 'downloaded') {
      clearDownloadToast();
      toast.success(`Update v${r.version} is ready. It installs the next time you quit.`, {
        title: 'Updates',
        timeout: 0,
        action: {
          label: 'Restart now',
          onClick: () => ipcRenderer.invoke('updater:install').then((res) => {
            if (!res || !res.ok) toast.error((res && res.error) || 'Install failed.', { title: 'Updates' });
          }).catch((err) => {
            toast.error(`Restart failed: ${(err && err.message) || err}`, { title: 'Updates' });
          }),
        },
      });
    } else {
      clearDownloadToast();
      toast.success(`You're on the latest version (v${r.currentVersion}).`, { title: 'Updates' });
    }
  });

  // Inference runtime updates (llama.cpp, MLX). Main offers only the selected
  // local engine's update, at startup or on the first send after a check; the
  // download starts when the user presses Update, and Update + Restart also
  // reloads the running model on the new runtime once its reply finishes.
  let engineToastId = null;
  let enginePctShown = -1;
  const engineToast = (kind, message, opts = {}) => {
    if (engineToastId) { toast.dismiss(engineToastId); engineToastId = null; }
    engineToastId = toast[kind](message, { title: 'Inference runtimes', timeout: 0, ...opts });
  };
  const engineNames = { llamaCpp: 'llama.cpp', mlx: 'mlx-openai-server', omlx: 'oMLX', vllm: 'vLLM' };
  ipcRenderer.on('engine-updater:result', (_e, r) => {
    if (!r) return;
    if (!r.ok) {
      enginePctShown = -1;
      const what = r.phase === 'restart' ? 'updated, but the engine restart failed' : 'update failed';
      engineToast('error', `${engineNames[r.engine] || 'Runtime'} ${what}: ${r.error || 'unknown error'}`, { timeout: 10000 });
      return;
    }
    if (r.status === 'checking') {
      engineToast('info', 'Checking for newer inference runtime builds...');
    } else if (r.status === 'available') {
      const pending = (r.engines || []).filter((e) => e.updateAvailable);
      if (!pending.length) return;
      const first = pending[0];
      const extra = pending.length > 1 ? ` (+${pending.length - 1} more)` : '';
      const install = (restart) => {
        enginePctShown = -1;
        engineToast('info', `Updating ${first.name}...`);
        ipcRenderer.invoke('engine-updater:install', first.engine, { restart })
          .then((res) => {
            if (!res || !res.ok) engineToast('error', `${first.name} update failed: ${(res && res.error) || 'unknown error'}`, { timeout: 10000 });
          })
          .catch((err) => engineToast('error', `${first.name} update failed: ${(err && err.message) || err}`, { timeout: 10000 }));
      };
      const actions = [{ label: 'Update', onClick: () => install(false) }];
      if (r.liveEngine === first.engine) actions.push({ label: 'Update + Restart', onClick: () => install(true) });
      engineToast('info', `${first.name} update available: ${first.latest}${extra}`, { actions });
    } else if (r.status === 'downloading') {
      // Progress arrives per percent; step the notice so it stays readable.
      const pct = Math.floor(Number(r.percent || 0) / 10) * 10;
      if (pct === enginePctShown) return;
      enginePctShown = pct;
      engineToast('info', `Downloading ${engineNames[r.engine] || 'runtime'} ${r.version || ''} - ${pct}%`);
    } else if (r.status === 'installing') {
      enginePctShown = -1;
      engineToast('info', `Installing ${engineNames[r.engine] || 'runtime'}${r.step ? ` (${r.step})` : ''}...`);
    } else if (r.status === 'installed' && r.pendingRestart) {
      engineToast('info', `${engineNames[r.engine] || 'Runtime'} updated to ${r.version}. Restarting the engine once the current reply finishes...`);
    } else if (r.status === 'installed') {
      engineToast('success', `${engineNames[r.engine] || 'Runtime'} updated to ${r.version}. It is used the next time the engine starts.`, { timeout: 10000 });
    } else if (r.status === 'restarted') {
      const model = r.model ? String(r.model).split(/[\\/]/).pop() : 'the model';
      engineToast('success', `${engineNames[r.engine] || 'Runtime'} updated to ${r.version} and ${model} reloaded.`, { timeout: 10000 });
    } else if (r.status === 'up-to-date') {
      const lines = (r.engines || []).map((e) => `${e.name}: ${e.current}`).join(' | ');
      engineToast('success', lines ? `Runtimes are current. ${lines}` : 'Runtimes are current.', { timeout: 8000 });
    }
  });

  shortcutManager.loadShortcuts(config);

  // Sync toggle shortcut with main process (lock is already registered by ShortcutService.initialize)
  const toggleShortcut = shortcutManager.getShortcut('window.toggle');
  if (toggleShortcut) ipcRenderer.send('update-global-shortcut', { action: 'register', key: toggleShortcut.key });

  settingsMenu.initialize(config);
  commandPalette.initialize(() => ({
    spaces: state.get('config') ? state.get('config').spaces : config.spaces,
    spaceManager,
    navigationManager,
    findBarManager,
    browserViewManager,
    layoutManager,
    agentPanel,
    viewShell: viewShellManager,
    libraryWindow,
    readerView,
    newTabPicker,
    cycleLayout,
    toggleOpenLinkExternal,
    bookmarkPage: () => tabBar.bookmarkActivePage(),
    openSettings: () => settingsMenu.toggle(),
    toggleWindow: () => ipcRenderer.send('toggle-window'),
  }));
  agentPanel.initialize(() => ({ navigationManager, spaceManager, settingsMenu, agentWorkspaceManager, state }));
  libraryWindow.initialize(() => ({ navigationManager, spaceManager }));
  readerView.initialize(() => ({ navigationManager, state }));
  // @ts-ignore legacy settings side effects look up this window property.
  window.browserDataPanel = libraryWindow;
  permissionPrompt.initialize();
  siteBlockedPrompt.initialize();
  passwordSaveBar.initialize();
  tabBar.initialize({
    state, spaceManager, navigationManager,
    panels: {
      libraryWindow,
      agentPanel,
      viewShell: viewShellManager.asToggle(),
      settingsMenu,
      findBarManager,
      browserViewManager,
      readerView,
      cycleLayout,
      toggleOpenLinkExternal,
    },
  });
  newTabPicker.initialize({
    state,
    spaceManager,
    getSearchEngine: () => configBridge.get('settings.defaultSearchEngine', 'google') || 'google',
    getCustomEngines: () => configBridge.get('settings.customSearchEngines', []) || [],
    getSettings: () => configBridge.get('settings', {}) || {},
  });
  tabBar.setNewTabPicker(newTabPicker);
  // Unified chrome — replaces legacy sidebar, ActivityRail, and ChromeLayoutManager.
  // The global URL bar has been retired; each tab now carries its own URL +
  // navigation strip via TabChromeStrip. ChromeBar still owns the global
  // tab-bar mount + window chrome, with action buttons folded into TabBar.
  chromeBar.initialize({
    state,
    tabBar,
    panels: {
      agentPanel,
      libraryWindow,
      settingsMenu,
      commandPalette,
    },
  });
  libraryWindow.onBadgeChange((count) => {
    if (typeof tabBar.setNotificationBadge === 'function') {
      tabBar.setNotificationBadge(count);
    }
  });
  // Restart-to-update pill: hydrated on load, then pushed as the wait grows.
  ipcRenderer.on('updater:nudge', (_e, nudge) => tabBar.setUpdateNudge(nudge));
  ipcRenderer.invoke('updater:status')
    .then((s) => { if (s && s.nudge) tabBar.setUpdateNudge(s.nudge); })
    .catch((err) => console.error('[updater] status unavailable:', (err && err.message) || err));
  ipcRenderer.on('notifications:added', (_e, payload) => {
    if (!payload || !payload.record) return;
    const r = payload.record;
    const showToasts = config.settings && config.settings.notifications
      ? config.settings.notifications.showToasts !== false
      : true;
    if (!showToasts) return;
    toast.info(r.body || r.origin || 'New notification', {
      title: r.title || r.origin || 'Notification',
      action: {
        label: 'Show',
        onClick: () => libraryWindow.open({ tab: 'notifications' }),
      },
    });
  });
  ipcRenderer.on('routine:run', (_e, payload) => runRoutine(payload || {}));
  ipcRenderer.on('pack:open-panes', (_e, payload) => openPackPanes(payload || {}));
  ipcRenderer.on('pack:run-task', (_e, payload) => runPackTask(payload || {}));
  ipcRenderer.on('shortcut:forwarded', (_e, payload) => handleForwardedShortcut(payload));
  // The quick launcher's "Open in Assistant" hands its session over here.
  ipcRenderer.on('app-mode:set', (_e, payload) => {
    const res = handleAppModeSet(payload, { viewShell: viewShellManager, agentPanel });
    if (!res.ok) console.warn('[app-mode:set] rejected:', res.error);
  });
  registerKeyboardShortcuts();

  // Before the welcome overlay: its starfield reads the resolved motion level.
  fx.init({ state });
  fx.applySettings(config.settings);
  // After TabBar built #tab-bar-wrap (the dock) and fx resolved the motion level.
  viewShellManager.initialize();
  welcomeOverlay.initialize({ onOpenLlmSettings: () => settingsMenu.showTab('llm') });
  welcomeOverlay.maybeShow(config);

  applySettings(config.settings);
  applyAppearanceSettings(config.settings);

  // Buttons are already generated and ordered from config at module load time

  // Initialize browser webview
  const browserWebview = /** @type {any} */ (document.querySelector('.web-browser'));
  if (browserWebview && config.settings.browserHomeUrl) {
    browserWebview.src = config.settings.browserHomeUrl;
  }

  // Initialize spaces from saved state. The canonical inputs are openTabs +
  // hiddenTabs (both already loaded into AppState by initFromConfig). We walk
  // openTabs, filter invalid ids, set multi-mode if needed, then run the
  // reconciler exactly once — it ensures every visible tab has a DOM wrapper
  // and the layout has correct activeSpaces.
  const adHocSpaces = state.get('adHocSpaces') || {};
  const knownIds = new Set(Object.keys(config.spaces || {}).concat(Object.keys(adHocSpaces)));
  const persistedOpenTabs = state.get('openTabs') || [];
  const validOpenTabs = persistedOpenTabs.filter((id) => knownIds.has(id));
  if (validOpenTabs.length !== persistedOpenTabs.length) {
    state.set('openTabs', validOpenTabs);
  }
  // Drop any hiddenTabs that aren't in openTabs anymore.
  const persistedHidden = state.get('hiddenTabs') || [];
  const validHidden = persistedHidden.filter((id) => validOpenTabs.includes(id));
  if (validHidden.length !== persistedHidden.length) {
    state.set('hiddenTabs', validHidden);
  }

  if (validOpenTabs.length > 0) {
    // Multi-mode honors the persisted setting; if it's never been set and we
    // have more than one open tab, fall back to multi.
    const desiredMulti = config.settings.multiSpace === true
      || (config.settings.multiSpace === undefined && validOpenTabs.length > 1);
    if (desiredMulti !== !!state.get('multiSpace')) {
      state.set('multiSpace', desiredMulti);
    }
    if (config.settings) config.settings.multiSpace = desiredMulti;

    // Ensure currentSpaceId is one of the open tabs.
    const persistedCurrent = state.get('currentSpaceId');
    if (!validOpenTabs.includes(persistedCurrent)) {
      state.set('currentSpaceId', validOpenTabs[0]);
    }

    // One reconcile = wrappers created for every visible tab + activeSpaces
    // derived from canonical inputs. Replaces the per-id select() loop.
    spaceManager._syncActiveSpaces();

    // Restore persisted zoom levels on the freshly-attached webviews.
    for (const id of validOpenTabs) {
      const wv = document.getElementById(id);
      if (wv) navigationManager.restoreZoomLevel(wv);
    }

    layoutManager.initialize();
  } else {
    const initialSpace = config.settings.enableDefaultSpace
      ? (config.settings.defaultSpace || 'custom1')
      : 'custom1';
    spaceManager.openTab(initialSpace);
    layoutManager.initialize();
  }

  initializeCheckboxes();

  // Wire find, gesture, and click-tracking events for all existing webviews
  initializeWebviewEvents();

  // Show failsafe notification if config was corrupted and had to be recovered/reset
  if (_configResetReason) {
    _showConfigResetNotification(_configResetReason);
  }
});

// --- Layout Cycle ---
const MULTI_LAYOUTS = ['sideBySide', 'grid', 'stacked'];

function cycleLayout() {
  if (!state.get('multiSpace')) {
    spaceManager.toggleMulti();
    layoutManager.setLayout(MULTI_LAYOUTS[0]);
  } else {
    const current = layoutManager.getLayoutName();
    const idx = MULTI_LAYOUTS.indexOf(current);
    const next = MULTI_LAYOUTS[(idx + 1) % MULTI_LAYOUTS.length] || MULTI_LAYOUTS[0];
    layoutManager.setLayout(next);
  }

  const currentName = layoutManager.getLayoutName();
  config.settings.lastLayout = currentName;
  saveSettings(config);
}

function toggleOpenLinkExternal() {
  const newVal = !state.get('openLinkExternal');
  state.set('openLinkExternal', newVal);
  config.settings.openLinkExternal = newVal;
  saveSettings(config);
}

// Scheduled routine fired by RoutineService (main). Run the saved task in the
// isolated agent workspace via the same path as Research Report, then report
// the outcome back so RoutineService only advances lastRunAt on a real finish.
// One routine at a time is guaranteed by RoutineService's pending gate.
function runRoutine(payload = {}) {
  const { id, name, task } = /** @type {any} */ (payload);
  const label = name || 'Routine';
  if (!id || !task) { try { ipcRenderer.send('routine:ran', { id, ok: false }); } catch (_) { /* ignore */ } return; }
  let settled = false;
  const finish = (ok, kind) => {
    // # nosemgrep: meow-constant-condition-js — `settled` is a dynamic closure guard (runs once), not a dead branch
    if (settled) return;
    settled = true;
    ipcRenderer.removeListener('agent:task-completed', onDone);
    ipcRenderer.removeListener('agent:task-failed', onFail);
    try { ipcRenderer.send('routine:ran', { id, ok }); } catch (_) { /* ignore */ }
    if (ok) toast.success(`Routine "${label}" finished`);
    else toast.error(`Routine "${label}" ${kind || 'failed'}`);
  };
  const onDone = (_e, result) => { if (result && result.scope === 'tab') return; finish(!!(result && result.ok !== false)); };
  const onFail = (_e, result) => { if (result && result.scope === 'tab') return; finish(false); };
  ipcRenderer.on('agent:task-completed', onDone);
  ipcRenderer.on('agent:task-failed', onFail);
  try {
    agentPanel.openWithTask(task, { scope: 'global' });
    toast.info(`Routine "${label}" started`);
  } catch (_) {
    finish(false, 'could not start');
  }
}

// A curated pack was applied (main → renderer dispatch, same shape as
// routine:run): open its starter sites as ordinary user panes. openAdHocTab
// keys the tab id off Date.now(), so a synchronous loop would collide — stagger
// the opens so each gets a distinct id.
function openPackPanes(payload = {}) {
  const { label, panes } = /** @type {any} */ (payload);
  const list = Array.isArray(panes) ? panes.filter((p) => p && p.url) : [];
  if (!list.length) return;
  let opened = 0;
  let failed = 0;
  list.forEach((p, i) => setTimeout(() => {
    try { spaceManager.openAdHocTab(p.url); opened += 1; } catch (_) { failed += 1; }
    if (opened + failed === list.length) {
      const name = label || 'Pack';
      if (failed === 0) toast.success(`${name}: opened ${opened} pane${opened === 1 ? '' : 's'}`);
      else if (opened === 0) toast.error(`${name}: could not open any panes`, { title: name });
      else toast.warn(`${name}: opened ${opened} of ${list.length} panes (${failed} failed)`, { title: name });
    }
  }, i * 40));
}

// Launch a pack's reusable agent task — same proven path as Research Report /
// Routines. Fire-and-surface; no completion tracking needed.
function runPackTask(payload = {}) {
  const { label, task } = /** @type {any} */ (payload);
  if (!task) return;
  try {
    agentPanel.openWithTask(task, { scope: 'global', userSend: true });
    toast.info(`${label || 'Pack'} task started`);
  } catch (_) {
    toast.error(`Could not start ${label || 'pack'} task`);
  }
}

// --- Window exports (for HTML onclick handlers) ---
// openSpace: sidebar click entry point — opens as a new tab or focuses if
// already open. Never closes.
window.openSpace = (id) => spaceManager.openTab(id);
window.selectNextSpace = () => spaceManager.next();
window.selectPreviousSpace = () => spaceManager.previous();
window.toggleMultiSpace = () => spaceManager.toggleMulti();
window.toggleBrowserView = (a, b) => browserViewManager.toggle(a, b);
window.toggleSpaceView = (a, b) => browserViewManager.toggleSpace(a, b);
window.toggleView = () => browserViewManager.toggleView();
window.resetView = () => {
  browserViewManager.toggleSpace(true, false);
  browserViewManager.toggle(false, true);
};
window.navigateBackSpace = () => navigationManager.back();
window.navigateForwardSpace = () => navigationManager.forward();
window.navigateBackBrowser = () => navigationManager.browserBack();
window.navigateForwardBrowser = () => navigationManager.browserForward();
window.navigateHomeSpace = () => navigationManager.home();
window.navigateHomeBrowser = () => navigationManager._homeReset('browser');
window.navigateHomeActive = () => navigationManager.home();
window.refreshPageSpace = () => navigationManager.refresh();
window.refreshPageBrowser = () => {
  const containers = document.querySelectorAll('#browser-container');
  containers.forEach((container) => {
    container.querySelectorAll('webview').forEach((wv) => { if (/** @type {any} */ (wv).reload) /** @type {any} */ (wv).reload(); });
  });
  navigationManager.focusWebview('browser-webview');
};
window.navigateHomeReset = () => navigationManager.home();
window.focusWebview = (id) => navigationManager.focusWebview(id);
window.cycleLayout = cycleLayout;
window.toggleFindBar = () => findBarManager.toggle();
window.closeFindBar = () => findBarManager.close();
window.toggleOpenLinkExternal = toggleOpenLinkExternal;
window.restartApp = () => ipcRenderer.send('restart-app');
window.fullNames = fullNames;
window.saveSettings = saveSettings;
window.shortcutManager = shortcutManager;
window.settingsMenu = settingsMenu;
window.reregisterKeyboardShortcuts = () => registerKeyboardShortcuts();
window.selectURL = (url) => {
  browserViewManager.toggle(true);
  const wv = /** @type {any} */ (document.getElementById('browser-webview'));
  if (wv) wv.src = url;
  navigationManager.focusWebview('browser-webview');
};
window.selectBrowserURL = window.selectURL;
window.navigateSpaceToUrl = () => ipcRenderer.send('show-url-prompt');
window.openConfig = () => ipcRenderer.send('open-config-file');
window.config = config;
window.getActiveWebview = () => navigationManager.getActiveWebview();
window.changeSetting = (checked, setting) => {
  config.settings[setting] = checked;
  saveSettings(config);
  applySettings(config.settings);
  applyAppearanceSettings(config.settings);
};
