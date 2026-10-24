/**
 * @jest-environment jsdom
 */
// InboxPane — results delivered by background sessions and routines:
// inbox:list / mark-read / delete / clear, live via inbox:changed, and
// opening an item marks it read and loads its session.

const InboxPane = require('../../../../../renderer/components/assistant/InboxPane');

const { unreadCount } = InboxPane;

function makeMockIpc(handlers) {
  const listeners = new Map();
  return {
    invoke: jest.fn(async (ch, arg) => {
      if (!(ch in handlers)) throw new Error(`unexpected channel ${ch}`);
      const h = handlers[ch];
      return typeof h === 'function' ? h(arg) : h;
    }),
    on: jest.fn((ch, cb) => {
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch).add(cb);
    }),
    removeListener: jest.fn((ch, cb) => { if (listeners.has(ch)) listeners.get(ch).delete(cb); }),
    emit(ch, payload) { for (const cb of Array.from(listeners.get(ch) || [])) cb({}, payload); },
    listenerCount(ch) { return (listeners.get(ch) || new Set()).size; },
  };
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function items() {
  return [
    { id: 'i-old', sessionId: 's1', title: 'Old result', summary: 'Older', ok: true, createdAt: 100, read: true },
    { id: 'i-new', sessionId: 's2', title: 'Price check', summary: 'Found 12 prices', ok: true, createdAt: 300, read: false },
    { id: 'i-fail', sessionId: 's3', title: 'Nightly crawl', summary: 'Timed out', ok: false, createdAt: 200, read: false },
  ];
}

