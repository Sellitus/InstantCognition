// llmVisibility — pause/resume the local LLM subprocess around window
// visibility, so the engine doesn't keep a CPU/GPU-hungry child alive while
// the user is gaming on a hidden Electron window. visibilityThrottling
// drives onSuspend/onResume hooks; this module just maps them to LLMManager.

const { stopProcess } = require('./backendRuntime');

function detachProcListeners(proc) {
  // The spawn-time exit handler (LLMManager._spawnAndWait) would otherwise still fire for a proc we're killing on purpose: with status already 'stopped' it can't classify the kill as an intentional stop, and falls through to _setStatus('error') — turning every hide-while-running into a spurious engine failure. Detach exit/error (and stdout/stderr log piping) before sending SIGTERM so nothing downstream reacts to this expected death.
  proc.removeAllListeners('exit');
  proc.removeAllListeners('error');
  if (proc.stdout) proc.stdout.removeAllListeners('data');
  if (proc.stderr) proc.stderr.removeAllListeners('data');
}

// Park the engine silently when the window hides. The snapshot is the source of truth for resume; stop() wipes it, so this tears down in-place (no stop() call). Only an idle-running engine is parked: killing one still mid-startup would make _waitForHealthy reject and its catch path wipe the pause snapshot via stop(), losing the restart state we just took.
function pauseForVisibility(manager) {
  if (!manager._proc || manager._status !== 'running') return; // a "starting" engine gets to finish loading even while hidden — next hide cycle will park it then, and there's no failure path that loses its snapshot in the meantime (see test: "parked engine stays 'stopped'")
  manager._pauseSnapshot = {
    opts: manager._lastStartOpts ? { ...manager._lastStartOpts } : null,
  };
  if (manager._restartTimer) {
    clearTimeout(manager._restartTimer);
    manager._restartTimer = null;
  }
  const proc = manager._proc;
  // Null the handle before killing so a fast SIGTERM exit can't be misread as still-managed state by anything checking _proc between now and resume.
  manager._proc = null;
  manager._setStatus('stopped');
  detachProcListeners(proc);
  // SIGTERM, then SIGKILL if the engine outlives its grace period; vLLM's
  // process group and WSL distro need the backend-aware stop.
  stopProcess(manager._backend, proc).then(
    (failures) => failures.forEach((f) => manager._appendLog('warn', f)),
    (err) => manager._appendLog('error', `pause stop failed: ${(err instanceof Error && err.message) || err}`),
  );
}

// Restart after a visibility pause. No-op if start() never produced a
// snapshot, if a user stop voided it, or if the user started something new
// while the window was hidden.
async function resumeFromVisibility(manager) {
  const snap = manager._pauseSnapshot;
  if (!snap) return;
  manager._pauseSnapshot = null;
  if (manager._proc) return; // a fresh engine is already running — don't clobber it just because an old snapshot happened to survive.
  if (manager._intentionalStop) return; // a manual stop while hidden is a real "don't run this" signal, not something resume should override — see the explicit-user-stop test in LLMService.test.js
  try {
    await manager.start(snap.opts);
  } catch (err) {
    const msg = (err instanceof Error && err.message) || err;
    // Logged rather than thrown: a failed resume is an engine-side problem to surface in the log panel, not something that should take down whatever visibility hook called us. Status reflects LLMManager.start's own error handling ('error' + lastError), so this isn't hiding it from callers who check status — just keeping one transient failure from escalating into an unhandled rejection up through a window-visibility callback.
    manager._appendLog('error', `resumeFromVisibility start failed: ${msg}`);
  }
}

module.exports = { pauseForVisibility, resumeFromVisibility };
