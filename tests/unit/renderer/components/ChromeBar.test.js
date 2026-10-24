/**
 * @jest-environment jsdom
 */

// ChromeBar — sidebar shell that reparents the TabBar and shows the LLM
// status pill. External boundary: electron.ipcRenderer (llm:get-status +
// llm:status-changed), mocked as a real EventEmitter so status pushes can
// be delivered. The injected `state` (AppState-shaped) and `tabBar`/`panels`
// are simple fakes — they are collaborators passed in, not internal modules.
// Fresh singleton per test via jest.resetModules().

let bus;
jest.mock('electron', () => {
  const { EventEmitter: EE } = require('events');
  const em = new EE();
  em.invoke = jest.fn(() => Promise.resolve(null));
  global.__cbBus = em;
  return { ipcRenderer: em };
});

function freshChromeBar() {
  jest.resetModules();
  const cb = require('../../../../renderer/components/ChromeBar');
  bus = global.__cbBus;
  return cb;
}

function makeState(initialLayout) {
  const handlers = {};
  return {
    _layout: initialLayout,
    get: jest.fn(function (key) { return key === 'chromeLayout' ? this._layout : undefined; }),
    on: jest.fn((evt, fn) => { handlers[evt] = fn; }),
    emit(evt, value) { if (handlers[evt]) handlers[evt](value); },
  };
}

