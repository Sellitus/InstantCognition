// TabBar render + reorder contracts. Locks in the highlight-consistency fix:
//   - In multi-mode every visible tab gets .active uniformly (no asymmetry
//     where one shown tab gets the blue indicator and the other doesn't).
//   - In single-mode only the current tab is "shown" (.active); other open
//     tabs render plain.
//   - Duplicate ids in openTabs render only one DOM tab.
//   - _reorder respects drop side (left half = before target, right = after).

jest.mock('electron', () => ({
  ipcRenderer: { send: jest.fn(), on: jest.fn(), invoke: jest.fn() },
}));

const AppState = require('../../../../renderer/core/AppState');
const tabBar = require('../../../../renderer/components/TabBar');

function setupDom() {
  const space = document.createElement('div');
  space.id = 'space-container';
  document.body.appendChild(space);
}

function makeState(overrides = {}) {
  const state = new AppState();
  state.initFromConfig({
    spaces: {
      custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/', type: 'ai-service' },
      custom2: { name: 'Claude', url: 'https://claude.ai/', type: 'ai-service' },
      custom3: { name: 'Gemini', url: 'https://gemini.google.com/', type: 'ai-service' },
    },
    settings: { multiSpace: false, defaultSpace: 'custom1' },
    state: {
      activeSpaces: ['custom1'],
      openTabs: ['custom1'],
      hiddenTabs: [],
      pinnedTabs: [],
    },
  });
  // Apply overrides AFTER initFromConfig so they win.
  for (const [key, val] of Object.entries(overrides)) state.set(key, val);
  return state;
}

function tabsByIdInDom() {
  return Array.from(document.querySelectorAll('.tab-bar-tab'));
}

function resetTabBarSingleton() {
  // The module exports a singleton; reset its mutable fields between tests
  // so render() rebuilds against fresh state/DOM instead of stale caches.
  tabBar.bar = null;
  tabBar._state = null;
  tabBar._spaceManager = null;
  tabBar._navigationManager = null;
  tabBar._newTabPicker = null;
  tabBar._panels = null;
  if (tabBar._actions) tabBar._actions.destroy();
  tabBar._actions = null;
  tabBar._menu = null;
  tabBar._menuSpaceId = null;
  tabBar._audioByWebContentsId = new Map();
  tabBar._audioWired = false;
}

function actionButton(id) {
  return document.getElementById(id);
}

// View and page actions live in the More menu; open it (re-reading live state)
// and return the item for `id`.
function menuItem(id) {
  const more = actionButton('tabbar-more');
  if (more.getAttribute('aria-expanded') !== 'true') more.click();
  return document.querySelector(`.ic-menu [data-item-id="${id}"]`);
}

function closeMenu() {
  const more = actionButton('tabbar-more');
  if (more.getAttribute('aria-expanded') === 'true') more.click();
}

function expectChecked(id, checked) {
  const item = menuItem(id);
  expect(item).not.toBeNull();
  expect(item.getAttribute('role')).toBe('menuitemcheckbox');
  expect(item.getAttribute('aria-checked')).toBe(checked ? 'true' : 'false');
  closeMenu();
}

