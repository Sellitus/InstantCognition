const AppState = require('../../../../renderer/core/AppState');
const NavigationManager = require('../../../../renderer/managers/NavigationManager');
const FindBarManager = require('../../../../renderer/managers/FindBarManager');

describe('FindBarManager', () => {
  let state;
  let nav;
  let findBar;

  beforeEach(() => {
    jest.useFakeTimers();
    // Skip Dropdown's animation lifecycle so open/close are synchronous.
    document.body.classList.add('no-animations');
    state = new AppState();
    nav = new NavigationManager(state);
    findBar = new FindBarManager(state, nav);

    const main = document.createElement('div');
    main.id = 'main-content';
    document.body.appendChild(main);
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.classList.remove('no-animations');
    document.body.textContent = '';
  });

  test('toggle() creates find bar DOM elements on first call', () => {
    findBar.toggle();
    expect(document.getElementById('find-bar')).not.toBeNull();
  });

  test('toggle() shows bar if hidden, hides if visible', () => {
    findBar.toggle();
    expect(state.get('findBarVisible')).toBe(true);
    expect(findBar._dropdown.isOpen()).toBe(true);

    findBar.toggle();
    expect(state.get('findBarVisible')).toBe(false);
    expect(findBar._dropdown.isOpen()).toBe(false);
    expect(document.getElementById('find-bar')).toBeNull();
  });

  test('open() always shows bar (does not toggle closed)', () => {
    findBar.open();
    expect(state.get('findBarVisible')).toBe(true);

    findBar.open();
    expect(state.get('findBarVisible')).toBe(true);
    expect(findBar._dropdown.isOpen()).toBe(true);
  });

  test('close() hides bar and clears term', () => {
    findBar.toggle();
    findBar._currentFindTerm = 'test';
    findBar.close();

    expect(state.get('findBarVisible')).toBe(false);
    expect(findBar._currentFindTerm).toBe('');
    expect(findBar._dropdown.isOpen()).toBe(false);
  });

  test('close() clears find input value', () => {
    findBar.toggle();
    findBar._findInput.value = 'search term';
    findBar.close();
    expect(findBar._findInput.value).toBe('');
  });

  test('close() calls stopFindInPage on targetWebview, not active', () => {
    const targetWv = { findInPage: jest.fn().mockReturnValue(1), stopFindInPage: jest.fn(), isConnected: true };
    const otherWv = { findInPage: jest.fn(), stopFindInPage: jest.fn(), isConnected: true };

    nav.setActiveWebview(targetWv);
    findBar.open();
    findBar._search('hello');
    jest.runAllTimers();

    nav.setActiveWebview(otherWv);
    findBar.close();

    expect(targetWv.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(otherWv.stopFindInPage).not.toHaveBeenCalled();
  });

  test('close() resets targetWebview and requestId', () => {
    findBar.open();
    findBar._targetWebview = { stopFindInPage: jest.fn() };
    findBar._requestId = 42;
    findBar.close();

    expect(findBar._targetWebview).toBeNull();
    expect(findBar._requestId).toBeNull();
  });

  test('findNext() calls findInPage on target webview', () => {
    const mockWv = { findInPage: jest.fn().mockReturnValue(1), isConnected: true };
    nav.setActiveWebview(mockWv);
    findBar.open();
    findBar._targetWebview = mockWv;
    findBar._currentFindTerm = 'hello';

    findBar.findNext();
    expect(mockWv.findInPage).toHaveBeenCalledWith('hello', { forward: true, findNext: true });
  });

  test('findPrev() searches backward', () => {
    const mockWv = { findInPage: jest.fn().mockReturnValue(1), isConnected: true };
    nav.setActiveWebview(mockWv);
    findBar.open();
    findBar._targetWebview = mockWv;
    findBar._currentFindTerm = 'hello';

    findBar.findPrev();
    expect(mockWv.findInPage).toHaveBeenCalledWith('hello', { forward: false, findNext: true });
  });

  test('findNext() does nothing without a target webview', () => {
    findBar._currentFindTerm = 'hello';
    findBar._targetWebview = null;
    expect(() => findBar.findNext()).not.toThrow();
  });

  test('handleFoundInPage shows count for matching webview and requestId', () => {
    findBar.open();
    const mockWv = { findInPage: jest.fn().mockReturnValue(5), isConnected: true };
    findBar._targetWebview = mockWv;
    findBar._requestId = 5;

    findBar.handleFoundInPage(mockWv, {
      requestId: 5,
      activeMatchOrdinal: 3,
      matches: 10,
      finalUpdate: true,
    });

    expect(findBar._resultsDisplay.textContent).toBe('3/10');
  });

  test('handleFoundInPage ignores events from wrong webview', () => {
    findBar.open();
    const targetWv = { isConnected: true };
    const otherWv = { isConnected: true };
    findBar._targetWebview = targetWv;
    findBar._requestId = 1;

    findBar.handleFoundInPage(otherWv, {
      requestId: 1,
      activeMatchOrdinal: 1,
      matches: 5,
      finalUpdate: true,
    });

    expect(findBar._resultsDisplay.textContent).toBe('');
  });

  test('handleFoundInPage ignores stale requestId', () => {
    findBar.open();
    const mockWv = { isConnected: true };
    findBar._targetWebview = mockWv;
    findBar._requestId = 5;

    findBar.handleFoundInPage(mockWv, {
      requestId: 3,
      activeMatchOrdinal: 1,
      matches: 5,
      finalUpdate: true,
    });

    expect(findBar._resultsDisplay.textContent).toBe('');
  });

  test('handleFoundInPage ignores non-final updates', () => {
    findBar.open();
    const mockWv = { isConnected: true };
    findBar._targetWebview = mockWv;
    findBar._requestId = 5;

    findBar.handleFoundInPage(mockWv, {
      requestId: 5,
      activeMatchOrdinal: 1,
      matches: 5,
      finalUpdate: false,
    });

    expect(findBar._resultsDisplay.textContent).toBe('');
  });

  test('handleFoundInPage shows "No results" when 0 matches', () => {
    findBar.open();
    const mockWv = { isConnected: true };
    findBar._targetWebview = mockWv;
    findBar._requestId = 5;
    findBar._currentFindTerm = 'xyz';

    findBar.handleFoundInPage(mockWv, {
      requestId: 5,
      activeMatchOrdinal: 0,
      matches: 0,
      finalUpdate: true,
    });

    expect(findBar._resultsDisplay.textContent).toBe('No results');
  });

  test('_search clears highlights when term is empty', () => {
    const mockWv = { findInPage: jest.fn().mockReturnValue(1), stopFindInPage: jest.fn(), isConnected: true };
    nav.setActiveWebview(mockWv);
    findBar.open();
    findBar._search('hello');
    jest.runAllTimers();
    expect(mockWv.findInPage).toHaveBeenCalled();

    findBar._search('');
    expect(mockWv.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(findBar._requestId).toBeNull();
  });

  test('Escape key in input closes find bar (via Dropdown controller)', () => {
    findBar.toggle();
    const closeSpy = jest.spyOn(findBar, 'close');

    // Dropdown's Esc handler is registered on document with useCapture=true,
    // so the key event must bubble to be observed.
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    findBar._findInput.dispatchEvent(event);

    // Dropdown.close() runs; FindBar's onClose callback syncs state.
    expect(state.get('findBarVisible')).toBe(false);
    closeSpy.mockRestore();
  });

  test('Enter key in input calls findNext', () => {
    findBar.toggle();
    const nextSpy = jest.spyOn(findBar, 'findNext');

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    findBar._findInput.dispatchEvent(event);

    expect(nextSpy).toHaveBeenCalled();
    nextSpy.mockRestore();
  });

  test('Shift+Enter key calls findPrev', () => {
    findBar.toggle();
    const prevSpy = jest.spyOn(findBar, 'findPrev');

    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true });
    findBar._findInput.dispatchEvent(event);

    expect(prevSpy).toHaveBeenCalled();
    prevSpy.mockRestore();
  });

  test('buttons have type="button" and aria-labels', () => {
    findBar.open();
    const buttons = findBar._content.querySelectorAll('button');
    expect(buttons.length).toBeGreaterThan(0);
    buttons.forEach((btn) => {
      expect(btn.type).toBe('button');
      expect(btn.getAttribute('aria-label')).toBeTruthy();
    });
  });
});
