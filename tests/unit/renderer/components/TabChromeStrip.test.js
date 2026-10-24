/**
 * @jest-environment jsdom
 *
 * TabChromeStrip — per-tab nav strip. The NEW wiring under test is the two
 * per-tab buttons added alongside the agent button:
 *   - Reader button  → injected readerView.open({ spaceId })
 *   - Copilot button → injected pageCopilot.open({ mode:'summarize', spaceId })
 * Both must no-op safely when the collaborator is absent or lacks open().
 * Also covers DOM build order, URL submit via resolveNavigationUrl, home,
 * agent button, and agent IPC status wiring/teardown.
 *
 * Collaborators (agentPanel/pageCopilot/readerView) are injected fakes — the
 * real external boundary. electron ipcRenderer is stubbed per file because
 * the component require()s it directly and the global mock lacks
 * removeListener.
 */

jest.mock('electron', () => {
  const handlers = new Map();
  return {
    ipcRenderer: {
      _handlers: handlers,
      on: jest.fn((ch, fn) => {
        if (!handlers.has(ch)) handlers.set(ch, new Set());
        handlers.get(ch).add(fn);
      }),
      removeListener: jest.fn((ch, fn) => {
        if (handlers.has(ch)) handlers.get(ch).delete(fn);
      }),
      send: jest.fn(),
      invoke: jest.fn(),
      _emit: (ch, ...args) => {
        if (handlers.has(ch)) handlers.get(ch).forEach((h) => h({}, ...args));
      },
    },
  };
});

let ipcRenderer;
let TabChromeStrip;

function makeWebview() {
  const wv = document.createElement('div');
  const listeners = {};
  Object.assign(wv, {
    _src: '',
    get src() { return this._src; },
    set src(v) { this._src = v; },
    getURL: jest.fn(() => 'https://current.example/'),
    canGoBack: jest.fn(() => false),
    canGoForward: jest.fn(() => false),
    goBack: jest.fn(),
    goForward: jest.fn(),
    reload: jest.fn(),
    addEventListener: jest.fn((ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); }),
    removeEventListener: jest.fn((ev, fn) => {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
    }),
    _fire: (ev) => (listeners[ev] || []).forEach((f) => f()),
    _listeners: listeners,
  });
  return wv;
}

function mountStrip(opts = {}) {
  const wrapper = document.createElement('div');
  document.body.appendChild(wrapper);
  const webview = makeWebview();
  wrapper.appendChild(webview);
  const strip = new TabChromeStrip({
    spaceId: 'custom1',
    getHomeUrl: () => 'https://home.example/',
    getSearchEngine: () => 'google',
    getTabTitle: () => 'My Tab',
    ...opts,
  });
  strip.mount(wrapper, webview);
  return { strip, wrapper, webview };
}

