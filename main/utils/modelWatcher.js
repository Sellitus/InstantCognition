// Filesystem watcher for the model registry. Extracted from
// ModelManagerService to keep that file under the 265-line cap.
//
// Watches modelsDir + configured scanDirs and, on any change, debounces
// then asks the manager to re-scan + register new models. Catches Hub
// downloads, external `cp`/Finder drops, huggingface-cli, etc.

const fs = require('fs');

const DEFAULT_DEBOUNCE_MS = 500;

function createModelWatcher(manager, opts = {}) {
  const debounceMs = opts.debounceMs || DEFAULT_DEBOUNCE_MS;
  let watchers = [];
  let scanDirsConfig = { combined: null, mlx: null, gguf: null };
  let timer = null;

  const stop = () => {
    for (const w of watchers) { try { w.close(); } catch (_) { /* ignore */ } }
    watchers = [];
    if (timer) { clearTimeout(timer); timer = null; }
  };

  const rescan = () => {
    try {
      manager.scanDirs({ combined: manager.getModelsDir() });
      const c = scanDirsConfig || { combined: null, mlx: null, gguf: null };
      if (c.combined || c.mlx || c.gguf) manager.scanDirs(c);
      manager.listModels();
    } catch (_) { /* best effort */ }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; rescan(); }, debounceMs);
  };

  const attach = (dir) => {
    if (!dir || !fs.existsSync(dir)) return;
    try {
      const recursive = process.platform === 'darwin' || process.platform === 'win32';
      const w = fs.watch(dir, { recursive, persistent: false }, (_event, filename) => {
        if (filename && /\.part$/i.test(String(filename))) return; // ignore in-flight downloads
        schedule();
      });
      watchers.push(w);
    } catch (_) { /* watch is best effort */ }
  };

  const start = (cfg) => {
    scanDirsConfig = cfg || { combined: null, mlx: null, gguf: null };
    stop();
    const targets = new Set([manager.getModelsDir()]);
    for (const k of ['combined', 'mlx', 'gguf']) if (scanDirsConfig[k]) targets.add(scanDirsConfig[k]);
    for (const dir of targets) attach(dir);
  };

  // Test injection: trigger the rescan path immediately, bypassing fs.watch.
  const _triggerRescanForTest = () => rescan();

  return { start, stop, _triggerRescanForTest };
}

module.exports = { createModelWatcher };
