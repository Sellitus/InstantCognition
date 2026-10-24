/**
 * @jest-environment jsdom
 */
// SessionList — the Assistant's sessions column: session:list rows, search,
// pin, inline rename, inline delete confirm, project grouping, and visible
// error rows when an IPC call rejects or answers {ok:false}.

const SessionList = require('../../../../../renderer/components/assistant/SessionList');

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

const SESSIONS = [
  { id: 's-pin', title: 'Pinned plan', updatedAt: 30, pinned: true },
  { id: 's-proj', title: 'Project work', updatedAt: 20, projectId: 'p1' },
  { id: 's-a', title: 'Alpha chat', updatedAt: 10, legacyRunId: 'run-a' },
  { id: 's-b', title: 'Beta research', updatedAt: 5, source: 'routine' },
];

function sessionsCopy() { return SESSIONS.map((s) => ({ ...s })); }

async function build(handlers = {}) {
  const ipc = makeMockIpc({
    'session:list': () => ({ ok: true, sessions: sessionsCopy() }),
    'projects:list': { ok: true, projects: [{ id: 'p1', name: 'Launch' }] },
    ...handlers,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  const onCountChange = jest.fn();
  const list = new SessionList({ root, ipc, onCountChange });
  await list.refresh();
  await flush();
  return { list, ipc, root, onCountChange };
}

function row(list, id) { return list.el.querySelector(`[data-session-id="${id}"]`); }
function action(list, id, name) { return row(list, id).querySelector(`[data-action="${name}"]`); }
function errorRow(list) { return list.el.querySelector('.session-list__error'); }

afterEach(() => { document.body.innerHTML = ''; });

describe('SessionList', () => {
  test('requires a root element', () => {
    expect(() => new SessionList(/** @type {any} */ ({}))).toThrow(TypeError);
  });

  test('renders session:list rows grouped Pinned, project (by name), then Recent', async () => {
    const { list, ipc, onCountChange } = await build();
    expect(ipc.invoke).toHaveBeenCalledWith('session:list', {});
    expect(list.el.classList.contains('agent-history')).toBe(true);
    const labels = Array.from(list.el.querySelectorAll('.session-list__group')).map((n) => n.textContent);
    expect(labels).toEqual(['Pinned', 'Launch', 'Recent']);
    const order = Array.from(list.el.querySelectorAll('[data-session-id]')).map((n) => n.getAttribute('data-session-id'));
    expect(order).toEqual(['s-pin', 's-proj', 's-a', 's-b']);
    expect(row(list, 's-b').textContent).toContain('Routine');
    expect(list.count()).toBe(4);
    expect(onCountChange).toHaveBeenLastCalledWith(4);
  });

  test('a single group renders without group labels', async () => {
    const { list } = await build({ 'session:list': { ok: true, sessions: [{ id: 'x', title: 'Only', updatedAt: 1 }] } });
    expect(list.el.querySelectorAll('.session-list__group')).toHaveLength(0);
    expect(row(list, 'x')).not.toBeNull();
  });

  test('the search box shows hint text while it is empty', async () => {
    const { list } = await build();
    const search = list.el.querySelector('.session-list__search');
    expect(search.getAttribute('placeholder')).toBe('Search sessions');
    expect(search.value).toBe('');
  });

  test('search filters by title and says when nothing matches', async () => {
    const { list } = await build();
    const search = list.el.querySelector('.session-list__search');
    search.value = 'alpha';
    search.dispatchEvent(new Event('input'));
    expect(Array.from(list.el.querySelectorAll('[data-session-id]')).map((n) => n.getAttribute('data-session-id'))).toEqual(['s-a']);
    search.value = 'zzz';
    search.dispatchEvent(new Event('input'));
    expect(list.el.querySelectorAll('[data-session-id]')).toHaveLength(0);
    expect(list.el.querySelector('.session-list__empty').textContent).toBe('No matching sessions.');
  });

  test('a rejected session:list shows a load error with a working retry', async () => {
    let fail = true;
    const { list, ipc } = await build({
      'session:list': () => {
        if (fail) throw new Error('store offline');
        return { ok: true, sessions: sessionsCopy() };
      },
    });
    const box = list.el.querySelector('.session-list__load-error');
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.textContent).toContain('store offline');
    fail = false;
    list.el.querySelector('.session-list__retry').click();
    await flush();
    expect(list.el.querySelector('.session-list__load-error')).toBeNull();
    expect(row(list, 's-a')).not.toBeNull();
    expect(ipc.invoke.mock.calls.filter((c) => c[0] === 'session:list')).toHaveLength(2);
  });

  test('an {ok:false} session:list reply is shown as an error, not as an empty list', async () => {
    const { list } = await build({ 'session:list': { ok: false, error: 'index_corrupt' } });
    expect(list.el.querySelector('.session-list__load-error').textContent).toContain('index_corrupt');
    expect(list.el.querySelector('.session-list__empty')).toBeNull();
  });

  test('session:list-changed reloads the list', async () => {
    const { list, ipc } = await build();
    ipc.emit('session:list-changed', { sessionId: 's-new', reason: 'created' });
    await flush();
    expect(ipc.invoke.mock.calls.filter((c) => c[0] === 'session:list')).toHaveLength(2);
    expect(list.count()).toBe(4);
  });

  describe('rename', () => {
    test('Enter commits through session:rename and shows the new title', async () => {
      const { list, ipc } = await build({
        'session:rename': ({ sessionId, title }) => ({ ok: true, session: { id: sessionId, title } }),
      });
      action(list, 's-a', 'rename').click();
      const input = list.el.querySelector('.session-list__rename-input');
      expect(input.getAttribute('aria-label')).toBe('Rename session');
      input.value = '  Alpha renamed ';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await flush();
      expect(ipc.invoke).toHaveBeenCalledWith('session:rename', { sessionId: 's-a', title: 'Alpha renamed' });
      expect(row(list, 's-a').querySelector('.session-list__row-title').textContent).toBe('Alpha renamed');
      expect(errorRow(list).hidden).toBe(true);
    });

    test('an {ok:false} reply keeps the old title and shows a visible error row', async () => {
      const { list } = await build({ 'session:rename': { ok: false, error: 'session_busy' } });
      action(list, 's-a', 'rename').click();
      const input = list.el.querySelector('.session-list__rename-input');
      input.value = 'New';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flush();
      expect(row(list, 's-a').querySelector('.session-list__row-title').textContent).toBe('Alpha chat');
      const err = errorRow(list);
      expect(err.hidden).toBe(false);
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toContain('Couldn’t rename session: it is still running');
      err.querySelector('.session-list__error-dismiss').click();
      expect(err.hidden).toBe(true);
    });

    test('an empty name is refused without an IPC call', async () => {
      const { list, ipc } = await build();
      action(list, 's-a', 'rename').click();
      const input = list.el.querySelector('.session-list__rename-input');
      input.value = '   ';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flush();
      expect(ipc.invoke.mock.calls.some((c) => c[0] === 'session:rename')).toBe(false);
      expect(errorRow(list).textContent).toContain('the name cannot be empty');
    });

    test('Esc cancels without saving and does not reach the panel', async () => {
      const { list, ipc } = await build();
      const outer = jest.fn();
      document.addEventListener('keydown', outer);
      action(list, 's-a', 'rename').click();
      const input = list.el.querySelector('.session-list__rename-input');
      input.value = 'Discard me';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await flush();
      document.removeEventListener('keydown', outer);
      expect(outer).not.toHaveBeenCalled();
      expect(list.el.querySelector('.session-list__rename-input')).toBeNull();
      expect(ipc.invoke.mock.calls.some((c) => c[0] === 'session:rename')).toBe(false);
    });

    test('F2 on a focused row starts renaming it', async () => {
      const { list } = await build();
      const open = action(list, 's-b', 'open');
      open.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
      expect(row(list, 's-b').querySelector('.session-list__rename-input')).not.toBeNull();
    });
  });

  describe('pin', () => {
    test('pinning sends session:pin and moves the row into Pinned', async () => {
      const { list, ipc } = await build({
        'session:pin': ({ sessionId, pinned }) => ({ ok: true, session: { id: sessionId, pinned } }),
      });
      expect(action(list, 's-b', 'pin').getAttribute('aria-pressed')).toBe('false');
      action(list, 's-b', 'pin').click();
      await flush();
      expect(ipc.invoke).toHaveBeenCalledWith('session:pin', { sessionId: 's-b', pinned: true });
      expect(action(list, 's-b', 'pin').getAttribute('aria-pressed')).toBe('true');
      const order = Array.from(list.el.querySelectorAll('[data-session-id]')).map((n) => n.getAttribute('data-session-id'));
      expect(order.slice(0, 2)).toEqual(['s-pin', 's-b']);
    });

    test('unpinning sends pinned:false', async () => {
      const { list, ipc } = await build({ 'session:pin': { ok: true } });
      action(list, 's-pin', 'pin').click();
      await flush();
      expect(ipc.invoke).toHaveBeenCalledWith('session:pin', { sessionId: 's-pin', pinned: false });
      expect(action(list, 's-pin', 'pin').getAttribute('aria-pressed')).toBe('false');
    });

    test('a rejected pin leaves the row unpinned and shows the error', async () => {
      const { list } = await build({ 'session:pin': () => { throw new Error('disk full'); } });
      action(list, 's-b', 'pin').click();
      await flush();
      expect(action(list, 's-b', 'pin').getAttribute('aria-pressed')).toBe('false');
      expect(errorRow(list).hidden).toBe(false);
      expect(errorRow(list).textContent).toContain('Couldn’t pin session: disk full');
    });
  });

  describe('delete', () => {
    test('asks inline first, then deletes through session:delete', async () => {
      const { list, ipc, onCountChange } = await build({ 'session:delete': { ok: true } });
      action(list, 's-b', 'delete').click();
      expect(ipc.invoke.mock.calls.some((c) => c[0] === 'session:delete')).toBe(false);
      const confirm = row(list, 's-b').querySelector('.session-list__confirm');
      expect(confirm.textContent).toContain('Beta research');
      confirm.querySelector('[data-action="confirm-delete"]').click();
      await flush();
      expect(ipc.invoke).toHaveBeenCalledWith('session:delete', { sessionId: 's-b' });
      expect(row(list, 's-b')).toBeNull();
      expect(onCountChange).toHaveBeenLastCalledWith(3);
    });

    test('Cancel keeps the row and sends nothing', async () => {
      const { list, ipc } = await build();
      action(list, 's-b', 'delete').click();
      row(list, 's-b').querySelector('[data-action="cancel-inline"]').click();
      expect(row(list, 's-b').querySelector('.session-list__confirm')).toBeNull();
      expect(ipc.invoke.mock.calls.some((c) => c[0] === 'session:delete')).toBe(false);
    });

    test('deleting a running session keeps it and explains why', async () => {
      const { list } = await build({ 'session:delete': { ok: false, error: 'session_busy' } });
      list.startDelete('s-a');
      row(list, 's-a').querySelector('[data-action="confirm-delete"]').click();
      await flush();
      expect(row(list, 's-a')).not.toBeNull();
      expect(errorRow(list).textContent).toContain('Couldn’t delete session: it is still running');
    });
  });

  describe('selection', () => {
    test('opening a row notifies onSelect and marks it current', async () => {
      const { list } = await build();
      const onSelect = jest.fn();
      const off = list.onSelect(onSelect);
      action(list, 's-a', 'open').click();
      expect(onSelect).toHaveBeenCalledWith('s-a', expect.objectContaining({ id: 's-a' }));
      expect(action(list, 's-a', 'open').getAttribute('aria-current')).toBe('true');
      off();
      action(list, 's-b', 'open').click();
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    test('setActive accepts the legacy run id an imported session carries', async () => {
      const { list } = await build();
      list.setActive('run-a');
      expect(list.getActive()).toBe('s-a');
      expect(row(list, 's-a').classList.contains('is-active')).toBe(true);
    });
  });

  test('session:event marks only the named session as running', async () => {
    const { list, ipc } = await build();
    ipc.emit('session:event', { sessionId: 's-b', channel: 'task-started', payload: {} });
    expect(row(list, 's-b').querySelector('.session-list__running')).not.toBeNull();
    expect(row(list, 's-a').querySelector('.session-list__running')).toBeNull();
    ipc.emit('session:event', { sessionId: 's-b', channel: 'task-completed', payload: {} });
    expect(row(list, 's-b').querySelector('.session-list__running')).toBeNull();
  });

  test('destroy unsubscribes every IPC listener', async () => {
    const { list, ipc } = await build();
    expect(ipc.listenerCount('session:list-changed')).toBe(1);
    list.destroy();
    expect(ipc.listenerCount('session:list-changed')).toBe(0);
    expect(ipc.listenerCount('session:event')).toBe(0);
    expect(ipc.listenerCount('agent:task-started')).toBe(0);
    expect(list.el.isConnected).toBe(false);
  });
});
