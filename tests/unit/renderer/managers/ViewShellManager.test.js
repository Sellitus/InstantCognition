// ViewShellManager — browser mode ⇄ assistant mode. The load-bearing
// invariants: no <webview> is ever moved (a reparent reloads the guest), the
// only inert element is the collapsed dock wrap, and the flip chord yields to
// modals and the shortcut recorder.

const EventEmitter = require('events');
const AppState = require('../../../../renderer/core/AppState');
const BrowserViewManager = require('../../../../renderer/managers/BrowserViewManager');
const LayoutManager = require('../../../../renderer/managers/LayoutManager');
const { ShellStore, WIDTH_BOUNDS } = require('../../../../renderer/core/ShellStore');
const { ViewShellManager, isBrowsingPayload } = require('../../../../renderer/managers/ViewShellManager');
const modalStack = require('../../../../renderer/utils/modalStack');
const shortcutManager = require('../../../../renderer/utils/shortcuts');

function mockBridge(assistant) {
  return {
    get: jest.fn((path, fallback) => (path === 'settings.assistant' && assistant ? assistant : fallback)),
    set: jest.fn(),
  };
}

function mockIpc() {
  const em = new EventEmitter();
  return { on: jest.fn((ch, fn) => em.on(ch, fn)), fire: (ch, payload) => em.emit(ch, {}, payload) };
}

// The app's body as TabBar/ChromeBar leave it: chrome sidebar, the wrap
// holding the tab bar and the space webviews, and the Ctrl+click browser.
function buildBody() {
  document.body.innerHTML = `
    <div id="chrome-sidebar"></div>
    <div id="tab-bar-wrap" class="tab-bar-wrap">
      <div id="tab-bar"><button id="tab-btn" type="button">Tab</button></div>
      <div id="space-container" style="display: flex;">
        <div class="space-webview-wrapper"><webview id="custom1" class="space-browser" tabindex="0"></webview></div>
        <div class="space-webview-wrapper"><webview id="custom2" class="space-browser" tabindex="0"></webview></div>
      </div>
    </div>
    <div id="browser-container" class="inactive"><webview id="browser-webview" tabindex="0"></webview></div>`;
}

function makePanel() {
  const content = document.createElement('div');
  content.className = 'agent-panel agent-panel-v2';
  const input = document.createElement('textarea');
  input.className = 'agent-panel-input';
  content.appendChild(input);
  return { content, input, host: { getContent: () => content, focusComposer: jest.fn(() => input.focus()) } };
}

function setup({ motion = 'off', assistant, chromeLayout } = {}) {
  buildBody();
  if (chromeLayout) document.body.setAttribute('data-chrome-layout', chromeLayout);
  const state = new AppState();
  const activeWebview = document.getElementById('custom1');
  const navigationManager = { getActiveWebview: jest.fn(() => activeWebview) };
  const browserViewManager = new BrowserViewManager(state, navigationManager);
  const ipc = mockIpc();
  const store = new ShellStore({ bridge: mockBridge(assistant) });
  store.hydrate();
  const manager = new ViewShellManager({
    store,
    ipc,
    getContext: () => ({ navigationManager, browserViewManager, state }),
    getMotionLevel: () => motion,
  });
  const panel = makePanel();
  manager.attachPanel(panel.host);
  manager.initialize();
  return { manager, store, state, ipc, panel, browserViewManager, navigationManager, wrap: document.getElementById('tab-bar-wrap') };
}

function modE() {
  return new KeyboardEvent('keydown', {
    key: 'e', metaKey: process.platform === 'darwin', ctrlKey: process.platform !== 'darwin', bubbles: true, cancelable: true,
  });
}

// The renderer's keydown path, reduced to the registry lookup it performs.
function pressModE(manager) {
  const ev = modE();
  const key = shortcutManager.normalizeKey(shortcutManager.eventToShortcut(ev));
  const match = shortcutManager.getAllShortcuts().find((s) => shortcutManager.normalizeKey(s.key) === key);
  expect(match && match.action).toBe('view.flip');
  return manager.requestFlip();
}

