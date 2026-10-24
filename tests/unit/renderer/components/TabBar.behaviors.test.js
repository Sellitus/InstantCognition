/** @jest-environment jsdom */

// TabBar behaviors — surface not covered by TabBar.test.js: audio IPC
// + indicator, every action dispatch case (user + agent-view routing),
// _onClick (ctrl+click multi entry, multi toggle, single focus, agent
// view), the right-click context menu (all items, agent mode, disabled
// states), _createTabIcon (logo vs initial), notification badge,
// new-tab button, and agent-view render.

const mockAudioListeners = {};
jest.mock('electron', () => ({
  ipcRenderer: {
    send: jest.fn(),
    invoke: jest.fn(),
    on: jest.fn((ch, cb) => { (mockAudioListeners[ch] = mockAudioListeners[ch] || []).push(cb); }),
  },
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
      custom3: { name: 'Workspace', url: 'https://example.com/', type: 'web' },
    },
    settings: { multiSpace: false, defaultSpace: 'custom1' },
    state: { openTabs: ['custom1'], hiddenTabs: [], pinnedTabs: [] },
  });
  for (const [k, v] of Object.entries(overrides)) state.set(k, v);
  return state;
}

function resetSingleton() {
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

beforeEach(() => {
  document.body.innerHTML = '';
  for (const k of Object.keys(mockAudioListeners)) delete mockAudioListeners[k];
  setupDom();
  resetSingleton();
  jest.clearAllMocks();
});

describe('TabBar audio IPC + indicator', () => {
  test('tab:audio-state with a numeric webContentsId updates state and re-renders', () => {
    const state = makeState({ openTabs: ['custom1'], currentSpaceId: 'custom1' });
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });

    // Give the tab webview a webContents id so the indicator can resolve.
    const wv = document.createElement('webview');
    wv.id = 'custom1';
    wv.getWebContentsId = () => 7;
    wv.setAudioMuted = jest.fn();
    document.body.appendChild(wv);

    mockAudioListeners['tab:audio-state'][0]({}, { webContentsId: 7, audible: true, muted: false });
    expect(tabBar._audioByWebContentsId.get(7)).toEqual({ audible: true, muted: false });
    const indicator = document.querySelector('.tab-bar-audio');
    expect(indicator).toBeTruthy();
    expect(indicator.title).toBe('Mute tab');
  });

  test('tab:audio-state ignores a non-numeric webContentsId', () => {
    const state = makeState();
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    mockAudioListeners['tab:audio-state'][0]({}, { webContentsId: 'oops' });
    expect(tabBar._audioByWebContentsId.size).toBe(0);
  });

  test('clicking the audio indicator toggles mute on the webview', () => {
    const state = makeState({ openTabs: ['custom1'], currentSpaceId: 'custom1' });
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    const wv = document.createElement('webview');
    wv.id = 'custom1';
    wv.getWebContentsId = () => 9;
    wv.setAudioMuted = jest.fn();
    document.body.appendChild(wv);
    mockAudioListeners['tab:audio-state'][0]({}, { webContentsId: 9, audible: true, muted: false });

    document.querySelector('.tab-bar-audio').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(wv.setAudioMuted).toHaveBeenCalledWith(true);
    expect(tabBar._audioByWebContentsId.get(9)).toEqual({ audible: true, muted: true });
  });

  test('a muted tab shows the muted indicator with the unmute title', () => {
    const state = makeState({ openTabs: ['custom1'], currentSpaceId: 'custom1' });
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    const wv = document.createElement('webview');
    wv.id = 'custom1';
    wv.getWebContentsId = () => 3;
    document.body.appendChild(wv);
    mockAudioListeners['tab:audio-state'][0]({}, { webContentsId: 3, audible: false, muted: true });
    const ind = document.querySelector('.tab-bar-audio');
    expect(ind.classList.contains('muted')).toBe(true);
    expect(ind.title).toBe('Unmute tab');
  });

  test('no audio indicator when the tab is silent and unmuted', () => {
    const state = makeState({ openTabs: ['custom1'], currentSpaceId: 'custom1' });
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    const wv = document.createElement('webview');
    wv.id = 'custom1';
    wv.getWebContentsId = () => 4;
    document.body.appendChild(wv);
    mockAudioListeners['tab:audio-state'][0]({}, { webContentsId: 4, audible: false, muted: false });
    expect(document.querySelector('.tab-bar-audio')).toBeNull();
  });
});

// View and page actions live in the More menu.
function menuItem(id) {
  const more = document.getElementById('tabbar-more');
  if (more.getAttribute('aria-expanded') !== 'true') more.click();
  return document.querySelector(`.ic-menu [data-item-id="${id}"]`);
}

