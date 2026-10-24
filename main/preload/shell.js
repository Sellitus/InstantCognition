// Preload for the app's own windows (main shell, launcher). They run with
// contextIsolation and the OS sandbox, so this file may require nothing but
// 'electron'. The bundled renderer reaches main only through `icShell`; its
// `electron` import is aliased to renderer/ipc/electronShim.js over this bridge.
const { contextBridge, ipcRenderer } = require('electron');

/** @param {typeof ipcRenderer} ipc */
function createBridge(ipc) {
  return {
    invoke: (channel, ...args) => ipc.invoke(channel, ...args),
    send: (channel, ...args) => ipc.send(channel, ...args),
    sendSync: (channel, ...args) => ipc.sendSync(channel, ...args),
    // The IpcRendererEvent holds the sender and cannot cross the bridge, so
    // listeners get only the payload; the returned function unsubscribes.
    on: (channel, listener) => {
      const wrapped = (_event, ...args) => listener(...args);
      ipc.on(channel, wrapped);
      return () => { ipc.removeListener(channel, wrapped); };
    },
  };
}

/** @param {NodeJS.Process} proc */
function processInfo(proc) {
  const env = {};
  if (proc.env && proc.env.npm_package_version) env.npm_package_version = proc.env.npm_package_version;
  return { platform: proc.platform, arch: proc.arch, versions: { ...proc.versions }, env };
}

contextBridge.exposeInMainWorld('icShell', createBridge(ipcRenderer));
contextBridge.exposeInMainWorld('process', processInfo(process));
