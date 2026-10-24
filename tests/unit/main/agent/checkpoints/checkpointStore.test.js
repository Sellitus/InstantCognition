// checkpointStore — snapshots taken through the real fsTools write path, then
// rewound on real temp directories.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCheckpointStore, isSessionId, isTurnId, checkpointSettings } = require('../../../../../main/agent/checkpoints/checkpointStore');
const fsTools = require('../../../../../main/agent/tools/fsTools');

const SID = 's_abc123';
const T1 = 'n_turn001';
const T2 = 'n_turn002';
const T3 = 'n_turn003';
const DAY = 86400000;

let base, root, outside, cpDir, agent, clock, store;

const tool = (name) => fsTools.find((t) => t.name === name);
const toolSettings = () => ({ workspace: { roots: [root], maxReadBytes: 1 << 20, maxWriteBytes: 1 << 20 } });
async function run(turnId, name, args) {
  const res = await tool(name).handler(args, { agentSettings: toolSettings(), checkpoints: store.forTurn({ sessionId: SID, turnId }) }, {});
  expect(res).toMatchObject({ ok: true });
  return res;
}
const file = (rel) => path.join(root, ...rel.split('/'));
const read = (rel) => fs.readFileSync(file(rel), 'utf8');
const manifestPath = (turnId) => path.join(cpDir, SID, turnId, 'manifest.json');
const blobs = () => fs.readdirSync(path.join(cpDir, SID, 'blobs'));

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-checkpoints-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  cpDir = path.join(base, 'userData', 'checkpoints');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(file('src/a.js'), 'original a\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  agent = { workspace: { roots: [root] }, checkpoints: { enabled: true, retentionDays: 30, maxBytesPerSession: 1 << 20 } };
  clock = 1_000_000_000_000;
  store = createCheckpointStore({ rootDir: cpDir, getSettings: () => agent, now: () => clock });
});

afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('rewind', () => {
  test('restores the original bytes of an edited file and drops the checkpoint', async () => {
    fs.chmodSync(file('src/a.js'), 0o640);
    await run(T1, 'fs.edit', { path: 'src/a.js', old_string: 'original', new_string: 'changed' });
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'rewritten twice\n' });
    expect(read('src/a.js')).toBe('rewritten twice\n');

    const res = await store.rewind({ sessionId: SID, turnId: T1 });
    expect(res).toEqual({ restored: [file('src/a.js')], deleted: [], conflicts: [], conversationNodeId: T1, untracked: ['shell'] });
    expect(read('src/a.js')).toBe('original a\n');
    expect(fs.statSync(file('src/a.js')).mode & 0o777).toBe(0o640);
    expect(fs.existsSync(path.join(cpDir, SID))).toBe(false);
  });

  test('deletes a file the turn created', async () => {
    await run(T1, 'fs.write', { path: 'new/created.txt', content: 'fresh' });
    const res = await store.rewind({ sessionId: SID, turnId: T1 });
    expect(res.deleted).toEqual([file('new/created.txt')]);
    expect(fs.existsSync(file('new/created.txt'))).toBe(false);
  });

  test('an externally edited file is a conflict and is not restored without force', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent wrote\n' });
    fs.writeFileSync(file('src/a.js'), 'user edited\n');

    expect((await store.preview({ sessionId: SID, turnId: T1 })).files).toEqual([
      { path: file('src/a.js'), rel: 'src/a.js', status: 'conflict', turnIds: [T1], reason: 'modified_externally', forceable: true },
    ]);
    const res = await store.rewind({ sessionId: SID, turnId: T1 });
    expect(res.restored).toEqual([]);
    expect(res.conflicts).toEqual([{ path: file('src/a.js'), rel: 'src/a.js', reason: 'modified_externally', turnId: T1 }]);
    expect(read('src/a.js')).toBe('user edited\n');
    expect(fs.existsSync(manifestPath(T1))).toBe(true);

    const forced = await store.rewind({ sessionId: SID, turnId: T1, force: true });
    expect(forced).toMatchObject({ restored: [file('src/a.js')], conflicts: [] });
    expect(read('src/a.js')).toBe('original a\n');
  });

  test('an externally deleted file is a conflict too', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent wrote\n' });
    fs.rmSync(file('src/a.js'));
    const res = await store.rewind({ sessionId: SID, turnId: T1 });
    expect(res.conflicts.map((c) => c.reason)).toEqual(['modified_externally']);
    expect(fs.existsSync(file('src/a.js'))).toBe(false);
  });

  test('rewinding an earlier turn also undoes every later turn, oldest original wins', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'turn 1\n' });
    await run(T2, 'fs.write', { path: 'src/a.js', content: 'turn 2\n' });
    await run(T2, 'fs.write', { path: 'b.txt', content: 'b from 2' });
    await run(T3, 'fs.write', { path: 'b.txt', content: 'b from 3' });
    await run(T3, 'fs.write', { path: 'src/a.js', content: 'turn 3\n' });

    const toT2 = await store.rewind({ sessionId: SID, turnId: T2 });
    expect(toT2).toMatchObject({ restored: [file('src/a.js')], deleted: [file('b.txt')], conflicts: [], conversationNodeId: T2 });
    expect(read('src/a.js')).toBe('turn 1\n');
    expect((await store.list({ sessionId: SID })).turns.map((t) => t.turnId)).toEqual([T1]);

    await store.rewind({ sessionId: SID, turnId: T1 });
    expect(read('src/a.js')).toBe('original a\n');
  });

  test('an outside edit between two turns blocks rewinding past it', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'turn 1\n' });
    fs.writeFileSync(file('src/a.js'), 'user between turns\n');
    await run(T2, 'fs.write', { path: 'src/a.js', content: 'turn 2\n' });
    const res = await store.rewind({ sessionId: SID, turnId: T1 });
    expect(res.conflicts).toEqual([{ path: file('src/a.js'), rel: 'src/a.js', reason: 'modified_externally', turnId: T1 }]);
    expect(read('src/a.js')).toBe('turn 2\n');
  });

  test('files:false leaves the disk alone and still returns the conversation node', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent\n' });
    expect(await store.rewind({ sessionId: SID, turnId: T1, files: false })).toEqual({ restored: [], deleted: [], conflicts: [], conversationNodeId: T1, untracked: ['shell'] });
    expect(read('src/a.js')).toBe('agent\n');
  });

  test('an unknown turn is an error', async () => {
    await expect(store.rewind({ sessionId: SID, turnId: T2 })).rejects.toThrow('checkpoint_not_found');
  });

  test('a directory swapped in place of the file is never forced', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent\n' });
    fs.rmSync(file('src/a.js'));
    fs.mkdirSync(file('src/a.js'));
    const res = await store.rewind({ sessionId: SID, turnId: T1, force: true });
    expect(res.conflicts.map((c) => c.reason)).toEqual(['not_a_regular_file']);
    expect(fs.statSync(file('src/a.js')).isDirectory()).toBe(true);
  });
});

