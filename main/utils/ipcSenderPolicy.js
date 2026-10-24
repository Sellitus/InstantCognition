// IPC sender policy: every ipcMain message is checked against who sent it.
// The app's own windows (trustShell) may use any channel, but only from their
// top frame while it shows a local page. Every other sender (a tab, a pop-up,
// an artifact frame) is a web page and may use only the channels the guest
// preloads send. install() runs before any handler registers.

// Sent by main/preload.js, main/preload/passwords.js, shared/hostInput.js and
// the ad blocker's cosmetic-filter preload.
const GUEST_CHANNELS = new Set([
  'permission:check', 'permission:request', 'notification:show', 'badge:set', 'badge:clear',
  'passwords:captured', 'passwords:fill-result',
  'navigate-back', 'navigate-forward', 'close-find-bar', 'refreshActive', 'quitApp',
  'switch-space', 'select-previous-space', 'select-next-space',
  '@ghostery/adblocker/inject-cosmetic-filters', '@ghostery/adblocker/is-mutation-observer-enabled',
]);

// electron-prompt's own window (Visit URL…) talks on per-prompt channels.
// The id is `${Date.now()}-${Math.random()}`, and Math.random can print as 5e-7.
const PROMPT_CHANNEL = /^prompt-(get-options|post-data|error):[\w.+-]+$/;
const PROMPT_PAGE = /^file:\/\/.*\/electron-prompt\/lib\/page\/prompt\.html(#.*)?$/;

const shellContents = new WeakSet();
const installed = new WeakSet();

/** Marks an app window's webContents as the app itself. */
function trustShell(contents) { shellContents.add(contents); }

function topFrameUrl(event) {
  const frame = event && event.senderFrame;
  return frame && !frame.parent ? String(frame.url || '') : null;
}

/** @returns {boolean} */
function allowed(channel, event) {
  const url = topFrameUrl(event);
  if (event && shellContents.has(event.sender) && url && url.startsWith('file:')) return true;
  if (PROMPT_CHANNEL.test(channel)) return !!url && PROMPT_PAGE.test(url);
  return GUEST_CHANNELS.has(channel);
}

function refuse(channel, event) {
  const sender = event && event.sender;
  const kind = sender && typeof sender.getType === 'function' ? sender.getType() : 'unknown';
  const frame = event && event.senderFrame;
  console.error(`[ipc] refused '${channel}' from ${kind} ${frame ? frame.url : '(frame gone)'}`);
}

/** @param {any} ipcMain electron's ipcMain, wrapped in place */
function install(ipcMain) {
  if (installed.has(ipcMain)) return;
  installed.add(ipcMain);

  // send/sendSync messages arrive as emit(channel, event, ...args); events
  // EventEmitter raises itself (newListener, removeListener) carry no sender.
  const emit = ipcMain.emit;
  ipcMain.emit = function emitChecked(channel, event, ...args) {
    if (event && typeof event === 'object' && 'sender' in event && !allowed(String(channel), event)) {
      refuse(channel, event);
      // A refused sendSync still needs an answer or the page blocks forever.
      event.returnValue = null;
      return false;
    }
    return emit.call(this, channel, event, ...args);
  };

  for (const method of ['handle', 'handleOnce']) {
    const register = ipcMain[method];
    ipcMain[method] = function handleChecked(channel, fn) {
      return register.call(this, channel, (event, ...args) => {
        if (!allowed(channel, event)) {
          refuse(channel, event);
          throw new Error(`forbidden: '${channel}'`);
        }
        return fn(event, ...args);
      });
    };
  }
}

module.exports = { install, trustShell, GUEST_CHANNELS };
