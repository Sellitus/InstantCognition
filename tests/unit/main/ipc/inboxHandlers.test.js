// inboxHandlers over a real InboxService on a tmp dir; ipcMain and the window
// are the external boundary (mocked).

const invokeHandlers = {};

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn((ch, fn) => { invokeHandlers[ch] = fn; }) },
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const inboxHandlers = require('../../../../main/ipc/inboxHandlers');
const { InboxService } = require('../../../../main/services/InboxService');

describe('inboxHandlers.register', () => {
  let dir;
  let inbox;
  let mockWindow;
  const call = (ch, arg) => invokeHandlers[ch]({}, arg);

  beforeEach(() => {
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-inbox-ipc-'));
    inbox = new InboxService({ filePath: path.join(dir, 'inbox.json') });
    mockWindow = { isDestroyed: () => false, webContents: { send: jest.fn() } };
    inboxHandlers.register(mockWindow, { inboxService: inbox });
  });

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('registers nothing without an inboxService', () => {
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    inboxHandlers.register(mockWindow, {});
    expect(Object.keys(invokeHandlers)).toEqual([]);
  });

  test('inbox:list returns items with the unread count', async () => {
    const a = inbox.add({ title: 'Digest', ok: true, source: 'routine' });
    expect(await call('inbox:list')).toEqual({ ok: true, items: [expect.objectContaining({ id: a.id, title: 'Digest', read: false })], unread: 1 });
  });

  test('mark-read, delete and clear change the store and push inbox:changed', async () => {
    const a = inbox.add({ title: 'One', ok: true });
    const b = inbox.add({ title: 'Two', ok: false });
    mockWindow.webContents.send.mockClear();

    expect(await call('inbox:mark-read', { id: a.id })).toEqual({ ok: true });
    expect(mockWindow.webContents.send).toHaveBeenLastCalledWith('inbox:changed', { reason: 'read', unread: 1 });
    expect(await call('inbox:mark-read', { id: a.id, read: false })).toEqual({ ok: true });
    expect(inbox.unreadCount()).toBe(2);
    expect(await call('inbox:mark-read', { all: true })).toEqual({ ok: true });
    expect(inbox.unreadCount()).toBe(0);

    expect(await call('inbox:delete', { id: b.id })).toEqual({ ok: true });
    expect(inbox.list().map((it) => it.id)).toEqual([a.id]);
    expect(await call('inbox:clear')).toEqual({ ok: true });
    expect(inbox.list()).toEqual([]);
    expect(mockWindow.webContents.send).toHaveBeenLastCalledWith('inbox:changed', { reason: 'cleared', unread: 0 });
  });

  test('bad arguments come back as errors and change nothing', async () => {
    const a = inbox.add({ title: 'One', ok: true });
    mockWindow.webContents.send.mockClear();
    expect(await call('inbox:mark-read', { id: '../x' })).toEqual({ ok: false, error: 'invalid_inbox_id' });
    expect(await call('inbox:mark-read', { id: a.id, read: 'yes' })).toEqual({ ok: false, error: 'invalid_read_flag' });
    expect(await call('inbox:mark-read', null)).toEqual({ ok: false, error: 'invalid_inbox_id' });
    expect(await call('inbox:delete', { id: 'ib_ffffffffffffffff' })).toEqual({ ok: false, error: 'not_found' });
    expect(await call('inbox:delete', 'ib_ffffffffffffffff')).toEqual({ ok: false, error: 'invalid_inbox_id' });
    expect(inbox.list()).toHaveLength(1);
    expect(inbox.unreadCount()).toBe(1);
    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });

  test('a corrupt inbox file is reported to the caller', async () => {
    fs.writeFileSync(path.join(dir, 'inbox.json'), 'not json');
    const fresh = new InboxService({ filePath: path.join(dir, 'inbox.json') });
    inboxHandlers.register(mockWindow, { inboxService: fresh });
    const res = await call('inbox:list');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^inbox_corrupt:/);
  });

  test('no push is sent to a destroyed window', () => {
    mockWindow.isDestroyed = () => true;
    inbox.add({ title: 'One', ok: true });
    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });
});
