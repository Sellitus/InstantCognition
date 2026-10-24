// projectHandlers — the Projects settings tab talks to ProjectService only
// through these channels. Every one must answer with a {ok:...} shape, even
// when the service throws, or the panel silently shows nothing.

const handlers = {};

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn((channel, handler) => { handlers[channel] = handler; }) },
}));

const { register } = require('../../../../main/ipc/projectHandlers');

function makeService(overrides = {}) {
  return {
    list: jest.fn(() => [{ id: 'p1', name: 'Notes' }]),
    create: jest.fn(async () => ({ ok: true, project: { id: 'p1' } })),
    rename: jest.fn(async () => ({ ok: true })),
    setContext: jest.fn(async () => ({ ok: true })),
    delete: jest.fn(async () => ({ ok: true })),
    files: jest.fn(async () => ({ ok: true, files: [] })),
    read: jest.fn(async () => ({ file: { id: 'f1' }, text: 'hello', imagePath: null, dataUrl: null })),
    addFile: jest.fn(async () => ({ ok: true })),
    addImage: jest.fn(async () => ({ ok: true })),
    removeFile: jest.fn(async () => ({ ok: true })),
    screenshotActive: jest.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe('projectHandlers', () => {
  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete handlers[key];
  });

  test('no projectService means no channels — the panel is simply absent', () => {
    register({}, {});
    expect(Object.keys(handlers)).toHaveLength(0);
  });

  test('every project channel is registered', () => {
    register({}, { projectService: makeService() });
    expect(Object.keys(handlers).sort()).toEqual([
      'projects:addFile', 'projects:addImage', 'projects:create', 'projects:delete',
      'projects:files', 'projects:list', 'projects:read', 'projects:removeFile',
      'projects:rename', 'projects:screenshotActive', 'projects:setContext',
    ]);
  });

  test('list wraps the service array in an ok envelope', async () => {
    const projectService = makeService();
    register({}, { projectService });
    expect(await handlers['projects:list']({}, {})).toEqual({ ok: true, projects: [{ id: 'p1', name: 'Notes' }] });
  });

  test('mutating channels forward their argument to the service', async () => {
    const projectService = makeService();
    register({}, { projectService });

    await handlers['projects:create']({}, { name: 'New' });
    await handlers['projects:rename']({}, { projectId: 'p1', name: 'Renamed' });
    await handlers['projects:removeFile']({}, { projectId: 'p1', fileId: 'f1' });

    expect(projectService.create).toHaveBeenCalledWith({ name: 'New' });
    expect(projectService.rename).toHaveBeenCalledWith({ projectId: 'p1', name: 'Renamed' });
    expect(projectService.removeFile).toHaveBeenCalledWith({ projectId: 'p1', fileId: 'f1' });
  });

  test('a missing argument becomes an empty object rather than undefined', async () => {
    const projectService = makeService();
    register({}, { projectService });
    await handlers['projects:delete']({});
    expect(projectService.delete).toHaveBeenCalledWith({});
  });

  test('read unwraps the service result into the renderer shape', async () => {
    const projectService = makeService();
    register({}, { projectService });
    expect(await handlers['projects:read']({}, { projectId: 'p1', fileId: 'f1' }))
      .toEqual({ ok: true, file: { id: 'f1' }, text: 'hello', imagePath: null, dataUrl: null });
    expect(projectService.read).toHaveBeenCalledWith('p1', 'f1');
  });

  test('a missing file reads as not_found, not as an empty success', async () => {
    const projectService = makeService({ read: jest.fn(async () => null) });
    register({}, { projectService });
    expect(await handlers['projects:read']({}, { projectId: 'p1', fileId: 'nope' }))
      .toEqual({ ok: false, error: 'not_found' });
  });

  test('a throwing service surfaces its message instead of rejecting the invoke', async () => {
    const projectService = makeService({ addFile: jest.fn(async () => { throw new Error('disk full'); }) });
    register({}, { projectService });
    expect(await handlers['projects:addFile']({}, { projectId: 'p1' }))
      .toEqual({ ok: false, error: 'disk full' });
  });

  test('a non-Error throw still produces a shaped failure', async () => {
    const projectService = makeService({ screenshotActive: jest.fn(async () => { throw 'nope'; }) });
    register({}, { projectService });
    expect(await handlers['projects:screenshotActive']({}, {}))
      .toEqual({ ok: false, error: 'failed' });
  });
});
