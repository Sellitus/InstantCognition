// electronShim — what `require('electron')` resolves to in the bundled shell.
// It must keep EventEmitter semantics over the icShell bridge and Electron's
// throw-on-failure contract for synchronous clipboard/shell calls.

// The preload's bridge (main/preload/shell.js) over a fake ipc channel.
function fakeBridge() {
  const subs = new Map();
  return {
    invoke: jest.fn(() => Promise.resolve('ok')),
    send: jest.fn(),
    sendSync: jest.fn(() => ({ ok: true })),
    on: jest.fn((ch, fn) => {
      if (!subs.has(ch)) subs.set(ch, []);
      subs.get(ch).push(fn);
      return () => { subs.set(ch, subs.get(ch).filter((x) => x !== fn)); };
    }),
    emit: (ch, ...args) => { for (const fn of subs.get(ch) || []) fn(...args); },
  };
}

const SHIM = '../../../../renderer/ipc/electronShim.js';
window.icShell = fakeBridge();
const { createElectronShim } = require(SHIM);

test('loading wires the default export to window.icShell', () => {
  const shim = require(SHIM);
  shim.ipcRenderer.send('boot', 1);
  expect(window.icShell.send).toHaveBeenCalledWith('boot', 1);
});

test('loading without the shell preload fails loudly', () => {
  const bridge = window.icShell;
  delete window.icShell;
  try {
    jest.isolateModules(() => {
      expect(() => require(SHIM)).toThrow(/window\.icShell is missing/);
    });
  } finally {
    window.icShell = bridge;
  }
});

test('on() hands listeners an event placeholder then the payload; removeListener detaches', () => {
  const bridge = fakeBridge();
  const { ipcRenderer } = createElectronShim(bridge);
  const fn = jest.fn();
  expect(ipcRenderer.on('ch', fn)).toBe(ipcRenderer);
  bridge.emit('ch', 'a', 'b');
  expect(fn).toHaveBeenCalledWith(expect.any(Object), 'a', 'b');
  expect(ipcRenderer.removeListener('ch', fn)).toBe(ipcRenderer);
  bridge.emit('ch', 'c');
  expect(fn).toHaveBeenCalledTimes(1);
});

test('a listener added twice is removed one registration at a time', () => {
  const bridge = fakeBridge();
  const { ipcRenderer } = createElectronShim(bridge);
  const fn = jest.fn();
  ipcRenderer.on('ch', fn);
  ipcRenderer.on('ch', fn);
  ipcRenderer.removeListener('ch', fn);
  bridge.emit('ch', 1);
  expect(fn).toHaveBeenCalledTimes(1);
  ipcRenderer.removeListener('ch', fn);
  bridge.emit('ch', 2);
  expect(fn).toHaveBeenCalledTimes(1);
});

test('removing a listener that was never added is a no-op', () => {
  const { ipcRenderer } = createElectronShim(fakeBridge());
  expect(() => ipcRenderer.removeListener('nope', () => {})).not.toThrow();
});

test('invoke, send and sendSync go through the bridge', async () => {
  const bridge = fakeBridge();
  const { ipcRenderer } = createElectronShim(bridge);
  await expect(ipcRenderer.invoke('x', 1)).resolves.toBe('ok');
  ipcRenderer.send('y', 2);
  expect(bridge.send).toHaveBeenCalledWith('y', 2);
  expect(ipcRenderer.sendSync('z')).toEqual({ ok: true });
});

test('clipboard and shell calls map to the main-process channels', async () => {
  const bridge = fakeBridge();
  const { clipboard, shell } = createElectronShim(bridge);
  clipboard.writeText('hi');
  expect(bridge.sendSync).toHaveBeenCalledWith('clipboard:write-text', 'hi');
  await shell.openExternal('https://x.test/');
  expect(bridge.invoke).toHaveBeenCalledWith('shell:open-external', 'https://x.test/');
  await shell.openPath('/d/f');
  expect(bridge.invoke).toHaveBeenCalledWith('shell:open-path', '/d/f');
  shell.showItemInFolder('/d/f');
  expect(bridge.sendSync).toHaveBeenCalledWith('shell:show-item-in-folder', '/d/f');
});

test('a synchronous call main reports as failed throws with main\'s reason', () => {
  const bridge = fakeBridge();
  bridge.sendSync.mockReturnValueOnce({ ok: false, error: 'pasteboard busy' }).mockReturnValueOnce(undefined);
  const { clipboard, shell } = createElectronShim(bridge);
  expect(() => clipboard.writeText('x')).toThrow('pasteboard busy');
  expect(() => shell.showItemInFolder('/x')).toThrow('shell:show-item-in-folder failed');
});
