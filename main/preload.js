const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector);
    if (element) element.innerText = text;
  };

  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type]);
  }
});

// Optimize IPC handling
const throttledIPC = new Map();
function throttleIPCSend(channel, data, wait = 16) {
  if (throttledIPC.has(channel)) return;
  ipcRenderer.send(channel, data);
  throttledIPC.set(channel, true);
  setTimeout(() => throttledIPC.delete(channel), wait);
}

// Optimize gesture handling
let gestureState = {
  startTime: 0,
  startX: 0,
  startY: 0,
  deltaX: 0,
  isActive: false,
  hasNavigated: false, // Add this flag
};

// Constants for gesture detection
const GESTURE_THRESHOLD = 1250; // Minimum distance in pixels
const GESTURE_MAX_TIME = 300; // Maximum time in milliseconds
const GESTURE_DIRECTION_THRESHOLD = 2.5; // Ratio of horizontal to vertical movement

window.addEventListener(
  'wheel',
  (event) => {
    if (!event.isTrusted) return;

    if (!gestureState.isActive) {
      gestureState = {
        startTime: Date.now(),
        startX: event.pageX,
        startY: event.pageY,
        deltaX: 0,
        isActive: true,
        hasNavigated: false, // Reset flag at start
      };
    }

    // Use requestAnimationFrame for smooth gesture handling
    requestAnimationFrame(() => {
      handleGestureFrame(event, gestureState);
    });
  },
  { passive: true }
);

function handleGestureFrame(event, gestureState) {
  gestureState.deltaX += event.deltaX;

  const gestureTime = Date.now() - gestureState.startTime;
  const horizontalDistance = Math.abs(gestureState.deltaX);
  const verticalDistance = Math.abs(event.pageY - gestureState.startY);

  const isHorizontalGesture = horizontalDistance > verticalDistance * GESTURE_DIRECTION_THRESHOLD;

  if (gestureTime < GESTURE_MAX_TIME && isHorizontalGesture && !gestureState.hasNavigated) {
    if (horizontalDistance >= GESTURE_THRESHOLD) {
      if (gestureState.deltaX > 0) {
        throttleIPCSend('navigate-forward');
      } else {
        throttleIPCSend('navigate-back');
      }
      gestureState.hasNavigated = true; // Set flag after navigation
    }
  } else if (gestureTime >= GESTURE_MAX_TIME) {
    gestureState.isActive = false;
    gestureState.deltaX = 0;
    gestureState.hasNavigated = false; // Reset flag
  }
}

// Reset gesture state when wheel events stop
let wheelTimeout;
let macOSGestureInProgress = false;
let macOSAccumulatedDeltaX = 0;
window.addEventListener(
  'wheel',
  () => {
    clearTimeout(wheelTimeout);
    wheelTimeout = setTimeout(() => {
      macOSGestureInProgress = false;
      macOSAccumulatedDeltaX = 0;
      gestureState.hasNavigated = false; // Reset flag when gesture ends
      gestureState.isActive = false;
    }, 50);
  },
  { passive: true }
);

// Handle mouse buttons
window.addEventListener('mousedown', (event) => {
  if (event.button === 3) {
    // XButton1 (Back button)
    ipcRenderer.send('navigate-back');
  } else if (event.button === 4) {
    // XButton2 (Forward button)
    ipcRenderer.send('navigate-forward');
  }
});

// Track macOS gesture state
let macOSGestureStartTime = 0;
let macOSGestureStartX = 0;
let macOSHasNavigated = false; // Add this flag

// Add macOS gesture support via swipe events with threshold
window.addEventListener('gesturestart', (event) => {
  macOSGestureStartTime = Date.now();
  macOSGestureStartX = event.pageX;
  macOSAccumulatedDeltaX = 0;
  macOSHasNavigated = false; // Reset flag at start
});

window.addEventListener('gesturechange', (event) => {
  if (macOSHasNavigated) return; // Skip if already navigated

  macOSAccumulatedDeltaX += event.rotation;

  const gestureTime = Date.now() - macOSGestureStartTime;
  const horizontalDistance = Math.abs(macOSAccumulatedDeltaX);

  if (gestureTime < GESTURE_MAX_TIME && horizontalDistance >= GESTURE_THRESHOLD) {
    if (macOSAccumulatedDeltaX > 0) {
      ipcRenderer.send('navigate-back');
    } else {
      ipcRenderer.send('navigate-forward');
    }
    macOSHasNavigated = true; // Set flag after navigation
  }
});

window.addEventListener('gestureend', () => {
  macOSGestureStartTime = 0;
  macOSAccumulatedDeltaX = 0;
  macOSHasNavigated = false; // Reset flag at end
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    ipcRenderer.send('close-find-bar');
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    ipcRenderer.send('refreshActive');
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'q') {
    event.preventDefault();
    ipcRenderer.send('quitApp');
  }

  if ((event.ctrlKey || event.metaKey) && /^[0-9]$/.test(event.key)) {
    event.preventDefault();
    ipcRenderer.send('switch-cognitizer', parseInt(event.key));
  }

  if (event.key === 'F1') {
    event.preventDefault();
    ipcRenderer.send('select-previous-cognitizer');
  }
  if (event.key === 'F2') {
    event.preventDefault();
    ipcRenderer.send('select-next-cognitizer');
  }
  if (
    ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'a') ||
    ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'w')
  ) {
    event.preventDefault();
    ipcRenderer.send('select-previous-cognitizer');
  }
  if (
    ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 's') ||
    ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd')
  ) {
    event.preventDefault();
    ipcRenderer.send('select-next-cognitizer');
  }
});
