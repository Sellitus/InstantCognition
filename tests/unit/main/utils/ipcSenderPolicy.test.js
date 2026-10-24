// ipcSenderPolicy wraps a real EventEmitter standing in for electron's ipcMain:
// emit() is how electron delivers send/sendSync messages and handle() is how
// invoke handlers register, so the stand-in exposes exactly that surface.

const { EventEmitter } = require('events');
const senderPolicy = require('../../../../main/utils/ipcSenderPolicy');

function fakeIpcMain() {
  const ipc = new EventEmitter();
  /** @type {Map<string, Function>} */
  const invokeHandlers = new Map();
  Object.assign(ipc, {
    handle(channel, fn) { invokeHandlers.set(channel, fn); },
    handleOnce(channel, fn) { invokeHandlers.set(channel, (...a) => { invokeHandlers.delete(channel); return fn(...a); }); },
    // electron awaits the handler inside a try, so a synchronous throw reaches the page as a rejection.
    async invoke(channel, event, ...args) { return invokeHandlers.get(channel)(event, ...args); },
  });
  return /** @type {any} */ (ipc);
}

function contents(url, type) {
  const mainFrame = { url, parent: null };
  return { getType: () => type, mainFrame, getURL: () => url };
}
const fromTop = (sender) => ({ sender, senderFrame: sender.mainFrame });
const fromSubFrame = (sender, url) => ({ sender, senderFrame: { url, parent: sender.mainFrame } });

describe('ipcSenderPolicy', () => {
  let ipc; let shell; let guest; let popup; let errors;

  beforeEach(() => {
    ipc = fakeIpcMain();
    senderPolicy.install(ipc);
    shell = contents('file:///app/index.html', 'window');
    senderPolicy.trustShell(shell);
    guest = contents('https://evil.example/', 'webview');
    popup = contents('https://evil.example/popup', 'window');
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { errors.mockRestore(); });

  test('the app window may invoke and send any channel', async () => {
    ipc.handle('fs:write', async (_e, v) => `wrote ${v}`);
    const got = jest.fn();
    ipc.on('config:update', got);
    await expect(ipc.invoke('fs:write', fromTop(shell), 'x')).resolves.toBe('wrote x');
    ipc.emit('config:update', fromTop(shell), { a: 1 });
    expect(got).toHaveBeenCalledWith(fromTop(shell), { a: 1 });
  });

  test('a web page in a tab cannot invoke or send an app channel', async () => {
    const write = jest.fn();
    ipc.handle('fs:write', write);
    const update = jest.fn();
    ipc.on('config:update', update);
    await expect(ipc.invoke('fs:write', fromTop(guest), '/etc/passwd')).rejects.toThrow("forbidden: 'fs:write'");
    ipc.emit('config:update', fromTop(guest), { settings: {} });
    expect(write).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("refused 'config:update' from webview https://evil.example/"));
  });

  test('a pop-up window is treated as a web page, not as the app', async () => {
    const write = jest.fn();
    ipc.handle('fs:write', write);
    await expect(ipc.invoke('fs:write', fromTop(popup))).rejects.toThrow('forbidden');
    expect(write).not.toHaveBeenCalled();
  });

  test('a frame inside the app window (an artifact) is not the app', async () => {
    const write = jest.fn();
    ipc.handle('fs:write', write);
    await expect(ipc.invoke('fs:write', fromSubFrame(shell, 'ic-artifact://frame/t1'))).rejects.toThrow('forbidden');
    expect(write).not.toHaveBeenCalled();
  });

  test('the app window loses its trust once its top frame is not a local page', async () => {
    const write = jest.fn();
    ipc.handle('fs:write', write);
    shell.mainFrame.url = 'https://evil.example/';
    await expect(ipc.invoke('fs:write', fromTop(shell))).rejects.toThrow('forbidden');
  });

  test('a sender whose frame is gone is refused', async () => {
    const write = jest.fn();
    ipc.handle('fs:write', write);
    await expect(ipc.invoke('fs:write', { sender: shell, senderFrame: null })).rejects.toThrow('forbidden');
  });

  test('web pages keep the channels their preloads send', async () => {
    const seen = [];
    for (const ch of ['notification:show', 'badge:set', 'badge:clear', 'passwords:captured', 'passwords:fill-result',
      'navigate-back', 'navigate-forward', 'close-find-bar', 'refreshActive', 'quitApp', 'switch-space',
      'select-previous-space', 'select-next-space']) {
      ipc.on(ch, () => seen.push(ch));
      ipc.emit(ch, fromTop(guest));
    }
    expect(seen).toHaveLength(13);
    ipc.handle('permission:check', async () => 'allow');
    ipc.handle('permission:request', async () => 'deny');
    ipc.handle('@ghostery/adblocker/inject-cosmetic-filters', async () => ({ ok: true }));
    await expect(ipc.invoke('permission:check', fromTop(guest))).resolves.toBe('allow');
    await expect(ipc.invoke('permission:request', fromTop(popup))).resolves.toBe('deny');
    await expect(ipc.invoke('@ghostery/adblocker/inject-cosmetic-filters', fromSubFrame(guest, 'https://ads.example/'))).resolves.toEqual({ ok: true });
    expect(errors).not.toHaveBeenCalled();
  });

  test('llm channels are app-only', async () => {
    const start = jest.fn();
    ipc.handle('llm:start', start);
    await expect(ipc.invoke('llm:start', fromTop(guest), {})).rejects.toThrow('forbidden');
    expect(start).not.toHaveBeenCalled();
  });

  test('a refused sendSync gets an answer instead of hanging the page', () => {
    const handler = jest.fn((e) => { e.returnValue = 'secret'; });
    ipc.on('config:get-sync', handler);
    const event = fromTop(guest);
    ipc.emit('config:get-sync', event);
    expect(handler).not.toHaveBeenCalled();
    expect(event).toHaveProperty('returnValue', null);
  });

  test('the URL prompt window may use only its own prompt channels', () => {
    const prompt = contents('file:///app/node_modules/electron-prompt/lib/page/prompt.html#1712-0.42', 'window');
    const options = jest.fn();
    ipc.on('prompt-get-options:1712-0.42', options);
    ipc.emit('prompt-get-options:1712-0.42', fromTop(prompt));
    expect(options).toHaveBeenCalled();
    const update = jest.fn();
    ipc.on('config:update', update);
    ipc.emit('config:update', fromTop(prompt));
    expect(update).not.toHaveBeenCalled();
    const fromGuest = jest.fn();
    ipc.on('prompt-post-data:1712-0.42', fromGuest);
    ipc.emit('prompt-post-data:1712-0.42', fromTop(guest), 'https://evil.example');
    expect(fromGuest).not.toHaveBeenCalled();
  });

  test('handleOnce and removeListener still work through the policy', async () => {
    ipc.handleOnce('once:ch', async () => 'first');
    await expect(ipc.invoke('once:ch', fromTop(shell))).resolves.toBe('first');
    const fn = jest.fn();
    ipc.on('x', fn);
    ipc.removeListener('x', fn);
    ipc.emit('x', fromTop(shell));
    expect(fn).not.toHaveBeenCalled();
  });

  test('installing twice wraps once', async () => {
    senderPolicy.install(ipc);
    const write = jest.fn();
    ipc.handle('fs:write', write);
    await expect(ipc.invoke('fs:write', fromTop(guest))).rejects.toThrow('forbidden');
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
