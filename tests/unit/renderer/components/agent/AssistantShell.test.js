// AssistantShell + ResizeHandle + BrowserDock — the shell's DOM pieces.

const ResizeHandle = require('../../../../../renderer/components/assistant/ResizeHandle');
const BrowserDock = require('../../../../../renderer/components/assistant/BrowserDock');
const AssistantShell = require('../../../../../renderer/components/assistant/AssistantShell');

function widthControl(start = 420) {
  let width = start;
  return {
    min: 320,
    max: 960,
    getWidth: () => width,
    setWidth: jest.fn((px) => { width = Math.min(960, Math.max(320, px)); }),
    commit: jest.fn(),
  };
}

function key(el, k, extra = {}) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
  el.dispatchEvent(ev);
  return ev;
}

afterEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
});

describe('ResizeHandle', () => {
  test('requires getWidth, setWidth and commit', () => {
    expect(() => new ResizeHandle(/** @type {any} */ ({ label: 'x', getWidth: () => 1 }))).toThrow(TypeError);
  });

  test('renders an accessible vertical separator', () => {
    const h = new ResizeHandle({ label: 'Resize assistant sidebar', controls: 'assistant-shell', ...widthControl() });
    expect(h.el.getAttribute('role')).toBe('separator');
    expect(h.el.getAttribute('aria-orientation')).toBe('vertical');
    expect(h.el.getAttribute('aria-label')).toBe('Resize assistant sidebar');
    expect(h.el.getAttribute('aria-controls')).toBe('assistant-shell');
    expect(h.el.getAttribute('aria-valuenow')).toBe('420');
    expect(h.el.getAttribute('aria-valuemin')).toBe('320');
    expect(h.el.getAttribute('aria-valuemax')).toBe('960');
    expect(h.el.tabIndex).toBe(0);
  });

  test('arrow keys resize (left widens), Shift takes a larger step, Home/End hit the bounds', () => {
    const ctl = widthControl();
    const h = new ResizeHandle({ label: 'r', controls: 'x', ...ctl });
    expect(key(h.el, 'ArrowLeft').defaultPrevented).toBe(true);
    expect(ctl.getWidth()).toBe(436);
    key(h.el, 'ArrowRight', { shiftKey: true });
    expect(ctl.getWidth()).toBe(372);
    key(h.el, 'End');
    expect(ctl.getWidth()).toBe(320);
    key(h.el, 'Home');
    expect(ctl.getWidth()).toBe(960);
    expect(h.el.getAttribute('aria-valuenow')).toBe('960');
    expect(ctl.commit).toHaveBeenCalledTimes(4);
  });

  test('other keys are left alone and do not commit', () => {
    const ctl = widthControl();
    const h = new ResizeHandle({ label: 'r', controls: 'x', ...ctl });
    expect(key(h.el, 'a').defaultPrevented).toBe(false);
    expect(ctl.setWidth).not.toHaveBeenCalled();
    expect(ctl.commit).not.toHaveBeenCalled();
  });

  test('a drag runs over a shield, widens when moving left, and commits once on release', () => {
    const ctl = widthControl();
    const h = new ResizeHandle({ label: 'r', controls: 'x', ...ctl });
    document.body.appendChild(h.el);
    h.el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 500, bubbles: true, cancelable: true }));
    expect(document.querySelector('.assistant-resize-shield')).not.toBeNull();
    expect(document.body.classList.contains('assistant-resizing')).toBe(true);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, bubbles: true }));
    expect(ctl.getWidth()).toBe(520);
    expect(ctl.commit).not.toHaveBeenCalled();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(ctl.commit).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.assistant-resize-shield')).toBeNull();
    expect(document.body.classList.contains('assistant-resizing')).toBe(false);
  });

  test('sub-threshold jitter is a click: no resize, no commit', () => {
    const ctl = widthControl();
    const h = new ResizeHandle({ label: 'r', controls: 'x', ...ctl });
    document.body.appendChild(h.el);
    h.el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 500, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 498, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(ctl.setWidth).not.toHaveBeenCalled();
    expect(ctl.commit).not.toHaveBeenCalled();
  });

  test('a non-primary button does not start a drag', () => {
    const ctl = widthControl();
    const h = new ResizeHandle({ label: 'r', controls: 'x', ...ctl });
    document.body.appendChild(h.el);
    h.el.dispatchEvent(new MouseEvent('mousedown', { button: 2, clientX: 500, bubbles: true }));
    expect(document.querySelector('.assistant-resize-shield')).toBeNull();
  });
});

