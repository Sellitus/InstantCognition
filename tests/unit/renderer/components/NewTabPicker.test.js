// Unit tests for renderer/components/NewTabPicker (a module-level singleton).
//
// External boundary mocked: electron.ipcRenderer — NewTabPicker itself never
// touches it, but its real collaborators (Dropdown, AgentPanel via deferred
// require) load `electron`, so the mock keeps the module graph quiet.
//
// Real (project-owned) collaborators are NOT mocked: the real Dropdown shell,
// the real fuzzyScore / resolveNavigationUrl utils, and a real AppState-like
// fake passed as the injected `state`. The spaceManager is a hand-rolled fake
// (it is an injected dependency, an explicit seam, not the unit under test).
// AgentPanel is the real singleton — we spy on its real openWithTask method to
// assert the exact integration contract _openAskAgent fires.

jest.mock('electron', () => ({
  ipcRenderer: { send: jest.fn(), on: jest.fn(), invoke: jest.fn(() => Promise.resolve(null)) },
}));

const picker = require('../../../../renderer/components/NewTabPicker');
const agentPanel = require('../../../../renderer/components/AgentPanel');

// Minimal observable state stub: only get() is used by NewTabPicker.
function makeState(config = {}, openTabs = []) {
  return {
    _config: config,
    _openTabs: openTabs,
    get(key) {
      if (key === 'config') return this._config;
      if (key === 'openTabs') return this._openTabs;
      return undefined;
    },
  };
}

function makeSpaceManager() {
  return {
    focusTab: jest.fn(),
    openTab: jest.fn(),
    openAdHocTab: jest.fn(),
  };
}

const SPACES = {
  s1: { name: 'ChatGPT', url: 'https://chatgpt.com/', type: 'ai-service', color: '#10a37f' },
  s2: { name: 'Claude', url: 'https://claude.ai/new', type: 'ai-service' },
  s3: { name: 'Example Wiki', url: 'https://example.org/wiki', type: 'web-page' },
  s4: { name: 'Local Llama', url: 'http://localhost:8080', type: 'local-llm' },
};

// A non-persistent Dropdown only attaches its surface to the document on
// open(). NewTabPicker holds live references to the elements it built, so
// query through those (the real elements the unit operates on) rather than
// relying on them being in document.body.
function content() {
  return picker._content;
}
function input() {
  return picker._input;
}
function urlOption() {
  return picker._content.querySelector('.new-tab-picker-url-option');
}
function askOption() {
  return picker._content.querySelector('.new-tab-picker-ask-option');
}
function cards() {
  return Array.from(picker._content.querySelectorAll('.new-tab-picker-card'));
}
function groupTitles() {
  return Array.from(picker._content.querySelectorAll('.new-tab-picker-group-title')).map((e) => e.textContent);
}

function setSearch(value) {
  input().value = value;
  input().dispatchEvent(new Event('input'));
}

function key(name, opts = {}) {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...opts }));
}

