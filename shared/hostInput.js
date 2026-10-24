// Host input handling shared by the webview preload and the app shell:
// trackpad swipes and mouse side buttons navigate back/forward, and a few
// keys (Escape, Cmd/Ctrl+R/Q/0-9, F1/F2, Cmd/Ctrl+Shift+W/S/D) reach main
// whichever of the two has focus.
const {
  NAVIGATION_ACTIONS,
  getNavigationActionForDomMouseButton,
  getNavigationActionForKeyInput,
} = require('./navigationInput');

// Constants for gesture detection
const GESTURE_THRESHOLD = 750; // Minimum distance in pixels - requires deliberate swipe
const GESTURE_MAX_TIME = 400; // Maximum time in milliseconds for a valid gesture
const GESTURE_DIRECTION_THRESHOLD = 2.0; // Ratio of horizontal to vertical movement - must be clearly horizontal

/**
 * @param {(channel: string, ...args: any[]) => void} send  ipcRenderer.send, or the shell's bridge to it
 * @param {Window} win
 */
function install(send, win) {
  const throttledIPC = new Map();
  function throttleIPCSend(channel, wait = 16) {
    if (throttledIPC.has(channel)) return;
    send(channel);
    throttledIPC.set(channel, true);
    setTimeout(() => throttledIPC.delete(channel), wait);
  }

  let gestureState = {
    startTime: 0,
    startX: 0,
    startY: 0,
    deltaX: 0,
    isActive: false,
    hasNavigated: false,
  };

  win.addEventListener(
    'wheel',
    (event) => {
      if (!event.isTrusted) return;

      if (!gestureState.isActive && !gestureState.hasNavigated) {
        gestureState = {
          startTime: Date.now(),
          startX: event.pageX,
          startY: event.pageY,
          deltaX: 0,
          isActive: true,
          hasNavigated: false,
        };
      }

      win.requestAnimationFrame(() => {
        handleGestureFrame(event, gestureState);
      });
    },
    { passive: true }
  );

  function handleGestureFrame(event, state) {
    state.deltaX += event.deltaX;

    const gestureTime = Date.now() - state.startTime;
    const horizontalDistance = Math.abs(state.deltaX);
    const verticalDistance = Math.abs(event.pageY - state.startY);

    const isHorizontalGesture = horizontalDistance > verticalDistance * GESTURE_DIRECTION_THRESHOLD;

    if (gestureTime < GESTURE_MAX_TIME && isHorizontalGesture && !state.hasNavigated) {
      if (horizontalDistance >= GESTURE_THRESHOLD) {
        throttleIPCSend(state.deltaX > 0 ? 'navigate-forward' : 'navigate-back');
        state.hasNavigated = true;
      }
    } else if (gestureTime >= GESTURE_MAX_TIME && !state.hasNavigated) {
      state.isActive = false;
      state.deltaX = 0;
    }
  }

  function runHistoryNavigationAction(action) {
    if (action === NAVIGATION_ACTIONS.BACK) {
      win.history.back();
    } else if (action === NAVIGATION_ACTIONS.FORWARD) {
      win.history.forward();
    }
  }

  // Reset gesture state when wheel events stop
  let wheelTimeout;
  let macOSAccumulatedDeltaX = 0;
  win.addEventListener(
    'wheel',
    () => {
      clearTimeout(wheelTimeout);
      wheelTimeout = setTimeout(() => {
        macOSAccumulatedDeltaX = 0;
        gestureState.hasNavigated = false;
        gestureState.isActive = false;
        gestureState.deltaX = 0;
      }, 300);
    },
    { passive: true }
  );

  // Every listener below ignores events a page script dispatched itself:
  // otherwise any site could quit the app or switch tabs with a synthetic key.

  // Mouse back/forward buttons navigate through the history API. pointerdown in
  // the capture phase fires before any page-level handler can block it, and
  // preventDefault() suppresses the mousedown that follows.
  win.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted) return;
    const action = getNavigationActionForDomMouseButton(event.button);
    if (!action) return;

    event.preventDefault();
    runHistoryNavigationAction(action);
  }, true);

  // Fallback: mousedown capture phase (fires if pointerdown was not dispatched)
  win.addEventListener('mousedown', (event) => {
    if (!event.isTrusted) return;
    runHistoryNavigationAction(getNavigationActionForDomMouseButton(event.button));
  }, true);

  let macOSGestureStartTime = 0;
  let macOSHasNavigated = false;

  win.addEventListener('gesturestart', (event) => {
    if (!event.isTrusted) return;
    macOSGestureStartTime = Date.now();
    macOSAccumulatedDeltaX = 0;
    macOSHasNavigated = false;
  });

  win.addEventListener('gesturechange', (event) => {
    if (!event.isTrusted || macOSHasNavigated) return;

    macOSAccumulatedDeltaX += /** @type {any} */ (event).rotation;

    const gestureTime = Date.now() - macOSGestureStartTime;
    const horizontalDistance = Math.abs(macOSAccumulatedDeltaX);

    if (gestureTime < GESTURE_MAX_TIME && horizontalDistance >= GESTURE_THRESHOLD) {
      send(macOSAccumulatedDeltaX > 0 ? 'navigate-back' : 'navigate-forward');
      macOSHasNavigated = true;
    }
  });

  win.addEventListener('gestureend', () => {
    macOSGestureStartTime = 0;
    macOSAccumulatedDeltaX = 0;
    macOSHasNavigated = false;
  });

  // BrowserBack/BrowserForward keys and Cmd+[/Cmd+] (macOS mouse drivers may send these)
  win.addEventListener('keydown', (event) => {
    if (!event.isTrusted) return;
    const action = getNavigationActionForKeyInput(event);
    if (!action) return;

    event.preventDefault();
    runHistoryNavigationAction(action);
  }, true);

  win.addEventListener('keydown', (event) => {
    if (!event.isTrusted) return;
    if (event.key === 'Escape') {
      send('close-find-bar');
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      send('refreshActive');
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'q') {
      event.preventDefault();
      send('quitApp');
    }

    if ((event.ctrlKey || event.metaKey) && /^[0-9]$/.test(event.key)) {
      event.preventDefault();
      send('switch-space', parseInt(event.key));
    }

    if (event.key === 'F1') {
      event.preventDefault();
      send('select-previous-space');
    }
    if (event.key === 'F2') {
      event.preventDefault();
      send('select-next-space');
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      send('select-previous-space');
    }
    if (
      ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 's') ||
      ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd')
    ) {
      event.preventDefault();
      send('select-next-space');
    }
  });
}

module.exports = { install };
