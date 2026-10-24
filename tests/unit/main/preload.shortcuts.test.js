/**
 * @jest-environment jsdom
 */

// Webview preload key map: Cmd/Ctrl+Shift+A belongs to panel.chat (main
// forwards it from before-input-event), so the page preload must not also
// turn it into a space switch.

jest.mock('electron', () => ({
  ipcRenderer: { send: jest.fn(), on: jest.fn(), invoke: jest.fn(() => Promise.resolve()), sendToHost: jest.fn() },
}));

const { ipcRenderer } = require('electron');
const { recordListeners } = require('../../helpers/trustedEvents');

let host;
beforeAll(() => {
  host = recordListeners(window);
  require('../../../main/preload');
});

beforeEach(() => {
  ipcRenderer.send.mockClear();
});

function press(key, mods = {}) {
  return host.fire(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
}

test.each([
  ['Cmd', { metaKey: true }],
  ['Ctrl', { ctrlKey: true }],
])('%s+Shift+A is left to the forwarded panel.chat shortcut', (_label, mods) => {
  const ev = press('A', { ...mods, shiftKey: true });
  expect(ipcRenderer.send).not.toHaveBeenCalledWith('select-previous-space');
  expect(ev.defaultPrevented).toBe(false);
});

test('Cmd+Shift+W still selects the previous space', () => {
  const ev = press('W', { metaKey: true, shiftKey: true });
  expect(ipcRenderer.send).toHaveBeenCalledWith('select-previous-space');
  expect(ev.defaultPrevented).toBe(true);
});

test('Cmd+E is not claimed by the page preload', () => {
  const ev = press('e', { metaKey: true });
  expect(ipcRenderer.send).not.toHaveBeenCalled();
  expect(ev.defaultPrevented).toBe(false);
});

test('a key the page dispatched itself never reaches main', () => {
  const ev = new KeyboardEvent('keydown', { key: 'q', metaKey: true, bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
  expect(ipcRenderer.send).not.toHaveBeenCalled();
  expect(ev.defaultPrevented).toBe(false);
});

test('the user pressing Cmd+Q still quits', () => {
  press('q', { metaKey: true });
  expect(ipcRenderer.send).toHaveBeenCalledWith('quitApp');
});