describe('manifest tampering', () => {
  test('a manifest path escaping the root is rejected and nothing outside is written', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent\n' });
    const m = JSON.parse(fs.readFileSync(manifestPath(T1), 'utf8'));
    const entry = m.files[file('src/a.js')];
    delete m.files[file('src/a.js')];
    m.files[path.join(outside, 'secret.txt')] = { ...entry, rel: '../outside/secret.txt' };
    fs.writeFileSync(manifestPath(T1), JSON.stringify(m));

    await expect(store.rewind({ sessionId: SID, turnId: T1, force: true })).rejects.toThrow('path_outside_workspace');
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  test('an abs key that disagrees with root+rel is rejected', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent\n' });
    const m = JSON.parse(fs.readFileSync(manifestPath(T1), 'utf8'));
    m.files[path.join(outside, 'secret.txt')] = m.files[file('src/a.js')];
    delete m.files[file('src/a.js')];
    fs.writeFileSync(manifestPath(T1), JSON.stringify(m));
    await expect(store.rewind({ sessionId: SID, turnId: T1, force: true })).rejects.toThrow('checkpoint_path_mismatch');
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  test('a corrupt manifest is listed and blocks rewind', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent\n' });
    fs.writeFileSync(manifestPath(T1), '{not json');
    expect((await store.list({ sessionId: SID })).corrupt).toEqual([T1]);
    await expect(store.rewind({ sessionId: SID, turnId: T1 })).rejects.toThrow('checkpoint_manifest_invalid');
    expect(read('src/a.js')).toBe('agent\n');
  });

  test('a turn dir without manifest.json (crash before the rename) is abandoned, not corrupt', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent\n' });
    fs.mkdirSync(path.join(cpDir, SID, T2));
    fs.writeFileSync(path.join(cpDir, SID, T2, '.manifest.ic-0123456789ab.tmp'), '{"half":');
    const listed = await store.list({ sessionId: SID });
    expect(listed.corrupt).toEqual([]);
    expect(listed.turns.map((t) => t.turnId)).toEqual([T1]);
    expect((await store.preview({ sessionId: SID, turnId: T1 })).files).toEqual([
      expect.objectContaining({ rel: 'src/a.js', status: 'restore' }),
    ]);
    await expect(store.preview({ sessionId: SID, turnId: T2 })).rejects.toThrow('checkpoint_not_found');
    expect(await store.rewind({ sessionId: SID, turnId: T1 })).toMatchObject({ restored: [file('src/a.js')], conflicts: [] });
    expect(read('src/a.js')).toBe('original a\n');
  });

  test('prune removes an abandoned turn dir and blob GC keeps working', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent\n' });
    fs.mkdirSync(path.join(cpDir, SID, T2));
    clock += 31 * DAY;
    expect(await store.prune()).toEqual({ removedTurns: 2 });
    expect(fs.existsSync(path.join(cpDir, SID))).toBe(false);
  });

  test('a turn recorded after a crash in the same turn id still snapshots normally', async () => {
    fs.mkdirSync(path.join(cpDir, SID, T1), { recursive: true });
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent\n' });
    expect((await store.list({ sessionId: SID })).turns.map((t) => t.turnId)).toEqual([T1]);
    expect(fs.existsSync(manifestPath(T1))).toBe(true);
  });

  test('a root no longer configured is not restored, even with force', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent\n' });
    agent.workspace.roots = [outside];
    const res = await store.rewind({ sessionId: SID, turnId: T1, force: true });
    expect(res.conflicts.map((c) => c.reason)).toEqual(['root_not_configured']);
    expect(read('src/a.js')).toBe('agent\n');
  });
});