function inertElements() {
  return Array.from(document.querySelectorAll('[inert]'));
}

beforeAll(() => {
  shortcutManager.shortcuts.clear();
  shortcutManager.initializeDefaults();
  shortcutManager.loadShortcuts({ settings: {} });
});

afterEach(() => {
  jest.useRealTimers();
  document.body.className = '';
  document.body.removeAttribute('data-chrome-layout');
  document.body.removeAttribute('style');
  document.body.innerHTML = '';
});

describe('ViewShellManager flip', () => {
  test('Mod+E flips both ways without removing or reinserting any webview', async () => {
    const { manager, wrap } = setup();
    const webviews = Array.from(document.querySelectorAll('webview'));
    const parents = webviews.map((w) => w.parentElement);
    const moved = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of [...r.addedNodes, ...r.removedNodes]) {
          if (n.nodeType !== 1) continue;
          const el = /** @type {Element} */ (n);
          if (el.matches('webview, iframe') || el.querySelector('webview, iframe')) moved.push(el);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    expect(pressModE(manager)).toBe(true);
    expect(document.body.classList.contains('app-mode-assistant')).toBe(true);
    manager.toggleDock();
    manager.toggleDock();
    expect(pressModE(manager)).toBe(true);
    expect(document.body.classList.contains('app-mode-browser')).toBe(true);

    await Promise.resolve();
    observer.disconnect();
    expect(moved).toEqual([]);
    expect(Array.from(document.querySelectorAll('webview'))).toEqual(webviews);
    expect(webviews.map((w) => w.parentElement)).toEqual(parents);
    expect(wrap.parentElement).toBe(document.body);
  });

  test('assistant mode mounts #assistant-shell once and keeps it mounted across flips', () => {
    const { manager, panel } = setup();
    expect(document.getElementById('assistant-shell')).toBeNull();
    manager.flip();
    const shell = document.getElementById('assistant-shell');
    expect(shell.parentElement).toBe(document.body);
    expect(document.getElementById('agent-panel').contains(panel.content)).toBe(true);
    manager.flip();
    expect(document.getElementById('assistant-shell')).toBe(shell);
    expect(shell.getAttribute('aria-hidden')).toBe('true');
  });

  test('the dock tools write annotating state into the shell store', () => {
    const { manager, store } = setup();
    const wv = document.getElementById('custom1');
    wv.send = jest.fn();
    window.getActiveWebview = () => wv;
    try {
      manager.flip();
      manager.setDockOpen(true);
      document.querySelector('.assistant-dock-annotate').click();
      expect(wv.send).toHaveBeenCalledWith('ic-annotate:start');
      expect(store.get('annotating')).toBe(true);
    } finally {
      delete window.getActiveWebview;
    }
  });

  test('works with the right chrome layout: classes apply, the wrap stays a body child', () => {
    const { manager, wrap } = setup({ chromeLayout: 'right' });
    manager.flip();
    expect(document.body.getAttribute('data-chrome-layout')).toBe('right');
    expect(document.body.classList.contains('app-mode-assistant')).toBe(true);
    expect(wrap.parentElement).toBe(document.body);
    expect(document.getElementById('assistant-shell').parentElement).toBe(document.body);
  });

  test('layoutManager.refresh() keeps the mode classes and its own inline display', () => {
    const { manager, state } = setup();
    state.set('currentSpaceId', 'custom1');
    state.set('activeSpaces', { custom1: true });
    const layoutManager = new LayoutManager(state);
    layoutManager.initialize();
    manager.flip();
    layoutManager.refresh();
    expect(document.body.classList.contains('app-mode-assistant')).toBe(true);
    expect(document.body.classList.contains('app-mode-browser')).toBe(false);
    // LayoutManager owns #space-container's inline display; the flip never writes it.
    expect(document.getElementById('space-container').style.display).toBe('flex');
    manager.flip();
    layoutManager.refresh();
    expect(document.body.classList.contains('app-mode-browser')).toBe(true);
  });

  test('motion off: no animation class is ever added', () => {
    jest.useFakeTimers();
    const { manager } = setup({ motion: 'off' });
    const seen = [];
    const observer = new MutationObserver(() => seen.push(document.body.classList.contains('assistant-flipping')));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    manager.flip();
    manager.flip();
    observer.disconnect();
    expect(seen).not.toContain(true);
    expect(document.body.classList.contains('assistant-flipping')).toBe(false);
  });

  test('motion on: the flip class is added and cleared after the spring settles', () => {
    jest.useFakeTimers();
    const { manager } = setup({ motion: 'full' });
    manager.flip();
    expect(document.body.classList.contains('assistant-flipping')).toBe(true);
    jest.advanceTimersByTime(2000);
    expect(document.body.classList.contains('assistant-flipping')).toBe(false);
  });

  test('Mod+E is ignored while a modal is open', () => {
    const { manager } = setup();
    const layer = modalStack.push();
    try {
      expect(manager.requestFlip()).toBe(false);
      expect(document.body.classList.contains('app-mode-browser')).toBe(true);
    } finally {
      modalStack.pop(layer);
    }
    expect(manager.requestFlip()).toBe(true);
  });

  test('Mod+E is ignored while a shortcut is being recorded', () => {
    const { manager, store } = setup();
    document.body.classList.add('recording-shortcut');
    expect(manager.requestFlip()).toBe(false);
    document.body.classList.remove('recording-shortcut');
    store.set('recording', true);
    expect(manager.requestFlip()).toBe(false);
    expect(manager.getMode()).toBe('browser');
  });

  test('requestFlip refuses without an attached panel; setMode/initialize throw', () => {
    buildBody();
    const manager = new ViewShellManager({ store: new ShellStore({ bridge: mockBridge() }) });
    expect(manager.requestFlip()).toBe(false);
    expect(() => manager.setMode('assistant')).toThrow(/no panel attached/);
    expect(() => manager.initialize()).toThrow(/attachPanel/);
    expect(() => manager.attachPanel({ getContent: () => null })).toThrow(TypeError);
  });

  test('setMode rejects an unknown mode and is a no-op for the current one', () => {
    const { manager } = setup();
    expect(() => manager.setMode(/** @type {any} */ ('sideways'))).toThrow(TypeError);
    expect(manager.setMode('browser')).toBe(false);
  });

  test('hydrating startMode assistant starts in assistant mode with the shell mounted', () => {
    const { manager } = setup({ assistant: { startMode: 'assistant' } });
    expect(manager.getMode()).toBe('assistant');
    expect(document.body.classList.contains('app-mode-assistant')).toBe(true);
    expect(document.getElementById('assistant-shell')).not.toBeNull();
  });
});

