// artifactHandlers — artifact:list/get/save and the artifact:upserted push.

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockInvoke = new Map();
const mockDialog = { showSaveDialog: jest.fn() };

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn((ch, fn) => { mockInvoke.set(ch, fn); }) },
  dialog: mockDialog,
}));

const { register, extensionFor, defaultFileName } = require('../../../../main/ipc/artifactHandlers');
const { createArtifactStore } = require('../../../../main/agent/artifacts/artifactStore');

const SID = 's_ipc001';
const invoke = (ch, arg) => mockInvoke.get(ch)({}, arg);
let base, store, win;

beforeEach(() => {
  mockInvoke.clear();
  jest.clearAllMocks();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-artifact-ipc-'));
  store = createArtifactStore({ baseDir: path.join(base, 'sessions') });
  win = { isDestroyed: jest.fn(() => false), webContents: { send: jest.fn() } };
  register(win, { artifactStore: store });
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

test('registers exactly the three channels', () => {
  expect([...mockInvoke.keys()].sort()).toEqual(['artifact:get', 'artifact:list', 'artifact:save']);
});

test('list and get return stored artifacts', async () => {
  const a = store.create(SID, { type: 'markdown', title: 'Notes', content: '# one' });
  store.update(SID, a.id, { content: '# two' });
  const listed = await invoke('artifact:list', { sessionId: SID });
  expect(listed).toEqual({ ok: true, artifacts: [expect.objectContaining({ id: a.id, version: 2, versions: [1, 2] })] });
  expect((await invoke('artifact:get', { sessionId: SID, artifactId: a.id })).artifact.content).toBe('# two');
  expect((await invoke('artifact:get', { sessionId: SID, artifactId: a.id, version: 1 })).artifact.content).toBe('# one');
  expect((await invoke('artifact:get', { sessionId: SID, artifactId: a.id, version: null })).artifact.version).toBe(2);
});

test('invalid input is rejected with an error result', async () => {
  expect(await invoke('artifact:list', { sessionId: '../etc' })).toEqual({ ok: false, error: 'invalid_session_id' });
  expect(await invoke('artifact:list', null)).toEqual({ ok: false, error: 'invalid_session_id' });
  expect(await invoke('artifact:get', { sessionId: SID, artifactId: '../../x' })).toEqual({ ok: false, error: 'invalid_artifact_id' });
  expect(await invoke('artifact:get', { sessionId: SID, artifactId: 'a_abcdef', version: '1' })).toEqual({ ok: false, error: 'invalid_version' });
  expect(await invoke('artifact:save', { sessionId: SID, artifactId: 'a_missing1' })).toEqual({ ok: false, error: 'artifact_not_found' });
  expect(mockDialog.showSaveDialog).not.toHaveBeenCalled();
});

test('save writes only to the path chosen in the main-side dialog', async () => {
  const a = store.create(SID, { type: 'code', language: 'python', title: 'My: script?', content: 'print(1)\n' });
  const chosen = path.join(base, 'picked.py');
  const decoy = path.join(base, 'renderer-supplied.py');
  mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen });
  const res = await invoke('artifact:save', { sessionId: SID, artifactId: a.id, path: decoy, filePath: decoy });
  expect(res).toEqual({ ok: true, path: chosen });
  expect(fs.readFileSync(chosen, 'utf8')).toBe('print(1)\n');
  expect(fs.existsSync(decoy)).toBe(false);
  const [parent, opts] = mockDialog.showSaveDialog.mock.calls[0];
  expect(parent).toBe(win);
  expect(opts.defaultPath).toBe('My script.py');
  expect(opts.filters[0]).toEqual({ name: 'PY', extensions: ['py'] });
});

test('save of an older version writes that version', async () => {
  const a = store.create(SID, { type: 'html', title: 'Page', content: '<p>1</p>' });
  store.update(SID, a.id, { content: '<p>2</p>' });
  const chosen = path.join(base, 'page.html');
  mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen });
  await invoke('artifact:save', { sessionId: SID, artifactId: a.id, version: 1 });
  expect(fs.readFileSync(chosen, 'utf8')).toBe('<p>1</p>');
});

test('cancelling the dialog writes nothing and reports cancelled', async () => {
  const a = store.create(SID, { type: 'svg', title: 'Logo', content: '<svg/>' });
  mockDialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
  expect(await invoke('artifact:save', { sessionId: SID, artifactId: a.id })).toEqual({ ok: false, error: 'cancelled' });
  mockDialog.showSaveDialog.mockResolvedValue({ canceled: false });
  expect(await invoke('artifact:save', { sessionId: SID, artifactId: a.id })).toEqual({ ok: false, error: 'cancelled' });
});

test('a write failure reaches the caller', async () => {
  const a = store.create(SID, { type: 'svg', title: 'Logo', content: '<svg/>' });
  mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(base, 'no-such-dir', 'x.svg') });
  expect(await invoke('artifact:save', { sessionId: SID, artifactId: a.id })).toEqual({ ok: false, error: expect.stringContaining('ENOENT') });
});

test('store writes are pushed as artifact:upserted, but not to a destroyed window', () => {
  const a = store.create(SID, { type: 'html', title: 'Page', content: '<p/>' });
  expect(win.webContents.send).toHaveBeenCalledWith('artifact:upserted', { sessionId: SID, artifact: a });
  win.isDestroyed.mockReturnValue(true);
  store.update(SID, a.id, { content: '<p>2</p>' });
  expect(win.webContents.send).toHaveBeenCalledTimes(1);
});

test('file extension and default name helpers', () => {
  expect(extensionFor({ type: 'mermaid' })).toBe('mmd');
  expect(extensionFor({ type: 'markdown' })).toBe('md');
  expect(extensionFor({ type: 'code', language: 'TypeScript' })).toBe('ts');
  expect(extensionFor({ type: 'code', language: 'cobol' })).toBe('txt');
  expect(defaultFileName({ id: 'a_abcdef', type: 'html', title: '../../etc/passwd' })).toBe('etcpasswd.html');
  expect(defaultFileName({ id: 'a_abcdef', type: 'html', title: '///' })).toBe('a_abcdef.html');
});