describe('recording', () => {
  test('the first mutation per turn keeps the original; blobs are content-addressed', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'one' });
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'two' });
    const m = JSON.parse(fs.readFileSync(manifestPath(T1), 'utf8'));
    const entry = m.files[file('src/a.js')];
    expect(entry).toMatchObject({ root, rel: 'src/a.js', original: { state: 'file' } });
    expect(entry.post).toBe(require('crypto').createHash('sha256').update('two').digest('hex'));
    expect(blobs()).toEqual([entry.original.hash]);
    expect(fs.readFileSync(path.join(cpDir, SID, 'blobs', entry.original.hash), 'utf8')).toBe('original a\n');
  });

  test('list reports turns oldest first with their files and the untracked shell', async () => {
    await run(T2, 'fs.write', { path: 'x.txt', content: 'x' });
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'y' });
    const res = await store.list({ sessionId: SID });
    expect(res.turns.map((t) => [t.turnId, t.seq])).toEqual([[T2, 1], [T1, 2]]);
    expect(res.turns[0].files).toEqual([{ path: file('x.txt'), rel: 'x.txt', created: true }]);
    expect(res).toMatchObject({ enabled: true, corrupt: [], untracked: ['shell'] });
  });

  test('a path outside every configured root is refused before any write', async () => {
    const cp = store.forTurn({ sessionId: SID, turnId: T1 });
    await expect(cp.beforeMutate(path.join(outside, 'secret.txt'))).rejects.toThrow('checkpoint_root_unknown');
    await expect(store.beforeMutate({ sessionId: SID, turnId: T1, absPath: path.join(outside, 'secret.txt'), root })).rejects.toThrow('path_outside_workspace');
  });

  test('afterMutate without a snapshot is an error', async () => {
    await expect(store.afterMutate({ sessionId: SID, turnId: T1, absPath: file('src/a.js'), content: 'x' })).rejects.toThrow('checkpoint_missing_snapshot');
  });
});

describe('disabled', () => {
  test('mutations record nothing and the write still lands', async () => {
    agent.checkpoints.enabled = false;
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'agent\n' });
    expect(read('src/a.js')).toBe('agent\n');
    expect(fs.existsSync(cpDir)).toBe(false);
    expect(await store.list({ sessionId: SID })).toMatchObject({ enabled: false, turns: [] });
  });
});

describe('retention', () => {
  test('turns older than retentionDays are pruned when a new turn records', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'one' });
    clock += 31 * DAY;
    await run(T2, 'fs.write', { path: 'b.txt', content: 'two' });
    expect((await store.list({ sessionId: SID })).turns.map((t) => t.turnId)).toEqual([T2]);
    expect(blobs()).toEqual([]);
  });

  test('prune() applies the age cutoff to every session and drops empty ones', async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'one' });
    clock += 29 * DAY;
    expect(await store.prune()).toEqual({ removedTurns: 0 });
    clock += 2 * DAY;
    expect(await store.prune()).toEqual({ removedTurns: 1 });
    expect(fs.existsSync(path.join(cpDir, SID))).toBe(false);
  });

  test('oldest turns go first when the session exceeds maxBytesPerSession; the current turn stays', async () => {
    fs.writeFileSync(file('big1.bin'), Buffer.alloc(600, 1));
    fs.writeFileSync(file('big2.bin'), Buffer.alloc(600, 2));
    agent.checkpoints.maxBytesPerSession = 1000;
    await run(T1, 'fs.write', { path: 'big1.bin', content: 'x' });
    await run(T2, 'fs.write', { path: 'big2.bin', content: 'y' });
    expect((await store.list({ sessionId: SID })).turns.map((t) => t.turnId)).toEqual([T2]);
    expect(blobs()).toHaveLength(1);
  });
});

