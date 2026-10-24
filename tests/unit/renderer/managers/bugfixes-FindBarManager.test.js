const AppState = require('../../../../renderer/core/AppState');
const NavigationManager = require('../../../../renderer/managers/NavigationManager');
const FindBarManager = require('../../../../renderer/managers/FindBarManager');

describe('FindBarManager bug fixes', () => {
  let state;
  let nav;
  let findBar;

  beforeEach(() => {
    jest.useFakeTimers();
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

  // ================================================================
  // HIGH #2: FindBar stuck visible when no CSS animation fires
  // Spec: close() must always finish — even if `animationend` never
  // fires the find surface must eventually be detached. The unified
  // Dropdown controller now owns this invariant via a fallback timer.
  // ================================================================
  describe('HIGH: FindBar stuck visible without CSS animation', () => {
    test('close() detaches surface via fallback timer when animationend never fires', () => {
      findBar.open();
      expect(findBar._dropdown.isOpen()).toBe(true);
      expect(document.getElementById('find-bar')).not.toBeNull();
      expect(state.get('findBarVisible')).toBe(true);

      findBar.close();

      // State flips immediately.
      expect(state.get('findBarVisible')).toBe(false);

      // Surface still mounted while animation is pending.
      expect(document.getElementById('find-bar')).not.toBeNull();

      // Run the Dropdown fallback timer (320ms cap) — surface must detach.
      jest.advanceTimersByTime(500);

      expect(document.getElementById('find-bar')).toBeNull();
      expect(findBar._dropdown.isOpen()).toBe(false);
    });

    test('close() detaches surface immediately when animationend fires', () => {
      findBar.open();
      const surface = findBar._dropdown.el;
      findBar.close();

      // animationend on the surface drives the close to completion.
      surface.dispatchEvent(new Event('animationend'));

      expect(findBar._dropdown.isOpen()).toBe(false);
      expect(document.getElementById('find-bar')).toBeNull();

      // Fallback firing later is harmless — already detached.
      jest.advanceTimersByTime(500);
      expect(document.getElementById('find-bar')).toBeNull();
    });

    test('close() short-circuits when body.no-animations is set', () => {
      document.body.classList.add('no-animations');
      findBar.open();
      findBar.close();

      // No animation path: close finishes synchronously.
      expect(findBar._dropdown.isOpen()).toBe(false);
      expect(document.getElementById('find-bar')).toBeNull();
    });
  });
});