describe('ViewShellManager inert + dock', () => {
  test('nothing is inert except the collapsed dock wrap', () => {
    const { manager, wrap } = setup();
    expect(inertElements()).toEqual([]);
    manager.openSidebar();
    expect(inertElements()).toEqual([]);
    manager.flip();
    expect(inertElements()).toEqual([wrap]);
    expect(wrap.getAttribute('aria-hidden')).toBe('true');
    manager.setDockOpen(true);
    expect(inertElements()).toEqual([]);
    expect(wrap.hasAttribute('aria-hidden')).toBe(false);
    manager.setDockOpen(false);
    expect(inertElements()).toEqual([wrap]);
    manager.flip();
    expect(inertElements()).toEqual([]);
    expect(wrap.hasAttribute('aria-hidden')).toBe(false);
  });

  test('the collapsed dock is never display:none or zero width inline', () => {
    const { manager, wrap } = setup();
    manager.flip();
    expect(wrap.style.display).toBe('');
    expect(wrap.style.width).toBe('');
  });

  test('the dock toggle button carries an accessible name and expanded state', () => {
    const { manager } = setup();
    manager.flip();
    const btn = document.querySelector('.assistant-dock-toggle');
    expect(btn.getAttribute('aria-label')).toBe('Show browser');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('tab-bar-wrap');
    /** @type {HTMLButtonElement} */ (btn).click();
    expect(btn.getAttribute('aria-label')).toBe('Hide browser');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.classList.contains('assistant-dock-open')).toBe(true);
  });

  test('an agent browsing step auto-opens the dock in assistant mode', () => {
    const { manager, ipc } = setup();
    manager.flip();
    ipc.fire('agent:step-planned', { step: 1, calls: [{ name: 'browser.navigate', args: { url: 'https://example.com' } }] });
    expect(manager.store.get('dockOpen')).toBe(true);
    expect(document.body.classList.contains('assistant-dock-open')).toBe(true);
  });

  test('a user-collapsed dock stays collapsed on agent browsing', () => {
    const { manager, ipc } = setup();
    manager.flip();
    manager.toggleDock(); // user opens
    manager.toggleDock(); // user collapses
    expect(manager.store.get('dockUserCollapsed')).toBe(true);
    ipc.fire('agent:step-acted', { step: 2, calls: [{ name: 'browser.click', args: {} }] });
    expect(manager.store.get('dockOpen')).toBe(false);
    manager.toggleDock(); // the user reopening clears the suppression
    expect(manager.store.get('dockUserCollapsed')).toBe(false);
  });

  test('web_search, non-browser tools and browser-mode steps never open the dock', () => {
    const { manager, ipc } = setup();
    ipc.fire('agent:step-planned', { calls: [{ name: 'browser.navigate' }] });
    expect(manager.store.get('dockOpen')).toBe(false);
    manager.flip();
    ipc.fire('agent:step-planned', { calls: [{ name: 'browser.web_search' }, { name: 'fs.read' }] });
    ipc.fire('agent:step-planned', null);
    expect(manager.store.get('dockOpen')).toBe(false);
  });

  test('isBrowsingPayload tolerates malformed payloads', () => {
    expect(isBrowsingPayload(undefined)).toBe(false);
    expect(isBrowsingPayload({ calls: 'browser.navigate' })).toBe(false);
    expect(isBrowsingPayload({ calls: [null, { name: 42 }] })).toBe(false);
    expect(isBrowsingPayload({ calls: [{ name: 'browser.read_page' }] })).toBe(true);
  });

  test('collapsing the dock with focus inside it moves focus to the composer', () => {
    const { manager, panel } = setup();
    manager.flip();
    manager.setDockOpen(true, { user: true });
    document.getElementById('tab-btn').focus();
    manager.setDockOpen(false, { user: true });
    expect(document.activeElement).toBe(panel.input);
  });
});

