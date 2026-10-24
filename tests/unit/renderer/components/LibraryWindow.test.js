/**
 * @jest-environment jsdom
 */

jest.mock('electron', () => {
  const handlers = new Map();
  return {
    ipcRenderer: {
      _handlers: handlers,
      invoke: jest.fn(async () => undefined),
      on: jest.fn((ch, fn) => {
        if (!handlers.has(ch)) handlers.set(ch, new Set());
        handlers.get(ch).add(fn);
      }),
      _emit: (ch, payload) => {
        if (handlers.has(ch)) handlers.get(ch).forEach((fn) => fn({}, payload));
      },
    },
    shell: {
      openPath: jest.fn(async () => ''),
      showItemInFolder: jest.fn(),
    },
  };
});

jest.mock('../../../../renderer/components/ConfirmDialog', () => ({ confirm: jest.fn(async () => true) }));
jest.mock('../../../../renderer/components/Toast', () => ({ success: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const microflush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const callsTo = (ipc, ch) => ipc.invoke.mock.calls.filter((c) => c[0] === ch);

describe('LibraryWindow', () => {
  let ipcRenderer;
  let libraryWindow;
  let navigateTo;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.classList.add('no-animations');
    jest.resetModules();
    ipcRenderer = require('electron').ipcRenderer;
    ipcRenderer._handlers.clear();
    ipcRenderer.invoke.mockReset();
    ipcRenderer.invoke.mockResolvedValue([]);
    navigateTo = jest.fn();
    libraryWindow = require('../../../../renderer/components/LibraryWindow');
    libraryWindow.initialize(() => ({ navigationManager: { navigateTo } }));
  });

  afterEach(() => {
    document.body.classList.remove('no-animations');
  });

  test('opens one Library shell with browsing, notification, and extension tabs', () => {
    libraryWindow.open();
    const tabs = Array.from(document.querySelectorAll('.library-window-tab')).map((el) => el.dataset.tab);
    expect(tabs).toEqual(['ask', 'bookmarks', 'history', 'downloads', 'notifications', 'extensions']);
    expect(document.querySelector('.library-window-tab.selected').dataset.tab).toBe('ask');
    expect(document.querySelector('.library-window-filter-row .voice-input-button')).toBeTruthy();
  });

  test('Ask Browsing invokes the browsing index and opens result URLs', async () => {
    ipcRenderer.invoke.mockImplementation(async (ch) => {
      if (ch === 'browsing:ask') {
        return { ok: true, mode: 'hybrid', results: [{ title: 'Saved note', url: 'https://example.com', source: 'history' }] };
      }
      return [];
    });
    libraryWindow.open({ tab: 'ask' });
    libraryWindow.input.value = 'saved note';
    libraryWindow.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('browsing:ask', { query: 'saved note', limit: 50 });
    expect(document.querySelector('.browser-data-status').textContent).toBe('semantic + keyword');
    document.querySelector('.browser-data-item').click();
    expect(navigateTo).toHaveBeenCalledWith('https://example.com');
  });

  test('Bookmarks list rows open their URL and remove through bookmarks:remove', async () => {
    ipcRenderer.invoke.mockImplementation(async (ch) => {
      if (ch === 'bookmarks:tree') {
        return { type: 'folder', children: [{ id: 'bm_1', type: 'bookmark', name: 'Example', url: 'https://example.com' }] };
      }
      if (ch === 'bookmarks:remove') return true;
      return [];
    });

    libraryWindow.open({ tab: 'bookmarks' });
    await flush();
    expect(document.querySelector('.browser-data-item').textContent).toContain('Example');

    document.querySelector('.bd-remove').click();
    await flush();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('bookmarks:remove', 'bm_1');
    // The remove button must not also navigate to the row it deletes.
    expect(navigateTo).not.toHaveBeenCalled();
  });

  test('History rows delete through history:delete and leave the row navigation alone', async () => {
    ipcRenderer.invoke.mockImplementation(async (ch) => {
      if (ch === 'history:recent') {
        return [{ id: 'h_1', title: 'Example', url: 'https://example.com', timestamp: Date.now() }];
      }
      if (ch === 'history:delete') return true;
      return [];
    });

    libraryWindow.open({ tab: 'history' });
    await flush();
    document.querySelector('.bd-remove').click();
    await flush();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('history:delete', 'h_1');
    expect(navigateTo).not.toHaveBeenCalled();
  });

  test('Clear Cookies & Cache is history-only and clears the session after a confirm', async () => {
    const { confirm } = require('../../../../renderer/components/ConfirmDialog');
    ipcRenderer.invoke.mockImplementation(async (ch) => {
      if (ch === 'session:clear-site-data') return { ok: true };
      return [];
    });

    libraryWindow.open({ tab: 'downloads' });
    await flush();
    const btn = libraryWindow.clearSiteDataBtn;
    expect(btn.hidden).toBe(true); // cookies/cache are not a downloads action

    libraryWindow.open({ tab: 'history' });
    await flush();
    expect(btn.hidden).toBe(false);
    btn.click();
    await flush();

    expect(confirm).toHaveBeenCalled();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('session:clear-site-data');
  });

  test('Notifications live inside Library and update the Library badge', async () => {
    const badge = jest.fn();
    libraryWindow.onBadgeChange(badge);
    ipcRenderer.invoke.mockImplementation(async (ch) => {
      if (ch === 'notifications:list') {
        return [{ id: 'n1', title: 'Build done', body: 'Ready', origin: 'app', timestamp: Date.now(), read: false }];
      }
      return [];
    });

    libraryWindow.open({ tab: 'notifications' });
    await flush();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('notifications:list');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('notifications:mark-all-read');
    expect(badge).toHaveBeenLastCalledWith(1);
    expect(document.querySelector('.notifications-panel-item').textContent).toContain('Build done');
  });

  test('Extensions live inside Library and keep install/remove controls wired', async () => {
    const { confirm } = require('../../../../renderer/components/ConfirmDialog');
    confirm.mockResolvedValue(true);
    ipcRenderer.invoke.mockImplementation(async (ch) => {
      if (ch === 'extensions:list') return [{ id: 'abc', name: 'Clipper', version: '1.0', path: '/tmp/clipper' }];
      if (ch === 'extensions:remove') return { ok: true };
      return [];
    });

    libraryWindow.open({ tab: 'extensions' });
    await flush();
    expect(document.querySelector('.extensions-panel-item').textContent).toContain('Clipper');

    document.querySelector('.ext-remove').click();
    await flush();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('extensions:remove', { id: 'abc' });
  });
  describe('filtering', () => {
    afterEach(() => { jest.useRealTimers(); });

    test('rapid typing in the History filter sends one search after 150ms of quiet', async () => {
      libraryWindow.open({ tab: 'history' });
      await flush();
      jest.useFakeTimers();
      ipcRenderer.invoke.mockClear();
      for (const value of ['a', 'ab', 'abc']) {
        libraryWindow.input.value = value;
        libraryWindow.input.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(50);
      }
      jest.advanceTimersByTime(99); // 149ms since the last keystroke
      expect(callsTo(ipcRenderer, 'history:search')).toHaveLength(0);
      jest.advanceTimersByTime(1);
      expect(callsTo(ipcRenderer, 'history:search')).toEqual([['history:search', { query: 'abc', limit: 200 }]]);
    });

    test('typing on the Ask tab never searches until Enter', async () => {
      libraryWindow.open({ tab: 'ask' });
      jest.useFakeTimers();
      ipcRenderer.invoke.mockClear();
      libraryWindow.input.value = 'what did I read';
      libraryWindow.input.dispatchEvent(new Event('input', { bubbles: true }));
      jest.advanceTimersByTime(500);
      expect(callsTo(ipcRenderer, 'browsing:ask')).toHaveLength(0);
      libraryWindow.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(callsTo(ipcRenderer, 'browsing:ask')).toEqual([['browsing:ask', { query: 'what did I read', limit: 50 }]]);
    });
  });

  test('skeleton rows show while a fetch is in flight, then real rows replace them', async () => {
    const pending = deferred();
    ipcRenderer.invoke.mockImplementation((ch) => (ch === 'history:recent' ? pending.promise : Promise.resolve([])));
    libraryWindow.open({ tab: 'history' });
    const list = document.getElementById('library-window-panel');
    expect(list.querySelectorAll('.library-skeleton')).toHaveLength(6);
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(list.querySelector('.browser-data-item')).toBeNull();

    pending.resolve([{ id: 'h1', title: 'Loaded row', url: 'https://a.test', timestamp: Date.now() }]);
    await flush();
    expect(list.querySelector('.library-skeleton')).toBeNull();
    expect(list.hasAttribute('aria-busy')).toBe(false);
    expect(list.querySelector('.browser-data-item').textContent).toContain('Loaded row');
  });

  test('a failed fetch shows an error state whose retry reloads the tab', async () => {
    let fail = true;
    ipcRenderer.invoke.mockImplementation(async (ch) => {
      if (ch === 'bookmarks:tree') {
        if (fail) throw new Error('bookmarks file locked');
        return { type: 'folder', children: [{ id: 'b1', type: 'bookmark', name: 'Recovered', url: 'https://r.test' }] };
      }
      return [];
    });
    libraryWindow.open({ tab: 'bookmarks' });
    await flush();
    const err = document.querySelector('#library-window-panel .library-error[role="alert"]');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('Couldn’t load bookmarks');
    expect(err.textContent).toContain('bookmarks file locked');
    expect(document.querySelector('.browser-data-item')).toBeNull();

    fail = false;
    err.querySelector('.library-retry').click();
    await flush();
    expect(document.querySelector('.library-error')).toBeNull();
    expect(document.querySelector('.browser-data-item').textContent).toContain('Recovered');
  });

  test('a slower earlier fetch cannot overwrite the tab the user switched to', async () => {
    const slowHistory = deferred();
    ipcRenderer.invoke.mockImplementation((ch) => {
      if (ch === 'history:recent') return slowHistory.promise;
      if (ch === 'bookmarks:tree') return Promise.resolve({ type: 'folder', children: [{ id: 'b1', type: 'bookmark', name: 'Bookmark row', url: 'https://b.test' }] });
      return Promise.resolve([]);
    });
    libraryWindow.open({ tab: 'history' });
    libraryWindow.open({ tab: 'bookmarks' });
    await flush();
    slowHistory.resolve([{ id: 'h1', title: 'Stale history row', url: 'https://h.test', timestamp: Date.now() }]);
    await flush();
    const text = document.getElementById('library-window-panel').textContent;
    expect(text).toContain('Bookmark row');
    expect(text).not.toContain('Stale history row');
  });

  test('history rows are grouped under Today, Yesterday and a locale date heading', async () => {
    const now = Date.now();
    const older = now - 3 * 24 * 60 * 60 * 1000;
    ipcRenderer.invoke.mockImplementation(async (ch) => {
      if (ch === 'history:recent') {
        return [
          { id: 'h1', title: 'Fresh', url: 'https://1.test', timestamp: now },
          { id: 'h2', title: 'Fresh too', url: 'https://2.test', timestamp: now - 1000 },
          { id: 'h3', title: 'Day old', url: 'https://3.test', timestamp: now - 24 * 60 * 60 * 1000 },
          { id: 'h4', title: 'Older', url: 'https://4.test', timestamp: older },
        ];
      }
      return [];
    });
    libraryWindow.open({ tab: 'history' });
    await flush();
    const labels = Array.from(document.querySelectorAll('#library-window-panel .library-group-label')).map((el) => el.textContent);
    const d = new Date(older);
    const opts = { weekday: 'long', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
    expect(labels).toEqual(['Today', 'Yesterday', d.toLocaleDateString(undefined, opts)]);
    // Each heading precedes its own rows; rows carry the globe icon (no favicons exist).
    const seq = Array.from(document.querySelectorAll('#library-window-panel > li')).map((li) => (
      li.classList.contains('library-group-label') ? '#' + li.textContent : li.querySelector('.bd-title').textContent));
    expect(seq).toEqual(['#Today', 'Fresh', 'Fresh too', '#Yesterday', 'Day old', '#' + labels[2], 'Older']);
    expect(document.querySelectorAll('.browser-data-item .bd-icon .icon-globe')).toHaveLength(4);
  });

  test('downloads show live progress, patch it from events, and open/reveal finished files', async () => {
    const { shell } = require('electron');
    const toast = require('../../../../renderer/components/Toast');
    shell.openPath.mockResolvedValue('No application is associated with this file');
    ipcRenderer.invoke.mockImplementation(async (ch) => {
      if (ch === 'downloads:active') return [{ id: 'd1', filename: 'big.iso', totalBytes: 1000, receivedBytes: 250, state: 'progressing' }];
      if (ch === 'downloads:history') return [{ id: 'd0', filename: 'done.pdf', totalBytes: 2048, receivedBytes: 2048, state: 'completed', savePath: '/tmp/done.pdf' }];
      return [];
    });
    libraryWindow.open({ tab: 'downloads' });
    await flush();

    const active = document.querySelector('[data-download-id="d1"]');
    const bar = active.querySelector('[role="progressbar"]');
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(bar.querySelector('.library-progress-bar').style.width).toBe('25%');
    expect(active.querySelector('.bd-sub').textContent).toBe('Downloading · 25% · 250 B of 1000 B');
    expect(active.querySelector('[data-action="open"]')).toBeNull(); // nothing to open yet
    const count = document.querySelector('#library-window-tab-downloads .library-window-tab-count');
    expect(count.hidden).toBe(false);
    expect(count.textContent).toBe('1');

    const fetchesBefore = ipcRenderer.invoke.mock.calls.length;
    ipcRenderer._emit('downloads:updated', { id: 'd1', filename: 'big.iso', totalBytes: 1000, receivedBytes: 750, state: 'progressing' });
    expect(document.querySelector('[data-download-id="d1"] [role="progressbar"]').getAttribute('aria-valuenow')).toBe('75');
    expect(ipcRenderer.invoke.mock.calls.length).toBe(fetchesBefore); // patched in place, no refetch

    const done = document.querySelector('[data-download-id="d0"]');
    expect(done.querySelector('[role="progressbar"]')).toBeNull();
    done.querySelector('[data-action="open"]').click();
    await flush();
    expect(shell.openPath).toHaveBeenCalledWith('/tmp/done.pdf');
    expect(toast.error).toHaveBeenCalledWith('Couldn’t open done.pdf: No application is associated with this file');

    done.querySelector('[data-action="reveal"]').click();
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/tmp/done.pdf');
  });

  test('opening a finished download that succeeds shows no error', async () => {
    const { shell } = require('electron');
    const toast = require('../../../../renderer/components/Toast');
    shell.openPath.mockResolvedValue('');
    toast.error.mockClear();
    ipcRenderer.invoke.mockImplementation(async (ch) => {
      if (ch === 'downloads:history') return [{ id: 'd0', filename: 'ok.txt', totalBytes: 10, state: 'completed', savePath: '/tmp/ok.txt' }];
      return [];
    });
    libraryWindow.open({ tab: 'downloads' });
    await flush();
    document.querySelector('[data-download-id="d0"] [data-action="open"]').click();
    await flush();
    expect(shell.openPath).toHaveBeenCalledWith('/tmp/ok.txt');
    expect(toast.error).not.toHaveBeenCalled();
  });

  describe('notification badge failures', () => {
    test('a failed unread count is shown on the Notifications tab, not reported as zero', async () => {
      jest.resetModules();
      ipcRenderer = require('electron').ipcRenderer;
      ipcRenderer._handlers.clear();
      ipcRenderer.invoke.mockReset();
      let fail = true;
      ipcRenderer.invoke.mockImplementation(async (ch) => {
        if (ch === 'notifications:list') {
          if (fail) throw new Error('inbox unreadable');
          return [{ id: 'n1', title: 'Hi', read: false }, { id: 'n2', title: 'Yo', read: false }];
        }
        return [];
      });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const fresh = require('../../../../renderer/components/LibraryWindow');
      const badge = jest.fn();
      fresh.onBadgeChange(badge);
      expect(badge).toHaveBeenCalledTimes(1); // immediate current value
      fresh.initialize(() => ({}));
      await flush();

      expect(badge).toHaveBeenCalledTimes(1); // no second, false "0 unread"
      const tab = fresh.content.querySelector('#library-window-tab-notifications');
      const count = tab.querySelector('.library-window-tab-count');
      expect(count.hidden).toBe(false);
      expect(count.classList.contains('is-error')).toBe(true);
      expect(count.textContent).toBe('!');
      expect(tab.getAttribute('aria-label')).toContain('inbox unreadable');
      expect(errSpy).toHaveBeenCalledWith('[LibraryWindow] notification badge refresh failed:', 'inbox unreadable');

      fail = false;
      fresh.open({ tab: 'notifications' });
      await flush();
      expect(badge).toHaveBeenLastCalledWith(2);
      expect(count.classList.contains('is-error')).toBe(false);
      expect(count.textContent).toBe('2');
      errSpy.mockRestore();
    });

    test('onBadgeChange rejects a non-function subscriber', () => {
      expect(() => libraryWindow.onBadgeChange(null)).toThrow(TypeError);
    });
  });

  describe('onOpenChange / isOpen()', () => {
    test('notifies on open and close; unsubscribe stops notifications', async () => {
      const seen = [];
      const off = libraryWindow.onOpenChange((open) => seen.push(open));
      expect(libraryWindow.isOpen()).toBe(false);
      libraryWindow.open({ tab: 'bookmarks' });
      expect(libraryWindow.isOpen()).toBe(true);
      libraryWindow.close();
      await flush();
      expect(libraryWindow.isOpen()).toBe(false);
      expect(seen).toEqual([true, false]);
      off();
      libraryWindow.open();
      await flush();
      expect(seen).toEqual([true, false]);
    });

    test('rejects a non-function subscriber', () => {
      expect(() => libraryWindow.onOpenChange(42)).toThrow(TypeError);
    });
  });
});
