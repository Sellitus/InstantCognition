const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionStore, assertSessionId, assertNodeId } = require('../../../../../main/agent/sessions/sessionStore');

describe('sessionStore', () => {
  let baseDir;
  let store;
  let clock;
  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sessions-'));
    clock = 1000;
    store = createSessionStore({ baseDir, now: () => ++clock });
  });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  const reopen = () => createSessionStore({ baseDir });

  test('create writes meta.json and an empty nodes.jsonl; append persists across instances', () => {
    const meta = store.create({ source: 'agent' });
    expect(meta.id).toMatch(/^s_[a-z0-9]+$/);
    expect(fs.readFileSync(path.join(baseDir, meta.id, 'nodes.jsonl'), 'utf8')).toBe('');
    const u = store.append(meta.id, { role: 'user', content: 'Plan my trip\nsecond line' });
    const a = store.append(meta.id, { role: 'assistant', content: 'Sure.' });
    expect(a.parentId).toBe(u.id);
    const fresh = reopen().get(meta.id);
    expect(fresh.meta.headId).toBe(a.id);
    expect(fresh.meta.title).toBe('Plan my trip');
    expect(fresh.meta.source).toBe('agent');
    expect(fresh.path).toEqual([u.id, a.id]);
    expect(fresh.corruptLines).toBe(0);
  });

  test('edit adds a sibling user node and branch() switches between the branches', () => {
    const { id } = store.create();
    const u1 = store.append(id, { role: 'user', content: 'first' });
    const a1 = store.append(id, { role: 'assistant', content: 'one' });
    const u2 = store.edit(id, u1.id, 'first, edited');
    expect(u2.parentId).toBeNull();
    expect(u2.data).toEqual({ editedFrom: u1.id });
    const a2 = store.append(id, { role: 'assistant', content: 'two' });
    let view = store.get(id);
    expect(view.path).toEqual([u2.id, a2.id]);
    expect(view.branches[u2.id]).toEqual({ index: 1, count: 2, siblingIds: [u1.id, u2.id] });
    view = store.branch(id, u1.id);
    expect(view.path).toEqual([u1.id, a1.id]);
    expect(reopen().get(id).path).toEqual([u1.id, a1.id]);
  });

  test('regenerate points head at the answered user node so the next answer is a sibling', () => {
    const { id } = store.create();
    const u = store.append(id, { role: 'user', content: 'q' });
    const a1 = store.append(id, { role: 'assistant', content: 'a1' });
    expect(store.regenerate(id, a1.id).id).toBe(u.id);
    const a2 = store.append(id, { role: 'assistant', content: 'a2' });
    expect(a2.parentId).toBe(u.id);
    expect(store.get(id).branches[a2.id].count).toBe(2);
  });

  test('an edited message keeps the lane of the one it replaces so its answer reruns in that lane', () => {
    const { id } = store.create();
    const u1 = store.append(id, { role: 'user', content: 'chat q', data: { lane: 'chat', attachments: [{ name: 'a.png' }] } });
    const u2 = store.edit(id, u1.id, 'chat q, edited');
    expect(u2.data).toEqual({ lane: 'chat', editedFrom: u1.id });
  });

  test('regenerate on an agent answer that followed tool calls finds the user turn above them', () => {
    const { id } = store.create();
    const u = store.append(id, { role: 'user', content: 'list files' });
    store.append(id, { role: 'assistant', kind: 'tool_calls', content: '', data: { calls: [{ id: 'c1', name: 'fs.list', args: {} }] } });
    store.append(id, { role: 'tool', kind: 'tool_results', content: '', data: { results: [{ id: 'c1', name: 'fs.list', content: '[]' }] } });
    const answer = store.append(id, { role: 'assistant', content: 'Nothing there.' });
    expect(store.regenerate(id, answer.id).id).toBe(u.id);
    expect(store.get(id).meta.headId).toBe(u.id);
  });

  test('fork copies the path into a new session and leaves the source untouched', () => {
    const src = store.create({ title: 'Source' });
    const u = store.append(src.id, { role: 'user', content: 'q' });
    store.append(src.id, { role: 'assistant', content: 'a' });
    const before = fs.readFileSync(path.join(baseDir, src.id, 'nodes.jsonl'), 'utf8');
    const forked = store.fork(src.id, u.id);
    expect(forked.forkedFrom).toEqual({ sessionId: src.id, nodeId: u.id });
    expect(forked.title).toBe('Source (fork)');
    expect(store.getPath(forked.id).map((n) => n.content)).toEqual(['q']);
    expect(fs.readFileSync(path.join(baseDir, src.id, 'nodes.jsonl'), 'utf8')).toBe(before);
  });

  test('rename / pin / setProject / setWorkspace update meta; list orders pinned first', () => {
    const a = store.create({ title: 'A' });
    const b = store.create({ title: 'B' });
    store.rename(a.id, '  Renamed   title ');
    store.pin(a.id, true);
    store.setProject(b.id, 'proj_1');
    store.setWorkspace(b.id, path.join(baseDir, 'ws'));
    const rows = reopen().list();
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(rows[0]).toMatchObject({ title: 'Renamed title', pinned: true });
    expect(rows[1]).toMatchObject({ projectId: 'proj_1', workspaceRoot: path.join(baseDir, 'ws') });
  });

  test('delete removes the session directory and emits changed', () => {
    const { id } = store.create();
    fs.writeFileSync(path.join(baseDir, id, 'artifact.json'), '{}');
    const events = [];
    store.on('changed', (e) => events.push(e));
    expect(store.delete(id)).toBe(true);
    expect(fs.existsSync(path.join(baseDir, id))).toBe(false);
    expect(events).toEqual([{ sessionId: id, reason: 'deleted' }]);
    expect(() => store.delete(id)).toThrow('session_not_found');
  });

  test('corrupt and duplicate jsonl lines are counted and listed, not skipped silently', () => {
    const { id } = store.create();
    const u = store.append(id, { role: 'user', content: 'ok' });
    const file = path.join(baseDir, id, 'nodes.jsonl');
    fs.appendFileSync(file, `{not json\n${JSON.stringify({ id: 'bad', role: 'user', kind: 'message', content: 'x', parentId: null })}\n${JSON.stringify(u)}\n`);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const view = reopen().get(id);
      expect(view.corruptLines).toBe(3);
      expect(view.corrupt.map((c) => c.line)).toEqual([2, 3, 4]);
      expect(view.corrupt[0].reason).toMatch(/^parse_error/);
      expect(view.corrupt[1].reason).toBe('invalid_node');
      expect(view.corrupt[2].reason).toBe('duplicate_id');
      expect(view.path).toEqual([u.id]);
      expect(reopen().list()[0].corruptLines).toBe(3);
      expect(errSpy).toHaveBeenCalled();
    } finally { errSpy.mockRestore(); }
  });

  test('an append after a torn last line starts on a fresh line', () => {
    const { id } = store.create();
    store.append(id, { role: 'user', content: 'q' });
    const file = path.join(baseDir, id, 'nodes.jsonl');
    fs.appendFileSync(file, '{"id":"n_torn');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const again = reopen();
      const a = again.append(id, { role: 'assistant', content: 'a' });
      const view = reopen().get(id);
      expect(view.path[view.path.length - 1]).toBe(a.id);
      expect(view.corruptLines).toBe(1);
    } finally { errSpy.mockRestore(); }
  });

  test('a meta write failure leaves no tmp file behind and surfaces the error', () => {
    const { id } = store.create();
    const spy = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('EIO'); });
    try {
      expect(() => store.rename(id, 'x')).toThrow('EIO');
    } finally { spy.mockRestore(); }
    expect(fs.readdirSync(path.join(baseDir, id)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  test('rejects malformed ids, path traversal, bad roles/kinds and oversize content', () => {
    expect(() => assertSessionId('../etc')).toThrow('invalid_session_id');
    expect(() => assertNodeId('n_')).toThrow('invalid_node_id');
    expect(() => store.get('s_../../x')).toThrow('invalid_session_id');
    expect(() => store.create({ id: 'S_UPPER123' })).toThrow('invalid_session_id');
    const { id } = store.create();
    expect(() => store.create({ id })).toThrow('session_exists');
    expect(() => store.append(id, { role: 'root', content: 'x' })).toThrow('invalid_role');
    expect(() => store.append(id, { role: 'user', kind: 'weird', content: 'x' })).toThrow('invalid_kind');
    expect(() => store.append(id, { role: 'user', content: 5 })).toThrow('invalid_content');
    expect(() => store.append(id, { role: 'user', content: 'x'.repeat(1_000_001) })).toThrow('content_too_large');
    expect(() => store.append(id, { role: 'user', content: 'x', parentId: 'n_abcdef12' })).toThrow('parent_not_found');
    expect(() => store.get('s_missing1')).toThrow('session_not_found');
    expect(() => store.pin(id, 'yes')).toThrow('invalid_pinned');
    expect(() => store.setProject(id, '../p')).toThrow('invalid_project_id');
    expect(() => store.setWorkspace(id, 'relative/dir')).toThrow('invalid_workspace_root');
    expect(() => store.setHead(id, 'n_abcdef12')).toThrow('node_not_found');
  });

  test('edit and regenerate refuse non-user targets', () => {
    const { id } = store.create();
    store.append(id, { role: 'user', content: 'q' });
    const a = store.append(id, { role: 'assistant', content: 'a' });
    expect(() => store.edit(id, a.id, 'x')).toThrow('not_a_user_message');
    const lone = store.create();
    const sys = store.append(lone.id, { role: 'assistant', content: 'hello' });
    expect(() => store.regenerate(lone.id, sys.id)).toThrow('no_user_message_to_regenerate');
  });

  test('list returns [] for a missing base dir and keeps listing past an unreadable session', () => {
    expect(createSessionStore({ baseDir: path.join(baseDir, 'nope') }).list()).toEqual([]);
    const good = store.create({ title: 'good' });
    const bad = store.create({ title: 'bad' });
    fs.writeFileSync(path.join(baseDir, bad.id, 'meta.json'), '{broken');
    const rows = reopen().list();
    expect(rows.find((r) => r.id === good.id).title).toBe('good');
    expect(rows.find((r) => r.id === bad.id).error).toMatch(/JSON/);
  });
});
