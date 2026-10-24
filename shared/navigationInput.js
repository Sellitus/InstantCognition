const NAVIGATION_ACTIONS = {
  BACK: 'back',
  FORWARD: 'forward',
};

// W3C / Chromium standard mouse-button numbering. This is spec-defined and
// platform-independent — Chromium does NOT renumber side buttons on macOS:
//   button 3 = X1 = "Browser Back"
//   button 4 = X2 = "Browser Forward"
//
// DO NOT re-invert these to chase a "reversed on macOS" report. This mapping
// oscillated for years: commit 23f2145 ("Fix back and forward mouse buttons
// on macos") flipped it, breaking every standard mouse; it was reverted,
// re-applied, and reverted again. Every one of those edits was misdirected.
// On macOS the physical side buttons are NOT delivered here at all — common
// mouse drivers translate them into Electron's native window `swipe` event,
// which is handled by getNavigationActionForSwipe() below. THAT function is
// where the macOS mouse-button direction actually gets decided; fix reversal
// reports there, not here. These DOM/Electron values are W3C-standard and
// correct. The navigationInput unit test pins the literal values for both
// this and the swipe mapping as an anti-oscillation guard — if it goes red,
// someone is reintroducing the historical inversion.
const DOM_MOUSE_BUTTONS = {
  BACK: 3,
  FORWARD: 4,
};

const MENU_ACCELERATORS = {
  BACK: 'CmdOrCtrl+[',
  FORWARD: 'CmdOrCtrl+]',
};

function getNavigationActionForDomMouseButton(button) {
  if (button === DOM_MOUSE_BUTTONS.BACK) return NAVIGATION_ACTIONS.BACK;
  if (button === DOM_MOUSE_BUTTONS.FORWARD) return NAVIGATION_ACTIONS.FORWARD;
  return null;
}

function getNavigationActionForElectronMouseButton(button) {
  // Electron's `before-input-event` reports 'back'/'forward' matching the
  // physical button by name — no inversion. See the anti-oscillation note on
  // DOM_MOUSE_BUTTONS above before changing this.
  if (button === 'back') return NAVIGATION_ACTIONS.BACK;
  if (button === 'forward') return NAVIGATION_ACTIONS.FORWARD;
  return null;
}

function getNavigationActionForKeyInput(input = {}) {
  const metaPressed = Boolean(input.metaKey ?? input.meta);
  const ctrlPressed = Boolean(input.ctrlKey ?? input.control);
  const shiftPressed = Boolean(input.shiftKey ?? input.shift);
  const altPressed = Boolean(input.altKey ?? input.alt);

  if (input.key === 'BrowserBack') return NAVIGATION_ACTIONS.BACK;
  if (input.key === 'BrowserForward') return NAVIGATION_ACTIONS.FORWARD;

  if ((metaPressed || ctrlPressed) && !shiftPressed && !altPressed) {
    if (input.key === '[') return NAVIGATION_ACTIONS.BACK;
    if (input.key === ']') return NAVIGATION_ACTIONS.FORWARD;
  }

  return null;
}

// *** THIS is where the recurring "back/forward mouse buttons are reversed on
// macOS" bug actually lives — NOT in DOM_MOUSE_BUTTONS or the Electron-string
// helper above (those are W3C-correct; do not touch them to chase this). ***
//
// On macOS, common mouse drivers/utilities translate the physical side
// buttons into Electron's native window `swipe` event rather than into DOM
// button 3/4 or Electron 'back'/'forward'. Empirically measured on the
// target machine (instrumented capture, repeated and consistent):
//   physical BACK  button -> swipe direction 'left'
//   physical FORWARD button -> swipe direction 'right'
// so the mapping below is by the PHYSICAL button, matching that reality.
//
// Tradeoff: a native macOS trackpad 3-finger swipe uses the opposite
// (Safari) convention (swipe right = back) and shares this same event with
// no in-event discriminator. That is acceptable here because trackpad
// swipe-to-navigate does not fire any path on this setup (the preload
// wheel/gesture thresholds are unreachable and the native event does not
// emit for the trackpad) — there is no working behavior to regress. If
// trackpad swipe is ever made functional, this becomes a genuine
// source-collision that needs a discriminator or a config toggle, NOT a
// flip of these two lines (flipping is exactly what made this bug recur).
function getNavigationActionForSwipe(direction) {
  if (direction === 'left') return NAVIGATION_ACTIONS.BACK;
  if (direction === 'right') return NAVIGATION_ACTIONS.FORWARD;
  return null;
}

module.exports = {
  DOM_MOUSE_BUTTONS,
  MENU_ACCELERATORS,
  NAVIGATION_ACTIONS,
  getNavigationActionForDomMouseButton,
  getNavigationActionForElectronMouseButton,
  getNavigationActionForKeyInput,
  getNavigationActionForSwipe,
};
