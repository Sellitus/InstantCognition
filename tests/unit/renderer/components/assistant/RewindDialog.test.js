// RewindDialog: previews checkpoint:preview, confirms through session:rewind,
// and never sends the rewind on Cancel / Esc. A missing checkpoint toasts an
// error and leaves only the conversation rewind; conflicts need "force".
const RewindDialog = require('../../../../../renderer/components/assistant/RewindDialog');

const SID = 's_abc123';
const REQ = { sessionId: SID, turnId: 'n5', context: { tag: 'view' } };

const FILES = [
  { path: '/w/a.js', rel: 'a.js', status: 'restore' },
  { path: '/w/b.js', rel: 'b.js', status: 'delete' },
  { path: '/w/c.js', rel: 'c.js', status: 'unchanged' },
];

function mockIpc(handlers) {
  return { invoke: jest.fn(async (ch, arg) => (handlers[ch] ? handlers[ch](arg) : undefined)) };
}

let root;
let opener;
function make(ipc, onRewound = jest.fn()) {
  return { dialog: new RewindDialog({ ipc, getRoot: () => root, onRewound }), onRewound };
}
const q = (sel) => /** @type {HTMLElement} */ (root.querySelector(sel));
const input = (sel) => /** @type {HTMLInputElement} */ (root.querySelector(`${sel} input`));
const key = (el, k, extra = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
const toastText = () => Array.from(document.querySelectorAll('.toast-error .toast-message')).map((n) => n.textContent);
const rewindCalls = (ipc) => ipc.invoke.mock.calls.filter((c) => c[0] === 'session:rewind');

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  opener = document.createElement('button');
  document.body.append(opener, root);
  opener.focus();
});

test('requires getRoot and a sessionId + turnId', async () => {
  expect(() => new RewindDialog(/** @type {any} */ ({}))).toThrow(TypeError);
  const { dialog } = make(mockIpc({}));
  await expect(dialog.open(/** @type {any} */ ({ sessionId: SID }))).rejects.toThrow(TypeError);
});

test('previews files and the conversation rewind; names untracked shell effects', async () => {
  const ipc = mockIpc({ 'checkpoint:preview': () => ({ ok: true, files: FILES }) });
  const { dialog } = make(ipc);
  await expect(dialog.open(REQ)).resolves.toBe(true);
  expect(ipc.invoke).toHaveBeenCalledWith('checkpoint:preview', { sessionId: SID, turnId: 'n5' });
  const box = q('[role="dialog"]');
  expect(box.getAttribute('aria-modal')).toBe('true');
  expect(box.querySelector('#rewind-dialog-title').textContent).toBe('Rewind to here');
  const rows = Array.from(root.querySelectorAll('.rewind-dialog__file')).map((li) => li.textContent);
  expect(rows).toEqual(['Restorea.js', 'Deleteb.js', 'Unchangedc.js']);
  expect(input('.rewind-dialog__files-opt').checked).toBe(true);
  expect(q('.rewind-dialog__force-opt').hidden).toBe(true);
  expect(q('.rewind-dialog__untracked').textContent).toMatch(/Shell side effects are not tracked/);
  expect(box.contains(document.activeElement)).toBe(true);
});

test('Cancel closes without sending the rewind and restores focus', async () => {
  const ipc = mockIpc({ 'checkpoint:preview': () => ({ ok: true, files: FILES }) });
  const { dialog, onRewound } = make(ipc);
  await dialog.open(REQ);
  q('.rewind-dialog__cancel').click();
  expect(dialog.isOpen()).toBe(false);
  expect(root.querySelector('.rewind-dialog')).toBeNull();
  expect(rewindCalls(ipc)).toHaveLength(0);
  expect(onRewound).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(opener);
});

test('Esc cancels without IPC', async () => {
  const ipc = mockIpc({ 'checkpoint:preview': () => ({ ok: true, files: FILES }) });
  const { dialog } = make(ipc);
  await dialog.open(REQ);
  key(q('.rewind-dialog__confirm'), 'Escape');
  expect(dialog.isOpen()).toBe(false);
  expect(rewindCalls(ipc)).toHaveLength(0);
});

test('Tab wraps inside the dialog', async () => {
  const ipc = mockIpc({ 'checkpoint:preview': () => ({ ok: true, files: FILES }) });
  const { dialog } = make(ipc);
  await dialog.open(REQ);
  const confirm = q('.rewind-dialog__confirm');
  confirm.focus();
  key(confirm, 'Tab');
  expect(document.activeElement).toBe(input('.rewind-dialog__files-opt'));
  key(document.activeElement, 'Tab', { shiftKey: true });
  expect(document.activeElement).toBe(confirm);
});

