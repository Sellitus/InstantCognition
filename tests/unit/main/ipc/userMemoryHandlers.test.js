jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    dialog: {
      showSaveDialog: jest.fn(),
      showOpenDialog: jest.fn(),
    },
  };
});

jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
}));

const fs = require('fs');
const { ipcMain, dialog } = require('electron');
const { register } = require('../../../../main/ipc/userMemoryHandlers');

const FORMAT = 'instantcognition.usermemory.v1';

function makeUserMemoryService() {
  return {
    isEnabled: jest.fn(() => true),
    list: jest.fn(() => [{ id: 'a', text: 'fact a' }]),
    add: jest.fn((text, opts) => ({ id: 'new', text, pinned: !!(opts && opts.pinned) })),
    edit: jest.fn((id, patch) => ({ id, ...patch })),
    remove: jest.fn(() => true),
    archive: jest.fn((id) => ({ id, archived: true })),
    unarchive: jest.fn((id) => ({ id, archived: false })),
    pin: jest.fn((id, on) => ({ id, pinned: on })),
    enable: jest.fn(),
    clearAll: jest.fn(),
    replaceAll: jest.fn(),
  };
}

describe('userMemoryHandlers', () => {
  let services;
  let userMemoryService;
  let mainWindow;

  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });

    userMemoryService = makeUserMemoryService();
    mainWindow = { webContents: { send: jest.fn() } };
    services = { userMemoryService, configService: { configPath: '/tmp/cfg.json' } };
    register(mainWindow, services);
  });

  test('no-ops when userMemoryService is missing (no handlers registered)', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow, {});
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('no-ops when services is undefined', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register(mainWindow, undefined);
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  describe('usermemory:list', () => {
    test('returns enabled + facts on success', async () => {
      const r = await ipcMain._handlers['usermemory:list']({}, { includeArchived: true });
      expect(userMemoryService.list).toHaveBeenCalledWith({ includeArchived: true });
      expect(r).toEqual({ ok: true, enabled: true, facts: [{ id: 'a', text: 'fact a' }] });
    });

    test('defaults opts to {} when omitted', async () => {
      await ipcMain._handlers['usermemory:list']({});
      expect(userMemoryService.list).toHaveBeenCalledWith({});
    });

    test('returns ok:false with message on throw', async () => {
      userMemoryService.list.mockImplementation(() => { throw new Error('boom'); });
      const r = await ipcMain._handlers['usermemory:list']({});
      expect(r).toEqual({ ok: false, error: 'boom' });
    });

    test('falls back to generic message when error has no message', async () => {
      userMemoryService.list.mockImplementation(() => { throw {}; });
      const r = await ipcMain._handlers['usermemory:list']({});
      expect(r).toEqual({ ok: false, error: 'list failed' });
    });
  });

  describe('usermemory:add', () => {
    test('adds and returns the new fact', async () => {
      const r = await ipcMain._handlers['usermemory:add']({}, { text: 'hi', pinned: true });
      expect(userMemoryService.add).toHaveBeenCalledWith('hi', { pinned: true });
      expect(r).toEqual({ ok: true, fact: { id: 'new', text: 'hi', pinned: true } });
    });

    test('returns empty_text when service returns falsy', async () => {
      userMemoryService.add.mockReturnValue(null);
      const r = await ipcMain._handlers['usermemory:add']({}, { text: '' });
      expect(r).toEqual({ ok: false, error: 'empty_text' });
    });

    test('defaults destructure when arg omitted', async () => {
      userMemoryService.add.mockReturnValue(null);
      const r = await ipcMain._handlers['usermemory:add']({});
      expect(userMemoryService.add).toHaveBeenCalledWith(undefined, { pinned: false });
      expect(r).toEqual({ ok: false, error: 'empty_text' });
    });

    test('returns ok:false on throw', async () => {
      userMemoryService.add.mockImplementation(() => { throw new Error('addboom'); });
      const r = await ipcMain._handlers['usermemory:add']({}, { text: 'x' });
      expect(r).toEqual({ ok: false, error: 'addboom' });
    });
  });

  describe('usermemory:edit', () => {
    test('edits and returns the fact', async () => {
      const r = await ipcMain._handlers['usermemory:edit']({}, { id: '1', patch: { text: 'z' } });
      expect(userMemoryService.edit).toHaveBeenCalledWith('1', { text: 'z' });
      expect(r).toEqual({ ok: true, fact: { id: '1', text: 'z' } });
    });

    test('returns not_found when service returns falsy', async () => {
      userMemoryService.edit.mockReturnValue(null);
      const r = await ipcMain._handlers['usermemory:edit']({}, { id: 'nope' });
      expect(userMemoryService.edit).toHaveBeenCalledWith('nope', {});
      expect(r).toEqual({ ok: false, error: 'not_found' });
    });

    test('returns ok:false on throw', async () => {
      userMemoryService.edit.mockImplementation(() => { throw new Error('editboom'); });
      const r = await ipcMain._handlers['usermemory:edit']({}, { id: '1' });
      expect(r).toEqual({ ok: false, error: 'editboom' });
    });
  });

  describe('usermemory:delete', () => {
    test('returns ok with service result', async () => {
      const r = await ipcMain._handlers['usermemory:delete']({}, 'id1');
      expect(userMemoryService.remove).toHaveBeenCalledWith('id1');
      expect(r).toEqual({ ok: true });
    });

    test('returns ok:false on throw', async () => {
      userMemoryService.remove.mockImplementation(() => { throw new Error('delboom'); });
      const r = await ipcMain._handlers['usermemory:delete']({}, 'id1');
      expect(r).toEqual({ ok: false, error: 'delboom' });
    });
  });

  describe('usermemory:archive', () => {
    test('archives when on=true (default)', async () => {
      const r = await ipcMain._handlers['usermemory:archive']({}, { id: '1' });
      expect(userMemoryService.archive).toHaveBeenCalledWith('1');
      expect(r).toEqual({ ok: true, fact: { id: '1', archived: true } });
    });

    test('unarchives when on=false', async () => {
      const r = await ipcMain._handlers['usermemory:archive']({}, { id: '2', on: false });
      expect(userMemoryService.unarchive).toHaveBeenCalledWith('2');
      expect(r).toEqual({ ok: true, fact: { id: '2', archived: false } });
    });

    test('returns not_found when service returns falsy', async () => {
      userMemoryService.archive.mockReturnValue(null);
      const r = await ipcMain._handlers['usermemory:archive']({}, { id: 'x' });
      expect(r).toEqual({ ok: false, error: 'not_found' });
    });

    test('returns ok:false on throw', async () => {
      userMemoryService.archive.mockImplementation(() => { throw new Error('arcboom'); });
      const r = await ipcMain._handlers['usermemory:archive']({}, { id: '1' });
      expect(r).toEqual({ ok: false, error: 'arcboom' });
    });
  });

  describe('usermemory:pin', () => {
    test('pins with on default true', async () => {
      const r = await ipcMain._handlers['usermemory:pin']({}, { id: '1' });
      expect(userMemoryService.pin).toHaveBeenCalledWith('1', true);
      expect(r).toEqual({ ok: true, fact: { id: '1', pinned: true } });
    });

    test('unpins when on=false', async () => {
      const r = await ipcMain._handlers['usermemory:pin']({}, { id: '1', on: false });
      expect(userMemoryService.pin).toHaveBeenCalledWith('1', false);
      expect(r).toEqual({ ok: true, fact: { id: '1', pinned: false } });
    });

    test('returns not_found when service returns falsy', async () => {
      userMemoryService.pin.mockReturnValue(undefined);
      const r = await ipcMain._handlers['usermemory:pin']({}, { id: 'x' });
      expect(r).toEqual({ ok: false, error: 'not_found' });
    });

    test('returns ok:false on throw', async () => {
      userMemoryService.pin.mockImplementation(() => { throw new Error('pinboom'); });
      const r = await ipcMain._handlers['usermemory:pin']({}, { id: '1' });
      expect(r).toEqual({ ok: false, error: 'pinboom' });
    });
  });

  describe('usermemory:enable', () => {
    test('coerces truthy to true', () => {
      ipcMain._handlers['usermemory:enable']({}, 1);
      expect(userMemoryService.enable).toHaveBeenCalledWith(true);
    });

    test('coerces falsy to false', () => {
      ipcMain._handlers['usermemory:enable']({}, 0);
      expect(userMemoryService.enable).toHaveBeenCalledWith(false);
    });
  });

  describe('usermemory:clear-all', () => {
    test('clears and returns ok', async () => {
      const r = await ipcMain._handlers['usermemory:clear-all']();
      expect(userMemoryService.clearAll).toHaveBeenCalled();
      expect(r).toEqual({ ok: true });
    });

    test('returns ok:false on throw', async () => {
      userMemoryService.clearAll.mockImplementation(() => { throw new Error('clrboom'); });
      const r = await ipcMain._handlers['usermemory:clear-all']();
      expect(r).toEqual({ ok: false, error: 'clrboom' });
    });
  });

  describe('usermemory:export', () => {
    test('returns no_config when configService missing', async () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { userMemoryService });
      const r = await ipcMain._handlers['usermemory:export']();
      expect(r).toEqual({ ok: false, error: 'no_config' });
    });

    test('returns canceled when dialog canceled', async () => {
      dialog.showSaveDialog.mockResolvedValue({ canceled: true });
      const r = await ipcMain._handlers['usermemory:export']();
      expect(r).toEqual({ ok: false, canceled: true });
    });

    test('returns canceled when no filePath', async () => {
      dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '' });
      const r = await ipcMain._handlers['usermemory:export']();
      expect(r).toEqual({ ok: false, canceled: true });
    });

    test('writes file and returns count on success', async () => {
      dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/mem.json' });
      userMemoryService.list.mockReturnValue([{ id: 'a' }, { id: 'b' }]);
      const r = await ipcMain._handlers['usermemory:export']();
      expect(userMemoryService.list).toHaveBeenCalledWith({ includeArchived: true });
      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.format).toBe(FORMAT);
      expect(written.facts).toHaveLength(2);
      expect(r).toEqual({ ok: true, path: '/out/mem.json', count: 2 });
    });

    test('returns ok:false when writeFileSync throws', async () => {
      dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/mem.json' });
      fs.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });
      const r = await ipcMain._handlers['usermemory:export']();
      expect(r).toEqual({ ok: false, error: 'disk full' });
    });
  });

  describe('usermemory:import', () => {
    test('returns no_config when configService missing', async () => {
      for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
      register(mainWindow, { userMemoryService });
      const r = await ipcMain._handlers['usermemory:import']({}, {});
      expect(r).toEqual({ ok: false, error: 'no_config' });
    });

    test('returns canceled when dialog canceled', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: true });
      const r = await ipcMain._handlers['usermemory:import']({}, {});
      expect(r).toEqual({ ok: false, canceled: true });
    });

    test('returns canceled when no filePaths', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
      const r = await ipcMain._handlers['usermemory:import']({}, {});
      expect(r).toEqual({ ok: false, canceled: true });
    });

    test('rejects unrecognized format', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in.json'] });
      fs.readFileSync.mockReturnValue(JSON.stringify({ format: 'other', facts: [] }));
      const r = await ipcMain._handlers['usermemory:import']({}, {});
      expect(r).toEqual({ ok: false, error: 'unrecognized_format' });
    });

    test('rejects when facts not an array', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in.json'] });
      fs.readFileSync.mockReturnValue(JSON.stringify({ format: FORMAT, facts: 'nope' }));
      const r = await ipcMain._handlers['usermemory:import']({}, {});
      expect(r).toEqual({ ok: false, error: 'unrecognized_format' });
    });

    test('replace mode calls replaceAll and counts all', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in.json'] });
      fs.readFileSync.mockReturnValue(JSON.stringify({ format: FORMAT, facts: [{ text: 'a' }, { text: 'b' }] }));
      const r = await ipcMain._handlers['usermemory:import']({}, { mode: 'replace' });
      expect(userMemoryService.replaceAll).toHaveBeenCalledWith([{ text: 'a' }, { text: 'b' }]);
      expect(r).toEqual({ ok: true, path: '/in.json', added: 2, skipped: 0 });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('config:changed', { kind: 'replace' });
    });

    test('merge mode dedupes existing + empty text', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in.json'] });
      userMemoryService.list.mockReturnValue([{ text: 'Existing' }]);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        format: FORMAT,
        facts: [{ text: 'existing' }, { text: '   ' }, { text: 'fresh', pinned: true }, { text: 'fresh' }],
      }));
      const r = await ipcMain._handlers['usermemory:import']({}, {});
      expect(userMemoryService.add).toHaveBeenCalledWith('fresh', { pinned: true, source: 'imported' });
      expect(userMemoryService.add).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ ok: true, path: '/in.json', added: 1, skipped: 3 });
    });

    test('merge mode defaults to merge when mode omitted', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in.json'] });
      userMemoryService.list.mockReturnValue([]);
      fs.readFileSync.mockReturnValue(JSON.stringify({ format: FORMAT, facts: [{ text: 'one' }] }));
      const r = await ipcMain._handlers['usermemory:import']({});
      expect(userMemoryService.add).toHaveBeenCalledWith('one', { pinned: false, source: 'imported' });
      expect(r.added).toBe(1);
    });

    test('returns ok:false when JSON parse throws', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in.json'] });
      fs.readFileSync.mockReturnValue('not json{');
      const r = await ipcMain._handlers['usermemory:import']({}, {});
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
    });

    test('send failure is swallowed (still returns ok)', async () => {
      mainWindow.webContents.send.mockImplementation(() => { throw new Error('send fail'); });
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in.json'] });
      userMemoryService.list.mockReturnValue([]);
      fs.readFileSync.mockReturnValue(JSON.stringify({ format: FORMAT, facts: [{ text: 'q' }] }));
      const r = await ipcMain._handlers['usermemory:import']({}, {});
      expect(r.ok).toBe(true);
    });
  });
});