describe('NewTabPicker', () => {
  let state;
  let spaceManager;
  let openWithTaskSpy;

  beforeEach(() => {
    // jsdom does not implement scrollIntoView; the production highlight code
    // calls it when a card is selected. Stub it (repo convention) so keyboard
    // navigation does not throw on a DOM API jsdom omits.
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
    document.body.textContent = '';
    document.body.classList.add('no-animations'); // synchronous Dropdown lifecycle
    state = makeState({ spaces: SPACES, settings: { defaultSearchEngine: 'google' } }, ['s2']);
    spaceManager = makeSpaceManager();
    openWithTaskSpy = jest.spyOn(agentPanel, 'openWithTask').mockImplementation(() => {});
    picker.initialize({ state, spaceManager });
  });

  afterEach(() => {
    if (picker.isOpen()) picker.close();
    openWithTaskSpy.mockRestore();
    document.body.classList.remove('no-animations');
    document.body.textContent = '';
  });

  describe('construction & open/close', () => {
    test('initialize builds the search input but does not attach the surface until open', () => {
      expect(content()).toBeInstanceOf(HTMLElement);
      expect(input()).toBeInstanceOf(HTMLInputElement);
      expect(input().placeholder).toBe('Search spaces or enter URL…');
      expect(input().getAttribute('data-autofocus')).toBe('true');
      expect(content().querySelector('.new-tab-picker-search-row .voice-input-button')).toBeTruthy();
      // Non-persistent dropdown: surface is not in the document until open().
      expect(document.getElementById('new-tab-picker')).toBeNull();
      picker.open();
      expect(document.getElementById('new-tab-picker')).not.toBeNull();
    });

    test('open() shows the dropdown, clears the input and renders spaces', () => {
      input().value = 'stale';
      picker.open();
      expect(picker.isOpen()).toBe(true);
      expect(input().value).toBe('');
      expect(cards().length).toBe(4);
    });

    test('close() hides the dropdown', () => {
      picker.open();
      picker.close();
      expect(picker.isOpen()).toBe(false);
    });

    test('toggle() opens when closed and closes when open', () => {
      expect(picker.isOpen()).toBe(false);
      picker.toggle();
      expect(picker.isOpen()).toBe(true);
      picker.toggle();
      expect(picker.isOpen()).toBe(false);
    });
  });

  describe('space rendering & grouping', () => {
    test('groups spaces under their type headers in the configured order', () => {
      picker.open();
      expect(groupTitles()).toEqual(['AI Services', 'Web Pages', 'Local']);
    });

    test('a card whose id is in openTabs gets the is-open class and "already open" title', () => {
      picker.open();
      const open = cards().find((c) => c.getAttribute('data-space-id') === 's2');
      expect(open.classList.contains('is-open')).toBe(true);
      const name = open.querySelector('.new-tab-picker-card-name');
      expect(name.title).toBe('Claude — already open');
      const closed = cards().find((c) => c.getAttribute('data-space-id') === 's1');
      expect(closed.classList.contains('is-open')).toBe(false);
    });

    test('card icon is the uppercased first letter of the space name', () => {
      picker.open();
      const card = cards().find((c) => c.getAttribute('data-space-id') === 's1');
      expect(card.querySelector('.new-tab-picker-card-icon').textContent).toBe('C');
    });

    test('space color is applied as the card left border', () => {
      picker.open();
      const card = cards().find((c) => c.getAttribute('data-space-id') === 's1');
      expect(card.style.borderLeftColor).toBe('rgb(16, 163, 127)');
    });

    test('spaces without a name are skipped', () => {
      state._config = { spaces: { ...SPACES, bad: { url: 'https://x', type: 'web-page' } }, settings: {} };
      picker.open();
      const ids = cards().map((c) => c.getAttribute('data-space-id'));
      expect(ids).not.toContain('bad');
      expect(ids).toHaveLength(4);
    });
  });

  describe('search / filtering', () => {
    test('fuzzy query narrows the rendered cards', () => {
      picker.open();
      setSearch('claude');
      const ids = cards().map((c) => c.getAttribute('data-space-id'));
      expect(ids).toEqual(['s2']);
    });

    test('a non-matching query shows the empty state', () => {
      picker.open();
      setSearch('zzzznotathing');
      expect(cards()).toHaveLength(0);
      const empty = document.querySelector('.new-tab-picker-empty');
      expect(empty).not.toBeNull();
      expect(empty.textContent).toBe('No matching spaces');
    });

    test('clearing the query restores all spaces and removes the empty state', () => {
      picker.open();
      setSearch('zzz');
      expect(document.querySelector('.new-tab-picker-empty')).not.toBeNull();
      setSearch('');
      expect(cards()).toHaveLength(4);
      expect(document.querySelector('.new-tab-picker-empty')).toBeNull();
    });
  });

  describe('URL detection', () => {
    test('a URL-ish input shows the navigate option', () => {
      picker.open();
      setSearch('example.com');
      expect(urlOption().classList.contains('visible')).toBe(true);
      expect(urlOption().textContent).toBe('Navigate to https://example.com');
    });

    test('a plain word does not show the navigate option', () => {
      picker.open();
      setSearch('hello world');
      expect(urlOption().classList.contains('visible')).toBe(false);
    });

    test('localhost is treated as a URL', () => {
      picker.open();
      setSearch('localhost:3000');
      expect(urlOption().classList.contains('visible')).toBe(true);
      expect(urlOption().textContent).toBe('Navigate to http://localhost:3000');
    });
  });

  describe('ask-the-agent option', () => {
    test('a sentence-like query that is not a URL offers "Ask the agent"', () => {
      picker.open();
      setSearch('what is the capital of France');
      expect(askOption().style.display).toBe('');
      expect(askOption().textContent).toBe('Ask the agent: what is the capital of France');
    });

    test('the ask option is suppressed when the input parses as a URL', () => {
      picker.open();
      setSearch('example.com');
      expect(urlOption().classList.contains('visible')).toBe(true);
      expect(askOption().style.display).toBe('none');
    });

    test('a sub-3-char query offers neither option', () => {
      picker.open();
      setSearch('ab');
      expect(askOption().style.display).toBe('none');
      expect(urlOption().classList.contains('visible')).toBe(false);
    });
  });

  describe('keyboard navigation', () => {
    test('ArrowDown highlights the URL option first when a URL is present', () => {
      picker.open();
      setSearch('example.com');
      key('ArrowDown');
      expect(urlOption().classList.contains('highlighted')).toBe(true);
    });

    test('ArrowDown then ArrowUp wraps highlight back to the URL option', () => {
      picker.open();
      setSearch('example.com'); // 1 url option + 0 ask + 0 cards => total 1
      key('ArrowDown');
      expect(urlOption().classList.contains('highlighted')).toBe(true);
      key('ArrowUp');
      expect(urlOption().classList.contains('highlighted')).toBe(true);
    });

    test('ArrowDown moves the highlight onto the first card when no url/ask', () => {
      picker.open();
      // 2-char query: below the 3-char ask threshold and not URL-ish, so the
      // only navigable items are cards (no url/ask competing for index 0).
      setSearch('cl');
      expect(cards().length).toBeGreaterThan(0);
      expect(askOption().style.display).toBe('none');
      expect(urlOption().classList.contains('visible')).toBe(false);
      key('ArrowDown');
      const card = cards()[0];
      expect(card.classList.contains('highlighted')).toBe(true);
    });
  });

  describe('actions: opening a space', () => {
    test('clicking a not-open card calls spaceManager.openTab and closes', () => {
      picker.open();
      const card = cards().find((c) => c.getAttribute('data-space-id') === 's1');
      card.click();
      expect(spaceManager.openTab).toHaveBeenCalledWith('s1');
      expect(spaceManager.focusTab).not.toHaveBeenCalled();
      expect(picker.isOpen()).toBe(false);
    });

    test('clicking an already-open card calls focusTab instead of openTab', () => {
      picker.open();
      const card = cards().find((c) => c.getAttribute('data-space-id') === 's2');
      card.click();
      expect(spaceManager.focusTab).toHaveBeenCalledWith('s2');
      expect(spaceManager.openTab).not.toHaveBeenCalled();
    });

    test('Enter with no highlight opens the only card when there is no url/ask', () => {
      picker.open();
      setSearch('cl'); // -> s2 only; under the 3-char ask threshold
      key('Enter');
      expect(spaceManager.focusTab).toHaveBeenCalledWith('s2'); // s2 is in openTabs
      expect(spaceManager.openTab).not.toHaveBeenCalled();
    });

    test('Enter on a card highlighted via ArrowDown opens that exact space', () => {
      picker.open();
      setSearch('chat'); // matches ChatGPT (s1) only; 4 chars -> ask also offered
      // Skip past the ask option to land on the card, then activate it.
      key('ArrowDown'); // ask
      key('ArrowDown'); // first card
      const highlighted = cards().find((c) => c.classList.contains('highlighted'));
      expect(highlighted.getAttribute('data-space-id')).toBe('s1');
      key('Enter');
      expect(spaceManager.openTab).toHaveBeenCalledWith('s1');
    });

    test('bare Enter prefers ask-the-agent over the first card for a 3+ char non-URL query', () => {
      picker.open();
      setSearch('claude'); // fuzzy-matches s2 AND is >=3 chars -> ask offered
      expect(askOption().style.display).toBe('');
      key('Enter');
      // Designed behavior: ask wins over the first card on a bare Enter.
      expect(openWithTaskSpy).toHaveBeenCalledWith('claude', { scope: 'global', userSend: true });
      expect(spaceManager.openTab).not.toHaveBeenCalled();
      expect(spaceManager.focusTab).not.toHaveBeenCalled();
    });
  });

  describe('actions: navigating to a URL', () => {
    test('clicking the navigate option opens an ad-hoc tab with the resolved URL', () => {
      picker.open();
      setSearch('example.com');
      urlOption().click();
      expect(spaceManager.openAdHocTab).toHaveBeenCalledWith('https://example.com');
      expect(picker.isOpen()).toBe(false);
    });

    test('Enter with no highlight prefers the URL over a matching card', () => {
      picker.open();
      // "example" fuzzy-matches s3 (Example Wiki) AND parses URL-ish via the .org
      setSearch('example.org');
      key('Enter');
      expect(spaceManager.openAdHocTab).toHaveBeenCalledWith('https://example.org');
      expect(spaceManager.openTab).not.toHaveBeenCalled();
    });
  });

  describe('actions: ask the agent', () => {
    test('clicking the ask option calls AgentPanel.openWithTask with the exact text + global scope', () => {
      picker.open();
      setSearch('summarize my open tabs');
      askOption().click();
      expect(openWithTaskSpy).toHaveBeenCalledWith('summarize my open tabs', { scope: 'global', userSend: true });
      expect(picker.isOpen()).toBe(false);
    });

    test('Cmd/Ctrl+Enter routes straight to ask-the-agent regardless of highlight', () => {
      picker.open();
      setSearch('explain the retry logic');
      key('Enter', { metaKey: true });
      expect(openWithTaskSpy).toHaveBeenCalledWith('explain the retry logic', { scope: 'global', userSend: true });
    });

    test('Cmd+Enter does nothing when there is no ask text (input parses as URL)', () => {
      picker.open();
      setSearch('example.com');
      key('Enter', { ctrlKey: true });
      expect(openWithTaskSpy).not.toHaveBeenCalled();
      // Falls through to normal Enter handling -> URL navigation.
      expect(spaceManager.openAdHocTab).toHaveBeenCalledWith('https://example.com');
    });
  });

  // The address-bar dropdown (OmniboxSuggest) on the picker's input. Lookups
  // reach main through ipcRenderer.invoke, the mocked boundary; search
  // settings come from the live accessors passed to initialize().
  describe('address-bar suggestions', () => {
    const { ipcRenderer } = require('electron');
    let live;

    const suggestRows = () => Array.from(content().querySelectorAll('.omnibox-row'));
    const suggestLabels = () => suggestRows().map((r) => r.querySelector('.omnibox-label').textContent);
    const suggestList = () => content().querySelector('.omnibox-list');
    const channels = () => ipcRenderer.invoke.mock.calls.map((c) => c[0]);
    async function typeAndSettle(text) {
      setSearch(text);
      jest.advanceTimersByTime(200);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }

    beforeEach(() => {
      jest.useFakeTimers();
      live = {
        settings: { searchSuggestionsEnabled: true, addressBarSearchHistory: true },
        engine: 'google',
        customEngines: [],
      };
      ipcRenderer.invoke.mockReset();
      ipcRenderer.invoke.mockImplementation((channel) => {
        if (channel === 'bookmarks:search') return Promise.resolve([]);
        if (channel === 'history:search') return Promise.resolve([{ title: 'Electron docs', url: 'https://electronjs.org/docs' }]);
        if (channel === 'search:suggest') return Promise.resolve({ ok: true, suggestions: ['electron app'] });
        return Promise.reject(new Error(`unexpected channel ${channel}`));
      });
      picker.initialize({
        state,
        spaceManager,
        getSettings: () => live.settings,
        getSearchEngine: () => live.engine,
        getCustomEngines: () => live.customEngines,
      });
      picker.open();
    });

    afterEach(() => {
      if (picker.isOpen()) picker.close();
      jest.useRealTimers();
    });

    test('history and engine suggestions appear under the picker input', async () => {
      await typeAndSettle('electron');
      expect(suggestLabels()).toEqual(['Electron docs', 'electron app']);
      expect(suggestList().hidden).toBe(false);
      // The picker's own rows stay rendered alongside the suggestions.
      expect(askOption().style.display).toBe('');
    });

    // The suggestion list sits in the flow above these rows: a press that blurs
    // the input closes it, the rows jump up before mouseup, and the click lands
    // on whatever slid under the pointer.
    test.each([
      ['navigate row', () => content().querySelector('.new-tab-picker-url-option')],
      ['ask row', () => askOption()],
      ['space card', () => content().querySelector('.new-tab-picker-card')],
    ])('pressing the %s keeps focus in the input so the list does not collapse mid-click', async (_name, row) => {
      await typeAndSettle('claude');
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      row().dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      expect(suggestList().hidden).toBe(false);
    });

    test('pressing inside the input itself still places the caret', async () => {
      await typeAndSettle('electron');
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      content().querySelector('.new-tab-picker-search').dispatchEvent(press);
      expect(press.defaultPrevented).toBe(false);
    });

    test('a picked history row opens that page in a new tab', async () => {
      await typeAndSettle('electron');
      key('ArrowDown');
      key('Enter');
      expect(spaceManager.openAdHocTab).toHaveBeenCalledWith('https://electronjs.org/docs');
      expect(openWithTaskSpy).not.toHaveBeenCalled();
      expect(picker.isOpen()).toBe(false);
    });

    test('a picked suggestion searches the live engine, even one chosen after initialize', async () => {
      live.customEngines = [{ id: 'mine', name: 'Mine', url: 'https://s.example/find?q=%s' }];
      live.engine = 'mine';
      await typeAndSettle('electron');
      suggestRows()[1].click();
      expect(spaceManager.openAdHocTab).toHaveBeenCalledWith('https://s.example/find?q=electron%20app');
      expect(picker.isOpen()).toBe(false);
    });

    test('suggestion toggles apply without re-initializing the picker', async () => {
      live.settings = { searchSuggestionsEnabled: false, addressBarSearchHistory: true };
      await typeAndSettle('electron');
      expect(channels()).not.toContain('search:suggest');
      expect(suggestLabels()).toEqual(['Electron docs']);

      ipcRenderer.invoke.mockClear();
      live.settings = { searchSuggestionsEnabled: true, addressBarSearchHistory: false };
      await typeAndSettle('electrons');
      expect(channels()).toEqual(['search:suggest']);
      expect(suggestLabels()).toEqual(['electron app']);
    });

    test('the input is the only combobox and controls both the suggestion list and the picker results', async () => {
      expect(content().querySelectorAll('[role="combobox"]')).toHaveLength(1);
      const controls = input().getAttribute('aria-controls').split(/\s+/);
      expect(controls).toEqual([suggestList().id, content().querySelector('.new-tab-picker-groups').id]);
      for (const id of controls) expect(content().querySelector(`#${id}`)).not.toBeNull();
      await typeAndSettle('electron');
      expect(input().getAttribute('aria-expanded')).toBe('true');
    });

    test('while suggestions are open they own the arrows; the picker highlight does not move', async () => {
      await typeAndSettle('electron');
      key('ArrowDown');
      expect(input().getAttribute('aria-activedescendant')).toBe(suggestRows()[0].id);
      expect(content().querySelectorAll('.highlighted')).toHaveLength(0);
    });

    test('a suggestion list showing only a note leaves the arrows to the picker rows', async () => {
      ipcRenderer.invoke.mockImplementation((channel) => {
        if (channel === 'search:suggest') return new Promise(() => {});
        return Promise.resolve([]);
      });
      await typeAndSettle('electron');
      expect(suggestList().hidden).toBe(false);
      expect(suggestRows()).toHaveLength(0);
      key('ArrowDown');
      expect(askOption().classList.contains('highlighted')).toBe(true);
    });

    test('Escape closes only the suggestions; the picker rows then take the arrows', async () => {
      await typeAndSettle('electron');
      key('Escape');
      expect(suggestList().hidden).toBe(true);
      expect(picker.isOpen()).toBe(true);
      key('ArrowDown');
      expect(askOption().classList.contains('highlighted')).toBe(true);
      key('Escape');
      expect(picker.isOpen()).toBe(false);
    });

    test('Enter with no suggestion highlighted falls through to the picker action', async () => {
      await typeAndSettle('electron');
      key('Enter');
      expect(openWithTaskSpy).toHaveBeenCalledWith('electron', { scope: 'global', userSend: true });
      expect(spaceManager.openAdHocTab).not.toHaveBeenCalled();
    });

    test('Cmd/Ctrl+Enter asks the agent even with a suggestion highlighted', async () => {
      await typeAndSettle('electron');
      key('ArrowDown');
      key('Enter', { metaKey: true });
      expect(openWithTaskSpy).toHaveBeenCalledWith('electron', { scope: 'global', userSend: true });
      expect(spaceManager.openAdHocTab).not.toHaveBeenCalled();
    });

    test('closing the picker drops a lookup still in flight', async () => {
      setSearch('electron');
      picker.close();
      jest.advanceTimersByTime(200);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });
  });

  describe('guard rails', () => {
    test('open() before initialize-dependent state is safe and renders no cards for empty config', () => {
      state._config = {};
      picker.open();
      expect(cards()).toHaveLength(0);
    });

    test('clicking a space with no spaceManager wired does not throw', () => {
      picker.open();
      const card = cards()[0];
      // Simulate a missing dependency by nulling the injected manager.
      picker._spaceManager = null;
      expect(() => card.click()).not.toThrow();
      // Restore so afterEach close() path is clean.
      picker._spaceManager = spaceManager;
    });
  });
});
