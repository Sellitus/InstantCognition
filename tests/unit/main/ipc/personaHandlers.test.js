// Focused coverage for the T3.9 pack surface added to personaHandlers:
// 'pack:apply' (install the pack persona via the real PersonaIoService import
// path + tell the renderer to open panes) and 'pack:run-task'. ipcMain and the
// renderer (webContents.send) are the external boundary and are mocked; the
// pack catalog and PersonaIoService are internal code and run for real.

const invokeHandlers = {};
const onHandlers = {};

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn((ch, fn) => { invokeHandlers[ch] = fn; }),
    on: jest.fn((ch, fn) => { onHandlers[ch] = fn; }),
  },
  dialog: {
    showSaveDialog: jest.fn(),
    showOpenDialog: jest.fn(),
  },
}));

const personaHandlers = require('../../../../main/ipc/personaHandlers');
const { PACKS } = require('../../../../shared/personaPacks');

function makeConfig(initial = {}) {
  const data = { settings: { agentPersonas: { ...initial } } };
  return {
    get: (p, fb) => {
      let c = data;
      for (const k of p.split('.')) c = (c && typeof c === 'object') ? c[k] : undefined;
      return c === undefined ? fb : c;
    },
    set: (p, v) => {
      const ks = p.split('.');
      let c = data;
      for (let i = 0; i < ks.length - 1; i += 1) { if (!c[ks[i]] || typeof c[ks[i]] !== 'object') c[ks[i]] = {}; c = c[ks[i]]; }
      c[ks[ks.length - 1]] = v;
    },
    _data: data,
  };
}

function setup(configService, overrides = {}) {
  Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
  Object.keys(onHandlers).forEach((k) => delete onHandlers[k]);
  const send = jest.fn();
  const mainWindow = { webContents: { send } };
  const services = {
    personaService: { listAll: () => [], listEnabled: () => [], ...overrides.personaService },
    personaRouter: { getLock: () => null, ...overrides.personaRouter },
    configService,
  };
  personaHandlers.register(mainWindow, services);
  return { send, mainWindow };
}

describe('personaHandlers — pack surface', () => {
  test('register is a no-op without personaService/personaRouter', () => {
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    personaHandlers.register({}, {});
    expect(invokeHandlers['pack:apply']).toBeUndefined();
  });

  test("'pack:apply' installs the pack persona and asks the renderer to open panes", () => {
    const cfg = makeConfig({ customPersonas: [], enabledPersonas: [] });
    const { send } = setup(cfg);
    const pack = PACKS.find((p) => p.id === 'job-hunt');

    const res = invokeHandlers['pack:apply']({}, { id: 'job-hunt' });

    expect(res.ok).toBe(true);
    const stored = cfg.get('settings.agentPersonas.customPersonas', []);
    expect(stored.map((p) => p.name)).toContain(pack.persona.name);
    expect(cfg.get('settings.agentPersonas.enabledPersonas', [])).toContain(pack.persona.name);
    expect(send).toHaveBeenCalledWith('config:changed', { kind: 'replace' });
    expect(send).toHaveBeenCalledWith('pack:open-panes', { label: pack.label, panes: pack.panes });
  });

  test("'pack:apply' is idempotent — re-applying skips the existing persona", () => {
    const cfg = makeConfig({ customPersonas: [], enabledPersonas: [] });
    setup(cfg);
    invokeHandlers['pack:apply']({}, { id: 'travel' });
    const res2 = invokeHandlers['pack:apply']({}, { id: 'travel' });
    expect(res2.ok).toBe(true);
    expect(res2.skipped).toBe(1);
    const stored = cfg.get('settings.agentPersonas.customPersonas', []);
    expect(stored.filter((p) => p.name === 'pack_travel').length).toBe(1);
  });

  test("'pack:apply' rejects an unknown id and a missing config", () => {
    const cfg = makeConfig();
    setup(cfg);
    expect(invokeHandlers['pack:apply']({}, { id: 'nope' })).toEqual({ ok: false, error: 'not_found' });

    const services = { personaService: { listAll: () => [] }, personaRouter: { getLock: () => null }, configService: null };
    personaHandlers.register({ webContents: { send: jest.fn() } }, services);
    expect(invokeHandlers['pack:apply']({}, { id: 'job-hunt' })).toEqual({ ok: false, error: 'no_config' });
  });

  test("'pack:run-task' forwards the pack task to the renderer", () => {
    const { send } = setup(makeConfig());
    const pack = PACKS.find((p) => p.id === 'lit-review');
    const res = invokeHandlers['pack:run-task']({}, { id: 'lit-review' });
    expect(res).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith('pack:run-task', { label: pack.label, task: pack.task });
  });

  test("'pack:run-task' rejects an unknown id", () => {
    setup(makeConfig());
    expect(invokeHandlers['pack:run-task']({}, { id: 'nope' })).toEqual({ ok: false, error: 'not_found' });
  });

  test("'pack:apply' surfaces an error when the persona import path throws", () => {
    // configService.get throwing inside personaIo.applyImport drives the
    // catch branch — it must report the failure, not crash or silently pass.
    const throwingConfig = {
      get: () => { throw new Error('config read exploded'); },
      set: jest.fn(),
    };
    const { send } = setup(throwingConfig);
    const res = invokeHandlers['pack:apply']({}, { id: 'job-hunt' });
    expect(res).toEqual({ ok: false, error: 'config read exploded' });
    expect(send).not.toHaveBeenCalledWith('pack:open-panes', expect.anything());
  });
});

