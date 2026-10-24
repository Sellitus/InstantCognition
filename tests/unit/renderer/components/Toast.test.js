/** @jest-environment jsdom */

// Toast — singleton notification stack. show() kind normalization +
// dedup window, info/success/warn/error sugar (error's 6s default),
// MAX_VISIBLE queueing + queue drain on dismiss, close + action
// buttons, escapeHtml in title/message, auto-dismiss timer, and the
// container re-creation guard.

jest.useFakeTimers();

const toast = require('../../../../renderer/components/Toast');

function resetToast() {
  // Singleton — clear its mutable state and the DOM between tests.
  toast._queue.length = 0;
  for (const rec of toast._visible.slice()) {
    if (rec.timerId) clearTimeout(rec.timerId);
    if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
  }
  toast._visible.length = 0;
  toast._lastShown.clear();
  if (toast._container && toast._container.parentNode) {
    toast._container.parentNode.removeChild(toast._container);
  }
  toast._container = null;
  document.body.innerHTML = '';
}

function toasts() {
  return Array.from(document.querySelectorAll('.toast'));
}

describe('Toast.show', () => {
  beforeEach(resetToast);

  test('returns null and renders nothing for a missing message', () => {
    expect(toast.show(null)).toBeNull();
    expect(toast.show({})).toBeNull();
    expect(toasts()).toHaveLength(0);
  });

  test('renders a toast and returns its id', () => {
    const id = toast.show({ kind: 'success', message: 'Saved' });
    expect(typeof id).toBe('string');
    const el = document.querySelector('.toast');
    expect(el.classList.contains('toast-success')).toBe(true);
    expect(el.dataset.id).toBe(id);
    expect(el.textContent).toContain('Saved');
  });

  test('an unknown kind falls back to info', () => {
    toast.show({ kind: 'bogus', message: 'hey' });
    expect(document.querySelector('.toast').classList.contains('toast-info')).toBe(true);
  });

  test('error and warn get role=alert; info/success get role=status', () => {
    toast.show({ kind: 'error', message: 'bad' });
    toast.show({ kind: 'info', message: 'fyi' });
    const [err, info] = toasts();
    expect(err.getAttribute('role')).toBe('alert');
    expect(info.getAttribute('role')).toBe('status');
  });

  test('escapes HTML in the title and message', () => {
    toast.show({ message: '<img src=x onerror=1>', title: '<b>t</b>' });
    const el = document.querySelector('.toast');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.toast-title b')).toBeNull();
    expect(el.querySelector('.toast-message').textContent).toContain('<img src=x onerror=1>');
  });

  test('omits the title element when no title is given', () => {
    toast.show({ message: 'no title' });
    expect(document.querySelector('.toast-title')).toBeNull();
  });

  test('dedups identical kind+message within the 3s window', () => {
    expect(toast.show({ message: 'dup' })).not.toBeNull();
    expect(toast.show({ message: 'dup' })).toBeNull(); // suppressed
    expect(toasts()).toHaveLength(1);
    jest.advanceTimersByTime(3001);
    expect(toast.show({ message: 'dup' })).not.toBeNull(); // window elapsed
    expect(toasts()).toHaveLength(2);
  });

  test('a different message is not deduped', () => {
    toast.show({ message: 'a' });
    toast.show({ message: 'b' });
    expect(toasts()).toHaveLength(2);
  });
});

describe('Toast sugar helpers', () => {
  beforeEach(resetToast);

  test('info / success / warn set their kind', () => {
    toast.info('i');
    toast.success('s');
    toast.warn('w');
    const classes = toasts().map((t) => t.className);
    expect(classes[0]).toContain('toast-info');
    expect(classes[1]).toContain('toast-success');
    expect(classes[2]).toContain('toast-warn');
  });

  test('error defaults to a 6s timeout and respects an explicit override', () => {
    toast.error('boom');
    const rec = toast._visible[0];
    expect(rec.entry.timeout).toBe(6000);
    resetToast();
    toast.error('boom2', { timeout: 1234 });
    expect(toast._visible[0].entry.timeout).toBe(1234);
  });

  test('a non-finite timeout falls back to the 4s default', () => {
    toast.show({ message: 'x', timeout: 'soon' });
    expect(toast._visible[0].entry.timeout).toBe(4000);
  });

  test('timeout:0 disables auto-dismiss (no timer scheduled)', () => {
    toast.show({ message: 'sticky', timeout: 0 });
    expect(toast._visible[0].timerId).toBeNull();
    jest.advanceTimersByTime(100000);
    expect(toasts()).toHaveLength(1);
  });
});

