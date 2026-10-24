// SettingsView: modal build, page navigation, cross-page search, deep links,
// change → config:set → side effect wiring, and visible error states.

jest.mock('electron', () => ({
  ipcRenderer: {
    send: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
    sendSync: jest.fn(() => ({ config: null })),
    invoke: jest.fn(() => Promise.resolve(null)),
  },
}));

const { ipcRenderer } = require('electron');

// SettingsView is a singleton. We re-require with isolateModules to get a
// fresh instance per test so internal _initialized state doesn't leak.
// SettingsView's persistent Dropdown attaches a CAPTURE-phase document
// keydown listener while open. If a test calls show() and never hide()s, that
// listener leaks onto `document` and swallows Escape in later tests (it calls
// stopPropagation in capture phase). We register every created view and force
// it closed in afterEach so tests stay independent.
const _liveViews = new Set();

function freshView() {
  let view;
  jest.isolateModules(() => {
    view = require('../../../../../renderer/components/settings/SettingsView');
  });
  _liveViews.add(view);
  return view;
}

// Returns the view PLUS the exact customModules / configBridge instances that
// this isolated view closed over, so a test can swap a module fn and have the
// view actually see the swap.
function freshViewWithDeps() {
  let view, customModules, configBridge;
  jest.isolateModules(() => {
    view = require('../../../../../renderer/components/settings/SettingsView');
    customModules = require('../../../../../renderer/components/settings/customModules');
    configBridge = require('../../../../../renderer/core/configBridge');
  });
  _liveViews.add(view);
  return { view, customModules, configBridge };
}

const sampleConfig = {
  settings: {
    theme: 'dark',
    enableAnimations: true,
    enableRippleEffects: true,
    sidebarExpandedWidth: 150,
    chromeLayout: 'top',
    pageZoomDefault: 1.0,
    uiDensity: 'comfortable',
    preventMenuExpansion: false,
    openLinkExternal: false,
    persistZoomLevels: false,
    enableDefaultSpace: false,
    defaultSpace: 'custom1',
    browserHomeUrl: 'https://www.google.com/',
  },
  spaces: {
    custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/', type: 'ai-service' },
  },
};

