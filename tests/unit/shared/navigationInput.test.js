const {
  DOM_MOUSE_BUTTONS,
  MENU_ACCELERATORS,
  NAVIGATION_ACTIONS,
  getNavigationActionForDomMouseButton,
  getNavigationActionForElectronMouseButton,
  getNavigationActionForKeyInput,
  getNavigationActionForSwipe,
} = require('../../../shared/navigationInput');

describe('navigationInput helpers', () => {
  // ANTI-OSCILLATION GUARD. The DOM/Electron back-forward mapping has been
  // inverted and reverted repeatedly (see commit 23f2145 and the note in
  // shared/navigationInput.js). These assertions deliberately use LITERAL
  // button values — not the DOM_MOUSE_BUTTONS constants, which would make the
  // test circular and pass regardless of the value. W3C/Chromium spec:
  // button 3 = Browser Back, button 4 = Browser Forward, platform-independent.
  // If these go red, someone is reintroducing the inversion bug — fix the
  // mapping, not the test.
  test('maps DOM mouse buttons to W3C-standard navigation actions', () => {
    expect(getNavigationActionForDomMouseButton(3)).toBe(NAVIGATION_ACTIONS.BACK);
    expect(getNavigationActionForDomMouseButton(4)).toBe(NAVIGATION_ACTIONS.FORWARD);
    expect(DOM_MOUSE_BUTTONS.BACK).toBe(3);
    expect(DOM_MOUSE_BUTTONS.FORWARD).toBe(4);
    expect(getNavigationActionForDomMouseButton(0)).toBeNull();
  });

  test('maps Electron mouse button strings to matching navigation actions (no inversion)', () => {
    expect(getNavigationActionForElectronMouseButton('back')).toBe(NAVIGATION_ACTIONS.BACK);
    expect(getNavigationActionForElectronMouseButton('forward')).toBe(NAVIGATION_ACTIONS.FORWARD);
    expect(getNavigationActionForElectronMouseButton('left')).toBeNull();
  });

  test('maps BrowserBack/BrowserForward keys and Cmd+[ / Cmd+] correctly', () => {
    expect(getNavigationActionForKeyInput({ key: 'BrowserBack' })).toBe(NAVIGATION_ACTIONS.BACK);
    expect(getNavigationActionForKeyInput({ key: 'BrowserForward' })).toBe(NAVIGATION_ACTIONS.FORWARD);
    expect(getNavigationActionForKeyInput({ key: '[', meta: true })).toBe(NAVIGATION_ACTIONS.BACK);
    expect(getNavigationActionForKeyInput({ key: ']', meta: true })).toBe(NAVIGATION_ACTIONS.FORWARD);
    expect(getNavigationActionForKeyInput({ key: '[', meta: true, shift: true })).toBeNull();
  });

  test('maps Ctrl+[ / Ctrl+] correctly for DOM keyboard events', () => {
    expect(getNavigationActionForKeyInput({ key: '[', ctrlKey: true })).toBe(NAVIGATION_ACTIONS.BACK);
    expect(getNavigationActionForKeyInput({ key: ']', ctrlKey: true })).toBe(NAVIGATION_ACTIONS.FORWARD);
    expect(getNavigationActionForKeyInput({ key: ']', ctrlKey: true, altKey: true })).toBeNull();
  });

  test('maps Control+[ / Control+] correctly for Electron before-input events', () => {
    expect(getNavigationActionForKeyInput({ key: '[', control: true })).toBe(NAVIGATION_ACTIONS.BACK);
    expect(getNavigationActionForKeyInput({ key: ']', control: true })).toBe(NAVIGATION_ACTIONS.FORWARD);
    expect(getNavigationActionForKeyInput({ key: '[', control: true, shift: true })).toBeNull();
  });

  // ANTI-OSCILLATION GUARD — the real one. On macOS the physical mouse side
  // buttons are delivered as Electron `swipe` events (driver translation),
  // so THIS mapping governs back/forward for the mouse on macOS. Empirically
  // measured on the target machine (repeated, consistent instrumented
  // capture): physical BACK button -> 'left', physical FORWARD -> 'right'.
  // The prior expectation ('right'->BACK, 'left'->FORWARD) encoded the
  // Safari-trackpad convention and was the source of the recurring
  // "mouse buttons reversed on macOS" bug. If these flip, the bug is back —
  // fix the mapping, not the test. See getNavigationActionForSwipe() note.
  test('maps swipe directions to match macOS mouse side buttons (BACK=left, FORWARD=right)', () => {
    expect(getNavigationActionForSwipe('left')).toBe(NAVIGATION_ACTIONS.BACK);
    expect(getNavigationActionForSwipe('right')).toBe(NAVIGATION_ACTIONS.FORWARD);
    expect(getNavigationActionForSwipe('up')).toBeNull();
  });

  test('exports hidden menu accelerators with the correct direction', () => {
    expect(MENU_ACCELERATORS.BACK).toBe('CmdOrCtrl+[');
    expect(MENU_ACCELERATORS.FORWARD).toBe('CmdOrCtrl+]');
  });
});