describe('Toast lifecycle', () => {
  beforeEach(resetToast);

  test('auto-dismisses after its timeout (with the 180ms leave animation)', () => {
    toast.show({ message: 'temp', timeout: 4000 });
    expect(toasts()).toHaveLength(1);
    jest.advanceTimersByTime(4000);
    expect(document.querySelector('.toast').classList.contains('toast-leaving')).toBe(true);
    jest.advanceTimersByTime(180);
    expect(toasts()).toHaveLength(0);
  });

  test('the close button dismisses the toast', () => {
    toast.show({ message: 'closeme', timeout: 0 });
    document.querySelector('.toast-close').click();
    jest.advanceTimersByTime(180);
    expect(toasts()).toHaveLength(0);
  });

  test('dismiss(unknown id) is a safe no-op', () => {
    toast.show({ message: 'x', timeout: 0 });
    expect(() => toast.dismiss('no-such-id')).not.toThrow();
    expect(toasts()).toHaveLength(1);
  });

  test('action button invokes onClick then dismisses', () => {
    const onClick = jest.fn();
    toast.show({ message: 'with action', timeout: 0, action: { label: 'Undo', onClick } });
    const actBtn = document.querySelector('.toast-action');
    expect(actBtn.textContent).toBe('Undo');
    actBtn.click();
    expect(onClick).toHaveBeenCalled();
    jest.advanceTimersByTime(180);
    expect(toasts()).toHaveLength(0);
  });

  test('action onClick errors are swallowed (toast still dismisses)', () => {
    toast.show({
      message: 'boom action', timeout: 0,
      action: { label: 'Go', onClick: () => { throw new Error('nope'); } },
    });
    expect(() => document.querySelector('.toast-action').click()).not.toThrow();
    jest.advanceTimersByTime(180);
    expect(toasts()).toHaveLength(0);
  });

  test('several actions render in order under the message, and each runs only its own handler', () => {
    const first = jest.fn();
    const second = jest.fn();
    toast.show({ message: 'two actions', timeout: 0, actions: [{ label: 'Update', onClick: first }, { label: 'Update + Restart', onClick: second }] });
    const buttons = [...document.querySelectorAll('.toast-actions .toast-action')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Update', 'Update + Restart']);

    buttons[1].click();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(toast._visible).toHaveLength(0);
  });

  test('a single action stays beside the message', () => {
    toast.show({ message: 'one action', timeout: 0, actions: [{ label: 'Show', onClick: jest.fn() }] });
    expect(document.querySelector('.toast-actions')).toBeNull();
    expect(document.querySelector('.toast > .toast-action').textContent).toBe('Show');
  });

  test('an action without a label renders no action button', () => {
    toast.show({ message: 'noaction', timeout: 0, action: { onClick: jest.fn() } });
    expect(document.querySelector('.toast-action')).toBeNull();
  });

  test('only MAX_VISIBLE (3) show at once; the rest queue and drain on dismiss', () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(toast.show({ message: `m${i}`, timeout: 0 }));
    expect(toasts()).toHaveLength(3);
    expect(toast._queue).toHaveLength(2);

    toast.dismiss(ids[0]);
    jest.advanceTimersByTime(180);
    // One dismissed → one dequeued and rendered.
    expect(toasts()).toHaveLength(3);
    expect(toast._queue).toHaveLength(1);

    toast.dismiss(ids[1]);
    jest.advanceTimersByTime(180);
    expect(toast._queue).toHaveLength(0);
    expect(toasts()).toHaveLength(3);
  });

  test('dismiss(id) cancels an entry still waiting in the queue — it never renders', () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(toast.show({ message: `q${i}`, timeout: 0 }));
    expect(toasts()).toHaveLength(3);
    expect(toast._queue).toHaveLength(2);

    toast.dismiss(ids[3]);
    expect(toast._queue).toHaveLength(1);
    expect(toast._queue[0].id).toBe(ids[4]);

    // Draining the visible stack must never surface the cancelled entry.
    for (const id of [ids[0], ids[1], ids[2], ids[4]]) toast.dismiss(id);
    jest.advanceTimersByTime(180);
    expect(toasts()).toHaveLength(0);
    expect(document.querySelector(`.toast[data-id="${ids[3]}"]`)).toBeNull();
  });

  test('re-uses the existing container across toasts', () => {
    toast.show({ message: 'one', timeout: 0 });
    const c1 = toast._container;
    toast.show({ message: 'two', timeout: 0 });
    expect(toast._container).toBe(c1);
    expect(document.querySelectorAll('.toast-stack')).toHaveLength(1);
  });

  test('re-creates the container if it was detached from the DOM', () => {
    toast.show({ message: 'one', timeout: 0 });
    const c1 = toast._container;
    c1.parentNode.removeChild(c1);
    toast.show({ message: 'two', timeout: 0 });
    expect(toast._container).not.toBe(c1);
    expect(document.body.contains(toast._container)).toBe(true);
  });

  test('dismissing clears the pending auto-dismiss timer', () => {
    const id = toast.show({ message: 'clear timer', timeout: 4000 });
    const rec = toast._visible.find((v) => v.entry.id === id);
    const spy = jest.spyOn(global, 'clearTimeout');
    toast.dismiss(id);
    expect(spy).toHaveBeenCalledWith(rec.timerId);
    spy.mockRestore();
  });
});