describe('TabChromeStrip', () => {
  beforeEach(() => {
    document.body.textContent = '';
    document.body.classList.add('no-animations');
    jest.resetModules();
    ipcRenderer = require('electron').ipcRenderer;
    ipcRenderer._handlers.clear();
    ipcRenderer.on.mockClear();
    ipcRenderer.removeListener.mockClear();
    TabChromeStrip = require('../../../../renderer/components/TabChromeStrip');
  });

  afterEach(() => {
    document.body.classList.remove('no-animations');
    document.body.textContent = '';
  });

  test('mount() builds the strip above the webview with reader, copilot and agent buttons in order', () => {
    const { wrapper } = mountStrip();
    const root = wrapper.querySelector('.tab-chrome-strip');
    expect(root).not.toBeNull();
    // Strip is prepended → it is the first child, webview second.
    expect(wrapper.firstChild).toBe(root);
    expect(root.dataset.spaceId).toBe('custom1');

    expect(root.querySelector('.tab-chrome-reader-btn')).not.toBeNull();
    expect(root.querySelector('.tab-chrome-copilot-btn')).not.toBeNull();
    expect(root.querySelector('.tab-chrome-agent-btn')).not.toBeNull();

    const order = Array.from(root.querySelectorAll('button, input')).map((el) => el.className.split(' ')[0]);
    expect(order).toEqual([
      'tab-chrome-btn', // back
      'tab-chrome-btn', // forward
      'tab-chrome-btn', // reload
      'tab-chrome-btn', // home
      'tab-chrome-url',
      'tab-chrome-btn', // reader
      'tab-chrome-btn', // copilot
      'tab-chrome-btn', // agent
    ]);
  });

  describe('address-bar suggestions', () => {
    async function openSuggestions(wrapper, text) {
      ipcRenderer.invoke.mockImplementation((channel) => Promise.resolve(
        channel === 'search:suggest' ? { ok: true, suggestions: ['kittens video'] }
          : channel === 'history:search' ? [{ title: 'Kittens', url: 'https://kittens.example/' }]
            : [],
      ));
      const input = wrapper.querySelector('.tab-chrome-url');
      input.focus();
      input.value = text;
      input.dispatchEvent(new Event('input'));
      jest.advanceTimersByTime(200);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return input;
    }
    const press = (input, k) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true }));

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('a private tab neither sends the typed text out nor lists history and bookmarks', async () => {
      const { wrapper, webview } = mountStrip({
        getSettings: () => ({ searchSuggestionsEnabled: true, addressBarSearchHistory: true }),
      });
      webview.setAttribute('partition', 'private');
      const input = await openSuggestions(wrapper, 'kitt');
      expect(ipcRenderer.invoke).not.toHaveBeenCalled();
      expect(wrapper.querySelectorAll('.omnibox-row')).toHaveLength(0);
      press(input, 'Enter');
      expect(webview.src).toBe('https://www.google.com/search?q=kitt');
    });

    test('a normal tab still gets history and engine suggestions', async () => {
      const { wrapper } = mountStrip({
        getSettings: () => ({ searchSuggestionsEnabled: true, addressBarSearchHistory: true }),
      });
      await openSuggestions(wrapper, 'kitt');
      const channels = ipcRenderer.invoke.mock.calls.map(([c]) => c);
      expect(channels).toEqual(expect.arrayContaining(['history:search', 'search:suggest']));
    });

    test('a picked history row loads its URL instead of searching the typed text', async () => {
      const { wrapper, webview } = mountStrip();
      const input = await openSuggestions(wrapper, 'kitt');
      press(input, 'ArrowDown');
      press(input, 'Enter');
      expect(webview.src).toBe('https://kittens.example/');
    });

    test('a picked suggestion searches the configured engine, even when it looks like a host', async () => {
      const { wrapper, webview } = mountStrip({ getSearchEngine: () => 'duckduckgo' });
      const input = await openSuggestions(wrapper, 'kitt');
      press(input, 'ArrowDown');
      press(input, 'ArrowDown');
      press(input, 'Enter');
      expect(webview.src).toBe('https://duckduckgo.com/?q=kittens%20video');
    });

    test('Enter with no highlighted row still navigates to the typed text', async () => {
      const { wrapper, webview } = mountStrip();
      const input = await openSuggestions(wrapper, 'kitt');
      press(input, 'Enter');
      expect(webview.src).toBe('https://www.google.com/search?q=kitt');
    });

    test('destroy() removes the suggestion list', async () => {
      const { strip, wrapper } = mountStrip();
      await openSuggestions(wrapper, 'kitt');
      strip.destroy();
      expect(document.querySelector('.omnibox-list')).toBeNull();
    });
  });

  test('Copilot button runs the unified chat /summarize action scoped to this tab', () => {
    const agentPanel = { openChatAction: jest.fn() };
    const { wrapper } = mountStrip({ agentPanel });

    wrapper.querySelector('.tab-chrome-copilot-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(agentPanel.openChatAction).toHaveBeenCalledTimes(1);
    expect(agentPanel.openChatAction).toHaveBeenCalledWith('summarize', { scope: 'tab', tabId: 'custom1', tabTitle: 'My Tab' });
  });

  test('Reader button opens the injected readerView for this spaceId', () => {
    const readerView = { open: jest.fn() };
    const { wrapper } = mountStrip({ readerView });

    wrapper.querySelector('.tab-chrome-reader-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(readerView.open).toHaveBeenCalledTimes(1);
    expect(readerView.open).toHaveBeenCalledWith({ spaceId: 'custom1' });
  });

  test('Copilot/Reader buttons no-op safely when collaborators are absent', () => {
    const { wrapper } = mountStrip(); // no agentPanel / readerView
    expect(() => {
      wrapper.querySelector('.tab-chrome-copilot-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      wrapper.querySelector('.tab-chrome-reader-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }).not.toThrow();
  });

  test('Copilot button no-ops when the chat panel lacks an openChatAction() method', () => {
    const agentPanel = { open: jest.fn() }; // present but no .openChatAction
    const { wrapper } = mountStrip({ agentPanel });
    expect(() => {
      wrapper.querySelector('.tab-chrome-copilot-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }).not.toThrow();
  });

  test('Agent button opens the injected agentPanel scoped to this tab with its title', () => {
    const agentPanel = { open: jest.fn() };
    const { wrapper } = mountStrip({ agentPanel, getTabTitle: () => 'Docs Tab' });

    wrapper.querySelector('.tab-chrome-agent-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(agentPanel.open).toHaveBeenCalledWith({ scope: 'tab', tabId: 'custom1', tabTitle: 'Docs Tab' });
  });

  test('Enter in the URL field navigates the OWN webview via resolveNavigationUrl', () => {
    const { wrapper, webview } = mountStrip();
    const input = wrapper.querySelector('.tab-chrome-url');
    input.value = 'example.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(webview.src).toBe('https://example.com');

    input.value = 'hello world';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(webview.src).toBe('https://www.google.com/search?q=hello%20world');
  });

  test('home button navigates the webview to getHomeUrl(spaceId)', () => {
    const { wrapper, webview } = mountStrip({ getHomeUrl: (id) => (id === 'custom1' ? 'https://start.test/' : null) });
    const root = wrapper.querySelector('.tab-chrome-strip');
    const homeBtn = root.querySelectorAll('.tab-chrome-btn')[3];
    homeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(webview.src).toBe('https://start.test/');
  });

  test('_sync mirrors the webview URL and enables/disables back/forward/home', () => {
    const { wrapper, webview } = mountStrip();
    webview.canGoBack.mockReturnValue(true);
    webview.canGoForward.mockReturnValue(false);
    webview._fire('did-navigate');

    const input = wrapper.querySelector('.tab-chrome-url');
    expect(input.value).toBe('https://current.example/');
    const root = wrapper.querySelector('.tab-chrome-strip');
    const btns = root.querySelectorAll('.tab-chrome-btn');
    expect(btns[0].disabled).toBe(false); // back enabled
    expect(btns[1].disabled).toBe(true);  // forward disabled
    expect(btns[3].disabled).toBe(false); // home enabled (getHomeUrl returns url)
  });

  test('agent IPC status events flip the status only for THIS tab', () => {
    const { wrapper } = mountStrip();
    const status = wrapper.querySelector('.tab-chrome-agent-status');
    expect(status.dataset.status).toBe('idle');

    ipcRenderer._emit('agent:task-started', { scope: 'tab', tabId: 'custom1' });
    expect(status.dataset.status).toBe('running');

    // Different tab — must be ignored.
    ipcRenderer._emit('agent:task-completed', { scope: 'tab', tabId: 'other', ok: true });
    expect(status.dataset.status).toBe('running');

    ipcRenderer._emit('agent:task-completed', { scope: 'tab', tabId: 'custom1', ok: true });
    expect(status.dataset.status).toBe('done');

    ipcRenderer._emit('agent:task-failed', { scope: 'tab', tabId: 'custom1' });
    expect(status.dataset.status).toBe('error');
  });

  test('Escape in the URL field blurs it (runs the _sync + blur path)', () => {
    const { wrapper } = mountStrip();
    const input = wrapper.querySelector('.tab-chrome-url');
    input.value = 'half-typed';
    input.focus();
    const blurSpy = jest.spyOn(input, 'blur');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(blurSpy).toHaveBeenCalledTimes(1);
    // _sync ran while the field was still focused, so the guard kept the
    // user's text (the "don't clobber while typing" contract).
    expect(input.value).toBe('half-typed');
  });

  test('back/forward buttons navigate only when the webview reports it can', () => {
    const { wrapper, webview } = mountStrip();
    const root = wrapper.querySelector('.tab-chrome-strip');
    const btns = root.querySelectorAll('.tab-chrome-btn');
    // canGoBack/canGoForward default false → guard blocks navigation.
    btns[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    btns[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(webview.goBack).not.toHaveBeenCalled();
    expect(webview.goForward).not.toHaveBeenCalled();

    webview.canGoBack.mockReturnValue(true);
    webview.canGoForward.mockReturnValue(true);
    btns[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    btns[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(webview.goBack).toHaveBeenCalledTimes(1);
    expect(webview.goForward).toHaveBeenCalledTimes(1);
  });

  test('reload button reloads the own webview', () => {
    const { wrapper, webview } = mountStrip();
    const btns = wrapper.querySelectorAll('.tab-chrome-btn');
    btns[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(webview.reload).toHaveBeenCalledTimes(1);
  });

  test('Enter with a blank URL does not navigate (resolveNavigationUrl returns falsy)', () => {
    const { wrapper, webview } = mountStrip();
    const input = wrapper.querySelector('.tab-chrome-url');
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(webview.src).toBe('');
  });

  test('home button no-ops when getHomeUrl returns nothing', () => {
    const { wrapper, webview } = mountStrip({ getHomeUrl: () => null });
    const btns = wrapper.querySelectorAll('.tab-chrome-btn');
    btns[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(webview.src).toBe('');
    // Home button should also be disabled by _sync.
    expect(btns[3].disabled).toBe(true);
  });

  test('did-start-loading / did-stop-loading toggle the reload busy class', () => {
    const { wrapper, webview } = mountStrip();
    const reloadBtn = wrapper.querySelectorAll('.tab-chrome-btn')[2];
    webview._fire('did-start-loading');
    expect(reloadBtn.classList.contains('is-loading')).toBe(true);
    webview._fire('did-stop-loading');
    expect(reloadBtn.classList.contains('is-loading')).toBe(false);
  });

  test('agent:task-completed without ok maps to failed (reason) or stopped (no reason)', () => {
    const { wrapper } = mountStrip();
    const status = wrapper.querySelector('.tab-chrome-agent-status');
    ipcRenderer._emit('agent:task-completed', { scope: 'tab', tabId: 'custom1', ok: false, reason: 'limit' });
    expect(status.dataset.status).toBe('failed');
    ipcRenderer._emit('agent:task-completed', { scope: 'tab', tabId: 'custom1', ok: false });
    expect(status.dataset.status).toBe('stopped');
  });

  test('IPC status events ignore non-tab scope and missing tabId', () => {
    const { wrapper } = mountStrip();
    const status = wrapper.querySelector('.tab-chrome-agent-status');
    ipcRenderer._emit('agent:task-started', { scope: 'global', tabId: 'custom1' });
    expect(status.dataset.status).toBe('idle');
    ipcRenderer._emit('agent:task-started', { scope: 'tab' });
    expect(status.dataset.status).toBe('idle');
    ipcRenderer._emit('agent:task-started', null);
    expect(status.dataset.status).toBe('idle');
  });

  test('_sync does not clobber the URL field while the user is typing in it', () => {
    const { wrapper, webview } = mountStrip();
    const input = wrapper.querySelector('.tab-chrome-url');
    input.value = 'user typing here';
    input.focus(); // document.activeElement === input
    webview._fire('did-navigate');
    expect(input.value).toBe('user typing here');
  });

  test('focus() syncs then focuses + selects the URL field', () => {
    const { strip, wrapper } = mountStrip();
    const input = wrapper.querySelector('.tab-chrome-url');
    const selectSpy = jest.spyOn(input, 'select');
    strip.focus();
    expect(document.activeElement).toBe(input);
    expect(selectSpy).toHaveBeenCalled();
    expect(input.value).toBe('https://current.example/');
  });

  test('rebind() swaps to a new webview, unwiring the old one and syncing the new', () => {
    const { strip, wrapper, webview } = mountStrip();
    const oldRemove = webview.removeEventListener;
    const fresh = makeWebview();
    fresh.getURL = jest.fn(() => 'https://rebound.example/');
    strip.rebind(fresh);
    expect(oldRemove).toHaveBeenCalledWith('did-navigate', expect.any(Function));
    expect(fresh.addEventListener).toHaveBeenCalledWith('did-navigate', expect.any(Function));
    const input = wrapper.querySelector('.tab-chrome-url');
    expect(input.value).toBe('https://rebound.example/');
    // Events now drive the NEW webview.
    fresh.getURL.mockReturnValue('https://changed.example/');
    fresh._fire('did-navigate');
    expect(input.value).toBe('https://changed.example/');
  });

  test('rebind() is a no-op for the same or a falsy webview', () => {
    const { strip, webview } = mountStrip();
    const calls = webview.removeEventListener.mock.calls.length;
    strip.rebind(webview);
    strip.rebind(null);
    expect(webview.removeEventListener.mock.calls.length).toBe(calls);
  });

  test('mount() ignores a missing wrapper or webview', () => {
    const strip = new TabChromeStrip({ spaceId: 'x' });
    expect(() => strip.mount(null, makeWebview())).not.toThrow();
    expect(() => strip.mount(document.createElement('div'), null)).not.toThrow();
  });

  test('destroy() removes the strip DOM and unsubscribes webview + agent IPC listeners', () => {
    const { strip, wrapper, webview } = mountStrip();
    const root = wrapper.querySelector('.tab-chrome-strip');
    expect(document.body.contains(root)).toBe(true);

    strip.destroy();

    expect(document.body.contains(root)).toBe(false);
    expect(webview.removeEventListener).toHaveBeenCalledWith('did-navigate', expect.any(Function));
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('agent:task-started', expect.any(Function));
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('agent:task-completed', expect.any(Function));
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('agent:task-failed', expect.any(Function));
  });
});