function makeTabBar() {
  const bar = document.createElement('div');
  bar.className = 'tab-bar';
  // Original home: a container that mimics the topBar mount point.
  const home = document.createElement('div');
  home.id = 'tabbar-home';
  home.appendChild(bar);
  document.body.appendChild(home);
  return { bar };
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('ChromeBar', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  afterEach(() => {
    if (bus) bus.removeAllListeners();
    document.body.textContent = '';
  });

  test('initialize() builds the #chrome-sidebar shell with logo, tabs area and LLM pill', () => {
    const cb = freshChromeBar();
    cb.initialize({ state: makeState('left'), tabBar: makeTabBar(), panels: {} });
    const sidebar = document.getElementById('chrome-sidebar');
    expect(sidebar).not.toBeNull();
    expect(sidebar.querySelector('#chrome-sidebar-toggle')).not.toBeNull();
    expect(sidebar.querySelector('.chrome-sidebar-tabs')).not.toBeNull();
    const pill = document.getElementById('chrome-llm-pill');
    expect(pill).not.toBeNull();
    expect(pill.classList.contains('stopped')).toBe(true);
    expect(pill.title).toBe('Local LLM: stopped');
  });

  test('vertical layout (left) reparents the TabBar into the sidebar and shows it', () => {
    const cb = freshChromeBar();
    const tabBar = makeTabBar();
    cb.initialize({ state: makeState('left'), tabBar, panels: {} });
    const sidebar = document.getElementById('chrome-sidebar');
    expect(sidebar.style.display).toBe('flex');
    expect(sidebar.querySelector('.chrome-sidebar-tabs').contains(tabBar.bar)).toBe(true);
    expect(tabBar.bar.classList.contains('tab-bar--vertical')).toBe(true);
    expect(tabBar.bar.classList.contains('tab-bar--horizontal')).toBe(false);
    expect(document.body.dataset.chromeLayout).toBe('left');
  });

  test('horizontal layout (top) hides the sidebar and puts the TabBar just before its home, outside it', () => {
    const cb = freshChromeBar();
    const tabBar = makeTabBar();
    const home = document.getElementById('tabbar-home');
    cb.initialize({ state: makeState('top'), tabBar, panels: {} });
    const sidebar = document.getElementById('chrome-sidebar');
    expect(sidebar.style.display).toBe('none');
    expect(home.contains(tabBar.bar)).toBe(false);
    expect(tabBar.bar.parentNode).toBe(document.body);
    expect(tabBar.bar.nextSibling).toBe(home);
    expect(tabBar.bar.classList.contains('tab-bar--horizontal')).toBe(true);
    expect(tabBar.bar.classList.contains('tab-bar--vertical')).toBe(false);
    expect(document.body.dataset.chromeLayout).toBe('top');
  });

  test('legacy aliases normalize: "sidebar" → left, "topBar" → top, unknown → left', () => {
    const cb = freshChromeBar();
    const state = makeState('sidebar');
    cb.initialize({ state, tabBar: makeTabBar(), panels: {} });
    expect(document.body.dataset.chromeLayout).toBe('left');

    state.emit('change:chromeLayout', 'topBar');
    expect(document.body.dataset.chromeLayout).toBe('top');

    state.emit('change:chromeLayout', 'nonsense');
    expect(document.body.dataset.chromeLayout).toBe('left');
  });

  test('state change:chromeLayout flips the layout live', () => {
    const cb = freshChromeBar();
    const tabBar = makeTabBar();
    const state = makeState('left');
    cb.initialize({ state, tabBar, panels: {} });
    expect(tabBar.bar.classList.contains('tab-bar--vertical')).toBe(true);
    state.emit('change:chromeLayout', 'bottom');
    expect(document.body.dataset.chromeLayout).toBe('bottom');
    expect(tabBar.bar.classList.contains('tab-bar--horizontal')).toBe(true);
    expect(tabBar.bar.parentNode).toBe(document.body);
    expect(tabBar.bar.nextSibling).toBe(document.getElementById('tabbar-home'));
    expect(document.getElementById('chrome-sidebar').style.display).toBe('none');
    state.emit('change:chromeLayout', 'left');
    expect(document.getElementById('chrome-sidebar').contains(tabBar.bar)).toBe(true);
  });

  test('aria-orientation is set on the TabBar per layout', () => {
    const cb = freshChromeBar();
    const tabBar = makeTabBar();
    const state = makeState('left');
    cb.initialize({ state, tabBar, panels: {} });
    expect(tabBar.bar.getAttribute('aria-orientation')).toBe('vertical');
    state.emit('change:chromeLayout', 'top');
    expect(tabBar.bar.getAttribute('aria-orientation')).toBe('horizontal');
  });

  test('--chrome-bar-thickness var: 30px horizontal, 0px vertical', () => {
    const cb = freshChromeBar();
    const state = makeState('top');
    cb.initialize({ state, tabBar: makeTabBar(), panels: {} });
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--chrome-bar-thickness')).toBe('30px');
    state.emit('change:chromeLayout', 'left');
    expect(root.style.getPropertyValue('--chrome-bar-thickness')).toBe('0px');
  });

  test('vertical width var reflects collapsed vs expanded sidebar', () => {
    const cb = freshChromeBar();
    const state = makeState('left');
    cb.initialize({ state, tabBar: makeTabBar(), panels: {} });
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--chrome-sidebar-current-width')).toBe('48px');
    const sidebar = document.getElementById('chrome-sidebar');
    sidebar.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    expect(sidebar.classList.contains('chrome-sidebar--expanded')).toBe(true);
    expect(root.style.getPropertyValue('--chrome-sidebar-current-width')).toBe('220px');
  });

  test('logo button toggles the settings menu panel', () => {
    const cb = freshChromeBar();
    const settingsMenu = { toggle: jest.fn() };
    cb.initialize({ state: makeState('left'), tabBar: makeTabBar(), panels: { settingsMenu } });
    document.getElementById('chrome-sidebar-toggle')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(settingsMenu.toggle).toHaveBeenCalledTimes(1);
  });

  test('logo button click is safe when no settingsMenu panel is wired', () => {
    const cb = freshChromeBar();
    cb.initialize({ state: makeState('left'), tabBar: makeTabBar(), panels: {} });
    expect(() => {
      document.getElementById('chrome-sidebar-toggle')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }).not.toThrow();
  });

  test('LLM pill renders the initial status from llm:get-status', async () => {
    const cb = freshChromeBar();
    bus.invoke = jest.fn(async () => ({ status: 'running', endpoint: 'http://127.0.0.1:8080' }));
    cb.initialize({ state: makeState('left'), tabBar: makeTabBar(), panels: {} });
    await flush();
    const pill = document.getElementById('chrome-llm-pill');
    expect(bus.invoke).toHaveBeenCalledWith('llm:get-status');
    expect(pill.className).toBe('chrome-llm-pill running');
    expect(pill.title).toBe('Local LLM: running @ http://127.0.0.1:8080');
  });

  test('LLM pill updates on a llm:status-changed push', async () => {
    const cb = freshChromeBar();
    cb.initialize({ state: makeState('left'), tabBar: makeTabBar(), panels: {} });
    await flush();
    bus.emit('llm:status-changed', { sender: bus }, { info: { status: 'starting' } });
    const pill = document.getElementById('chrome-llm-pill');
    expect(pill.className).toBe('chrome-llm-pill starting');
    expect(pill.title).toBe('Local LLM: starting');
  });

  test('a failing llm:get-status leaves the default stopped pill (no throw)', async () => {
    const cb = freshChromeBar();
    bus.invoke = jest.fn(() => Promise.reject(new Error('llm down')));
    cb.initialize({ state: makeState('left'), tabBar: makeTabBar(), panels: {} });
    await flush();
    const pill = document.getElementById('chrome-llm-pill');
    expect(pill.classList.contains('stopped')).toBe(true);
  });

  test('re-applying the same layout does not re-snapshot/move the TabBar', () => {
    const cb = freshChromeBar();
    const tabBar = makeTabBar();
    const state = makeState('left');
    cb.initialize({ state, tabBar, panels: {} });
    const tabsArea = document.querySelector('.chrome-sidebar-tabs');
    expect(tabsArea.contains(tabBar.bar)).toBe(true);
    state.emit('change:chromeLayout', 'left');
    // Still parented in the sidebar, no error, layout unchanged.
    expect(tabsArea.contains(tabBar.bar)).toBe(true);
    expect(document.body.dataset.chromeLayout).toBe('left');
  });
});
