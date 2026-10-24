// main/preload/shell.js — the sandboxed shell's only bridge to main. It must
// strip the IpcRendererEvent (which cannot cross the context bridge), let a
// listener unsubscribe, and expose no environment beyond the app version.

jest.mock('electron', () => {
  const listeners = new Map();
  return {
    contextBridge: { exposeInMainWorld: jest.fn() },
    ipcRenderer: {
      invoke: jest.fn(() => Promise.resolve('r')),
      send: jest.fn(),
      sendSync: jest.fn(() => 's'),
      on: jest.fn((ch, fn) => { if (!listeners.has(ch)) listeners.set(ch, new Set()); listeners.get(ch).add(fn); }),
      removeListener: jest.fn((ch, fn) => { const set = listeners.get(ch); if (set) set.delete(fn); }),
      _emit: (ch, ...args) => { for (const fn of listeners.get(ch) || []) fn({ sender: 'event' }, ...args); },
    },
  };
});

const { contextBridge, ipcRenderer } = require('electron');

let exposed;
beforeAll(() => {
  process.env.npm_package_version = '4.0.0';
  process.env.IC_TEST_SECRET = 'do-not-leak';
  require('../../../../main/preload/shell');
  exposed = Object.fromEntries(contextBridge.exposeInMainWorld.mock.calls);
});
afterAll(() => { delete process.env.IC_TEST_SECRET; });

test('exposes exactly icShell and process', () => {
  expect(Object.keys(exposed).sort()).toEqual(['icShell', 'process']);
});

test('invoke, send and sendSync pass straight through', async () => {
  await expect(exposed.icShell.invoke('a:b', 1, 2)).resolves.toBe('r');
  expect(ipcRenderer.invoke).toHaveBeenCalledWith('a:b', 1, 2);
  exposed.icShell.send('c:d', 'x');
  expect(ipcRenderer.send).toHaveBeenCalledWith('c:d', 'x');
  expect(exposed.icShell.sendSync('e:f')).toBe('s');
});

test('listeners get only the payload, and the returned function unsubscribes', () => {
  const fn = jest.fn();
  const off = exposed.icShell.on('push', fn);
  ipcRenderer._emit('push', 'p1', 'p2');
  expect(fn).toHaveBeenCalledWith('p1', 'p2');
  off();
  ipcRenderer._emit('push', 'p3');
  expect(fn).toHaveBeenCalledTimes(1);
});

test('process carries platform info and the app version, never the rest of the environment', () => {
  expect(exposed.process).toMatchObject({ platform: process.platform, arch: process.arch });
  expect(exposed.process.versions.node).toBe(process.versions.node);
  expect(exposed.process.env).toEqual({ npm_package_version: '4.0.0' });
});
