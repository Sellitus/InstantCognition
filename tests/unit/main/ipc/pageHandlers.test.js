// pageHandlers — the renderer names the active tab by webContents id; main
// resolves it and prints / saves it. Only guest pages may be targeted.

jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: { handle: jest.fn((ch, fn) => { handlers[ch] = fn; }), _handlers: handlers },
    webContents: { fromId: jest.fn() },
    dialog: { showSaveDialog: jest.fn() },
    app: { getPath: jest.fn(() => '/downloads') },
  };
});

const { ipcMain, webContents, dialog } = require('electron');
const pageHandlers = require('../../../../main/ipc/pageHandlers');

function makeWindow() {
  return { isDestroyed: jest.fn(() => false), webContents: { send: jest.fn() } };
}

function makeGuest(type = 'webview') {
  return {
    isDestroyed: jest.fn(() => false),
    getType: jest.fn(() => type),
    getTitle: jest.fn(() => 'Guest'),
    print: jest.fn((_o, cb) => cb(true, '')),
    printToPDF: jest.fn(() => Promise.resolve(Buffer.from('%PDF'))),
  };
}

const failures = (win) => win.webContents.send.mock.calls.filter((c) => c[0] === 'page:action-failed');

let win;
let errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  win = makeWindow();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  pageHandlers.register(win);
});

afterEach(() => errorSpy.mockRestore());

test('registers page:print and page:save-pdf', () => {
  expect(ipcMain.handle).toHaveBeenCalledWith('page:print', expect.any(Function));
  expect(ipcMain.handle).toHaveBeenCalledWith('page:save-pdf', expect.any(Function));
});

test('page:print prints the guest page with that webContents id', async () => {
  const guest = makeGuest();
  webContents.fromId.mockReturnValue(guest);
  await expect(ipcMain._handlers['page:print']({}, 42)).resolves.toBe(true);
  expect(webContents.fromId).toHaveBeenCalledWith(42);
  expect(guest.print).toHaveBeenCalled();
  expect(failures(win)).toEqual([]);
});

test('page:save-pdf renders the guest page after the save dialog', async () => {
  const guest = makeGuest();
  webContents.fromId.mockReturnValue(guest);
  dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
  await expect(ipcMain._handlers['page:save-pdf']({}, 42)).resolves.toBe(false);
  expect(dialog.showSaveDialog).toHaveBeenCalledWith(win, expect.objectContaining({ title: 'Save Page as PDF' }));
});

test('an id that names a non-guest webContents (the shell itself) is refused', async () => {
  const shell = makeGuest('window');
  webContents.fromId.mockReturnValue(shell);
  await expect(ipcMain._handlers['page:print']({}, 1)).resolves.toBe(false);
  expect(shell.print).not.toHaveBeenCalled();
  expect(failures(win)).toEqual([['page:action-failed', { title: 'Print', message: 'There is no open page to print.' }]]);
});

test('an unknown or malformed id is reported, not thrown', async () => {
  webContents.fromId.mockReturnValue(undefined);
  await expect(ipcMain._handlers['page:save-pdf']({}, 999)).resolves.toBe(false);
  await expect(ipcMain._handlers['page:print']({}, 'abc')).resolves.toBe(false);
  expect(webContents.fromId).toHaveBeenCalledTimes(1);
  expect(failures(win)).toHaveLength(2);
});
