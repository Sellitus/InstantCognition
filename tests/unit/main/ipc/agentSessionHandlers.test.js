jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      handle: jest.fn((ch, fn) => { handlers[ch] = fn; }),
      _handlers: handlers,
    },
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain } = require('electron');
const { register, insideConfiguredRoot } = require('../../../../main/ipc/agentSessionHandlers');
const { createSessionStore } = require('../../../../main/agent/sessions/sessionStore');
const { createCheckpointStore } = require('../../../../main/agent/checkpoints/checkpointStore');

const invoke = (ch, arg) => ipcMain._handlers[ch]({}, arg);

describe('agentSessionHandlers', () => {
  let dir;
  let store;
  let win;
  let busy;
  let roots;

  beforeEach(() => {
    for (const k of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sesshdl-'));
    store = createSessionStore({ baseDir: path.join(dir, 'sessions') });
    win = { isDestroyed: () => false, webContents: { send: jest.fn() } };
    busy = [];
    roots = [path.join(dir, 'ws')];
    const mockConfig = { get: (key, fallback) => (key === 'settings.llm.agent' ? { workspace: { roots } } : fallback) };
    const sessionManager = { isBusy: (sessionId) => busy.includes(sessionId), pendingPlan: () => null, forget: jest.fn() };
    register(win, { sessionStore: store, sessionManager, configService: mockConfig });
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('does nothing without a session store', () => {
    for (const k of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[k];
    register(win, {});
    expect(Object.keys(ipcMain._handlers)).toEqual([]);
  });

  test('create / list / get / rename / pin / set-project round-trip and push list-changed', async () => {
    const created = await invoke('session:create', { title: 'Trip' });
    expect(created).toMatchObject({ ok: true, session: { title: 'Trip' } });
    const id = created.session.id;
    expect(win.webContents.send).toHaveBeenCalledWith('session:list-changed', { sessionId: id, reason: 'created' });
    await expect(invoke('session:rename', { sessionId: id, title: 'Trip v2' })).resolves.toMatchObject({ ok: true, session: { title: 'Trip v2' } });
    await expect(invoke('session:pin', { sessionId: id, pinned: true })).resolves.toMatchObject({ session: { pinned: true } });
    await expect(invoke('session:set-project', { sessionId: id, projectId: 'p1' })).resolves.toMatchObject({ session: { projectId: 'p1' } });
    const list = await invoke('session:list');
    expect(list.sessions.map((s) => s.id)).toEqual([id]);
    await expect(invoke('session:get', { sessionId: id })).resolves.toMatchObject({ ok: true, meta: { id }, path: [], pendingPlan: null });
  });

  test('workspace roots must lie inside a configured root', async () => {
    const { session } = await invoke('session:create', {});
    const inside = path.join(roots[0], 'sub');
    await expect(invoke('session:set-workspace', { sessionId: session.id, root: inside })).resolves.toMatchObject({ ok: true, session: { workspaceRoot: inside } });
    await expect(invoke('session:set-workspace', { sessionId: session.id, root: path.join(dir, 'elsewhere') })).resolves.toEqual({ ok: false, error: 'root_not_configured' });
    await expect(invoke('session:set-workspace', { sessionId: session.id, root: `${roots[0]}/../escape` })).resolves.toEqual({ ok: false, error: 'root_not_configured' });
    await expect(invoke('session:set-workspace', { sessionId: session.id, root: 'relative' })).resolves.toEqual({ ok: false, error: 'root_not_configured' });
    await expect(invoke('session:create', { workspaceRoot: '/etc' })).resolves.toEqual({ ok: false, error: 'root_not_configured' });
    await expect(invoke('session:set-workspace', { sessionId: session.id, root: null })).resolves.toMatchObject({ session: { workspaceRoot: null } });
    expect(insideConfiguredRoot(roots[0], { get: () => ({ workspace: { roots } }) })).toBe(true);
  });

  test('edit / regenerate / branch / fork drive the message tree', async () => {
    const { session } = await invoke('session:create', {});
    const u = store.append(session.id, { role: 'user', content: 'q' });
    const a = store.append(session.id, { role: 'assistant', content: 'a' });
    const edited = await invoke('session:edit', { sessionId: session.id, nodeId: u.id, content: 'q2' });
    expect(edited).toMatchObject({ ok: true, node: { parentId: null, content: 'q2' } });
    const back = await invoke('session:branch', { sessionId: session.id, nodeId: u.id });
    expect(back.path).toEqual([u.id, a.id]);
    await expect(invoke('session:regenerate', { sessionId: session.id, nodeId: a.id })).resolves.toMatchObject({ node: { id: u.id } });
    const forked = await invoke('session:fork', { sessionId: session.id, nodeId: u.id });
    expect(forked.session.forkedFrom).toEqual({ sessionId: session.id, nodeId: u.id });
  });

  test('tree edits and delete refuse a running session', async () => {
    const { session } = await invoke('session:create', {});
    const u = store.append(session.id, { role: 'user', content: 'q' });
    busy.push(session.id);
    await expect(invoke('session:delete', { sessionId: session.id })).resolves.toEqual({ ok: false, error: 'session_busy' });
    await expect(invoke('session:edit', { sessionId: session.id, nodeId: u.id, content: 'x' })).resolves.toEqual({ ok: false, error: 'session_busy' });
    await expect(invoke('session:rewind', { sessionId: session.id, turnId: u.id })).resolves.toEqual({ ok: false, error: 'session_busy' });
    busy.length = 0;
    await expect(invoke('session:delete', { sessionId: session.id })).resolves.toEqual({ ok: true });
    expect(store.exists(session.id)).toBe(false);
  });

  describe('delete with a checkpoint store', () => {
    let cpDir;
    let checkpointStore;
    const seedCheckpoint = (sid) => {
      fs.mkdirSync(path.join(cpDir, sid, 'n_turn001'), { recursive: true });
      fs.writeFileSync(path.join(cpDir, sid, 'n_turn001', 'manifest.json'), '{}');
    };

    beforeEach(() => {
      for (const k of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[k];
      cpDir = path.join(dir, 'checkpoints');
      checkpointStore = createCheckpointStore({ rootDir: cpDir, getSettings: () => ({}) });
      const sessionManager = { isBusy: (sessionId) => busy.includes(sessionId), pendingPlan: () => null, forget: jest.fn() };
      register(win, { sessionStore: store, sessionManager, checkpointStore });
    });

    test("removes the session's checkpoint dir and keeps other sessions'", async () => {
      const a = (await invoke('session:create', {})).session.id;
      const b = (await invoke('session:create', {})).session.id;
      seedCheckpoint(a);
      seedCheckpoint(b);
      await expect(invoke('session:delete', { sessionId: a })).resolves.toEqual({ ok: true });
      expect(store.exists(a)).toBe(false);
      expect(fs.existsSync(path.join(cpDir, a))).toBe(false);
      expect(fs.existsSync(path.join(cpDir, b, 'n_turn001', 'manifest.json'))).toBe(true);
    });

    test('a running session keeps both its tree and its checkpoints', async () => {
      const a = (await invoke('session:create', {})).session.id;
      seedCheckpoint(a);
      busy.push(a);
      await expect(invoke('session:delete', { sessionId: a })).resolves.toEqual({ ok: false, error: 'session_busy' });
      expect(store.exists(a)).toBe(true);
      expect(fs.existsSync(path.join(cpDir, a, 'n_turn001', 'manifest.json'))).toBe(true);
    });

    test('an unknown session removes nothing', async () => {
      seedCheckpoint('s_missing1');
      await expect(invoke('session:delete', { sessionId: 's_missing1' })).resolves.toEqual({ ok: false, error: 'session_not_found' });
      expect(fs.existsSync(path.join(cpDir, 's_missing1', 'n_turn001'))).toBe(true);
    });

    test('a checkpoint removal failure is reported after the session is deleted', async () => {
      const a = (await invoke('session:create', {})).session.id;
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        fs.mkdirSync(path.dirname(cpDir), { recursive: true });
        fs.writeFileSync(cpDir, 'not a directory');
        const res = await invoke('session:delete', { sessionId: a });
        expect(res.ok).toBe(true);
        expect(res.checkpointError).toMatch(/ENOTDIR/);
        expect(store.exists(a)).toBe(false);
        expect(err).toHaveBeenCalled();
      } finally { err.mockRestore(); }
    });
  });

  test('malformed input is rejected before reaching the store', async () => {
    await expect(invoke('session:get', { sessionId: '../../etc' })).resolves.toEqual({ ok: false, error: 'invalid_session_id' });
    await expect(invoke('session:get', null)).resolves.toEqual({ ok: false, error: 'invalid_session_id' });
    await expect(invoke('session:create', { title: 42 })).resolves.toEqual({ ok: false, error: 'invalid_title' });
    await expect(invoke('session:create', { title: 'x'.repeat(201) })).resolves.toEqual({ ok: false, error: 'invalid_title' });
    const { session } = await invoke('session:create', {});
    await expect(invoke('session:edit', { sessionId: session.id, nodeId: 'n_abcdef12', content: '' })).resolves.toEqual({ ok: false, error: 'invalid_content' });
    await expect(invoke('session:branch', { sessionId: session.id, nodeId: 'x' })).resolves.toEqual({ ok: false, error: 'invalid_node_id' });
    await expect(invoke('session:pin', { sessionId: session.id, pinned: 'yes' })).resolves.toEqual({ ok: false, error: 'invalid_pinned' });
    await expect(invoke('session:set-project', { sessionId: session.id, projectId: '../p' })).resolves.toEqual({ ok: false, error: 'invalid_project_id' });
    await expect(invoke('session:delete', { sessionId: 's_missing1' })).resolves.toEqual({ ok: false, error: 'session_not_found' });
  });

  test('rewind without a checkpoint store reports checkpoints_unavailable after validating the turn', async () => {
    const { session } = await invoke('session:create', {});
    const u = store.append(session.id, { role: 'user', content: 'q' });
    await expect(invoke('session:rewind', { sessionId: session.id, turnId: u.id, files: 'no' })).resolves.toEqual({ ok: false, error: 'invalid_files_flag' });
    await expect(invoke('session:rewind', { sessionId: session.id, turnId: u.id })).resolves.toEqual({ ok: false, error: 'checkpoints_unavailable' });
    expect(store.get(session.id).meta.headId).toBe(u.id);
  });
});
