// spacesV2Handlers — add/remove/reset channels for the in-settings spaces editor.

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: { on: jest.fn((channel, fn) => { mockHandlers.set(channel, fn); }) },
}));

function fakeConfigService(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial));
  return {
    get: jest.fn((path, fb) => {
      const parts = String(path).split('.');
      let cur = store;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return fb;
        cur = cur[p];
      }
      return cur === undefined ? fb : cur;
    }),
    set: jest.fn((path, value) => {
      const parts = String(path).split('.');
      let cur = store;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }),
  };
}

function fakeMainWindow() { return { isDestroyed: () => false, webContents: { send: jest.fn() } }; }

function loadHandlers(mainWindow, configService) {
  mockHandlers.clear();
  jest.isolateModules(() => {
    const mod = require('../../../../main/ipc/spacesV2Handlers');
    mod.register(mainWindow, { configService });
  });
}

describe('spacesV2Handlers', () => {
  test('spaces:add writes a new entry and broadcasts it', () => {
    const cs = fakeConfigService({ spaces: {} });
    const mw = fakeMainWindow();
    loadHandlers(mw, cs);
    mockHandlers.get('spaces:add')({}, { name: 'TestEngine', url: 'https://example.com', type: 'web-page' });
    const setCall = cs.set.mock.calls[0];
    expect(setCall[0]).toMatch(/^spaces\.custom\d+$/);
    expect(setCall[1]).toEqual({ name: 'TestEngine', url: 'https://example.com', type: 'web-page' });
    expect(mw.webContents.send).toHaveBeenCalledWith('config:changed', expect.objectContaining({ kind: 'set' }));
  });

  test('spaces:add ignores invalid payloads', () => {
    const cs = fakeConfigService({});
    loadHandlers(fakeMainWindow(), cs);
    mockHandlers.get('spaces:add')({}, null);
    mockHandlers.get('spaces:add')({}, 'not an object');
    expect(cs.set).not.toHaveBeenCalled();
  });

  test('spaces:remove deletes an existing entry and broadcasts the new map', () => {
    const cs = fakeConfigService({ spaces: { keep: { name: 'k' }, gone: { name: 'g' } } });
    const mw = fakeMainWindow();
    loadHandlers(mw, cs);
    mockHandlers.get('spaces:remove')({}, 'gone');
    expect(cs.set).toHaveBeenCalledWith('spaces', { keep: { name: 'k' } });
    expect(mw.webContents.send).toHaveBeenCalled();
  });

  test('spaces:remove no-ops when id does not exist', () => {
    const cs = fakeConfigService({ spaces: { only: { name: 'o' } } });
    loadHandlers(fakeMainWindow(), cs);
    mockHandlers.get('spaces:remove')({}, 'unknown');
    expect(cs.set).not.toHaveBeenCalled();
  });

  test('spaces:remove strips the id from the persisted tab model', () => {
    const cs = fakeConfigService({
      spaces: { gone: { name: 'g' }, keep: { name: 'k' } },
      state: {
        openTabs: ['keep', 'gone'],
        hiddenTabs: ['gone'],
        pinnedTabs: ['gone'],
        activeSpaces: ['keep', 'gone'],
        currentSpaceId: 'other',
      },
    });
    loadHandlers(fakeMainWindow(), cs);
    mockHandlers.get('spaces:remove')({}, 'gone');

    const stateWrite = cs.set.mock.calls.find((c) => c[0] === 'state');
    expect(stateWrite).toBeDefined();
    expect(stateWrite[1].openTabs).toEqual(['keep']);
    expect(stateWrite[1].hiddenTabs).toEqual([]);
    expect(stateWrite[1].pinnedTabs).toEqual([]);
    expect(stateWrite[1].activeSpaces).toEqual(['keep']);
    expect(stateWrite[1].currentSpaceId).toBe('other');
  });

  test('spaces:remove re-points currentSpaceId when the removed space was current', () => {
    const cs = fakeConfigService({
      spaces: { gone: { name: 'g' }, keep: { name: 'k' } },
      state: { openTabs: ['gone', 'keep'], currentSpaceId: 'gone' },
    });
    loadHandlers(fakeMainWindow(), cs);
    mockHandlers.get('spaces:remove')({}, 'gone');

    const stateWrite = cs.set.mock.calls.find((c) => c[0] === 'state');
    expect(stateWrite).toBeDefined();
    expect(stateWrite[1].openTabs).toEqual(['keep']);
    expect(stateWrite[1].currentSpaceId).toBe('keep');
  });

  test('spaces:remove leaves the tab model alone when the id is not an open tab', () => {
    const cs = fakeConfigService({
      spaces: { gone: { name: 'g' } },
      state: { openTabs: ['custom1'], currentSpaceId: 'custom1' },
    });
    loadHandlers(fakeMainWindow(), cs);
    mockHandlers.get('spaces:remove')({}, 'gone');

    // Only the spaces map write; the untouched tab model gets no 'state' write.
    const stateWrites = cs.set.mock.calls.filter((c) => c[0] === 'state');
    expect(stateWrites).toHaveLength(0);
  });

  test('spaces:remove clears currentSpaceId to "" when it was the only open tab', () => {
    const cs = fakeConfigService({
      spaces: { gone: { name: 'g' } },
      state: { openTabs: ['gone'], currentSpaceId: 'gone' },
    });
    loadHandlers(fakeMainWindow(), cs);
    mockHandlers.get('spaces:remove')({}, 'gone');

    const stateWrite = cs.set.mock.calls.find((c) => c[0] === 'state');
    expect(stateWrite).toBeDefined();
    expect(stateWrite[1].openTabs).toEqual([]);
    expect(stateWrite[1].currentSpaceId).toBe('');
  });

  test('spaces:reset replaces with DEFAULT_CONFIG.spaces and broadcasts', () => {
    const cs = fakeConfigService({ spaces: { custom999: { name: 'wiped' } } });
    const mw = fakeMainWindow();
    loadHandlers(mw, cs);
    mockHandlers.get('spaces:reset')({});
    expect(cs.set).toHaveBeenCalledWith('spaces', expect.any(Object));
    const fresh = cs.set.mock.calls[0][1];
    // DEFAULT_CONFIG.spaces should include the bundled AI services.
    expect(Object.keys(fresh).length).toBeGreaterThan(5);
    expect(mw.webContents.send).toHaveBeenCalled();
  });
});
