// extensionHandlers wires ExtensionService to ipcMain. ipcMain + dialog are
// the external boundary (mocked); captured handlers are invoked to assert
// delegation and the no-source file-picker branch of install-prepare.

const invokeHandlers = {};

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn((ch, fn) => { invokeHandlers[ch] = fn; }) },
  dialog: { showOpenDialog: jest.fn() },
}));

const { dialog } = require('electron');
const extensionHandlers = require('../../../../main/ipc/extensionHandlers');

function makeService() {
  return {
    list: jest.fn(() => []),
    load: jest.fn((p) => ({ id: 'loaded', path: p })),
    remove: jest.fn(() => true),
    prepareInstall: jest.fn(() => ({ ok: true, name: 'Ext', staging: '/s', isDirectory: false })),
    commitInstall: jest.fn(() => ({ ok: true, id: 'x' })),
  };
}

describe('extensionHandlers.register', () => {
  beforeEach(() => {
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    dialog.showOpenDialog.mockReset();
  });

  test('registers nothing without an extensionService', () => {
    extensionHandlers.register({}, {});
    expect(invokeHandlers['extensions:install-prepare']).toBeUndefined();
  });

  test("'install-prepare' with a source delegates straight to prepareInstall", async () => {
    const extensionService = makeService();
    extensionHandlers.register({}, { extensionService });
    const res = await invokeHandlers['extensions:install-prepare']({}, { source: 'someid' });
    expect(extensionService.prepareInstall).toHaveBeenCalledWith('someid');
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ ok: true }));
  });

  test("'install-prepare' with no source opens the .crx/.zip picker", async () => {
    const extensionService = makeService();
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/dl/foo.crx'] });
    extensionHandlers.register({}, { extensionService });
    await invokeHandlers['extensions:install-prepare']({}, {});
    const opts = dialog.showOpenDialog.mock.calls[0][1];
    expect(opts.filters[0].extensions).toEqual(['crx', 'zip']);
    expect(extensionService.prepareInstall).toHaveBeenCalledWith('/dl/foo.crx');
  });

  test("'install-prepare' returns cancelled when the picker is dismissed", async () => {
    const extensionService = makeService();
    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    extensionHandlers.register({}, { extensionService });
    const res = await invokeHandlers['extensions:install-prepare']({}, {});
    expect(res).toEqual({ ok: false, cancelled: true });
    expect(extensionService.prepareInstall).not.toHaveBeenCalled();
  });

  test("'install-commit' forwards the staging options", async () => {
    const extensionService = makeService();
    extensionHandlers.register({}, { extensionService });
    await invokeHandlers['extensions:install-commit']({}, { staging: '/s', isDirectory: false, accept: true });
    expect(extensionService.commitInstall).toHaveBeenCalledWith({ staging: '/s', isDirectory: false, accept: true });
  });

  test("'list' and 'remove' still delegate", async () => {
    const extensionService = makeService();
    extensionHandlers.register({}, { extensionService });
    await invokeHandlers['extensions:list']({});
    invokeHandlers['extensions:remove']({}, { id: 'abc' });
    expect(extensionService.list).toHaveBeenCalled();
    expect(extensionService.remove).toHaveBeenCalledWith('abc');
  });

  test("'load' with an explicit path delegates straight to load (no picker)", async () => {
    const extensionService = makeService();
    const mainWindow = {};
    extensionHandlers.register(mainWindow, { extensionService });
    const res = await invokeHandlers['extensions:load']({}, { path: '/ext/dir' });
    expect(extensionService.load).toHaveBeenCalledWith('/ext/dir');
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(res).toEqual({ id: 'loaded', path: '/ext/dir' });
  });

  test("'load' with no path opens the directory picker then loads the chosen dir", async () => {
    const extensionService = makeService();
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/picked/ext'] });
    const mainWindow = {};
    extensionHandlers.register(mainWindow, { extensionService });
    await invokeHandlers['extensions:load']({}, {});
    const opts = dialog.showOpenDialog.mock.calls[0][1];
    expect(opts.properties).toEqual(['openDirectory']);
    expect(extensionService.load).toHaveBeenCalledWith('/picked/ext');
  });

  test("'load' returns null when the directory picker is cancelled (no load)", async () => {
    const extensionService = makeService();
    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    extensionHandlers.register({}, { extensionService });
    const res = await invokeHandlers['extensions:load']({}, {});
    expect(res).toBeNull();
    expect(extensionService.load).not.toHaveBeenCalled();
  });

  test("'load' returns null when there is no path and no window to prompt", async () => {
    const extensionService = makeService();
    extensionHandlers.register(null, { extensionService });
    const res = await invokeHandlers['extensions:load']({}, {});
    expect(res).toBeNull();
    expect(extensionService.load).not.toHaveBeenCalled();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  test("'install-prepare' with no source and no window reports a clear error", async () => {
    const extensionService = makeService();
    extensionHandlers.register(null, { extensionService });
    const res = await invokeHandlers['extensions:install-prepare']({}, {});
    expect(res).toEqual({ ok: false, error: 'No source provided' });
    expect(extensionService.prepareInstall).not.toHaveBeenCalled();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });
});
