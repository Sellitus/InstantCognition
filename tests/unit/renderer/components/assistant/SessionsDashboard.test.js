/**
 * @jest-environment jsdom
 */
// SessionsDashboard — running/paused/queued sessions from session:running
// plus session:event, step counts, Stop/Open, and completion notices (Toast,
// plus a desktop Notification while the window is unfocused).

const SessionsDashboard = require('../../../../../renderer/components/assistant/SessionsDashboard');

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

function makeMockToast() {
  return { success: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function build(opts = {}) {
  const ipc = makeMockIpc({ 'session:running': { ok: true, runs: [] }, 'session:stop': { ok: true, state: 'stopping' }, ...(opts.handlers || {}) });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onOpen = jest.fn();
  const toast = makeMockToast();
  const dash = new SessionsDashboard({
    container,
    ipc,
    onOpen,
    toast,
    notifier: opts.notifier === undefined ? null : opts.notifier,
    hasFocus: opts.hasFocus || (() => true),
  });
  return { dash, ipc, onOpen, toast, container };
}

function ev(sessionId, channel, payload = {}) { return { sessionId, channel, payload }; }
function rowOf(dash, id) { return dash.el.querySelector(`[data-session-id="${id}"]`); }

afterEach(() => { document.body.innerHTML = ''; });

describe('SessionsDashboard', () => {
  test('requires a container and onOpen', () => {
    expect(() => new SessionsDashboard(/** @type {any} */ ({ onOpen: () => {} }))).toThrow(TypeError);
    expect(() => new SessionsDashboard(/** @type {any} */ ({ container: document.createElement('div') }))).toThrow(TypeError);
  });

  test('counts come from session:event and the summary reads them', () => {
    const { dash, ipc } = build();
    ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Scrape prices' } }));
    ipc.emit('session:event', ev('b', 'task-started', { task: { description: 'Draft memo' } }));
    ipc.emit('session:event', ev('c', 'queued', { position: 1 }));
    ipc.emit('session:event', ev('b', 'task-paused'));
    expect(dash.counts()).toEqual({ running: 1, paused: 1, queued: 1 });
    expect(dash.el.querySelector('.sessions-dashboard__summary').textContent).toBe('1 running · 1 paused · 1 queued');
    expect(rowOf(dash, 'a').textContent).toContain('Scrape prices');

    ipc.emit('session:event', ev('b', 'task-resumed'));
    ipc.emit('session:event', ev('a', 'task-completed', { ok: true, summary: 'done' }));
    ipc.emit('session:event', ev('c', 'dequeued'));
    expect(dash.counts()).toEqual({ running: 1, paused: 0, queued: 0 });
    expect(rowOf(dash, 'a')).toBeNull();
    expect(rowOf(dash, 'c')).toBeNull();
  });

  test('step-acted counts steps per session and events for other sessions are filtered', () => {
    const { dash, ipc } = build();
    ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Run' } }));
    ipc.emit('session:event', ev('a', 'step-acted', { step: 1 }));
    ipc.emit('session:event', ev('a', 'step-acted', { step: 2 }));
    ipc.emit('session:event', ev('other', 'step-acted', { step: 1 }));
    ipc.emit('session:event', ev('other', 'task-paused'));
    expect(dash.get('a').steps).toBe(2);
    expect(dash.get('other')).toBeNull();
    expect(dash.counts()).toEqual({ running: 1, paused: 0, queued: 0 });
    expect(rowOf(dash, 'a').querySelector('.sessions-dashboard__steps').textContent).toContain('2');
  });

  test('malformed events are ignored', () => {
    const { dash, ipc } = build();
    ipc.emit('session:event', null);
    ipc.emit('session:event', { channel: 'task-started' });
    ipc.emit('session:event', { sessionId: 'x' });
    expect(dash.counts()).toEqual({ running: 0, paused: 0, queued: 0 });
  });

  test('refresh seeds from session:running and keeps step counts already seen', async () => {
    const { dash, ipc } = build({
      handlers: {
        'session:running': {
          ok: true,
          runs: [
            { sessionId: 'a', lane: 'background', state: 'running', task: 'Run A' },
            { sessionId: 'q', lane: 'background', state: 'queued', task: 'Later', position: 2 },
          ],
        },
      },
    });
    ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Run A' } }));
    ipc.emit('session:event', ev('a', 'step-acted'));
    await dash.refresh();
    expect(dash.counts()).toEqual({ running: 1, paused: 0, queued: 1 });
    expect(dash.get('a').steps).toBe(1);
    expect(dash.get('q').position).toBe(2);
  });

  test('a failed session:running is shown with a retry', async () => {
    const { dash } = build({ handlers: { 'session:running': { ok: false, error: 'manager_down' } } });
    await dash.refresh();
    const status = dash.el.querySelector('.sessions-dashboard__status');
    expect(status.hidden).toBe(false);
    expect(status.getAttribute('role')).toBe('alert');
    expect(status.textContent).toContain('manager_down');
  });

  describe('stop', () => {
    test('stopping a finished session is a no-op: nothing is sent', async () => {
      const { dash, ipc } = build();
      ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Run' } }));
      ipc.emit('session:event', ev('a', 'task-completed', { ok: true }));
      await expect(dash.stop('a')).resolves.toEqual({ ok: true, state: 'finished' });
      await expect(dash.stop('never-seen')).resolves.toEqual({ ok: true, state: 'finished' });
      expect(ipc.invoke.mock.calls.some((c) => c[0] === 'session:stop')).toBe(false);
    });

    test('Stop on a running row sends session:stop and shows Stopping…', async () => {
      const { dash, ipc } = build();
      ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Run' } }));
      rowOf(dash, 'a').querySelector('[data-action="stop"]').click();
      expect(ipc.invoke).toHaveBeenCalledWith('session:stop', { sessionId: 'a' });
      const btn = rowOf(dash, 'a').querySelector('[data-action="stop"]');
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toContain('Stopping');
      await flush();
    });

    test('a run that ended before main saw the stop resolves as finished and drops the row', async () => {
      const { dash, ipc } = build({ handlers: { 'session:stop': { ok: false, error: 'not_running' } } });
      ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Run' } }));
      await expect(dash.stop('a')).resolves.toEqual({ ok: true, state: 'finished' });
      expect(rowOf(dash, 'a')).toBeNull();
    });

    test('a stop failure stays on the row as a visible error', async () => {
      const { dash, ipc } = build({ handlers: { 'session:stop': () => { throw new Error('ipc closed'); } } });
      ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Run' } }));
      await expect(dash.stop('a')).resolves.toEqual({ ok: false, error: 'ipc closed' });
      const err = rowOf(dash, 'a').querySelector('.sessions-dashboard__row-error');
      expect(err.textContent).toBe('Couldn’t stop: ipc closed');
      expect(err.getAttribute('role')).toBe('alert');
    });

    test('stopping a queued session dequeues it', async () => {
      const { dash, ipc } = build({ handlers: { 'session:stop': { ok: true, state: 'dequeued' } } });
      ipc.emit('session:event', ev('q', 'queued', { position: 1 }));
      await dash.stop('q');
      expect(rowOf(dash, 'q')).toBeNull();
    });
  });

  test('Open hands the session to onOpen', () => {
    const { dash, ipc, onOpen } = build();
    ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Run' } }));
    rowOf(dash, 'a').querySelector('[data-action="open"]').click();
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  describe('completion notices', () => {
    test('task-completed with notify raises a Toast whose action opens the session', () => {
      const { ipc, toast, onOpen } = build();
      ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Scrape prices' } }));
      ipc.emit('session:event', ev('a', 'task-completed', { ok: true, summary: 'Found 12', notify: true }));
      expect(toast.success).toHaveBeenCalledWith('Finished: Scrape prices', expect.objectContaining({ title: 'Session complete' }));
      toast.success.mock.calls[0][1].action.onClick();
      expect(onOpen).toHaveBeenCalledWith('a');
    });

    test('task-completed without notify stays quiet', () => {
      const { ipc, toast } = build();
      ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Run' } }));
      ipc.emit('session:event', ev('a', 'task-completed', { ok: true }));
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.warn).not.toHaveBeenCalled();
    });

    test('only notify === true announces; a truthy non-boolean does not', () => {
      const { ipc, toast } = build();
      ipc.emit('session:event', ev('a', 'task-completed', { ok: true, notify: 'yes' }));
      ipc.emit('session:event', ev('b', 'task-completed', { ok: true, notify: 1 }));
      expect(toast.success).not.toHaveBeenCalled();
    });

    test('inbox-failed is surfaced as an error toast that can open the session', () => {
      const { ipc, toast, onOpen, dash } = build();
      ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Nightly crawl' } }));
      ipc.emit('session:event', ev('a', 'inbox-failed', { error: 'inbox_corrupt: items array missing' }));
      expect(toast.error).toHaveBeenCalledWith(
        'Nightly crawl finished, but its result could not be saved to the inbox: inbox_corrupt: items array missing',
        expect.objectContaining({ title: 'Inbox' }),
      );
      toast.error.mock.calls[0][1].action.onClick();
      expect(onOpen).toHaveBeenCalledWith('a');
      expect(dash.get('a')).not.toBeNull();
    });

    test('subagent events neither add rows nor change counts', () => {
      const { ipc, dash } = build();
      ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Parent' } }));
      ipc.emit('session:event', ev('a', 'subagent-started', { subagentId: 'x' }));
      ipc.emit('session:event', ev('a', 'subagent-completed', { subagentId: 'x' }));
      expect(dash.counts()).toEqual({ running: 1, paused: 0, queued: 0 });
      expect(dash.get('a').steps).toBe(0);
    });

    test('a stopped run warns instead of reporting success', () => {
      const { ipc, toast } = build();
      ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Run' } }));
      ipc.emit('session:event', ev('a', 'task-completed', { ok: false, reason: 'stopped', notify: true }));
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.warn).toHaveBeenCalledWith('Stopped: Run', expect.objectContaining({ title: 'Session ended' }));
    });

    test('a focused window gets no desktop notification', async () => {
      const mockNotification = jest.fn();
      mockNotification.permission = 'granted';
      const { ipc } = build({ notifier: mockNotification, hasFocus: () => true });
      ipc.emit('session:event', ev('a', 'task-completed', { ok: true, notify: true }));
      await flush();
      expect(mockNotification).not.toHaveBeenCalled();
    });

    test('an unfocused window also gets a desktop notification that opens the session', async () => {
      const instances = [];
      const mockNotification = jest.fn(function MockNotification(title, options) {
        this.title = title;
        this.options = options;
        instances.push(this);
      });
      mockNotification.permission = 'granted';
      const { ipc, onOpen } = build({ notifier: mockNotification, hasFocus: () => false });
      ipc.emit('session:event', ev('a', 'task-started', { task: { description: 'Scrape' } }));
      ipc.emit('session:event', ev('a', 'task-completed', { ok: true, summary: 'Found 12 prices', notify: true }));
      await flush();
      expect(mockNotification).toHaveBeenCalledWith('Session complete', { body: 'Found 12 prices', tag: 'session-a' });
      const focus = jest.spyOn(window, 'focus').mockImplementation(() => {});
      instances[0].onclick();
      expect(focus).toHaveBeenCalled();
      focus.mockRestore();
      expect(onOpen).toHaveBeenCalledWith('a');
    });

    test('permission is requested when undecided, and a denial skips the desktop copy', async () => {
      const mockNotification = jest.fn();
      mockNotification.permission = 'default';
      mockNotification.requestPermission = jest.fn(async () => 'denied');
      const { ipc, toast } = build({ notifier: mockNotification, hasFocus: () => false });
      ipc.emit('session:event', ev('a', 'task-completed', { ok: true, notify: true }));
      await flush();
      expect(mockNotification.requestPermission).toHaveBeenCalled();
      expect(mockNotification).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalled();
    });

    test('a Notification API that throws is surfaced, not swallowed', async () => {
      const mockNotification = jest.fn(() => { throw new Error('not allowed in this context'); });
      mockNotification.permission = 'granted';
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const { ipc, toast } = build({ notifier: mockNotification, hasFocus: () => false });
      ipc.emit('session:event', ev('a', 'task-completed', { ok: true, notify: true }));
      await flush();
      expect(toast.warn).toHaveBeenCalledWith('Desktop notification failed: not allowed in this context', expect.any(Object));
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    test('a background failure raises an error toast; a foreground one is left to the thread', async () => {
      const { dash, ipc, toast } = build({
        handlers: { 'session:running': { ok: true, runs: [{ sessionId: 'fg', lane: 'foreground', state: 'running', task: 'Visible' }] } },
      });
      await dash.refresh();
      ipc.emit('session:event', ev('fg', 'task-failed', { error: 'boom' }));
      expect(toast.error).not.toHaveBeenCalled();
      ipc.emit('session:event', ev('bg', 'task-started', { task: { description: 'Hidden' } }));
      ipc.emit('session:event', ev('bg', 'task-failed', { error: 'boom' }));
      expect(toast.error).toHaveBeenCalledWith('Hidden failed: boom', expect.objectContaining({ title: 'Session failed' }));
    });
  });

  test('destroy unsubscribes from session:event', () => {
    const { dash, ipc } = build();
    expect(ipc.listenerCount('session:event')).toBe(1);
    dash.destroy();
    expect(ipc.listenerCount('session:event')).toBe(0);
  });
});