describe('removeSession', () => {
  const OTHER = 's_other01';

  test("deletes every turn and blob of one session and leaves other sessions' checkpoints alone", async () => {
    await run(T1, 'fs.write', { path: 'src/a.js', content: 'one' });
    await run(T2, 'fs.write', { path: 'b.txt', content: 'two' });
    await tool('fs.write').handler({ path: 'c.txt', content: 'other' }, { agentSettings: toolSettings(), checkpoints: store.forTurn({ sessionId: OTHER, turnId: T1 }) }, {});
    expect(blobs()).toHaveLength(1);
    await expect(store.removeSession(SID)).resolves.toEqual({ removed: true });
    expect(fs.existsSync(path.join(cpDir, SID))).toBe(false);
    expect((await store.list({ sessionId: SID })).turns).toEqual([]);
    expect((await store.list({ sessionId: OTHER })).turns.map((t) => t.turnId)).toEqual([T1]);
    expect(read('src/a.js')).toBe('one');
  });

  test('a session without checkpoints reports removed:false', async () => {
    await expect(store.removeSession(SID)).resolves.toEqual({ removed: false });
  });

  test('a malformed id is refused before touching disk', async () => {
    fs.mkdirSync(cpDir, { recursive: true });
    fs.writeFileSync(path.join(base, 'userData', 'keep.txt'), 'keep');
    await expect(store.removeSession('../keep.txt')).rejects.toThrow('invalid_session_id');
    await expect(store.removeSession('s_abc/../..')).rejects.toThrow('invalid_session_id');
    await expect(store.removeSession(/** @type {any} */ (42))).rejects.toThrow('invalid_session_id');
    expect(fs.readFileSync(path.join(base, 'userData', 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(cpDir)).toBe(true);
  });

  test('a symlink in place of the session dir is unlinked, its target untouched', async () => {
    fs.mkdirSync(cpDir, { recursive: true });
    fs.symlinkSync(outside, path.join(cpDir, SID), 'dir');
    await expect(store.removeSession(SID)).resolves.toEqual({ removed: true });
    expect(fs.existsSync(path.join(cpDir, SID))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });
});

describe('ids and settings', () => {
  test.each([
    ['s_abc123', true], ['s_' + 'a'.repeat(32), true], ['s_abc12', false], ['s_ABC123', false],
    ['s_abc/../x', false], ['../s_abc123', false], ['n_abc123', false], [42, false],
  ])('isSessionId(%p) = %p', (id, ok) => { expect(isSessionId(id)).toBe(ok); });

  test('isTurnId accepts only n_ ids', () => {
    expect(isTurnId('n_turn001')).toBe(true);
    expect(isTurnId('n_..%2f..')).toBe(false);
    expect(isTurnId('s_turn001')).toBe(false);
  });

  test('every entry point rejects a malformed id before touching disk', async () => {
    await expect(store.list({ sessionId: '../etc' })).rejects.toThrow('invalid_session_id');
    await expect(store.preview({ sessionId: SID, turnId: 'n_/x' })).rejects.toThrow('invalid_turn_id');
    await expect(store.rewind({ sessionId: 's_..', turnId: T1 })).rejects.toThrow('invalid_session_id');
    await expect(store.beforeMutate({ sessionId: SID, turnId: '..', absPath: file('src/a.js'), root })).rejects.toThrow('invalid_turn_id');
    expect(() => store.forTurn({ sessionId: 'nope', turnId: T1 })).toThrow('invalid_session_id');
    await expect(store.rewind({ sessionId: SID, turnId: T1, force: 'yes' })).rejects.toThrow('invalid_force_flag');
    expect(fs.existsSync(cpDir)).toBe(false);
  });

  test('settings fall back to defaults for missing or mistyped keys', () => {
    expect(checkpointSettings({ checkpoints: { enabled: 'no', retentionDays: -1 } })).toEqual({ enabled: true, retentionDays: 30, maxBytesPerSession: 209715200 });
    expect(checkpointSettings(undefined).enabled).toBe(true);
  });

  test('the factory requires an absolute rootDir and a settings getter', () => {
    expect(() => createCheckpointStore({ rootDir: 'rel', getSettings: () => ({}) })).toThrow('checkpoint_root_dir_required');
    expect(() => createCheckpointStore({ rootDir: cpDir })).toThrow('checkpoint_get_settings_required');
  });
});