async function build(handlers = {}) {
  const ipc = makeMockIpc({
    'inbox:list': () => ({ ok: true, items: items() }),
    'inbox:mark-read': { ok: true },
    'inbox:delete': { ok: true },
    'inbox:clear': { ok: true },
    ...handlers,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onOpen = jest.fn();
  const pane = new InboxPane({ container, ipc, onOpen });
  const unread = jest.fn();
  pane.onUnreadChange(unread);
  await pane.refresh();
  return { pane, ipc, onOpen, unread };
}

function item(pane, id) { return pane.el.querySelector(`[data-item-id="${id}"]`); }
function tool(pane, label) {
  return Array.from(pane.el.querySelectorAll('.inbox-pane__toolbar button')).find((b) => b.textContent === label) || null;
}
function errorRow(pane) { return pane.el.querySelector('.inbox-pane__error'); }

afterEach(() => { document.body.innerHTML = ''; });

describe('InboxPane', () => {
  test('requires a container and onOpen', () => {
    expect(() => new InboxPane(/** @type {any} */ ({ onOpen: () => {} }))).toThrow(TypeError);
    expect(() => new InboxPane(/** @type {any} */ ({ container: document.createElement('div') }))).toThrow(TypeError);
  });

  test('lists items newest first with unread and failed states', async () => {
    const { pane, unread } = await build();
    const ids = Array.from(pane.el.querySelectorAll('[data-item-id]')).map((n) => n.getAttribute('data-item-id'));
    expect(ids).toEqual(['i-new', 'i-fail', 'i-old']);
    expect(item(pane, 'i-new').classList.contains('is-unread')).toBe(true);
    expect(item(pane, 'i-old').classList.contains('is-unread')).toBe(false);
    expect(item(pane, 'i-fail').classList.contains('is-failed')).toBe(true);
    expect(item(pane, 'i-fail').textContent).toContain('Failed');
    expect(pane.unread()).toBe(2);
    expect(unread).toHaveBeenLastCalledWith(2);
  });

  test('mark-read sends inbox:mark-read {id} and lowers the unread count', async () => {
    const { pane, ipc, unread } = await build();
    item(pane, 'i-new').querySelector('[data-action="mark-read"]').click();
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith('inbox:mark-read', { id: 'i-new' });
    expect(item(pane, 'i-new').classList.contains('is-unread')).toBe(false);
    expect(unread).toHaveBeenLastCalledWith(1);
  });

  test('a failed mark-read keeps the item unread and shows the error', async () => {
    const { pane } = await build({ 'inbox:mark-read': { ok: false, error: 'item_not_found' } });
    await pane.markRead('i-new');
    expect(item(pane, 'i-new').classList.contains('is-unread')).toBe(true);
    expect(errorRow(pane).hidden).toBe(false);
    expect(errorRow(pane).getAttribute('role')).toBe('alert');
    expect(errorRow(pane).textContent).toContain('Couldn’t mark as read: item_not_found');
  });

  test('Mark all read sends one inbox:mark-read {all:true}', async () => {
    const { pane, ipc, unread } = await build();
    tool(pane, 'Mark all read').click();
    await flush();
    expect(ipc.invoke.mock.calls.filter((c) => c[0] === 'inbox:mark-read')).toEqual([['inbox:mark-read', { all: true }]]);
    expect(pane.unread()).toBe(0);
    expect(unread).toHaveBeenLastCalledWith(0);
    expect(tool(pane, 'Mark all read')).toBeNull();
  });

  test('opening an item marks it read, then loads its session', async () => {
    const { pane, ipc, onOpen } = await build();
    item(pane, 'i-new').querySelector('[data-action="open"]').click();
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith('inbox:mark-read', { id: 'i-new' });
    expect(onOpen).toHaveBeenCalledWith('s2', expect.objectContaining({ id: 'i-new' }));
  });

  test('an item without a session (a routine that failed to start) has no Open action', async () => {
    const { pane, onOpen } = await build({
      'inbox:list': { ok: true, items: [{ id: 'orphan', sessionId: null, title: 'Routine did not start', ok: false, createdAt: 1, read: true }] },
    });
    expect(item(pane, 'orphan').querySelector('[data-action="open"]')).toBeNull();
    expect(item(pane, 'orphan').querySelector('button.inbox-pane__open')).toBeNull();
    expect(item(pane, 'orphan').textContent).toContain('Routine did not start');
    expect(item(pane, 'orphan').querySelector('[data-action="delete"]')).not.toBeNull();
    await pane.open('orphan');
    expect(onOpen).not.toHaveBeenCalled();
    expect(errorRow(pane).textContent).toContain('no session to open');
  });

  test('an unreadable inbox offers Clear inbox as recovery', async () => {
    let corrupt = true;
    const { pane, ipc } = await build({
      'inbox:list': () => (corrupt ? { ok: false, error: 'inbox_corrupt: item 3 is malformed' } : { ok: true, items: [] }),
      'inbox:clear': () => { corrupt = false; return { ok: true }; },
    });
    const buttons = Array.from(errorRow(pane).querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Retry', 'Clear inbox']);
    errorRow(pane).querySelectorAll('button')[1].click();
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith('inbox:clear', {});
    expect(errorRow(pane).hidden).toBe(true);
    expect(pane.el.querySelector('.inbox-pane__empty')).not.toBeNull();
  });

  test('an ordinary load failure offers only Retry', async () => {
    const { pane } = await build({ 'inbox:list': { ok: false, error: 'inbox_not_configured' } });
    expect(Array.from(errorRow(pane).querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Retry']);
  });

  test('delete sends inbox:delete {id} and removes the item', async () => {
    const { pane, ipc } = await build();
    item(pane, 'i-old').querySelector('[data-action="delete"]').click();
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith('inbox:delete', { id: 'i-old' });
    expect(item(pane, 'i-old')).toBeNull();
  });

  test('Clear asks inline, then sends inbox:clear', async () => {
    const { pane, ipc, unread } = await build();
    tool(pane, 'Clear').click();
    expect(ipc.invoke.mock.calls.some((c) => c[0] === 'inbox:clear')).toBe(false);
    expect(pane.el.querySelector('.inbox-pane__confirm').textContent).toContain('Clear all?');
    pane.el.querySelector('.inbox-pane__confirm .inbox-pane__tool--danger').click();
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith('inbox:clear', {});
    expect(pane.items()).toEqual([]);
    expect(unread).toHaveBeenLastCalledWith(0);
  });

  test('Cancel on the clear confirm sends nothing', async () => {
    const { pane, ipc } = await build();
    tool(pane, 'Clear').click();
    tool(pane, 'Cancel').click();
    expect(ipc.invoke.mock.calls.some((c) => c[0] === 'inbox:clear')).toBe(false);
    expect(pane.items()).toHaveLength(3);
  });

  test('a rejected clear keeps the items and shows the error', async () => {
    const { pane } = await build({ 'inbox:clear': () => { throw new Error('write failed'); } });
    await pane.clear();
    expect(pane.items()).toHaveLength(3);
    expect(errorRow(pane).textContent).toContain('Couldn’t clear the inbox: write failed');
  });

  test('a failed inbox:list shows a retry, not an empty inbox', async () => {
    let fail = true;
    const { pane } = await build({ 'inbox:list': () => (fail ? { ok: false, error: 'inbox_unreadable' } : { ok: true, items: items() }) });
    expect(errorRow(pane).textContent).toContain('Couldn’t load the inbox: inbox_unreadable');
    expect(pane.el.querySelector('.inbox-pane__empty')).toBeNull();
    fail = false;
    errorRow(pane).querySelector('button').click();
    await flush();
    expect(errorRow(pane).hidden).toBe(true);
    expect(pane.items()).toHaveLength(3);
  });

  test('inbox:changed reloads the list', async () => {
    const { pane, ipc } = await build();
    ipc.emit('inbox:changed', { reason: 'added', unread: 3 });
    await flush();
    expect(ipc.invoke.mock.calls.filter((c) => c[0] === 'inbox:list')).toHaveLength(2);
    expect(pane.items()).toHaveLength(3);
  });

  test('destroy unsubscribes from inbox:changed', async () => {
    const { pane, ipc } = await build();
    pane.destroy();
    expect(ipc.listenerCount('inbox:changed')).toBe(0);
  });

  describe('unreadCount', () => {
    test('prefers the unread field, else counts unread items', () => {
      expect(unreadCount({ ok: true, items: [], unread: 7 })).toBe(7);
      expect(unreadCount({ ok: true, items: items() })).toBe(2);
      expect(unreadCount({ reason: 'added', unread: 0 })).toBe(0);
    });

    test('throws on a malformed or failed reply', () => {
      expect(() => unreadCount(undefined)).toThrow('inbox:list returned no items');
      expect(() => unreadCount({ ok: false, error: 'inbox_unreadable' })).toThrow('inbox_unreadable');
      expect(() => unreadCount({ ok: true })).toThrow();
    });
  });
});