describe('ViewShellManager widths', () => {
  test.each([
    ['NaN', NaN, WIDTH_BOUNDS.sidebarWidth.fallback],
    ['-5', -5, WIDTH_BOUNDS.sidebarWidth.fallback],
    ['99999', 99999, WIDTH_BOUNDS.sidebarWidth.max],
  ])('sidebar width %s is clamped before reaching the CSS variable', (_l, input, expected) => {
    const { manager } = setup();
    manager.openSidebar();
    manager.store.set('sidebarWidth', 500);
    manager.store.set('sidebarWidth', input);
    expect(document.body.style.getPropertyValue('--assistant-sidebar-width')).toBe(`${expected}px`);
  });

  test.each([
    ['NaN', NaN, WIDTH_BOUNDS.dockWidth.fallback],
    ['-5', -5, WIDTH_BOUNDS.dockWidth.fallback],
    ['99999', 99999, WIDTH_BOUNDS.dockWidth.max],
  ])('dock width %s is clamped before reaching the CSS variable', (_l, input, expected) => {
    const { manager } = setup();
    manager.store.set('dockWidth', 700);
    manager.store.set('dockWidth', input);
    expect(document.body.style.getPropertyValue('--dock-width')).toBe(`${expected}px`);
  });

  test('the sidebar handle is a keyboard separator that resizes and persists', () => {
    const { manager, store } = setup();
    manager.openSidebar();
    const handle = document.querySelector('.assistant-resize-handle--sidebar');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-valuenow')).toBe('420');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(store.get('sidebarWidth')).toBe(436);
    expect(handle.getAttribute('aria-valuenow')).toBe('436');
    expect(store._bridge.set).toHaveBeenCalledWith('settings.assistant.sidebarWidth', 436);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(store.get('sidebarWidth')).toBe(WIDTH_BOUNDS.sidebarWidth.max);
  });
});