describe('BrowserDock', () => {
  function wrap() {
    const el = document.createElement('div');
    el.id = 'tab-bar-wrap';
    document.body.appendChild(el);
    return el;
  }

  test('requires an onToggle callback', () => {
    expect(() => new BrowserDock(/** @type {any} */ ({}))).toThrow(TypeError);
  });

  test('collapsed in assistant mode: wrap inert + aria-hidden, button says Show browser', () => {
    const w = wrap();
    const dock = new BrowserDock({ onToggle: jest.fn() });
    dock.sync({ appMode: 'assistant', dockOpen: false });
    expect(w.hasAttribute('inert')).toBe(true);
    expect(w.getAttribute('aria-hidden')).toBe('true');
    expect(dock.el.getAttribute('aria-label')).toBe('Show browser');
    expect(dock.el.getAttribute('aria-expanded')).toBe('false');
    dock.sync({ appMode: 'assistant', dockOpen: true });
    expect(w.hasAttribute('inert')).toBe(false);
    expect(w.hasAttribute('aria-hidden')).toBe(false);
    expect(dock.el.getAttribute('aria-label')).toBe('Hide browser');
  });

  test('never strips inert it did not set', () => {
    const w = wrap();
    w.setAttribute('inert', '');
    const dock = new BrowserDock({ onToggle: jest.fn() });
    dock.sync({ appMode: 'browser', dockOpen: false });
    expect(w.hasAttribute('inert')).toBe(true);
  });

  test('a missing wrap is tolerated; the click reaches onToggle', () => {
    const onToggle = jest.fn();
    const dock = new BrowserDock({ onToggle });
    expect(() => dock.sync({ appMode: 'assistant', dockOpen: false })).not.toThrow();
    dock.el.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('AssistantShell', () => {
  function build(overrides = {}) {
    const content = document.createElement('div');
    content.className = 'agent-panel';
    const opts = {
      content,
      onFlip: jest.fn(),
      onDockToggle: jest.fn(),
      flipLabel: 'Switch to browser view',
      sidebar: widthControl(420),
      dock: widthControl(520),
      ...overrides,
    };
    const shell = new AssistantShell(opts);
    shell.mount();
    return { shell, opts, content };
  }

  test('requires a content element and both callbacks', () => {
    expect(() => new AssistantShell(/** @type {any} */ ({ content: null }))).toThrow(TypeError);
    expect(() => new AssistantShell(/** @type {any} */ ({ content: document.createElement('div') }))).toThrow(TypeError);
  });

  test('mounts #assistant-shell as a body child with the panel in an #agent-panel region', () => {
    const { shell, content } = build();
    expect(shell.root.parentElement).toBe(document.body);
    const region = document.getElementById('agent-panel');
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe('Assistant');
    expect(region.contains(content)).toBe(true);
    shell.mount();
    expect(document.querySelectorAll('#assistant-shell')).toHaveLength(1);
  });

  test('browser mode, sidebar closed: hidden from AT, no handles or rail', () => {
    const { shell } = build();
    shell.sync({ appMode: 'browser', sidebarOpen: false, dockOpen: false });
    expect(shell.root.getAttribute('aria-hidden')).toBe('true');
    expect(shell.root.hasAttribute('inert')).toBe(false);
    expect(shell.sidebarHandle.el.hidden).toBe(true);
    expect(shell.rail.hidden).toBe(true);
  });

  test('browser mode, sidebar open: visible with only the sidebar handle', () => {
    const { shell } = build();
    shell.sync({ appMode: 'browser', sidebarOpen: true, dockOpen: false });
    expect(shell.root.hasAttribute('aria-hidden')).toBe(false);
    expect(shell.sidebarHandle.el.hidden).toBe(false);
    expect(shell.dockHandle.el.hidden).toBe(true);
    expect(shell.rail.hidden).toBe(true);
  });

  test('assistant mode: rail shown; the dock handle follows the dock', () => {
    const { shell, opts } = build();
    shell.sync({ appMode: 'assistant', sidebarOpen: false, dockOpen: false });
    expect(shell.rail.hidden).toBe(false);
    expect(shell.sidebarHandle.el.hidden).toBe(true);
    expect(shell.dockHandle.el.hidden).toBe(true);
    shell.sync({ appMode: 'assistant', sidebarOpen: false, dockOpen: true });
    expect(shell.dockHandle.el.hidden).toBe(false);
    shell.flipBtn.click();
    expect(opts.onFlip).toHaveBeenCalledTimes(1);
    expect(shell.flipBtn.getAttribute('aria-label')).toBe('Switch to browser view');
  });

  test('the dock receives the ShellStore and annotation sender for recording/annotating state', () => {
    const mockStore = { set: jest.fn(), get: jest.fn() };
    const sendAnnotation = jest.fn();
    const { shell } = build({ store: mockStore, sendAnnotation });
    expect(shell.dock.recorder()._store).toBe(mockStore);
    expect(shell.dock.annotation()._store).toBe(mockStore);
    expect(shell.dock._opts.sendAnnotation).toBe(sendAnnotation);
  });
});