describe('TabBar action dispatch', () => {
  function init(panels, stateOverrides) {
    const state = makeState(stateOverrides);
    const spaceManager = { reorderTabs: jest.fn(), toggleMulti: jest.fn(), toggleViewMode: jest.fn() };
    tabBar.initialize({ state, spaceManager, navigationManager: null, panels });
    return { state, spaceManager };
  }

  test('assistant / library / settings open the consolidated windows', () => {
    const panels = {
      agentPanel: { toggle: jest.fn(), openChat: jest.fn(), openChatAction: jest.fn() },
      libraryWindow: { toggle: jest.fn() },
      settingsMenu: { toggle: jest.fn() },
    };
    init(panels);
    document.getElementById('tabbar-assistant').click();
    document.getElementById('tabbar-library').click();
    document.getElementById('tabbar-settings').click();
    expect(panels.agentPanel.toggle).toHaveBeenCalled();
    expect(panels.libraryWindow.toggle).toHaveBeenCalledWith({ tab: 'ask' });
    expect(panels.settingsMenu.toggle).toHaveBeenCalled();
  });

  test('assistant action is inert when the chat panel is unavailable', () => {
    const panels = {};
    init(panels);
    expect(() => document.getElementById('tabbar-assistant').click()).not.toThrow();
  });

  test('in agent view, multiSpace + layout route to the workspace manager', () => {
    const wsm = { toggleMulti: jest.fn(), cycleLayout: jest.fn() };
    const panels = { agentWorkspaceManager: wsm };
    init(panels, { viewMode: 'agent', agentWorkspace: { tabs: [], currentTabId: null } });
    menuItem('tabbar-multi-space').click();
    menuItem('tabbar-layout').click();
    expect(wsm.toggleMulti).toHaveBeenCalled();
    expect(wsm.cycleLayout).toHaveBeenCalled();
  });

  test('outside agent view, multiSpace + layout route to spaceManager / panels.cycleLayout', () => {
    const panels = { cycleLayout: jest.fn() };
    const { spaceManager } = init(panels);
    menuItem('tabbar-multi-space').click();
    menuItem('tabbar-layout').click();
    expect(spaceManager.toggleMulti).toHaveBeenCalled();
    expect(panels.cycleLayout).toHaveBeenCalled();
  });

  test('actions are inert no-ops when their panel/handler is absent', () => {
    init({});
    ['tabbar-assistant', 'tabbar-library', 'tabbar-settings'].forEach((id) => {
      expect(() => document.getElementById(id).click()).not.toThrow();
    });
    ['tabbar-find', 'tabbar-external-links', 'tabbar-browser-view', 'tabbar-space-view'].forEach((id) => {
      const item = menuItem(id);
      expect(item).not.toBeNull();
      expect(() => item.click()).not.toThrow();
    });
  });
});

describe('TabBar setNotificationBadge', () => {
  test('shows the unread count and hides at zero, capping at 99+', () => {
    const state = makeState();
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    const badge = () => document.querySelector('#tabbar-library .tab-bar-action-badge');

    tabBar.setNotificationBadge(5);
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe('5');

    tabBar.setNotificationBadge(150);
    expect(badge().textContent).toBe('99+');

    expect(document.getElementById('tabbar-library').getAttribute('aria-label')).toBe('Library (99+ unread)');

    tabBar.setNotificationBadge(0);
    expect(badge().hidden).toBe(true);
    expect(badge().textContent).toBe('');
    expect(document.getElementById('tabbar-library').getAttribute('aria-label')).toBe('Library');

    tabBar.setNotificationBadge(-3); // clamped to 0
    expect(badge().hidden).toBe(true);
  });
});