describe('ViewShellManager focus + view state', () => {
  test('assistant mode focuses the composer; browser mode restores the previous webview focus', () => {
    const { manager, panel } = setup();
    const wv = document.getElementById('custom2');
    wv.focus();
    manager.flip();
    expect(panel.host.focusComposer).toHaveBeenCalled();
    expect(document.activeElement).toBe(panel.input);
    manager.flip();
    expect(document.activeElement).toBe(wv);
  });

  test('closing the sidebar from inside it returns focus to the active webview', () => {
    const { manager, panel } = setup();
    manager.openSidebar();
    panel.input.focus();
    manager.closeSidebar();
    expect(document.activeElement).toBe(document.getElementById('custom1'));
  });

  test('closing the sidebar while focus is elsewhere leaves focus alone', () => {
    const { manager } = setup();
    manager.openSidebar();
    const tabBtn = document.getElementById('tab-btn');
    tabBtn.focus();
    manager.closeSidebar();
    expect(document.activeElement).toBe(tabBtn);
  });

  test('a hidden space view is shown for the dock and restored on the way back', () => {
    const { manager, state, browserViewManager } = setup();
    browserViewManager.toggle(true);
    browserViewManager.toggleSpace(false, true);
    expect(state.get('spaceViewActive')).toBe(false);
    manager.flip();
    expect(state.get('spaceViewActive')).toBe(true);
    manager.flip();
    expect(state.get('spaceViewActive')).toBe(false);
    expect(state.get('browserViewActive')).toBe(true);
  });

  test('an already-visible space view is left alone on both flips', () => {
    const { manager, state, browserViewManager } = setup();
    const spy = jest.spyOn(browserViewManager, 'toggleSpace');
    manager.flip();
    manager.flip();
    expect(spy).not.toHaveBeenCalled();
    expect(state.get('spaceViewActive')).toBe(true);
  });
});

describe('ViewShellManager subscriptions', () => {
  test('visibility and mode listeners fire on transitions only; unsubscribe stops them', () => {
    const { manager } = setup();
    const vis = [];
    const modes = [];
    const offVis = manager.onVisibilityChange((v) => vis.push(v));
    manager.onModeChange((m) => modes.push(m));
    manager.openSidebar();
    manager.flip();
    manager.flip();
    manager.closeSidebar();
    expect(vis).toEqual([true, false]);
    expect(modes).toEqual(['assistant', 'browser']);
    offVis();
    manager.openSidebar();
    expect(vis).toEqual([true, false]);
    expect(() => manager.onVisibilityChange(/** @type {any} */ ('x'))).toThrow(TypeError);
    expect(() => manager.onModeChange(/** @type {any} */ (null))).toThrow(TypeError);
  });

  test('asToggle exposes the pill contract: isOpen, onOpenChange, toggle', () => {
    const { manager } = setup();
    const t = manager.asToggle();
    const seen = [];
    t.onOpenChange((open) => seen.push(open));
    expect(t.isOpen()).toBe(false);
    t.toggle();
    expect(t.isOpen()).toBe(true);
    t.toggle();
    expect(seen).toEqual([true, false]);
  });
});
