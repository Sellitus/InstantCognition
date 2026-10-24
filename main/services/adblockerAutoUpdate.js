// adblockerAutoUpdate — park the adblocker's hourly refresh while the window
// is hidden, so we don't refetch ~5MB of filter lists when no webview is
// making requests. visibilityThrottling drives onSuspend/onResume hooks.

function setupAutoUpdate(service) {
  service._teardownAutoUpdate();
  const tick = async () => {
    try { await service.refresh(); }
    catch (error) { console.error('Adblocker auto-update failed; the current lists stay active:', error); }
  };
  // unref() so the timer doesn't keep the event loop alive on its own.
  service.intervalId = setInterval(tick, 60 * 60 * 1000);
  if (service.intervalId && service.intervalId.unref) service.intervalId.unref();

  if (typeof service._visibilityUnsub === 'function') return;
  try {
    const vis = require('./visibilityThrottling');
    if (vis && typeof vis.onSuspend === 'function' && typeof vis.onResume === 'function') {
      const offSuspend = vis.onSuspend(() => service._teardownAutoUpdate());
      // A disable() clears blocker/interval but leaves these hooks subscribed,
      // so only revive the hourly timer when the service is actually enabled —
      // otherwise re-showing the window silently re-enables the adblocker.
      const offResume = vis.onResume(() => { if (service.isEnabled) setupAutoUpdate(service); });
      service._visibilityUnsub = () => { offSuspend(); offResume(); };
    }
  } catch (_) { /* visibility hooks optional */ }
}

function teardownAutoUpdate(service) {
  if (service.intervalId) {
    clearInterval(service.intervalId);
    service.intervalId = null;
  }
}

module.exports = { setupAutoUpdate, teardownAutoUpdate };