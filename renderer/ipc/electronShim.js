// The `electron` module as the bundled shell renderer sees it (esbuild aliases
// the import here; scripts/build-renderer.js). The shell has no Node, so each
// member goes through the `icShell` bridge from main/preload/shell.js; clipboard
// and shell calls run in main (main/ipc/shellHandlers.js).

// Stand-in for IpcRendererEvent, which cannot cross the context bridge.
// Shell listeners take (event, payload) and never read the event.
const BRIDGED_EVENT = Object.freeze({});

/**
 * @param {{ invoke: Function, send: Function, sendSync: Function, on: (channel: string, fn: Function) => () => void }} bridge
 */
function createElectronShim(bridge) {
  /** @type {Map<string, Map<Function, Array<() => void>>>} */
  const subscriptions = new Map();

  const ipcRenderer = {
    invoke: (channel, ...args) => bridge.invoke(channel, ...args),
    send: (channel, ...args) => { bridge.send(channel, ...args); },
    sendSync: (channel, ...args) => bridge.sendSync(channel, ...args),
    on(channel, listener) {
      const unsubscribe = bridge.on(channel, (...args) => listener(BRIDGED_EVENT, ...args));
      if (!subscriptions.has(channel)) subscriptions.set(channel, new Map());
      const byListener = subscriptions.get(channel);
      if (!byListener.has(listener)) byListener.set(listener, []);
      byListener.get(listener).push(unsubscribe);
      return ipcRenderer;
    },
    // Matches EventEmitter: removes one registration of this listener.
    removeListener(channel, listener) {
      const byListener = subscriptions.get(channel);
      const unsubs = byListener && byListener.get(listener);
      if (!unsubs) return ipcRenderer;
      unsubs.pop()();
      if (!unsubs.length) byListener.delete(listener);
      if (!byListener.size) subscriptions.delete(channel);
      return ipcRenderer;
    },
  };

  /** Throws when main reports a failure, as Electron's synchronous calls do. */
  function syncCall(channel, ...args) {
    const res = bridge.sendSync(channel, ...args);
    if (!res || res.ok !== true) throw new Error((res && res.error) || `${channel} failed`);
  }

  const clipboard = {
    writeText: (text) => syncCall('clipboard:write-text', String(text)),
  };

  const shell = {
    openExternal: (url) => bridge.invoke('shell:open-external', url),
    openPath: (filePath) => bridge.invoke('shell:open-path', filePath),
    showItemInFolder: (filePath) => syncCall('shell:show-item-in-folder', filePath),
  };

  return { ipcRenderer, clipboard, shell };
}

if (typeof window === 'undefined' || !window.icShell) {
  throw new Error('electronShim: window.icShell is missing, so the shell preload did not run');
}

module.exports = createElectronShim(window.icShell);
module.exports.createElectronShim = createElectronShim;