describe('SettingsView', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
    // jsdom doesn't implement scrollIntoView; stub it so showTab() doesn't throw.
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
    // Force synchronous close on the underlying Dropdown so visibility-state
    // assertions don't need to wait for CSS transitions.
    document.body.classList.add('no-animations');
    ipcRenderer.send.mockClear();
    // Advanced-section open state persists in localStorage; start each test
    // from the collapsed defaults.
    localStorage.clear();
  });

  afterEach(() => {
    // Force every view created this test back to closed so its Dropdown's
    // capture-phase document keydown listener doesn't leak into later tests.
    for (const v of _liveViews) {
      try { v.hide(); } catch (_) {}
    }
    _liveViews.clear();
    jest.useRealTimers();
    document.body.classList.remove('no-animations');
  });

  test('initialize() builds the modal lazily and is idempotent', () => {
    const view = freshView();
    expect(document.querySelector('.settings-v2')).toBeNull();
    view.initialize(sampleConfig);
    expect(document.querySelector('.settings-v2')).not.toBeNull();
    expect(document.querySelectorAll('.settings-v2-header').length).toBe(1);
    // Second call is a no-op.
    view.initialize(sampleConfig);
    expect(document.querySelectorAll('.settings-v2-header').length).toBe(1);
  });

  test('initialize() keeps writes made to an already-seeded bridge instead of re-copying the startup config', () => {
    const { view, configBridge } = freshViewWithDeps();
    configBridge.initialize(sampleConfig);
    configBridge.set('settings.assistant.lastMode', 'assistant');
    view.initialize(sampleConfig);
    expect(configBridge.get('settings.assistant.lastMode')).toBe('assistant');
  });

  test('initialize() seeds an unseeded bridge from the given config', () => {
    const { view, configBridge } = freshViewWithDeps();
    expect(configBridge.snapshot()).toBeNull();
    view.initialize(sampleConfig);
    expect(configBridge.get('settings.theme')).toBe('dark');
  });

  test('renders one nav item per registry section', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    const navItems = document.querySelectorAll('.settings-v2-nav-item');
    // General + Appearance + 10 stubs from the Phase 2 registry.
    expect(navItems.length).toBeGreaterThanOrEqual(2);
    const generalNav = Array.from(navItems).find((el) => el.dataset.sectionId === 'general');
    const appearanceNav = Array.from(navItems).find((el) => el.dataset.sectionId === 'appearance');
    expect(generalNav).toBeDefined();
    expect(appearanceNav).toBeDefined();
    expect(generalNav.querySelector('.settings-v2-nav-item-icon')).not.toBeNull();
    expect(appearanceNav.querySelector('.settings-v2-nav-item-icon')).not.toBeNull();
  });

  test('renders one row per migrated General + Appearance setting', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    const generalSection = document.querySelector('section[data-section-id="general"]');
    const appearanceSection = document.querySelector('section[data-section-id="appearance"]');
    expect(generalSection).not.toBeNull();
    expect(appearanceSection).not.toBeNull();
    expect(generalSection.querySelectorAll('.settings-v2-row').length).toBeGreaterThan(0);
    expect(appearanceSection.querySelectorAll('.settings-v2-row').length).toBeGreaterThan(0);
  });

  test('search input filters rows by AND-token match', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    const search = document.querySelector('.settings-v2-search input');
    expect(search).not.toBeNull();

    // "ripple" is a unique synonym/keyword belonging to one row.
    search.value = 'ripple';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);

    // Filter out rows rendered inside custom modules — those have their own
    // internal layout and aren't search-indexed.
    const visibleRows = Array.from(document.querySelectorAll('.settings-v2-row'))
      .filter((el) => !el.hidden && !el.closest('.sv-custom-module'));
    expect(visibleRows.length).toBe(1);
    expect(visibleRows[0].dataset.settingId).toBe('appearance.enableRippleEffects');
  });

  test('synonym search matches: "make text bigger" → pageZoomDefault', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    const search = document.querySelector('.settings-v2-search input');

    search.value = 'make text bigger';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);

    // Filter out rows rendered inside custom modules — those have their own
    // internal layout and aren't search-indexed.
    const visibleRows = Array.from(document.querySelectorAll('.settings-v2-row'))
      .filter((el) => !el.hidden && !el.closest('.sv-custom-module'));
    expect(visibleRows.some((r) => r.dataset.settingId === 'appearance.pageZoomDefault')).toBe(true);
  });

  const visibleRowCount = () => Array.from(document.querySelectorAll('.settings-v2-row')).filter((el) => !el.hidden).length;

  // Bug 1: clearing the search used to un-hide every row, including rows
  // whose visibleIf is false (startup.url with startupBehavior !== 'url').
  test('clearing the search restores the pre-search rows and keeps visibleIf-hidden rows hidden', () => {
    const view = freshView();
    view.initialize({ ...sampleConfig, settings: { ...sampleConfig.settings, startupBehavior: 'restoreSession' } });
    const search = document.querySelector('.settings-v2-search input');
    const urlRow = document.querySelector('.settings-v2-row[data-setting-id="startup.url"]');
    expect(urlRow.hidden).toBe(true);
    const before = visibleRowCount();
    const total = document.querySelectorAll('.settings-v2-row').length;
    expect(before).toBeLessThan(total);

    search.value = 'theme';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    expect(visibleRowCount()).toBeLessThan(before);

    search.value = '';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    expect(visibleRowCount()).toBe(before);
    expect(urlRow.hidden).toBe(true);
  });

  test('a search never reveals a row whose visibleIf is false, even when it matches', () => {
    const view = freshView();
    view.initialize({ ...sampleConfig, settings: { ...sampleConfig.settings, startupBehavior: 'restoreSession' } });
    const search = document.querySelector('.settings-v2-search input');
    search.value = 'startup url';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    expect(document.querySelector('.settings-v2-row[data-setting-id="startup.url"]').hidden).toBe(true);
  });

  test('zero-result search shows the "no matches" empty state', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    const search = document.querySelector('.settings-v2-search input');

    search.value = 'asdfqwerzzz';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);

    // Filter out rows rendered inside custom modules — those have their own
    // internal layout and aren't search-indexed.
    const visibleRows = Array.from(document.querySelectorAll('.settings-v2-row'))
      .filter((el) => !el.hidden && !el.closest('.sv-custom-module'));
    expect(visibleRows.length).toBe(0);
  });

  test('toggling a registered toggle setting calls configBridge.set via IPC', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();

    const row = document.querySelector('.settings-v2-row[data-setting-id="general.preventMenuExpansion"]');
    expect(row).not.toBeNull();
    const checkbox = row.querySelector('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    const setCalls = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'config:set');
    expect(setCalls.length).toBeGreaterThanOrEqual(1);
    const lastSet = setCalls[setCalls.length - 1][1];
    expect(lastSet.path).toBe('settings.preventMenuExpansion');
    expect(lastSet.value).toBe(true);
  });

  // Regression: show() rebuilds sections so externally-changed config (e.g.
  // LLM auto-start updating activeBackend) isn't shown stale. Custom modules
  // register listeners on global objects (ipcRenderer, speechSynthesis) that
  // removing the DOM does NOT detach, so each rebuild MUST tear down the prior
  // mount. Mounts minus teardowns must stay at exactly 1 (the live mount).
  test('REGRESSION: reopening Settings tears down prior custom modules (no listener leak)', () => {
    const { view, customModules } = freshViewWithDeps();
    const teardown = jest.fn();
    const mount = jest.fn(() => teardown);
    customModules.llmTab = mount;

    view.initialize(sampleConfig); // mount #1
    view.show();                   // rebuild: teardown #1, mount #2
    view.show();                   // rebuild: teardown #2, mount #3

    expect(mount.mock.calls.length).toBeGreaterThan(1);
    expect(mount.mock.calls.length - teardown.mock.calls.length).toBe(1);
  });

  test('show() / hide() / toggle() change visibility state', () => {
    const view = freshView();
    view.initialize(sampleConfig);

    view.show();
    jest.advanceTimersByTime(60);
    expect(document.body.classList.contains('settings-open')).toBe(true);

    view.hide();
    expect(document.body.classList.contains('settings-open')).toBe(false);

    view.toggle();
    expect(document.body.classList.contains('settings-open')).toBe(true);
    view.toggle();
    expect(document.body.classList.contains('settings-open')).toBe(false);
  });

  // Regression: Dropdown attaches a CAPTURE-phase document keydown listener on
  // open(). It used to stopPropagation()+close() on every Esc, so the search
  // box's own Esc-to-clear (a bubble-phase handler) never ran — pressing Esc
  // with a query closed the whole modal instead of clearing the search.
  test('REGRESSION: Esc with a search query clears the search and keeps Settings open', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    jest.advanceTimersByTime(60);
    expect(document.body.classList.contains('settings-open')).toBe(true);

    const search = document.querySelector('.settings-v2-search input');
    const allRows = visibleRowCount();
    search.value = 'theme';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    expect(visibleRowCount()).toBeLessThan(allRows);

    // Esc dispatched from the search input: Dropdown's capture listener sees it
    // first but must abstain (query present) so _onSearchKey can clear.
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    jest.advanceTimersByTime(120);

    expect(document.body.classList.contains('settings-open')).toBe(true);
    expect(search.value).toBe('');
    expect(visibleRowCount()).toBe(allRows);
  });

  test('Esc with an EMPTY search query still closes Settings (behavior preserved)', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    jest.advanceTimersByTime(60);
    expect(document.body.classList.contains('settings-open')).toBe(true);

    const search = document.querySelector('.settings-v2-search input');
    expect(search.value).toBe('');
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    jest.advanceTimersByTime(60);

    expect(document.body.classList.contains('settings-open')).toBe(false);
  });

  const pageEl = (id) => document.querySelector(`section.settings-v2-page[data-section-id="${id}"]`);
  const navEl = (id) => document.querySelector(`.settings-v2-nav-item[data-section-id="${id}"]`);
  const shownPages = () => Array.from(document.querySelectorAll('section.settings-v2-page'))
    .filter((p) => !p.hidden).map((p) => p.dataset.sectionId);

  test('showTab(pageId) opens the modal on that page only', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.showTab('appearance');
    jest.advanceTimersByTime(120);
    expect(document.body.classList.contains('settings-open')).toBe(true);
    expect(shownPages()).toEqual(['appearance']);
    expect(navEl('appearance').getAttribute('aria-current')).toBe('page');
  });

  // Deep links from renderer.js / AgentPanel.js / saved palette commands use
  // pre-redesign section ids; each must land on the page (and card) that now
  // holds that content.
  test.each([
    ['llm', 'llm', null],
    ['shortcuts', 'shortcuts', 'shortcuts'],
    ['chat', 'assistant', 'chat'],
    ['agent-safety', 'assistant', 'agent-safety'],
    ['startup', 'general', 'launch'],
    ['user-memory', 'projects', 'memory'],
    ['packs', 'personas', 'packs'],
    ['ask-browsing', 'search', 'ask-browsing'],
    ['model-overrides', 'llm', 'model-overrides'],
  ])('showTab(%p) lands on page %p', (id, page, card) => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.showTab(id);
    jest.advanceTimersByTime(120);
    expect(shownPages()).toEqual([page]);
    expect(navEl(page).classList.contains('is-active')).toBe(true);
    if (card && card !== 'shortcuts') {
      const cardEl = pageEl(page).querySelector(`[data-card-id="${card}"]`);
      expect(cardEl.classList.contains('is-flash')).toBe(true);
      if (cardEl.tagName === 'DETAILS') expect(cardEl.open).toBe(true);
    }
  });

  test('showTab with an unknown id warns and keeps the current page', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const view = freshView();
    view.initialize(sampleConfig);
    view.showTab('privacy');
    view.showTab('no-such-page');
    expect(shownPages()).toEqual(['privacy']);
    expect(warn).toHaveBeenCalledWith('[settings] showTab: unknown page "no-such-page"; staying on "privacy"');
    warn.mockRestore();
  });

  // ---- Side-effect dispatch (each registry sideEffect fires the right IPC) ----

  function clickToggle(view, settingId, newValue) {
    const row = document.querySelector(`.settings-v2-row[data-setting-id="${settingId}"]`);
    expect(row).not.toBeNull();
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) {
      checkbox.checked = !!newValue;
      checkbox.dispatchEvent(new Event('change'));
      return;
    }
    const radio = row.querySelector(`input[type="radio"][value="${newValue}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
      return;
    }
    const select = row.querySelector('select');
    if (select) {
      select.value = newValue;
      select.dispatchEvent(new Event('change'));
      return;
    }
    throw new Error(`No control found for ${settingId}`);
  }

  function clickButton(settingId) {
    const row = document.querySelector(`.settings-v2-row[data-setting-id="${settingId}"]`);
    const btn = row.querySelector('.settings-v2-row-control button.sv-button');
    btn.click();
  }

  async function flush() {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }

  function ipcCallChannels() { return ipcRenderer.send.mock.calls.map((c) => c[0]); }

  test('applyAdblocker → call-createAndUpdateaAblocker on enable', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickToggle(view, 'privacy.enableAdblocker', true);
    expect(ipcCallChannels()).toContain('call-createAndUpdateaAblocker');
  });

  test('applyAdblocker → call-disableAdblocker on disable', () => {
    const view = freshView();
    view.initialize({ ...sampleConfig, settings: { ...sampleConfig.settings, enableAdblocker: true } });
    view.show();
    clickToggle(view, 'privacy.enableAdblocker', false);
    expect(ipcCallChannels()).toContain('call-disableAdblocker');
  });

  test('applyLaunchAtStartup → call-enableLaunchAtStartup on enable', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickToggle(view, 'startup.launchAtStartup', true);
    expect(ipcCallChannels()).toContain('call-enableLaunchAtStartup');
  });

  test('applyAutoDenyCertErrors → set-auto-deny-cert-errors with the new value', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickToggle(view, 'privacy.autoDenyCertErrors', true);
    const calls = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'set-auto-deny-cert-errors');
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe(true);
  });

  test('applySpellCheck → settings:apply-spellcheck', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickToggle(view, 'language.spellCheckEnabled', true);
    expect(ipcCallChannels()).toContain('settings:apply-spellcheck');
  });

  test('applyLogLevel → settings:set-log-level with the chosen value', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    const row = document.querySelector('.settings-v2-row[data-setting-id="advanced.logLevel"]');
    const select = row.querySelector('select');
    select.value = 'debug';
    select.dispatchEvent(new Event('change'));
    const calls = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'settings:set-log-level');
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe('debug');
  });

  test('setDefaultBrowser button → settings:set-default-browser', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickButton('advanced.defaultBrowser');
    expect(ipcCallChannels()).toContain('settings:set-default-browser');
  });

  test('checkForUpdates button → updater:check-now', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickButton('advanced.checkForUpdates');
    expect(ipcCallChannels()).toContain('updater:check-now');
  });

  test('openConfigFile button → open-config-file', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickButton('advanced.openConfig');
    expect(ipcCallChannels()).toContain('open-config-file');
  });

  test('restartApp button → restart-app', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickButton('general.restartApp');
    expect(ipcCallChannels()).toContain('restart-app');
  });

  test('resetAllSettings button confirms then sends settings:reset-all', async () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickButton('advanced.resetAll');
    const overlay = document.querySelector('.confirm-dialog-overlay');
    expect(overlay).not.toBeNull();
    expect(ipcCallChannels()).not.toContain('settings:reset-all');
    overlay.querySelector('.confirm-dialog-confirm').click();
    await flush();
    expect(ipcCallChannels()).toContain('settings:reset-all');
  });

  test('applyChromeLayout updates window.appState["chromeLayout"]', () => {
    const setSpy = jest.fn();
    const w = /** @type {any} */ (window);
    w.appState = { set: setSpy };
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickToggle(view, 'appearance.chromeLayout', 'right');
    expect(setSpy).toHaveBeenCalledWith('chromeLayout', 'right');
    delete w.appState;
  });

  test('appearance toggle (theme) re-applies appearance via window.applyAppearanceSettings', () => {
    const applySpy = jest.fn();
    const w = /** @type {any} */ (window);
    w.applyAppearanceSettings = applySpy;
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickToggle(view, 'appearance.theme', 'light');
    expect(applySpy).toHaveBeenCalled();
    delete w.applyAppearanceSettings;
  });

  test('requiresRestart settings flip the restart-needed banner on', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    const hint = document.querySelector('.settings-v2-restart-hint');
    expect(hint.hidden).toBe(true);
    const row = document.querySelector('.settings-v2-row[data-setting-id="advanced.hardwareAcceleration"]');
    const select = row.querySelector('select');
    select.value = 'off';
    select.dispatchEvent(new Event('change'));
    expect(hint.hidden).toBe(false);
  });

  test('Expand all / Collapse all toggle every advanced <details> section', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    const expandAll = Array.from(document.querySelectorAll('.settings-v2-toolbar-actions button'))
      .find((b) => /Expand all/i.test(b.textContent));
    const collapseAll = Array.from(document.querySelectorAll('.settings-v2-toolbar-actions button'))
      .find((b) => /Collapse all/i.test(b.textContent));
    expect(expandAll).toBeDefined();
    expect(collapseAll).toBeDefined();

    expandAll.click();
    const details = Array.from(document.querySelectorAll('details.sv-advanced'));
    expect(details.length).toBeGreaterThan(0);
    expect(details.every((d) => d.open === true)).toBe(true);

    collapseAll.click();
    expect(details.every((d) => d.open === false)).toBe(true);
  });

  // NOTE: When the modal is OPEN, the Dropdown attaches a capture-phase
  // document keydown handler that calls stopPropagation() on Escape and
  // closes the whole dropdown — so SettingsView._onSearchKey never sees a
  // dispatched Escape while open (the search-clear-on-Esc path is reachable
  // only when the field handler runs before the capture handler). We test
  // _onSearchKey's own branches via the (still DOM-mounted, persistent)
  // input before show(), where the Dropdown capture handler is not attached.

  test('Escape on the search field with a query clears the query', () => {
    const view = freshView();
    view.initialize(sampleConfig);          // persistent dropdown mounts the input now
    const search = document.querySelector('.settings-v2-search input');
    search.value = 'theme';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    expect(search.value).toBe('theme');

    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    search.dispatchEvent(esc);
    jest.advanceTimersByTime(120);
    expect(search.value).toBe('');
    expect(esc.defaultPrevented).toBe(true);
  });

  test('Escape on the search field with an empty query does NOT preventDefault', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    const search = document.querySelector('.settings-v2-search input');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    search.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
  });

  test('Enter on the search field jumps to the top match without throwing', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    const search = document.querySelector('.settings-v2-search input');
    search.value = 'theme';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    expect(() => search.dispatchEvent(enter)).not.toThrow();
    expect(enter.defaultPrevented).toBe(true);
  });

  test('while OPEN, Escape closes the whole modal (Dropdown capture handler wins)', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    jest.advanceTimersByTime(60);
    expect(document.body.classList.contains('settings-open')).toBe(true);
    const search = document.querySelector('.settings-v2-search input');
    search.value = 'theme';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.body.classList.contains('settings-open')).toBe(false);
  });

  test('search clear button resets the query and hides itself', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    const search = document.querySelector('.settings-v2-search input');
    const clearBtn = document.querySelector('.settings-v2-search-clear');
    expect(clearBtn.hidden).toBe(true);

    search.value = 'zoom';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    expect(clearBtn.hidden).toBe(false);

    clearBtn.click();
    jest.advanceTimersByTime(120);
    expect(search.value).toBe('');
    expect(clearBtn.hidden).toBe(true);
  });

  test('zero-result empty state exposes an "Open config file" button wired to IPC', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    const search = document.querySelector('.settings-v2-search input');
    search.value = 'zzznotarealsetting';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    const empty = document.querySelector('.settings-v2-empty');
    expect(empty).not.toBeNull();
    expect(empty.hidden).toBe(false);
    const cfgBtn = empty.querySelector('button');
    cfgBtn.click();
    expect(ipcCallChannels()).toContain('open-config-file');

    // Restoring a matching query hides the empty state again.
    search.value = '';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    expect(empty.hidden).toBe(true);
  });

  test('applyDns side effect sends dns:apply when the DoH provider changes', () => {
    const view = freshView();
    view.initialize({ ...sampleConfig, settings: { ...sampleConfig.settings, dns: { mode: 'secure', provider: 'cloudflare' } } });
    view.show();
    const row = document.querySelector('.settings-v2-row[data-setting-id="privacy.dnsProvider"]');
    expect(row.hidden).toBe(false);
    const select = row.querySelector('select');
    select.value = 'google';
    select.dispatchEvent(new Event('change'));
    const set = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'config:set').pop()[1];
    expect(set).toEqual({ path: 'settings.dns.provider', value: 'google' });
    expect(ipcCallChannels()).toContain('dns:apply');
  });

  test('applyPrivateIpCertRanges sends the full ranges payload with the new value', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickToggle(view, 'privacy.privateIpCerts.loopback', true);
    const calls = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'set-private-ip-cert-ranges');
    expect(calls.length).toBe(1);
    expect(calls[0][1].loopback).toBe(true);
  });

  test('openBrowserDataPanel button hides settings and toggles the panel', () => {
    const toggleSpy = jest.fn();
    const w = /** @type {any} */ (window);
    w.browserDataPanel = { toggle: toggleSpy };
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    expect(document.body.classList.contains('settings-open')).toBe(true);
    clickButton('privacy.clearBrowsingData');
    expect(document.body.classList.contains('settings-open')).toBe(false);
    jest.advanceTimersByTime(100);
    expect(toggleSpy).toHaveBeenCalledTimes(1);
    delete w.browserDataPanel;
  });

  const rowError = (id) => document.querySelector(`.settings-v2-row[data-setting-id="${id}"] .settings-v2-row-error`);

  test('openBrowserDataPanel without the panel shows a row error and keeps settings open', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickButton('privacy.clearBrowsingData');
    expect(document.body.classList.contains('settings-open')).toBe(true);
    const err = rowError('privacy.clearBrowsingData');
    expect(err.hidden).toBe(false);
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toBe("Couldn't apply this change: The browsing-data panel is not available in this window.");
    errSpy.mockRestore();
  });

  test('an unknown side effect name surfaces as a row error (value is still saved)', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    view._rows.get('general.preventMenuExpansion').setting.sideEffect = 'totallyMadeUp';
    expect(() => clickToggle(view, 'general.preventMenuExpansion', true)).not.toThrow();
    const err = rowError('general.preventMenuExpansion');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe('Couldn\'t apply this change: Unknown settings side effect "totallyMadeUp"');
    expect(err.closest('.settings-v2-row').classList.contains('has-error')).toBe(true);
    const set = ipcRenderer.send.mock.calls.filter((c) => c[0] === 'config:set').pop()[1];
    expect(set).toEqual({ path: 'settings.preventMenuExpansion', value: true });
    errSpy.mockRestore();
  });

  test('a throwing side effect shows a row error; the next successful change clears it', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const w = /** @type {any} */ (window);
    w.appState = { set: () => { throw new Error('boom'); } };
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    expect(() => clickToggle(view, 'appearance.chromeLayout', 'left')).not.toThrow();
    const err = rowError('appearance.chromeLayout');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe("Couldn't apply this change: boom");
    w.appState = { set: jest.fn() };
    clickToggle(view, 'appearance.chromeLayout', 'right');
    expect(err.hidden).toBe(true);
    expect(err.textContent).toBe('');
    delete w.appState;
    errSpy.mockRestore();
  });

  test('a side effect that rejects asynchronously shows a row error', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    ipcRenderer.send.mockImplementation((channel) => {
      if (channel === 'settings:reset-all') throw new Error('ipc closed');
    });
    try {
      clickButton('advanced.resetAll');
      expect(rowError('advanced.resetAll').hidden).toBe(true);
      document.querySelector('.confirm-dialog-overlay .confirm-dialog-confirm').click();
      await flush();
      const err = rowError('advanced.resetAll');
      expect(err.hidden).toBe(false);
      expect(err.textContent).toBe("Couldn't apply this change: ipc closed");
    } finally {
      ipcRenderer.send.mockImplementation(() => {});
      errSpy.mockRestore();
    }
  });

  test('resetAll modal cancelled → no reset IPC', async () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    clickButton('advanced.resetAll');
    const overlay = document.querySelector('.confirm-dialog-overlay');
    overlay.querySelector('.confirm-dialog-cancel').click();
    await flush();
    expect(ipcCallChannels()).not.toContain('settings:reset-all');
  });

  test('setRestartNeeded with a reason updates the banner text', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.setRestartNeeded(true, 'GPU change needs a restart');
    const hint = document.querySelector('.settings-v2-restart-hint');
    expect(hint.hidden).toBe(false);
    expect(hint.querySelector('.settings-v2-restart-hint-text').textContent).toBe('GPU change needs a restart');
    view.setRestartNeeded(false);
    expect(hint.hidden).toBe(true);
  });

  test('restart-hint "Restart now" button sends restart-app', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.setRestartNeeded(true);
    const btn = document.querySelector('.settings-v2-restart-hint button');
    btn.click();
    expect(ipcCallChannels()).toContain('restart-app');
  });

  test('header close button hides the modal', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    expect(document.body.classList.contains('settings-open')).toBe(true);
    document.querySelector('.settings-v2-header .app-dropdown-close').click();
    expect(document.body.classList.contains('settings-open')).toBe(false);
  });

  test('nav item click switches to that page with the enter transition', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    expect(shownPages()).toEqual(['general']);
    navEl('appearance').click();
    expect(shownPages()).toEqual(['appearance']);
    expect(navEl('appearance').classList.contains('is-active')).toBe(true);
    expect(navEl('appearance').getAttribute('aria-current')).toBe('page');
    expect(navEl('general').hasAttribute('aria-current')).toBe(false);
    expect(pageEl('appearance').classList.contains('is-entering')).toBe(true);
    pageEl('appearance').dispatchEvent(new Event('animationend'));
    expect(pageEl('appearance').classList.contains('is-entering')).toBe(false);
  });

  test('nav groups render in order with their pages beneath', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    const headers = Array.from(document.querySelectorAll('.settings-v2-nav-group')).map((h) => h.textContent);
    expect(headers).toEqual(['General', 'Appearance', 'AI', 'Web', 'System']);
    expect(navEl('llm').dataset.groupId).toBe('ai');
    expect(navEl('privacy').dataset.groupId).toBe('web');
  });

  test('arrow keys move focus through nav items and wrap', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    const items = Array.from(document.querySelectorAll('.settings-v2-nav-item'));
    items[0].focus();
    items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items[items.length - 1]);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  test('search spans every page, grouped by page, and clearing returns to the current page', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    navEl('privacy').click();
    const search = document.querySelector('.settings-v2-search input');
    search.value = 'ripple';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    expect(shownPages()).toEqual(['motion']);
    expect(pageEl('motion').querySelector('.settings-v2-page-open').hidden).toBe(false);
    const badge = navEl('motion').querySelector('.settings-v2-nav-item-badge');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1');
    expect(navEl('general').classList.contains('is-dimmed')).toBe(true);
    expect(document.querySelector('.settings-v2-match-count').textContent).toBe('1 match');
    const title = document.querySelector('[data-setting-id="appearance.enableRippleEffects"] .settings-v2-row-title');
    expect(title.querySelector('mark')).not.toBeNull();

    search.value = '';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    expect(shownPages()).toEqual(['privacy']);
    expect(badge.hidden).toBe(true);
    expect(title.querySelector('mark')).toBeNull();
  });

  test('a result\'s "go to" button clears the search, opens its page and flashes the row', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    const search = document.querySelector('.settings-v2-search input');
    search.value = 'loopback';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    const row = document.querySelector('.settings-v2-row[data-setting-id="privacy.privateIpCerts.loopback"]');
    const goto = row.querySelector('.settings-v2-row-goto');
    expect(goto.hidden).toBe(false);
    expect(goto.getAttribute('aria-label')).toContain('in Privacy & security');
    goto.click();
    expect(search.value).toBe('');
    expect(shownPages()).toEqual(['privacy']);
    expect(row.classList.contains('is-flash')).toBe(true);
    expect(row.closest('details.sv-advanced').open).toBe(true);
    expect(goto.hidden).toBe(true);
  });

  test('Enter jumps to the top visible match on its page', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    const search = document.querySelector('.settings-v2-search input');
    search.value = 'ripple';
    search.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(120);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(shownPages()).toEqual(['motion']);
    expect(document.querySelector('[data-setting-id="appearance.enableRippleEffects"]').classList.contains('is-flash')).toBe(true);
  });

  // Bug 2: a search that matched the Models row as a whole used to open every
  // disclosure inside it. Only a disclosure holding a directly matching,
  // visible knob may open, and the pre-search state returns on clear.
  test('search opens only disclosures with a direct, visible knob match', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    navEl('llm').click();
    const llmRow = document.querySelector('.settings-v2-row[data-setting-id="llm.tab"]');
    const disclosures = Array.from(llmRow.querySelectorAll('details.sv-advanced'));
    expect(disclosures.length).toBeGreaterThanOrEqual(5);
    expect(disclosures.every((d) => !d.open)).toBe(true);
    const search = document.querySelector('.settings-v2-search input');
    const run = (q) => { search.value = q; search.dispatchEvent(new Event('input')); jest.advanceTimersByTime(120); };

    // "temperature" matches llm.tab's own synonyms and only a knob in the
    // hidden mlx-lm panel, so nothing opens.
    run('temperature');
    expect(llmRow.hidden).toBe(false);
    expect(disclosures.filter((d) => d.open)).toEqual([]);

    // "jinja" matches one knob in the visible llama.cpp Advanced panel.
    run('jinja');
    expect(llmRow.hidden).toBe(false);
    const open = disclosures.filter((d) => d.open);
    expect(open.length).toBe(1);
    expect(open[0].contains(llmRow.querySelector('[data-setting-id="llm.llamaCpp.jinja"]'))).toBe(true);
    expect(llmRow.querySelector('[data-setting-id="llm.llamaCpp.jinja"]').classList.contains('is-search-miss')).toBe(false);
    expect(llmRow.querySelector('[data-setting-id="llm.llamaCpp.contextSize"]').classList.contains('is-search-miss')).toBe(true);

    // "trust remote code" only matches a knob in a hidden panel: no hit.
    run('trust remote code');
    expect(disclosures.filter((d) => d.open)).toEqual([]);
    expect(llmRow.hidden).toBe(true);

    run('');
    expect(disclosures.every((d) => !d.open)).toBe(true);
    expect(llmRow.querySelectorAll('.is-search-miss').length).toBe(0);
    expect(disclosures.every((d) => d.dataset.preSearchOpen === undefined)).toBe(true);
  });

  // Bug 5: llm.autoStart, mlx.fallbackEnabled and openConfig each rendered twice.
  test('formerly duplicated controls render exactly once across all pages', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    expect(document.querySelectorAll('[data-setting-id="llm.autoStart"]').length).toBe(1);
    expect(document.querySelectorAll('[data-setting-id="llm.mlx.fallbackEnabled"]').length).toBe(1);
    expect(document.querySelectorAll('[data-setting-id$="openConfig"]').length).toBe(1);
    expect(document.querySelectorAll('[data-setting-id="startup.llmAutoStart"]').length).toBe(0);
    const ids = Array.from(document.querySelectorAll('.settings-v2-row[data-setting-id]')).map((r) => r.dataset.settingId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('startup.launchAtStartup is reachable by data-setting-id on the Startup page', () => {
    const view = freshView();
    view.initialize(sampleConfig);
    view.show();
    const row = document.querySelector('.settings-v2-row[data-setting-id="startup.launchAtStartup"]');
    expect(row.closest('section').dataset.sectionId).toBe('general');
    expect(row.closest('details.sv-advanced')).not.toBeNull();
  });

  test('guards: show/hide/toggle/showTab no-op before initialize()', () => {
    const view = freshView();
    expect(() => { view.show(); view.hide(); view.toggle(); view.showTab('general'); }).not.toThrow();
    expect(document.querySelector('.settings-v2')).toBeNull();
  });

  test('setRestartNeeded no-ops when the banner element is absent (pre-build)', () => {
    const view = freshView();
    expect(() => view.setRestartNeeded(true, 'x')).not.toThrow();
  });

  test('_renderCustomModule renders a visible error for an unknown module name', () => {
    const { view, configBridge } = freshViewWithDeps();
    view.initialize(sampleConfig);
    const node = view._renderCustomModule(
      { id: 'x', type: 'custom', renderModule: 'definitelyNotAModule' },
      undefined,
      { config: {}, configBridge },
    );
    expect(node.classList.contains('sv-error')).toBe(true);
    expect(node.getAttribute('role')).toBe('alert');
    expect(node.textContent).toBe('Missing settings module "definitelyNotAModule"');
  });

  test('_renderCustomModule catches a throwing module and renders an inline error', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { view, customModules, configBridge } = freshViewWithDeps();
    const orig = customModules.spaces;
    customModules.spaces = () => { throw new Error('render exploded'); };
    try {
      view.initialize(sampleConfig);
      const node = view._renderCustomModule(
        { id: 'x', type: 'custom', renderModule: 'spaces' },
        undefined,
        { config: {}, configBridge },
      );
      expect(node.classList.contains('sv-custom-module')).toBe(true);
      const err = node.querySelector('.sv-error');
      expect(err.textContent).toBe('Failed to render this section: render exploded');
      expect(err.getAttribute('role')).toBe('alert');
    } finally {
      customModules.spaces = orig;
      errSpy.mockRestore();
    }
  });

  test('a throwing visibleIf keeps the row visible and shows the error on it', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const view = freshView();
    view.initialize(sampleConfig);
    const entry = view._rows.get('startup.url');
    entry.setting.visibleIf = () => { throw new Error('bad rule'); };
    view._reevaluateVisibility();
    expect(entry.visibleIfOk).toBe(true);
    expect(rowError('startup.url').textContent).toBe("Visibility rule failed: bad rule");
    errSpy.mockRestore();
  });

  test('visibleIf hides startup.url unless startupBehavior === "url"', () => {
    const view = freshView();
    view.initialize({ ...sampleConfig, settings: { ...sampleConfig.settings, startupBehavior: 'restoreSession', startupUrl: '' } });
    view.show();
    const urlRow = document.querySelector('.settings-v2-row[data-setting-id="startup.url"]');
    expect(urlRow.hidden).toBe(true);
    // Switch behavior to "url".
    const behaviorRow = document.querySelector('.settings-v2-row[data-setting-id="startup.behavior"]');
    const urlRadio = behaviorRow.querySelector('input[type="radio"][value="url"]');
    urlRadio.checked = true;
    urlRadio.dispatchEvent(new Event('change'));
    // Re-evaluate happens synchronously inside _onChange.
    expect(urlRow.hidden).toBe(false);
  });
});
