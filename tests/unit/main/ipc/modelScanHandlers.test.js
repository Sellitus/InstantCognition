jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    dialog: { showOpenDialog: jest.fn() },
  };
});

jest.mock('fs', () => ({ existsSync: jest.fn(() => true) }));

const fs = require('fs');
const { ipcMain, dialog } = require('electron');
const { register } = require('../../../../main/ipc/modelScanHandlers');

describe('modelScanHandlers', () => {
  let modelManagerService;
  let configService;
  let mainWindow;
  let store;

  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    fs.existsSync.mockReturnValue(true);

    store = {};
    configService = {
      get: jest.fn((k, d) => (k in store ? store[k] : d)),
      set: jest.fn((k, v) => { store[k] = v; }),
    };
    modelManagerService = {
      startWatching: jest.fn(),
      scanDirs: jest.fn(() => ({ mlx: 1, gguf: 2, added: 3, skipped: 0 })),
    };
    mainWindow = {};
    register(mainWindow, { modelManagerService, configService });
  });

  test('no-ops when modelManagerService missing', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow, { configService });
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('no-ops when configService missing', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow, { modelManagerService });
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('no-ops when services arg omitted', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow);
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  describe('llm:set-scan-dirs', () => {
    test('merges partial patch keeping prev other slots', async () => {
      store['settings.llm.scanDirs'] = { combined: '/old', mlx: '/oldmlx', gguf: null };
      const r = await ipcMain._handlers['llm:set-scan-dirs']({}, { mlx: null });
      expect(r).toEqual({ combined: '/old', mlx: null, gguf: null });
      expect(configService.set).toHaveBeenCalledWith('settings.llm.scanDirs', { combined: '/old', mlx: null, gguf: null });
      expect(modelManagerService.startWatching).toHaveBeenCalledWith({ combined: '/old', mlx: null, gguf: null });
    });

    test('sets new values from patch', async () => {
      const r = await ipcMain._handlers['llm:set-scan-dirs']({}, { combined: '/new', gguf: '/g' });
      expect(r).toEqual({ combined: '/new', mlx: null, gguf: '/g' });
    });

    test('throws when a scan dir does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      expect(() => ipcMain._handlers['llm:set-scan-dirs']({}, { combined: '/missing' }))
        .toThrow('Scan dir not found: /missing');
      expect(configService.set).not.toHaveBeenCalled();
    });

    test('startWatching failure is non-fatal', async () => {
      modelManagerService.startWatching.mockImplementation(() => { throw new Error('watch boom'); });
      const r = await ipcMain._handlers['llm:set-scan-dirs']({}, { combined: '/x' });
      expect(r).toEqual({ combined: '/x', mlx: null, gguf: null });
    });

    test('defaults patch to {} when omitted (keeps prev)', async () => {
      store['settings.llm.scanDirs'] = { combined: '/keep', mlx: null, gguf: null };
      const r = await ipcMain._handlers['llm:set-scan-dirs']({});
      expect(r).toEqual({ combined: '/keep', mlx: null, gguf: null });
    });

    test('handles prev being null (no stored config)', async () => {
      const r = await ipcMain._handlers['llm:set-scan-dirs']({}, { combined: '/c' });
      expect(r).toEqual({ combined: '/c', mlx: null, gguf: null });
    });
  });

  describe('llm:browse-scan-dir', () => {
    test('returns chosen path', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/picked'] });
      const r = await ipcMain._handlers['llm:browse-scan-dir']({}, { title: 'Pick' });
      expect(dialog.showOpenDialog).toHaveBeenCalledWith(mainWindow, expect.objectContaining({ title: 'Pick' }));
      expect(r).toBe('/picked');
    });

    test('uses default title when omitted', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/p'] });
      await ipcMain._handlers['llm:browse-scan-dir']({});
      expect(dialog.showOpenDialog).toHaveBeenCalledWith(mainWindow, expect.objectContaining({ title: 'Choose models folder' }));
    });

    test('returns null on cancel', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
      expect(await ipcMain._handlers['llm:browse-scan-dir']({}, {})).toBeNull();
    });

    test('returns null when no paths', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
      expect(await ipcMain._handlers['llm:browse-scan-dir']({}, {})).toBeNull();
    });
  });

  describe('llm:scan-models', () => {
    test('returns zeros when no dirs configured', async () => {
      const r = await ipcMain._handlers['llm:scan-models']();
      expect(r).toEqual({ mlx: 0, gguf: 0, added: 0, skipped: 0 });
      expect(modelManagerService.scanDirs).not.toHaveBeenCalled();
    });

    test('scans configured dirs and returns summary', async () => {
      store['settings.llm.scanDirs'] = { combined: '/c' };
      const r = await ipcMain._handlers['llm:scan-models']();
      expect(modelManagerService.scanDirs).toHaveBeenCalledWith({ combined: '/c' });
      expect(r).toEqual({ mlx: 1, gguf: 2, added: 3, skipped: 0 });
    });
  });
});
