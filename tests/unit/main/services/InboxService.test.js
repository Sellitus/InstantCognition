const fs = require('fs');
const os = require('os');
const path = require('path');
const { InboxService, assertItemId } = require('../../../../main/services/InboxService');

describe('InboxService', () => {
  let dir;
  let file;
  let inbox;
  let clock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-inbox-'));
    file = path.join(dir, 'inbox.json');
    clock = 1000;
    inbox = new InboxService({ filePath: file, now: () => clock++ });
  });

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const readDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  test('a missing file reads as an empty inbox', () => {
    expect(inbox.list()).toEqual([]);
    expect(inbox.unreadCount()).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('add, list, markRead, delete and clear persist to disk', () => {
    const a = inbox.add({ sessionId: 's_abcdef01', title: '  Daily\n digest ', summary: 'Three new posts', ok: true, source: 'routine' });
    const b = inbox.add({ title: 'Price check', ok: false, summary: 'LLM unreachable' });
    expect(a).toEqual({ id: a.id, sessionId: 's_abcdef01', title: 'Daily digest', summary: 'Three new posts', ok: true, source: 'routine', createdAt: 1000, read: false });
    expect(b).toMatchObject({ sessionId: null, source: 'agent', ok: false });
    expect(inbox.list().map((it) => it.id)).toEqual([b.id, a.id]);
    expect(inbox.unreadCount()).toBe(2);

    expect(inbox.markRead(a.id)).toEqual({ ok: true });
    const reopened = new InboxService({ filePath: file });
    expect(reopened.list().find((it) => it.id === a.id).read).toBe(true);
    expect(reopened.unreadCount()).toBe(1);

    inbox.markRead(a.id, false);
    expect(inbox.unreadCount()).toBe(2);
    inbox.markAllRead();
    expect(inbox.unreadCount()).toBe(0);

    expect(inbox.delete(b.id)).toEqual({ ok: true });
    expect(readDisk().items.map((it) => it.id)).toEqual([a.id]);
    expect(inbox.clear()).toEqual({ ok: true });
    expect(readDisk()).toEqual({ version: 1, items: [] });
  });

  test('list returns copies, so callers cannot mutate stored items', () => {
    const a = inbox.add({ title: 'One', ok: true });
    inbox.list()[0].read = true;
    expect(inbox.list().find((it) => it.id === a.id).read).toBe(false);
  });

  test('writes are atomic: no temp files remain and the file is always whole JSON', () => {
    for (let i = 0; i < 5; i++) inbox.add({ title: `Item ${i}`, ok: true });
    expect(fs.readdirSync(dir)).toEqual(['inbox.json']);
    expect(readDisk().items).toHaveLength(5);
  });

  test('a failed rename leaves the previous file intact and removes the temp file', () => {
    const a = inbox.add({ title: 'Kept', ok: true });
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('EXDEV mocked'); });
    try {
      expect(() => inbox.add({ title: 'Lost', ok: true })).toThrow('EXDEV mocked');
    } finally {
      rename.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual(['inbox.json']);
    expect(readDisk().items.map((it) => it.id)).toEqual([a.id]);
    expect(inbox.list().map((it) => it.title)).toEqual(['Kept']);
  });

  test('a corrupt file is surfaced on read and write and left untouched until clear', () => {
    fs.writeFileSync(file, '{"items": [');
    expect(() => inbox.list()).toThrow(/^inbox_corrupt:/);
    expect(() => inbox.add({ title: 'New', ok: true })).toThrow(/^inbox_corrupt:/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"items": [');
    inbox.clear();
    expect(inbox.list()).toEqual([]);
  });

  test('a file without an items array or with a malformed item is corrupt', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(() => new InboxService({ filePath: file }).list()).toThrow('inbox_corrupt: items array missing');
    fs.writeFileSync(file, JSON.stringify({ version: 1, items: [{ id: 'nope' }] }));
    expect(() => new InboxService({ filePath: file }).list()).toThrow('inbox_corrupt: item 0 is malformed');
  });

  test('changed events carry the reason and unread count', () => {
    const seen = [];
    inbox.on('changed', (e) => seen.push(e));
    const a = inbox.add({ title: 'One', ok: true });
    inbox.markRead(a.id);
    inbox.delete(a.id);
    inbox.clear();
    expect(seen).toEqual([
      { reason: 'added', unread: 1 },
      { reason: 'read', unread: 0 },
      { reason: 'deleted', unread: 0 },
      { reason: 'cleared', unread: 0 },
    ]);
  });

  test('the inbox keeps the newest 500 items', () => {
    let first = null;
    for (let i = 0; i < 501; i++) {
      const it = inbox.add({ title: `Item ${i}`, ok: true });
      if (i === 0) first = it;
    }
    const items = inbox.list();
    expect(items).toHaveLength(500);
    expect(items[0].title).toBe('Item 500');
    expect(items.some((it) => it.id === first.id)).toBe(false);
  });

  test('long titles and summaries are cut', () => {
    const it = inbox.add({ title: 't'.repeat(500), summary: 's'.repeat(9000), ok: true });
    expect(it.title).toHaveLength(200);
    expect(it.summary).toHaveLength(8000);
  });

  test('invalid input is rejected without writing', () => {
    expect(() => inbox.add({ title: '', ok: true })).toThrow('title required');
    expect(() => inbox.add({ title: 'x', ok: 'yes' })).toThrow('ok must be a boolean');
    expect(() => inbox.add({ title: 'x', ok: true, summary: 5 })).toThrow('invalid_summary');
    expect(() => inbox.add({ title: 'x', ok: true, sessionId: '../etc' })).toThrow('invalid_session_id');
    expect(() => inbox.add(null)).toThrow('title required');
    expect(fs.existsSync(file)).toBe(false);
  });

  test('unknown and malformed ids are refused', () => {
    inbox.add({ title: 'One', ok: true });
    expect(() => inbox.markRead('ib_0000000000000000')).toThrow('not_found');
    expect(() => inbox.delete('ib_0000000000000000')).toThrow('not_found');
    expect(() => inbox.markRead('../../x')).toThrow('invalid_inbox_id');
    expect(() => assertItemId(42)).toThrow('invalid_inbox_id');
    expect(assertItemId('ib_0123456789abcdef')).toBe('ib_0123456789abcdef');
  });

  test('an unconfigured inbox and a relative path fail loudly', () => {
    const bare = new InboxService();
    expect(() => bare.list()).toThrow('inbox_not_configured');
    expect(() => bare.clear()).toThrow('inbox_not_configured');
    expect(() => bare.configure({ filePath: 'inbox.json' })).toThrow('absolute filePath required');
  });
});