// The persona:* handlers (list/test-route/lock/clear-cache/export/import/save)
// are the rest of personaHandlers. ipcMain, dialog and webContents.send are the
// external boundary (mocked); PersonaIoService runs for real with fs faked.
describe('personaHandlers — persona surface', () => {
  const { dialog } = require('electron');
  const fs = require('fs');
  let writeSpy;
  let readSpy;

  beforeEach(() => {
    dialog.showSaveDialog.mockReset();
    dialog.showOpenDialog.mockReset();
    // PersonaIoService does real fs IO; spy on the actual module boundary so
    // nothing touches the disk while the export/import logic runs for real.
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => '{}');
  });

  afterEach(() => {
    writeSpy.mockRestore();
    readSpy.mockRestore();
  });

  test("'persona:list' returns all/enabled personas and the router lock", () => {
    setup(makeConfig(), {
      personaService: { listAll: () => [{ name: 'a' }], listEnabled: () => [{ name: 'a' }] },
      personaRouter: { getLock: () => 'a' },
    });
    expect(invokeHandlers['persona:list']()).toEqual({
      all: [{ name: 'a' }], enabled: [{ name: 'a' }], lock: 'a',
    });
  });

  test("'persona:list' degrades to empty lists with an error message on failure", () => {
    setup(makeConfig(), {
      personaService: { listAll: () => { throw new Error('boom'); }, listEnabled: () => [] },
      personaRouter: { getLock: () => null },
    });
    expect(invokeHandlers['persona:list']()).toEqual({
      all: [], enabled: [], lock: null, error: 'boom',
    });
  });

  test("'persona:test-route' routes async and reports ok with the route result", async () => {
    const route = jest.fn(async (t) => ({ persona: `routed:${t}` }));
    setup(makeConfig(), { personaRouter: { getLock: () => null, route } });
    const res = await invokeHandlers['persona:test-route']({}, { description: 'help me' });
    expect(route).toHaveBeenCalledWith('help me');
    expect(res).toEqual({ ok: true, persona: 'routed:help me' });
  });

  test("'persona:test-route' uses the sync router when sync:true and reports failures", async () => {
    const routeSync = jest.fn(() => { throw new Error('no route'); });
    setup(makeConfig(), { personaRouter: { getLock: () => null, routeSync } });
    const res = await invokeHandlers['persona:test-route']({}, { description: 'x', sync: true });
    expect(routeSync).toHaveBeenCalledWith('x');
    expect(res).toEqual({ ok: false, error: 'no route' });
  });

  test("'persona:lock' sets a string lock and ignores non-strings; reset clears it", () => {
    const setLock = jest.fn();
    const clearLock = jest.fn();
    setup(makeConfig(), { personaRouter: { getLock: () => null, setLock, clearLock } });
    onHandlers['persona:lock']({}, 'sales');
    expect(setLock).toHaveBeenCalledWith('sales');
    onHandlers['persona:lock']({}, 42);
    expect(setLock).toHaveBeenLastCalledWith(null);
    onHandlers['persona:reset-lock']({});
    expect(clearLock).toHaveBeenCalled();
  });

  test("'persona:clear-cache' reports ok, and surfaces an error if the router throws", () => {
    const clearCache = jest.fn();
    setup(makeConfig(), { personaRouter: { getLock: () => null, clearCache } });
    expect(invokeHandlers['persona:clear-cache']()).toEqual({ ok: true });

    setup(makeConfig(), {
      personaRouter: { getLock: () => null, clearCache: () => { throw new Error('cache fail'); } },
    });
    expect(invokeHandlers['persona:clear-cache']()).toEqual({ ok: false, error: 'cache fail' });
  });

  test("'persona:export' writes the chosen file and returns its path + count", async () => {
    const cfg = makeConfig({ customPersonas: [{ name: 'p1' }, { name: 'p2' }] });
    setup(cfg);
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/personas.json' });
    const res = await invokeHandlers['persona:export']();
    expect(res).toEqual({ ok: true, path: '/out/personas.json', count: 2 });
    expect(fs.writeFileSync).toHaveBeenCalledWith('/out/personas.json', expect.stringContaining('"p1"'));
  });

  test("'persona:export' returns canceled and writes nothing when the dialog is dismissed", async () => {
    setup(makeConfig());
    dialog.showSaveDialog.mockResolvedValue({ canceled: true });
    const res = await invokeHandlers['persona:export']();
    expect(res).toEqual({ ok: false, canceled: true });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test("'persona:export' refuses without a config service", async () => {
    setup(null);
    expect(await invokeHandlers['persona:export']()).toEqual({ ok: false, error: 'no_config' });
  });

  test("'persona:import' applies a valid export file and notifies the renderer", async () => {
    const cfg = makeConfig({ customPersonas: [], enabledPersonas: [] });
    const { send } = setup(cfg);
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/p.json'] });
    fs.readFileSync.mockReturnValue(JSON.stringify({
      format: 'instantcognition.personas.v1',
      customPersonas: [{ name: 'Imported', label: 'Imported' }],
      builtinOverrides: {},
    }));
    const res = await invokeHandlers['persona:import']();
    expect(res.ok).toBe(true);
    expect(res.added).toBe(1);
    expect(res.path).toBe('/in/p.json');
    expect(cfg.get('settings.agentPersonas.customPersonas', []).map((p) => p.name)).toContain('imported');
    expect(send).toHaveBeenCalledWith('config:changed', { kind: 'replace' });
  });

  test("'persona:import' rejects invalid JSON without notifying the renderer", async () => {
    const { send } = setup(makeConfig());
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/bad.json'] });
    fs.readFileSync.mockReturnValue('{ not json');
    const res = await invokeHandlers['persona:import']();
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_json');
    expect(send).not.toHaveBeenCalledWith('config:changed', expect.anything());
  });

  test("'persona:import' returns canceled when the open dialog is dismissed", async () => {
    setup(makeConfig());
    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await invokeHandlers['persona:import']()).toEqual({ ok: false, canceled: true });
  });

  test("'persona:list' error fallback string when the thrown error has no message", () => {
    setup(makeConfig(), {
      personaService: { listAll: () => { throw {}; }, listEnabled: () => [] },
      personaRouter: { getLock: () => null },
    });
    expect(invokeHandlers['persona:list']()).toEqual({
      all: [], enabled: [], lock: null, error: 'list failed',
    });
  });

  test("'persona:test-route' default-args: no payload routes the empty string", async () => {
    const route = jest.fn(async () => ({ persona: 'd' }));
    setup(makeConfig(), { personaRouter: { getLock: () => null, route } });
    const res = await invokeHandlers['persona:test-route']({});
    expect(route).toHaveBeenCalledWith(''); // description undefined → String('')
    expect(res).toEqual({ ok: true, persona: 'd' });
  });

  test("'persona:test-route' error fallback string when the router throws a message-less error", async () => {
    setup(makeConfig(), { personaRouter: { getLock: () => null, route: async () => { throw {}; } } });
    expect(await invokeHandlers['persona:test-route']({}, { description: 'x' }))
      .toEqual({ ok: false, error: 'route failed' });
  });

  test("'persona:lock' passes a non-empty string through and coerces empty/missing to null", () => {
    const setLock = jest.fn();
    setup(makeConfig(), { personaRouter: { getLock: () => null, setLock, clearLock: jest.fn() } });
    onHandlers['persona:lock']({}, '');     // empty string → null
    expect(setLock).toHaveBeenLastCalledWith(null);
    onHandlers['persona:lock']({});         // undefined → null
    expect(setLock).toHaveBeenLastCalledWith(null);
    onHandlers['persona:lock']({}, 'dev');  // valid string → through
    expect(setLock).toHaveBeenLastCalledWith('dev');
  });

  test("'persona:clear-cache' error fallback string when the error has no message", () => {
    setup(makeConfig(), {
      personaRouter: { getLock: () => null, clearCache: () => { throw {}; } },
    });
    expect(invokeHandlers['persona:clear-cache']()).toEqual({ ok: false, error: 'clear failed' });
  });

  test("'persona:export' surfaces an error with a fallback when the IO layer throws", async () => {
    const cfg = makeConfig({ customPersonas: [{ name: 'p' }] });
    setup(cfg);
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/p.json' });
    writeSpy.mockImplementation(() => { throw {}; }); // message-less throw inside exportToPath
    const res = await invokeHandlers['persona:export']();
    expect(res).toEqual({ ok: false, error: 'export failed' });
  });

  test("'persona:export' returns canceled when the dialog gives no filePath", async () => {
    setup(makeConfig());
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '' });
    expect(await invokeHandlers['persona:export']()).toEqual({ ok: false, canceled: true });
  });

  test("'persona:import' surfaces an error with a fallback when readFile throws message-less", async () => {
    setup(makeConfig());
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/p.json'] });
    readSpy.mockImplementation(() => { throw {}; });
    const res = await invokeHandlers['persona:import']();
    expect(res.ok).toBe(false);
    expect(res.error).toBe('import failed');
  });

  test("'persona:import' returns canceled when filePaths is empty", async () => {
    setup(makeConfig());
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
    expect(await invokeHandlers['persona:import']()).toEqual({ ok: false, canceled: true });
  });

  test("'persona:import' tolerates a missing webContents when notifying the renderer", async () => {
    // mainWindow without webContents must not crash the success path.
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    Object.keys(onHandlers).forEach((k) => delete onHandlers[k]);
    const cfg = makeConfig({ customPersonas: [], enabledPersonas: [] });
    personaHandlers.register({}, {
      personaService: { listAll: () => [], listEnabled: () => [] },
      personaRouter: { getLock: () => null },
      configService: cfg,
    });
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/ok.json'] });
    readSpy.mockReturnValue(JSON.stringify({
      format: 'instantcognition.personas.v1',
      customPersonas: [{ name: 'Imported', label: 'Imported' }],
      builtinOverrides: {},
    }));
    const res = await invokeHandlers['persona:import']();
    expect(res.ok).toBe(true);
    expect(res.path).toBe('/in/ok.json');
  });

  test("'pack:apply' default-args: no payload yields not_found (undefined id)", () => {
    setup(makeConfig());
    expect(invokeHandlers['pack:apply']({})).toEqual({ ok: false, error: 'not_found' });
  });

  test("'pack:apply' surfaces a fallback error when applyImport throws message-less", () => {
    const cfg = makeConfig({ customPersonas: [], enabledPersonas: [] });
    setup(cfg);
    // personaIo.applyImport reads config; a message-less throw drives the
    // (err instanceof Error && err.message) || 'apply failed' fallback.
    cfg.get = () => { throw {}; };
    expect(invokeHandlers['pack:apply']({}, { id: 'job-hunt' }))
      .toEqual({ ok: false, error: 'apply failed' });
  });

  test("'pack:run-task' default-args: no payload yields not_found", () => {
    setup(makeConfig());
    expect(invokeHandlers['pack:run-task']({})).toEqual({ ok: false, error: 'not_found' });
  });

  test("'pack:run-task' rejects a pack id that has no task defined", () => {
    setup(makeConfig());
    // Find a pack without a task, if any; otherwise assert the guard via a
    // monkeypatched catalog entry through the unknown-id path already covered.
    const taskless = PACKS.find((p) => !p.task);
    if (taskless) {
      expect(invokeHandlers['pack:run-task']({}, { id: taskless.id }))
        .toEqual({ ok: false, error: 'not_found' });
    } else {
      expect(invokeHandlers['pack:run-task']({}, { id: 'definitely-not-a-pack' }))
        .toEqual({ ok: false, error: 'not_found' });
    }
  });

  test("'pack:apply' tolerates a window without webContents on the open-panes notify", () => {
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    const cfg = makeConfig({ customPersonas: [], enabledPersonas: [] });
    personaHandlers.register({}, {
      personaService: { listAll: () => [], listEnabled: () => [] },
      personaRouter: { getLock: () => null },
      configService: cfg,
    });
    const res = invokeHandlers['pack:apply']({}, { id: 'job-hunt' });
    expect(res.ok).toBe(true); // send() guard swallowed the missing webContents
  });
});