describe('TabBar inbox badge on the Assistant-view pill', () => {
  const { ipcRenderer } = require('electron');
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const viewShell = () => ({ isOpen: () => false, toggle: jest.fn(), onOpenChange: () => () => {} });
  const badge = () => document.querySelector('#tabbar-flip .tab-bar-action-badge');
  const flip = () => document.getElementById('tabbar-flip');

  afterEach(() => { ipcRenderer.invoke.mockReset(); });

  test('reads 99+ above 99 and hides at 0, following inbox:changed', async () => {
    ipcRenderer.invoke.mockImplementation(async (ch) => (ch === 'inbox:list' ? { ok: true, items: [], unread: 150 } : undefined));
    tabBar.initialize({ state: makeState(), spaceManager: { reorderTabs: jest.fn() }, navigationManager: null, panels: { viewShell: viewShell() } });
    await flush();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('inbox:list', {});
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe('99+');
    expect(flip().getAttribute('aria-label')).toBe('Assistant view (99+ unread)');

    const onChanged = mockAudioListeners['inbox:changed'].slice(-1)[0];
    onChanged({}, { reason: 'read', unread: 3 });
    expect(badge().textContent).toBe('3');
    onChanged({}, { reason: 'cleared', unread: 0 });
    expect(badge().hidden).toBe(true);
    expect(badge().textContent).toBe('');
    expect(flip().getAttribute('aria-label')).toBe('Assistant view');
  });

  test('a count that cannot be read shows "!" with the reason, not a silent zero', async () => {
    ipcRenderer.invoke.mockImplementation(async (ch) => (ch === 'inbox:list' ? { ok: false, error: 'inbox_corrupt: bad json' } : undefined));
    tabBar.initialize({ state: makeState(), spaceManager: { reorderTabs: jest.fn() }, navigationManager: null, panels: { viewShell: viewShell() } });
    await flush();
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe('!');
    expect(badge().classList.contains('is-error')).toBe(true);
    expect(flip().getAttribute('aria-label')).toBe('Assistant view (inbox unavailable: inbox_corrupt: bad json)');
  });

  test('without the Assistant-view pill the inbox is not queried', async () => {
    tabBar.initialize({ state: makeState(), spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    await flush();
    expect(ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'inbox:list')).toBe(false);
    expect(mockAudioListeners['inbox:changed']).toBeUndefined();
  });

  test('the library badge is unaffected by the inbox count', async () => {
    ipcRenderer.invoke.mockImplementation(async (ch) => (ch === 'inbox:list' ? { ok: true, items: [], unread: 4 } : undefined));
    tabBar.initialize({ state: makeState(), spaceManager: { reorderTabs: jest.fn() }, navigationManager: null, panels: { viewShell: viewShell() } });
    await flush();
    expect(document.querySelector('#tabbar-library .tab-bar-action-badge').hidden).toBe(true);
  });
});

describe('TabBar setUpdateNudge', () => {
  const pill = () => /** @type {HTMLButtonElement} */ (document.getElementById('tabbar-update'));
  const { ipcRenderer } = require('electron');
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // A dismissed dialog lingers for its leave animation, so act on the newest.
  const dialogButton = (cls) => {
    const all = document.querySelectorAll(`.confirm-dialog-${cls}`);
    return /** @type {HTMLElement} */ (all[all.length - 1]);
  };

  function init() {
    tabBar.initialize({ state: makeState(), spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
  }

  afterEach(() => {
    document.querySelectorAll('.confirm-dialog-overlay, .confirm-dialog').forEach((n) => n.remove());
    /** @type {jest.Mock} */ (ipcRenderer.invoke).mockReset();
  });

  test('stays hidden until a downloaded update has waited long enough to nudge', () => {
    init();
    expect(pill().hidden).toBe(true);
    tabBar.setUpdateNudge({ level: 'none', version: null });
    expect(pill().hidden).toBe(true);
  });

  test('recommended shows the pill with an accessible restart label', () => {
    init();
    tabBar.setUpdateNudge({ level: 'recommended', version: '4.2.0' });
    expect(pill().hidden).toBe(false);
    expect(pill().classList.contains('is-elevated')).toBe(false);
    expect(pill().getAttribute('aria-label')).toBe('Restart to install update v4.2.0');
  });

  test('elevated switches to the warn tone, and none hides it again', () => {
    init();
    tabBar.setUpdateNudge({ level: 'elevated', version: '4.2.0' });
    expect(pill().classList.contains('is-elevated')).toBe(true);
    tabBar.setUpdateNudge({ level: 'none', version: null });
    expect(pill().hidden).toBe(true);
    expect(pill().classList.contains('is-elevated')).toBe(false);
  });

  test('clicking asks first and installs only on confirm', async () => {
    init();
    /** @type {jest.Mock} */ (ipcRenderer.invoke).mockResolvedValue({ ok: true });
    tabBar.setUpdateNudge({ level: 'recommended', version: '4.2.0' });

    pill().click();
    await flush();
    dialogButton('cancel').click();
    await flush();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('updater:install');

    pill().click();
    await flush();
    expect(dialogButton('message').textContent).toContain('v4.2.0');
    dialogButton('confirm').click();
    await flush();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('updater:install');
  });

  test('an install that fails is shown, not swallowed', async () => {
    init();
    /** @type {jest.Mock} */ (ipcRenderer.invoke).mockResolvedValue({ ok: false, error: 'No update has been downloaded.' });
    tabBar.setUpdateNudge({ level: 'elevated', version: '4.2.0' });
    pill().click();
    await flush();
    dialogButton('confirm').click();
    await flush();
    await flush();
    expect(document.body.textContent).toContain('No update has been downloaded.');
  });

  test('an update this build can only download opens its release page instead of restarting', async () => {
    init();
    /** @type {jest.Mock} */ (ipcRenderer.send).mockClear();
    tabBar.setUpdateNudge({ level: 'recommended', version: '4.2.0', url: 'https://github.com/o/r/releases/tag/v4.2.0' });
    expect(pill().getAttribute('aria-label')).toBe('Download update v4.2.0');

    pill().click();
    await flush();

    expect(ipcRenderer.send).toHaveBeenCalledWith('open-external-url', 'https://github.com/o/r/releases/tag/v4.2.0');
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('updater:install');
    expect(document.querySelector('.confirm-dialog')).toBeNull();
  });

  test('a later downloaded update drops the release link and restarts again', async () => {
    init();
    /** @type {jest.Mock} */ (ipcRenderer.send).mockClear();
    /** @type {jest.Mock} */ (ipcRenderer.invoke).mockResolvedValue({ ok: true });
    tabBar.setUpdateNudge({ level: 'recommended', version: '4.2.0', url: 'https://github.com/o/r/releases/tag/v4.2.0' });
    tabBar.setUpdateNudge({ level: 'recommended', version: '4.2.0', url: null });
    expect(pill().getAttribute('aria-label')).toBe('Restart to install update v4.2.0');

    pill().click();
    await flush();
    dialogButton('confirm').click();
    await flush();

    expect(ipcRenderer.send).not.toHaveBeenCalledWith('open-external-url', expect.anything());
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('updater:install');
  });
});

describe('TabBar _onClick', () => {
  test('single-mode click focuses the tab', () => {
    const focusTab = jest.fn();
    const state = makeState({ openTabs: ['custom1', 'custom2'], currentSpaceId: 'custom1' });
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn(), focusTab }, navigationManager: null });
    document.querySelector('.tab-bar-tab[data-space-id="custom2"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(focusTab).toHaveBeenCalledWith('custom2');
  });

  test('multi-mode click on a visible tab hides it without moving focus', () => {
    const focusTab = jest.fn();
    const toggleTabVisibility = jest.fn();
    const state = makeState({
      multiSpace: true, openTabs: ['custom1', 'custom2'], hiddenTabs: [], currentSpaceId: 'custom1',
    });
    tabBar.initialize({
      state,
      spaceManager: { reorderTabs: jest.fn(), toggleTabVisibility, focusTab, toggleMulti: jest.fn() },
      navigationManager: null,
    });
    document.querySelector('.tab-bar-tab[data-space-id="custom2"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggleTabVisibility).toHaveBeenCalledWith('custom2');
    expect(focusTab).not.toHaveBeenCalled();
  });

  test('multi-mode click on a hidden tab un-hides AND focuses it', () => {
    const focusTab = jest.fn();
    const state = makeState({
      multiSpace: true, openTabs: ['custom1', 'custom2'], hiddenTabs: ['custom2'], currentSpaceId: 'custom1',
    });
    tabBar.initialize({
      state,
      spaceManager: { reorderTabs: jest.fn(), toggleTabVisibility: jest.fn(), focusTab, toggleMulti: jest.fn() },
      navigationManager: null,
    });
    document.querySelector('.tab-bar-tab[data-space-id="custom2"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(focusTab).toHaveBeenCalledWith('custom2');
  });

  test('Ctrl+Click from single-mode enables multi and opens the clicked tab', () => {
    const openTab = jest.fn();
    const toggleMulti = jest.fn();
    const state = makeState({ openTabs: ['custom1', 'custom2'], currentSpaceId: 'custom1', multiSpace: false });
    tabBar.initialize({
      state,
      spaceManager: { reorderTabs: jest.fn(), toggleMulti, openTab, toggleTabVisibility: jest.fn() },
      navigationManager: null,
    });
    document.querySelector('.tab-bar-tab[data-space-id="custom2"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(toggleMulti).toHaveBeenCalled();
    expect(openTab).toHaveBeenCalledWith('custom2');
  });

  test('agent-view click routes through the workspace manager', () => {
    const wsm = { _setCurrent: jest.fn() };
    const state = makeState({
      viewMode: 'agent',
      agentWorkspace: { tabs: [{ id: 'ag1', title: 'Agent', url: 'https://x.com' }], currentTabId: 'ag1' },
    });
    tabBar.initialize({
      state,
      spaceManager: { reorderTabs: jest.fn() },
      navigationManager: null,
      panels: { agentWorkspaceManager: wsm },
    });
    document.querySelector('.tab-bar-tab[data-space-id="ag1"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(wsm._setCurrent).toHaveBeenCalledWith('ag1');
  });

  test('_onClick is a no-op without a space manager or id', () => {
    const state = makeState();
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    tabBar._spaceManager = null;
    expect(() => tabBar._onClick('custom1', {})).not.toThrow();
  });
});

describe('TabBar agent-view render', () => {
  test('renders agent workspace tabs with hostname-derived labels', () => {
    const state = makeState({
      viewMode: 'agent',
      agentWorkspace: {
        tabs: [
          { id: 'a1', title: 'My Page', url: 'https://example.com/x' },
          { id: 'a2', title: '', url: 'https://news.site/article' },
        ],
        currentTabId: 'a1',
        multiSpace: true,
        hiddenTabs: ['a2'],
      },
    });
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    expect(tabBar.bar.classList.contains('tabbar--agent-mode')).toBe(true);
    const tabs = Array.from(document.querySelectorAll('.tab-bar-tab'));
    expect(tabs.map((t) => t.dataset.spaceId)).toEqual(['a1', 'a2']);
    expect(tabs[1].classList.contains('hidden')).toBe(true);
  });

  test('agent view still renders when there are zero tabs (keeps the toggle reachable)', () => {
    const state = makeState({
      viewMode: 'agent',
      agentWorkspace: { tabs: [], currentTabId: null },
    });
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    expect(tabBar.bar.classList.contains('visible')).toBe(true);
  });

  test('user view with no open tabs hides the bar', () => {
    const state = makeState({ openTabs: [] });
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    expect(tabBar.bar.classList.contains('visible')).toBe(false);
    expect(tabBar.bar.innerHTML).toBe('');
  });
});

describe('TabBar context menu', () => {
  function initWithTabs(openTabs, extra = {}) {
    const state = makeState({ openTabs, currentSpaceId: openTabs[0], ...extra });
    const spaceManager = {
      reorderTabs: jest.fn(), closeTab: jest.fn(), openTab: jest.fn(),
      pinTab: jest.fn(), unpinTab: jest.fn(), focusTab: jest.fn(),
    };
    const navigationManager = { home: jest.fn() };
    tabBar.initialize({ state, spaceManager, navigationManager });
    return { state, spaceManager, navigationManager };
  }

  function openMenu(spaceId) {
    document.querySelector(`.tab-bar-tab[data-space-id="${spaceId}"]`)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    return tabBar._menu;
  }

  test('right-click builds the menu with the expected items', () => {
    initWithTabs(['custom1', 'custom2']);
    const menu = openMenu('custom1');
    expect(menu.style.display).toBe('block');
    const labels = Array.from(menu.querySelectorAll('.tab-bar-context-menu-item')).map((i) => i.textContent);
    expect(labels).toEqual(expect.arrayContaining([
      'Close Tab', 'Close Other Tabs', 'Close Tabs to the Right',
      'Duplicate Tab', 'Pin Tab', 'Reload', 'Go Home',
    ]));
  });

  test('Close Tab is disabled for the only tab', () => {
    initWithTabs(['custom1']);
    const menu = openMenu('custom1');
    const closeItem = Array.from(menu.querySelectorAll('.tab-bar-context-menu-item'))
      .find((i) => i.textContent === 'Close Tab');
    expect(closeItem.classList.contains('disabled')).toBe(true);
  });

  test('Close Tab closes the right-clicked tab', () => {
    const { spaceManager } = initWithTabs(['custom1', 'custom2']);
    const menu = openMenu('custom2');
    Array.from(menu.querySelectorAll('.tab-bar-context-menu-item'))
      .find((i) => i.textContent === 'Close Tab').click();
    expect(spaceManager.closeTab).toHaveBeenCalledWith('custom2');
  });

  test('Close Other Tabs closes every other unpinned tab', () => {
    const { spaceManager } = initWithTabs(['custom1', 'custom2', 'custom3']);
    const menu = openMenu('custom2');
    Array.from(menu.querySelectorAll('.tab-bar-context-menu-item'))
      .find((i) => i.textContent === 'Close Other Tabs').click();
    expect(spaceManager.closeTab).toHaveBeenCalledWith('custom1');
    expect(spaceManager.closeTab).toHaveBeenCalledWith('custom3');
    expect(spaceManager.closeTab).not.toHaveBeenCalledWith('custom2');
  });

  test('Close Tabs to the Right closes only tabs after the target', () => {
    const { spaceManager } = initWithTabs(['custom1', 'custom2', 'custom3']);
    const menu = openMenu('custom1');
    Array.from(menu.querySelectorAll('.tab-bar-context-menu-item'))
      .find((i) => i.textContent === 'Close Tabs to the Right').click();
    expect(spaceManager.closeTab).toHaveBeenCalledWith('custom2');
    expect(spaceManager.closeTab).toHaveBeenCalledWith('custom3');
    expect(spaceManager.closeTab).not.toHaveBeenCalledWith('custom1');
  });

  test('Duplicate Tab re-opens the same space id', () => {
    const { spaceManager } = initWithTabs(['custom1', 'custom2']);
    const menu = openMenu('custom1');
    Array.from(menu.querySelectorAll('.tab-bar-context-menu-item'))
      .find((i) => i.textContent === 'Duplicate Tab').click();
    expect(spaceManager.openTab).toHaveBeenCalledWith('custom1');
  });

  test('Pin Tab pins; on a pinned tab the item flips to Unpin', () => {
    const { state, spaceManager } = initWithTabs(['custom1', 'custom2']);
    let menu = openMenu('custom1');
    Array.from(menu.querySelectorAll('.tab-bar-context-menu-item'))
      .find((i) => i.textContent === 'Pin Tab').click();
    expect(spaceManager.pinTab).toHaveBeenCalledWith('custom1');

    state.set('pinnedTabs', ['custom1']);
    menu = openMenu('custom1');
    const unpin = Array.from(menu.querySelectorAll('.tab-bar-context-menu-item'))
      .find((i) => i.textContent === 'Unpin Tab');
    expect(unpin).toBeTruthy();
    unpin.click();
    expect(spaceManager.unpinTab).toHaveBeenCalledWith('custom1');
  });

  test('Reload reloads the matching webview', () => {
    initWithTabs(['custom1', 'custom2']);
    const wv = document.createElement('webview');
    wv.id = 'custom1';
    wv.reload = jest.fn();
    document.body.appendChild(wv);
    const menu = openMenu('custom1');
    Array.from(menu.querySelectorAll('.tab-bar-context-menu-item'))
      .find((i) => i.textContent === 'Reload').click();
    expect(wv.reload).toHaveBeenCalled();
  });

  test('Go Home focuses the tab then navigates home', () => {
    jest.useFakeTimers();
    const { spaceManager, navigationManager } = initWithTabs(['custom1', 'custom2']);
    const menu = openMenu('custom1');
    Array.from(menu.querySelectorAll('.tab-bar-context-menu-item'))
      .find((i) => i.textContent === 'Go Home').click();
    expect(spaceManager.focusTab).toHaveBeenCalledWith('custom1');
    jest.advanceTimersByTime(60);
    expect(navigationManager.home).toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('Escape and outside click dismiss the open menu', () => {
    initWithTabs(['custom1', 'custom2']);
    const menu = openMenu('custom1');
    expect(menu.style.display).toBe('block');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.style.display).toBe('none');

    openMenu('custom1');
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(tabBar._menu.style.display).toBe('none');
  });

  test('agent-mode menu operates on the workspace, not user openTabs', () => {
    const wsm = { closeTab: jest.fn(), closeOtherTabs: jest.fn(), closeTabsToRight: jest.fn() };
    const state = makeState({
      viewMode: 'agent',
      agentWorkspace: {
        tabs: [{ id: 'g1', title: 'P1', url: 'https://a.com' }, { id: 'g2', title: 'P2', url: 'https://b.com' }],
        currentTabId: 'g1',
      },
    });
    tabBar.initialize({
      state,
      spaceManager: { reorderTabs: jest.fn() },
      navigationManager: { home: jest.fn() },
      panels: { agentWorkspaceManager: wsm },
    });
    document.querySelector('.tab-bar-tab[data-space-id="g1"]')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    const items = Array.from(tabBar._menu.querySelectorAll('.tab-bar-context-menu-item'));
    items.find((i) => i.textContent === 'Close Tab').click();
    expect(wsm.closeTab).toHaveBeenCalledWith('g1');
    // Duplicate / Pin / Go Home are user-only → disabled in agent mode.
    expect(items.find((i) => i.textContent === 'Duplicate Tab').classList.contains('disabled')).toBe(true);
  });

  test('_showMenu is a no-op when the menu element is missing', () => {
    initWithTabs(['custom1', 'custom2']);
    tabBar._menu = null;
    expect(() => tabBar._showMenu('custom1', 0, 0)).not.toThrow();
  });
});

describe('TabBar misc', () => {
  test('setNewTabPicker wires the picker and the + button opens it', () => {
    const state = makeState();
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    const picker = { open: jest.fn() };
    tabBar.setNewTabPicker(picker);
    document.querySelector('.tab-bar-new-tab-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picker.open).toHaveBeenCalled();
  });

  test('_createTabIcon uses the logo image for known names, initial otherwise', () => {
    const withLogo = tabBar._createTabIcon({ name: 'ChatGPT' });
    expect(withLogo.querySelector('img.tab-bar-icon-img')).toBeTruthy();
    const withInitial = tabBar._createTabIcon({ name: 'Workspace' });
    expect(withInitial.textContent).toBe('W');
    const noName = tabBar._createTabIcon({});
    expect(noName.textContent).toBe('?');
  });

  // jsdom in this worker has no DataTransfer/DragEvent constructors; build a
  // minimal compatible transfer + dispatch a plain Event carrying it. The
  // TabBar handlers only touch setData/getData/effectAllowed/dropEffect.
  function makeDataTransfer() {
    const store = {};
    return {
      effectAllowed: 'all',
      dropEffect: 'none',
      setData: (k, v) => { store[k] = String(v); },
      getData: (k) => store[k] || '',
    };
  }
  function fireDrag(el, type, dt, extra = {}) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    ev.dataTransfer = dt;
    Object.assign(ev, extra);
    el.dispatchEvent(ev);
    return ev;
  }

  test('dragstart/dragover/drop set and clear drag classes and reorder', () => {
    const reorderTabs = jest.fn();
    const state = makeState({ openTabs: ['custom1', 'custom2', 'custom3'], currentSpaceId: 'custom1' });
    tabBar.initialize({ state, spaceManager: { reorderTabs }, navigationManager: null });
    const src = document.querySelector('.tab-bar-tab[data-space-id="custom1"]');
    const target = document.querySelector('.tab-bar-tab[data-space-id="custom3"]');
    target.getBoundingClientRect = () => ({ left: 0, width: 100 });

    const dt = makeDataTransfer();
    fireDrag(src, 'dragstart', dt);
    expect(src.classList.contains('dragging')).toBe(true);
    expect(dt.getData('text/plain')).toBe('custom1');

    fireDrag(target, 'dragover', dt);
    expect(target.classList.contains('drag-over')).toBe(true);
    fireDrag(target, 'dragleave', dt);
    expect(target.classList.contains('drag-over')).toBe(false);

    fireDrag(target, 'drop', dt, { clientX: 80 }); // right half → after custom3
    expect(reorderTabs).toHaveBeenCalledWith(['custom2', 'custom3', 'custom1']);

    fireDrag(src, 'dragend', dt);
    expect(src.classList.contains('dragging')).toBe(false);
  });

  test('dropping a tab onto itself is ignored', () => {
    const reorderTabs = jest.fn();
    const state = makeState({ openTabs: ['custom1', 'custom2'], currentSpaceId: 'custom1' });
    tabBar.initialize({ state, spaceManager: { reorderTabs }, navigationManager: null });
    const tab = document.querySelector('.tab-bar-tab[data-space-id="custom1"]');
    tab.getBoundingClientRect = () => ({ left: 0, width: 100 });
    const dt = makeDataTransfer();
    dt.setData('text/plain', 'custom1');
    fireDrag(tab, 'drop', dt, { clientX: 10 });
    expect(reorderTabs).not.toHaveBeenCalled();
  });

  test('_reorder is a no-op when either id is not in openTabs', () => {
    const reorderTabs = jest.fn();
    const state = makeState({ openTabs: ['custom1', 'custom2'], currentSpaceId: 'custom1' });
    tabBar.initialize({ state, spaceManager: { reorderTabs }, navigationManager: null });
    tabBar._reorder('ghost', 'custom1');
    tabBar._reorder('custom1', 'ghost');
    expect(reorderTabs).not.toHaveBeenCalled();
  });

  test('in agent view, _reorder routes to the agent workspace, not user openTabs', () => {
    const wsm = { reorderTabs: jest.fn() };
    const userReorder = jest.fn();
    const state = makeState({
      viewMode: 'agent',
      openTabs: ['custom1', 'custom2'],
      agentWorkspace: {
        tabs: [
          { id: 'agent-tab-a', url: 'https://a.test', title: 'A' },
          { id: 'agent-tab-b', url: 'https://b.test', title: 'B' },
          { id: 'agent-tab-c', url: 'https://c.test', title: 'C' },
        ],
        currentTabId: 'agent-tab-a',
      },
      currentSpaceId: 'custom1',
    });
    // Panels carry the workspace manager; window.agentWorkspaceManager is absent in jsdom.
    tabBar.initialize({
      state,
      spaceManager: { reorderTabs: userReorder },
      navigationManager: null,
      panels: { agentWorkspaceManager: wsm },
    });
    // Agent tab ids never appear in user openTabs, so the old code silently
    // no-opped; now the workspace manager receives the new order.
    tabBar._reorder('agent-tab-a', 'agent-tab-c', true);
    expect(wsm.reorderTabs).toHaveBeenCalledWith(['agent-tab-b', 'agent-tab-c', 'agent-tab-a']);
    expect(userReorder).not.toHaveBeenCalled();
  });

  test('in agent view, _reorder drops user-view ids (not in agent tabs) untouched', () => {
    const wsm = { reorderTabs: jest.fn() };
    const state = makeState({
      viewMode: 'agent',
      agentWorkspace: {
        tabs: [{ id: 'agent-tab-a', url: 'https://a.test' }, { id: 'agent-tab-b', url: 'https://b.test' }],
        currentTabId: 'agent-tab-a',
      },
      currentSpaceId: 'custom1',
    });
    tabBar.initialize({
      state,
      spaceManager: { reorderTabs: jest.fn() },
      navigationManager: null,
      panels: { agentWorkspaceManager: wsm },
    });
    // A user-view space id is not an agent tab, so the reorder is a no-op.
    tabBar._reorder('custom1', 'agent-tab-b');
    tabBar._reorder('agent-tab-a', 'custom1');
    expect(wsm.reorderTabs).not.toHaveBeenCalled();
  });

  test('pinned tabs render first with a separator before unpinned', () => {
    const state = makeState({
      openTabs: ['custom1', 'custom2', 'custom3'],
      pinnedTabs: ['custom3'],
      currentSpaceId: 'custom1',
    });
    tabBar.initialize({ state, spaceManager: { reorderTabs: jest.fn() }, navigationManager: null });
    const order = Array.from(document.querySelectorAll('.tab-bar-tab')).map((t) => t.dataset.spaceId);
    expect(order[0]).toBe('custom3'); // pinned first
    expect(document.querySelector('.tab-bar-pin-separator')).toBeTruthy();
    expect(document.querySelector('.tab-bar-tab[data-space-id="custom3"]').classList.contains('pinned')).toBe(true);
  });
});

describe('TabBar private tabs', () => {
  function initWithPrivateTab() {
    const state = makeState({
      adHocSpaces: { tab_p: { name: 'secret.example', url: 'https://secret.example/', type: 'ad-hoc', private: true } },
      openTabs: ['custom1', 'tab_p'],
      currentSpaceId: 'tab_p',
    });
    const spaceManager = {
      reorderTabs: jest.fn(), closeTab: jest.fn(), openTab: jest.fn(),
      pinTab: jest.fn(), unpinTab: jest.fn(), focusTab: jest.fn(),
    };
    tabBar.initialize({ state, spaceManager, navigationManager: { home: jest.fn() } });
    return { spaceManager };
  }

  function menuItem(spaceId, label) {
    document.querySelector(`.tab-bar-tab[data-space-id="${spaceId}"]`)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    return Array.from(tabBar._menu.querySelectorAll('.tab-bar-context-menu-item')).find((i) => i.textContent === label);
  }

  test('a private tab is marked for sight and for screen readers; a regular tab is not', () => {
    initWithPrivateTab();
    const priv = document.querySelector('.tab-bar-tab[data-space-id="tab_p"]');
    expect(priv.classList.contains('private')).toBe(true);
    expect(priv.getAttribute('aria-label')).toBe('secret.example (private)');
    expect(priv.title).toBe('secret.example (private)');
    expect(priv.querySelector('.tab-bar-private-badge')).toBeTruthy();

    const regular = document.querySelector('.tab-bar-tab[data-space-id="custom1"]');
    expect(regular.classList.contains('private')).toBe(false);
    expect(regular.getAttribute('aria-label')).toBe('ChatGPT');
    expect(regular.querySelector('.tab-bar-private-badge')).toBeNull();
  });

  test('Pin Tab is disabled with a reason on a private tab and still works on a regular one', () => {
    const { spaceManager } = initWithPrivateTab();
    const privPin = menuItem('tab_p', 'Pin Tab');
    expect(privPin.classList.contains('disabled')).toBe(true);
    expect(privPin.title).toBe("Private tabs can't be pinned");
    privPin.click();
    expect(spaceManager.pinTab).not.toHaveBeenCalled();

    menuItem('custom1', 'Pin Tab').click();
    expect(spaceManager.pinTab).toHaveBeenCalledWith('custom1');
  });
});
