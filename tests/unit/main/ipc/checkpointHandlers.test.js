// checkpointHandlers — IPC input validation and pass-through to a real store.

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockInvoke = new Map();
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn((ch, fn) => { mockInvoke.set(ch, fn); }) },
}));

const { register } = require('../../../../main/ipc/checkpointHandlers');
const { createCheckpointStore } = require('../../../../main/agent/checkpoints/checkpointStore');

const SID = 's_abc123';
const TID = 'n_turn001';
const invoke = (ch, arg) => mockInvoke.get(ch)({}, arg);

let base, root, store;

beforeEach(async () => {
  mockInvoke.clear();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-cp-ipc-')));
  root = path.join(base, 'root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'original');
  const agent = { workspace: { roots: [root] }, checkpoints: { enabled: true } };
  store = createCheckpointStore({ rootDir: path.join(base, 'checkpoints'), getSettings: () => agent });
  const cp = store.forTurn({ sessionId: SID, turnId: TID });
  await cp.beforeMutate(path.join(root, 'a.txt'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'agent');
  await cp.afterMutate(path.join(root, 'a.txt'), 'agent');
  register(null, { checkpointStore: store });
});

afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

test('registers nothing without a store', () => {
  mockInvoke.clear();
  register(null, {});
  expect(mockInvoke.size).toBe(0);
});

test('list / preview / rewind round-trip', async () => {
  expect(await invoke('checkpoint:list', { sessionId: SID })).toMatchObject({ ok: true, turns: [{ turnId: TID }] });
  expect(await invoke('checkpoint:preview', { sessionId: SID, turnId: TID })).toMatchObject({ ok: true, files: [{ rel: 'a.txt', status: 'restore' }] });
  expect(await invoke('checkpoint:rewind', { sessionId: SID, turnId: TID })).toMatchObject({ ok: true, restored: [path.join(root, 'a.txt')], conversationNodeId: TID });
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('original');
});

test('rewind forwards files:false and force:true', async () => {
  fs.writeFileSync(path.join(root, 'a.txt'), 'user');
  expect(await invoke('checkpoint:rewind', { sessionId: SID, turnId: TID, files: false })).toMatchObject({ ok: true, restored: [], conflicts: [] });
  expect(await invoke('checkpoint:rewind', { sessionId: SID, turnId: TID })).toMatchObject({ ok: true, conflicts: [{ reason: 'modified_externally' }] });
  expect(await invoke('checkpoint:rewind', { sessionId: SID, turnId: TID, force: true })).toMatchObject({ ok: true, conflicts: [] });
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('original');
});

test.each([
  ['checkpoint:list', undefined, 'invalid_session_id'],
  ['checkpoint:list', { sessionId: '../x' }, 'invalid_session_id'],
  ['checkpoint:preview', { sessionId: SID }, 'invalid_turn_id'],
  ['checkpoint:preview', { sessionId: SID, turnId: 'n_../../x' }, 'invalid_turn_id'],
  ['checkpoint:rewind', { sessionId: SID, turnId: TID, files: 'yes' }, 'invalid_files_flag'],
  ['checkpoint:rewind', { sessionId: SID, turnId: TID, force: 1 }, 'invalid_force_flag'],
  ['checkpoint:rewind', { sessionId: 7, turnId: TID }, 'invalid_session_id'],
])('%s rejects %p', async (ch, arg, error) => {
  expect(await invoke(ch, arg)).toEqual({ ok: false, error });
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('agent');
});

test('a store failure comes back as { ok:false, error }', async () => {
  expect(await invoke('checkpoint:rewind', { sessionId: SID, turnId: 'n_missing1' })).toEqual({ ok: false, error: 'checkpoint_not_found' });
});