test('a missing checkpoint shows an error toast and rewinds the conversation only', async () => {
  const ipc = mockIpc({
    'checkpoint:preview': () => ({ ok: false, error: 'checkpoint_not_found' }),
    'session:rewind': () => ({ ok: true, conversationRewound: true, restored: [], deleted: [], conflicts: [], headId: 'n4' }),
  });
  const { dialog, onRewound } = make(ipc);
  await expect(dialog.open(REQ)).resolves.toBe(true);
  expect(toastText().some((t) => t.includes('No file checkpoint exists for that message'))).toBe(true);
  const files = input('.rewind-dialog__files-opt');
  expect(files.checked).toBe(false);
  expect(files.disabled).toBe(true);
  await dialog.confirm();
  expect(rewindCalls(ipc)[0][1]).toEqual({ sessionId: SID, turnId: 'n5', files: false, force: false });
  expect(onRewound).toHaveBeenCalledWith(expect.objectContaining({ headId: 'n4' }), REQ.context);
  expect(dialog.isOpen()).toBe(false);
});

test('any other preview failure toasts and opens no dialog', async () => {
  const ipc = mockIpc({ 'checkpoint:preview': () => ({ ok: false, error: 'session_busy' }) });
  const { dialog } = make(ipc);
  await expect(dialog.open(REQ)).resolves.toBe(false);
  expect(root.querySelector('.rewind-dialog')).toBeNull();
  expect(toastText().some((t) => t.includes('Wait for the current run to finish first.'))).toBe(true);
});

test('conflicts need force: the first try keeps the dialog open, force goes through', async () => {
  const conflict = { path: '/w/a.js', rel: 'a.js', status: 'conflict', reason: 'modified outside the agent' };
  const rewind = jest.fn((arg) => (arg.force
    ? { ok: true, conversationRewound: true, restored: ['/w/a.js'], deleted: [], conflicts: [], headId: 'n4' }
    : { ok: true, conversationRewound: false, restored: [], deleted: [], conflicts: [conflict] }));
  const ipc = mockIpc({ 'checkpoint:preview': () => ({ ok: true, files: [FILES[0]] }), 'session:rewind': rewind });
  const { dialog, onRewound } = make(ipc);
  await dialog.open(REQ);
  await expect(dialog.confirm()).resolves.toBeNull();
  expect(rewind).toHaveBeenLastCalledWith({ sessionId: SID, turnId: 'n5', files: true, force: false });
  expect(dialog.isOpen()).toBe(true);
  expect(q('.rewind-dialog__conflicts').textContent).toContain('a.js (modified outside the agent)');
  expect(q('.rewind-dialog__force-opt').hidden).toBe(false);
  expect(onRewound).not.toHaveBeenCalled();
  input('.rewind-dialog__force-opt').click();
  await dialog.confirm();
  expect(rewind).toHaveBeenLastCalledWith({ sessionId: SID, turnId: 'n5', files: true, force: true });
  expect(onRewound).toHaveBeenCalledTimes(1);
});

test('turning files off disables and clears force', async () => {
  const conflict = { rel: 'a.js', status: 'conflict' };
  const ipc = mockIpc({ 'checkpoint:preview': () => ({ ok: true, files: [conflict] }) });
  const { dialog } = make(ipc);
  await dialog.open(REQ);
  const force = input('.rewind-dialog__force-opt');
  expect(force.disabled).toBe(false);
  force.checked = true;
  input('.rewind-dialog__files-opt').click();
  expect(force.disabled).toBe(true);
  expect(force.checked).toBe(false);
});

test('a refused rewind shows the error and keeps the dialog', async () => {
  const ipc = mockIpc({
    'checkpoint:preview': () => ({ ok: true, files: FILES }),
    'session:rewind': () => ({ ok: false, error: 'not_a_user_message' }),
  });
  const { dialog, onRewound } = make(ipc);
  await dialog.open(REQ);
  await dialog.confirm();
  expect(dialog.isOpen()).toBe(true);
  expect(q('.rewind-dialog__error').textContent).toBe('Couldn’t rewind: Only your own messages can be rewound to.');
  expect(onRewound).not.toHaveBeenCalled();
});