describe('TabBar render', () => {
  let spaceManager;

  beforeEach(() => {
    setupDom();
    resetTabBarSingleton();
    spaceManager = { reorderTabs: jest.fn() };
  });

  afterEach(() => {
    document.body.textContent = '';
    jest.clearAllMocks();
  });

  test('multi-mode: every visible tab gets .active and none get the dropped .multi-active class', () => {
    const state = makeState({
      multiSpace: true,
      openTabs: ['custom1', 'custom2'],
      hiddenTabs: [],
      currentSpaceId: 'custom1',
    });
    tabBar.initialize({ state, spaceManager, navigationManager: null });

    const tabs = tabsByIdInDom();
    expect(tabs.map((t) => t.dataset.spaceId)).toEqual(['custom1', 'custom2']);

    // Both visible tabs must carry .active — that's what drives the unified
    // blue-left-indicator + background. The pre-fix asymmetry assigned .active
    // only to currentSpaceId and .multi-active only to the other one.
    expect(tabs.every((t) => t.classList.contains('active'))).toBe(true);

    // .multi-active was the source of the inconsistency — it must not exist
    // anywhere in the rendered tab bar anymore.
    expect(document.querySelectorAll('.tab-bar-tab.multi-active').length).toBe(0);

    // The currently focused tab (currentSpaceId) gets the additional .focused
    // marker; the other visible tab does not.
    const current = tabs.find((t) => t.dataset.spaceId === 'custom1');
    const peer = tabs.find((t) => t.dataset.spaceId === 'custom2');
    expect(current.classList.contains('focused')).toBe(true);
    expect(peer.classList.contains('focused')).toBe(false);
  });

  test('multi-mode: hidden tabs render dimmed (.hidden) and NOT shown (.active)', () => {
    const state = makeState({
      multiSpace: true,
      openTabs: ['custom1', 'custom2'],
      hiddenTabs: ['custom2'],
      currentSpaceId: 'custom1',
    });
    tabBar.initialize({ state, spaceManager, navigationManager: null });

    const visible = document.querySelector('.tab-bar-tab[data-space-id="custom1"]');
    const hidden = document.querySelector('.tab-bar-tab[data-space-id="custom2"]');

    expect(visible.classList.contains('active')).toBe(true);
    expect(visible.classList.contains('hidden')).toBe(false);

    expect(hidden.classList.contains('active')).toBe(false);
    expect(hidden.classList.contains('hidden')).toBe(true);
  });

  test('single-mode: only the current tab is .active; other open tabs render plain', () => {
    const state = makeState({
      multiSpace: false,
      openTabs: ['custom1', 'custom2', 'custom3'],
      hiddenTabs: [],
      currentSpaceId: 'custom2',
    });
    tabBar.initialize({ state, spaceManager, navigationManager: null });

    const tabs = tabsByIdInDom();
    expect(tabs.map((t) => t.dataset.spaceId)).toEqual(['custom1', 'custom2', 'custom3']);

    const byId = Object.fromEntries(tabs.map((t) => [t.dataset.spaceId, t]));
    expect(byId.custom2.classList.contains('active')).toBe(true);
    expect(byId.custom1.classList.contains('active')).toBe(false);
    expect(byId.custom3.classList.contains('active')).toBe(false);
    // Single-mode never marks anything .hidden — that's a multi-mode concept.
    expect(tabs.some((t) => t.classList.contains('hidden'))).toBe(false);
    // .focused is multi-mode only; it must not appear in single-mode renders.
    expect(tabs.some((t) => t.classList.contains('focused'))).toBe(false);
  });

  test('render dedups duplicate ids in openTabs to one DOM tab per id', () => {
    const state = makeState({
      multiSpace: true,
      openTabs: ['custom1', 'custom2', 'custom1'], // duplicate
      hiddenTabs: [],
      currentSpaceId: 'custom1',
    });
    tabBar.initialize({ state, spaceManager, navigationManager: null });

    expect(document.querySelectorAll('.tab-bar-tab[data-space-id="custom1"]').length).toBe(1);
    expect(document.querySelectorAll('.tab-bar-tab[data-space-id="custom2"]').length).toBe(1);
  });

  test('_reorder with after=false inserts source BEFORE target', () => {
    const state = makeState({
      multiSpace: true,
      openTabs: ['custom1', 'custom2', 'custom3'],
      currentSpaceId: 'custom1',
    });
    tabBar.initialize({ state, spaceManager, navigationManager: null });

    // Drag custom3 onto the LEFT half of custom1 → insert before custom1.
    tabBar._reorder('custom3', 'custom1', false);

    expect(spaceManager.reorderTabs).toHaveBeenCalledTimes(1);
    expect(spaceManager.reorderTabs).toHaveBeenCalledWith(['custom3', 'custom1', 'custom2']);
  });

  test('_reorder with after=true inserts source AFTER target', () => {
    const state = makeState({
      multiSpace: true,
      openTabs: ['custom1', 'custom2', 'custom3'],
      currentSpaceId: 'custom1',
    });
    tabBar.initialize({ state, spaceManager, navigationManager: null });

    // Drag custom1 onto the RIGHT half of custom2 → insert after custom2.
    tabBar._reorder('custom1', 'custom2', true);

    expect(spaceManager.reorderTabs).toHaveBeenCalledTimes(1);
    expect(spaceManager.reorderTabs).toHaveBeenCalledWith(['custom2', 'custom1', 'custom3']);
  });

  // Ctrl+Click in multi-mode hides the clicked tab, and if only one tab is
  // visible afterwards we auto-flip back to single-mode so the user isn't
  // stranded in "multi-mode with one tab" — which is visually the same as
  // single-mode but with the multi-mode mode flag still on.
  test('Ctrl+Click in multi-mode auto-disables multi when visibleCount drops to 1', () => {
    const state = makeState({
      multiSpace: true,
      openTabs: ['custom1', 'custom2'],
      hiddenTabs: [],
      currentSpaceId: 'custom1',
    });
    spaceManager = {
      reorderTabs: jest.fn(),
      // The real method updates hiddenTabs in state; mirror that here so the
      // visibleCount math after the call reflects truth.
      toggleTabVisibility: jest.fn((id) => {
        const hidden = state.get('hiddenTabs').slice();
        const i = hidden.indexOf(id);
        if (i === -1) hidden.push(id); else hidden.splice(i, 1);
        state.set('hiddenTabs', hidden);
      }),
      toggleMulti: jest.fn(() => {
        state.set('multiSpace', !state.get('multiSpace'));
      }),
      focusTab: jest.fn(),
    };
    tabBar.initialize({ state, spaceManager, navigationManager: null });

    const target = document.querySelector('.tab-bar-tab[data-space-id="custom2"]');
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));

    // 1) The clicked tab was hidden.
    expect(spaceManager.toggleTabVisibility).toHaveBeenCalledWith('custom2');
    // 2) Auto-disable kicked in because only one tab remains visible.
    expect(spaceManager.toggleMulti).toHaveBeenCalledTimes(1);
    // 3) After the auto-disable, multiSpace is false.
    expect(state.get('multiSpace')).toBe(false);
  });

  test('the bar shows only More, the Assistant and Library pills, and Settings', () => {
    tabBar.initialize({ state: makeState(), spaceManager, navigationManager: null });

    const visible = Array.from(document.querySelectorAll('.tab-bar-actions > .tab-bar-action-btn'))
      .filter((b) => !(/** @type {HTMLElement} */ (b).hidden))
      .map((b) => b.id);
    expect(visible).toEqual(['tabbar-more', 'tabbar-assistant', 'tabbar-library', 'tabbar-settings']);
    // The Update pill exists but waits hidden for a restart nudge.
    expect(actionButton('tabbar-update').hidden).toBe(true);
    ['tabbar-multi-space', 'tabbar-layout', 'tabbar-space-view', 'tabbar-browser-view',
      'tabbar-bookmark', 'tabbar-find', 'tabbar-external-links'].forEach((id) => {
      expect(actionButton(id)).toBeNull();
    });
    const pills = Array.from(document.querySelectorAll('.tab-bar-pill:not([hidden])')).map((b) => b.id);
    expect(pills).toEqual(['tabbar-assistant', 'tabbar-library']);
    expect(actionButton('tabbar-assistant').querySelector('.tab-bar-action-btn-label').textContent).toBe('Assistant');
    expect(actionButton('tabbar-library').querySelector('.tab-bar-action-btn-label').textContent).toBe('Library');
  });

  test('More opens a sectioned menu with view and page groups split by a separator', () => {
    tabBar.initialize({ state: makeState(), spaceManager, navigationManager: null });
    const more = actionButton('tabbar-more');
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    more.click();

    const menu = document.querySelector('.ic-menu');
    expect(menu).not.toBeNull();
    expect(Array.from(menu.querySelectorAll('.ic-menu-label')).map((l) => l.textContent)).toEqual(['View', 'Page']);
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(Array.from(menu.querySelectorAll('[data-item-id]')).map((i) => i.dataset.itemId)).toEqual([
      'tabbar-multi-space', 'tabbar-layout', 'tabbar-space-view', 'tabbar-browser-view',
      'tabbar-bookmark', 'tabbar-find', 'tabbar-external-links',
    ]);
    // Shortcut hints come from the shortcut registry.
    expect(menu.querySelector('[data-item-id="tabbar-find"] kbd').textContent).toMatch(/F$/);
    expect(menu.querySelector('[data-item-id="tabbar-external-links"] kbd')).toBeNull();
  });

  test('menu items dispatch to existing app handlers', () => {
    const state = makeState();
    const panels = {
      findBarManager: { toggle: jest.fn() },
      browserViewManager: { toggle: jest.fn(), toggleSpace: jest.fn() },
      cycleLayout: jest.fn(),
      toggleOpenLinkExternal: jest.fn(),
    };
    spaceManager = {
      reorderTabs: jest.fn(),
      toggleMulti: jest.fn(),
    };
    tabBar.initialize({ state, spaceManager, navigationManager: null, panels });

    menuItem('tabbar-multi-space').click();
    menuItem('tabbar-layout').click();
    menuItem('tabbar-find').click();
    menuItem('tabbar-external-links').click();
    menuItem('tabbar-browser-view').click();
    menuItem('tabbar-space-view').click();

    expect(spaceManager.toggleMulti).toHaveBeenCalledTimes(1);
    expect(panels.cycleLayout).toHaveBeenCalledTimes(1);
    expect(panels.findBarManager.toggle).toHaveBeenCalledTimes(1);
    expect(panels.toggleOpenLinkExternal).toHaveBeenCalledTimes(1);
    expect(panels.browserViewManager.toggle).toHaveBeenCalledTimes(1);
    expect(panels.browserViewManager.toggleSpace).toHaveBeenCalledTimes(1);
    // Choosing an item closes the menu.
    expect(document.querySelector('.ic-menu')).toBeNull();
  });

  test('bookmark item toggles the focused page through bookmarks:toggle', async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.invoke.mockClear();
    ipcRenderer.invoke.mockResolvedValue({ added: true, url: 'https://example.com/a' });
    const navigationManager = {
      getActiveWebview: () => ({ getURL: () => 'https://example.com/a', getTitle: () => 'Example' }),
    };
    tabBar.initialize({ state: makeState(), spaceManager, navigationManager });

    menuItem('tabbar-bookmark').click();
    await Promise.resolve();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('bookmarks:toggle', {
      url: 'https://example.com/a',
      title: 'Example',
    });
  });

  test('bookmarkActivePage (palette entry point) uses the same toggle path', async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.invoke.mockClear();
    ipcRenderer.invoke.mockResolvedValue({ added: false });
    const navigationManager = {
      getActiveWebview: () => ({ getURL: () => 'https://example.com/b', getTitle: () => 'B' }),
    };
    tabBar.initialize({ state: makeState(), spaceManager, navigationManager });

    await tabBar.bookmarkActivePage();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('bookmarks:toggle', { url: 'https://example.com/b', title: 'B' });
  });

  test('bookmark item ignores non-web pages', () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.invoke.mockClear();
    const navigationManager = {
      getActiveWebview: () => ({ getURL: () => 'about:blank', getTitle: () => '' }),
    };
    tabBar.initialize({ state: makeState(), spaceManager, navigationManager });

    menuItem('tabbar-bookmark').click();

    // Bookmarking about:blank would put an unopenable row in the Library.
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  test('menu checkmarks follow AppState and the layout item names the current layout', () => {
    const state = makeState();
    tabBar.initialize({ state, spaceManager, navigationManager: null });

    expectChecked('tabbar-multi-space', false);
    expectChecked('tabbar-find', false);
    expectChecked('tabbar-external-links', false);
    expectChecked('tabbar-browser-view', false);
    expectChecked('tabbar-space-view', true);
    expect(menuItem('tabbar-layout').getAttribute('role')).toBe('menuitem');
    closeMenu();

    state.set('multiSpace', true);
    state.set('currentLayout', 'grid');
    state.set('findBarVisible', true);
    state.set('openLinkExternal', true);
    state.set('browserViewActive', true);
    state.set('spaceViewActive', false);

    expectChecked('tabbar-multi-space', true);
    expectChecked('tabbar-find', true);
    expectChecked('tabbar-external-links', true);
    expectChecked('tabbar-browser-view', true);
    expectChecked('tabbar-space-view', false);
    expect(menuItem('tabbar-layout').querySelector('.ic-menu-item-desc').textContent).toBe('Grid');
    closeMenu();
  });

  test('the More dot lights only while a toggle is away from its default', () => {
    const state = makeState();
    tabBar.initialize({ state, spaceManager, navigationManager: null });
    const dot = () => document.querySelector('#tabbar-more .tab-bar-more-dot');
    const more = actionButton('tabbar-more');

    // Space View is on by default, so the resting state shows no dot.
    expect(dot().hidden).toBe(true);
    expect(more.getAttribute('aria-label')).toBe('More tools');

    state.set('findBarVisible', true);
    expect(dot().hidden).toBe(false);
    expect(more.classList.contains('has-active')).toBe(true);
    expect(more.getAttribute('aria-label')).toBe('More tools (Find in Page)');

    state.set('findBarVisible', false);
    state.set('spaceViewActive', false);
    expect(dot().hidden).toBe(false);
    expect(more.getAttribute('aria-label')).toBe('More tools (Space View)');

    state.set('spaceViewActive', true);
    expect(dot().hidden).toBe(true);
  });

  test('pills read as pressed while their panel reports open', () => {
    const listeners = {};
    const makePanel = (key) => ({
      toggle: jest.fn(),
      isOpen: () => key === 'library',
      onOpenChange: (cb) => {
        listeners[key] = cb;
        return () => { if (listeners[key] === cb) delete listeners[key]; };
      },
    });
    const panels = { agentPanel: makePanel('assistant'), libraryWindow: makePanel('library') };
    tabBar.initialize({ state: makeState(), spaceManager, navigationManager: null, panels });
    const pressed = (id) => actionButton(id).getAttribute('aria-pressed');

    // Initial state comes from isOpen().
    expect(pressed('tabbar-assistant')).toBe('false');
    expect(pressed('tabbar-library')).toBe('true');

    listeners.assistant(true);
    expect(pressed('tabbar-assistant')).toBe('true');
    expect(actionButton('tabbar-assistant').classList.contains('is-open')).toBe(true);
    // A re-render keeps the pressed state.
    tabBar.render();
    expect(pressed('tabbar-assistant')).toBe('true');
    listeners.assistant(false);
    listeners.library(false);
    expect(pressed('tabbar-assistant')).toBe('false');
    expect(pressed('tabbar-library')).toBe('false');
    // Re-initializing replaces the action group and drops its panel listeners.
    tabBar.initialize({ state: makeState(), spaceManager, navigationManager: null });
    expect(listeners).toEqual({});
  });

  test('a wired viewShell adds the Assistant-view pill and menu item, both driving the flip', () => {
    let notify = null;
    let open = false;
    const viewShell = {
      isOpen: () => open,
      toggle: jest.fn(),
      onOpenChange: (cb) => { notify = cb; return () => { notify = null; }; },
    };
    tabBar.initialize({ state: makeState(), spaceManager, navigationManager: null, panels: { viewShell } });
    const visible = Array.from(document.querySelectorAll('.tab-bar-actions > .tab-bar-action-btn'))
      .filter((b) => !b.hidden)
      .map((b) => b.id);
    expect(visible).toEqual(['tabbar-more', 'tabbar-flip', 'tabbar-assistant', 'tabbar-library', 'tabbar-settings']);
    const flip = actionButton('tabbar-flip');
    expect(flip.getAttribute('aria-pressed')).toBe('false');

    open = true;
    notify(true);
    expect(actionButton('tabbar-flip').getAttribute('aria-pressed')).toBe('true');
    expectChecked('tabbar-assistant-view', true);
    // Assistant mode is a view, not a stray toggle: the More dot stays dark.
    expect(document.querySelector('#tabbar-more .tab-bar-more-dot').hidden).toBe(true);

    actionButton('tabbar-flip').click();
    menuItem('tabbar-assistant-view').click();
    expect(viewShell.toggle).toHaveBeenCalledTimes(2);
  });

  test('without a viewShell neither the flip pill nor its menu item renders', () => {
    tabBar.initialize({ state: makeState(), spaceManager, navigationManager: null });
    expect(actionButton('tabbar-flip')).toBeNull();
    expect(menuItem('tabbar-assistant-view')).toBeNull();
    closeMenu();
  });

  test('the action group drops its backing only while the strip does not overflow', () => {
    tabBar.initialize({ state: makeState(), spaceManager, navigationManager: null });
    const bar = document.getElementById('tab-bar');
    Object.defineProperty(bar, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(bar, 'scrollWidth', { value: 800, configurable: true, writable: true });
    window.dispatchEvent(new Event('resize'));
    expect(bar.classList.contains('is-overflowing')).toBe(false);
    Object.defineProperty(bar, 'scrollWidth', { value: 1400, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(bar.classList.contains('is-overflowing')).toBe(true);
    tabBar.render();
    expect(bar.classList.contains('is-overflowing')).toBe(true);
  });

  test('focus on an action survives the re-render a state change triggers', () => {
    const state = makeState();
    tabBar.initialize({ state, spaceManager, navigationManager: null });
    const settings = actionButton('tabbar-settings');
    settings.focus();
    state.set('findBarVisible', true);
    expect(document.activeElement).toBe(actionButton('tabbar-settings'));
  });

  test('action buttons have an aria-label (tooltip text) and no native title attr', () => {
    const state = makeState();
    tabBar.initialize({ state, spaceManager, navigationManager: null });

    const buttons = document.querySelectorAll('.tab-bar-action-btn');
    expect(buttons.length).toBe(5);
    buttons.forEach((btn) => {
      expect(btn.getAttribute('aria-label')).toBeTruthy();
      // Native tooltip is replaced by the custom Tooltip helper.
      expect(btn.hasAttribute('title')).toBe(false);
    });
  });
});
