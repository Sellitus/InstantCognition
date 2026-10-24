// NotificationService tests — EventEmitter-based inbox with FIFO cap,
// same-origin tag dedup, ephemeral (private session) handling, and
// per-tab click routing.

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp-mock-userdata') },
}));

jest.mock('../../../../main/utils/iconCache', () => ({
  storeDataUrl: jest.fn(() => null),
  gc: jest.fn(),
  clearAll: jest.fn(),
  getCacheDir: jest.fn(() => null),
  MAX_BYTES: 256 * 1024,
}));

function makeFakeConfig() {
  const store = {};
  return {
    get: jest.fn((key, def) => (key in store ? store[key] : def)),
    set: jest.fn((key, val) => { store[key] = val; }),
    _store: store,
  };
}

let svc;

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  svc = require('../../../../main/services/NotificationService');
  svc.removeAllListeners();
  svc._inbox = [];
  svc._tabMap.clear();
  svc._cap = 200;
  if (svc._persistTimer) { clearTimeout(svc._persistTimer); svc._persistTimer = null; }
  svc._configService = null;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('NotificationService.add', () => {
  test('assigns id, timestamp, defaults', () => {
    const rec = svc.add({ origin: 'https://x.com', title: 'Hi', body: 'there' });
    expect(rec.id).toMatch(/^notif-/);
    expect(Number.isFinite(rec.timestamp)).toBe(true);
    expect(rec.read).toBe(false);
    expect(rec.ephemeral).toBe(false);
    expect(rec.title).toBe('Hi');
    expect(rec.body).toBe('there');
    expect(rec.origin).toBe('https://x.com');
    expect(svc.list()).toHaveLength(1);
  });

  test('emits "added" with unreadCount', () => {
    const listener = jest.fn();
    svc.on('added', listener);
    svc.add({ origin: 'https://x.com', title: 'Hi' });
    expect(listener).toHaveBeenCalledTimes(1);
    const arg = listener.mock.calls[0][0];
    expect(arg.record.title).toBe('Hi');
    expect(arg.unreadCount).toBe(1);
  });

  test('tag collision within same origin replaces the existing entry', () => {
    svc.add({ origin: 'https://x.com', title: 'First', tag: 'chat-42' });
    const replaced = jest.fn();
    svc.on('replaced', replaced);
    const rec = svc.add({ origin: 'https://x.com', title: 'Second', tag: 'chat-42' });
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0].title).toBe('Second');
    expect(svc.list()[0].id).toBe(rec.id);
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(replaced.mock.calls[0][0].previousId).toMatch(/^notif-/);
  });

  test('tag collision across different origins does NOT dedup', () => {
    svc.add({ origin: 'https://a.com', title: 'A', tag: 'shared' });
    svc.add({ origin: 'https://b.com', title: 'B', tag: 'shared' });
    expect(svc.list()).toHaveLength(2);
  });

  test('empty tag does not dedup', () => {
    svc.add({ origin: 'https://x.com', title: 'A', tag: '' });
    svc.add({ origin: 'https://x.com', title: 'B', tag: '' });
    expect(svc.list()).toHaveLength(2);
  });

  test('FIFO cap evicts oldest entries', () => {
    svc._cap = 3;
    svc.add({ origin: 'https://x.com', title: '1' });
    svc.add({ origin: 'https://x.com', title: '2' });
    svc.add({ origin: 'https://x.com', title: '3' });
    svc.add({ origin: 'https://x.com', title: '4' });
    const titles = svc.list().map((r) => r.title);
    // Newest first; oldest ('1') evicted
    expect(titles).toEqual(['4', '3', '2']);
  });

  test('records webContentsId for activation routing', () => {
    const rec = svc.add({ origin: 'https://x.com', title: 'x', webContentsId: 123 });
    expect(svc.getWebContentsIdFor(rec.id)).toBe(123);
  });

  test('stores the webview localId on the record (activation must route under it)', () => {
    const rec = svc.add({ origin: 'https://x.com', title: 'x', localId: 'local-abc' });
    expect(rec.localId).toBe('local-abc');
    // A record persisted without a live instance still routes its window show.
    const anon = svc.add({ origin: 'https://x.com', title: 'y' });
    expect(anon.localId).toBeNull();
  });
});

describe('NotificationService.dismiss / clearAll / markRead', () => {
  test('dismiss removes by id and emits', () => {
    const rec = svc.add({ origin: 'https://x.com', title: 'x' });
    const listener = jest.fn();
    svc.on('dismissed', listener);
    expect(svc.dismiss(rec.id)).toBe(true);
    expect(svc.list()).toHaveLength(0);
    expect(listener).toHaveBeenCalledWith({ id: rec.id, unreadCount: 0 });
  });

  test('dismiss is idempotent for unknown id', () => {
    expect(svc.dismiss('notif-unknown')).toBe(false);
  });

  test('clearAll empties the inbox and emits', () => {
    svc.add({ origin: 'https://x.com', title: 'a' });
    svc.add({ origin: 'https://x.com', title: 'b' });
    const listener = jest.fn();
    svc.on('cleared', listener);
    const n = svc.clearAll();
    expect(n).toBe(2);
    expect(svc.list()).toHaveLength(0);
    expect(listener).toHaveBeenCalled();
  });

  test('markRead flips unread flag and updates count', () => {
    const rec = svc.add({ origin: 'https://x.com', title: 'x' });
    expect(svc.unreadCount()).toBe(1);
    expect(svc.markRead(rec.id)).toBe(true);
    expect(svc.unreadCount()).toBe(0);
    // Idempotent
    expect(svc.markRead(rec.id)).toBe(false);
  });

  test('markAllRead flips every unread entry', () => {
    svc.add({ origin: 'https://x.com', title: 'a' });
    svc.add({ origin: 'https://x.com', title: 'b' });
    expect(svc.unreadCount()).toBe(2);
    const touched = svc.markAllRead();
    expect(touched).toBe(2);
    expect(svc.unreadCount()).toBe(0);
  });
});

describe('NotificationService.list filtering', () => {
  test('filters out read when includeRead=false', () => {
    const a = svc.add({ origin: 'https://x.com', title: 'a' });
    svc.add({ origin: 'https://x.com', title: 'b' });
    svc.markRead(a.id);
    const unread = svc.list({ includeRead: false });
    expect(unread).toHaveLength(1);
    expect(unread[0].title).toBe('b');
  });

  test('filters by origin', () => {
    svc.add({ origin: 'https://a.com', title: 'a' });
    svc.add({ origin: 'https://b.com', title: 'b' });
    const onlyA = svc.list({ origin: 'https://a.com' });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].title).toBe('a');
  });
});

describe('NotificationService ephemeral (private) entries', () => {
  test('still emitted to consumers but not persisted', () => {
    const cfg = makeFakeConfig();
    svc.initialize(cfg);
    const listener = jest.fn();
    svc.on('added', listener);
    svc.add({ origin: 'https://x.com', title: 'a', ephemeral: true });
    svc.add({ origin: 'https://y.com', title: 'b' });
    expect(listener).toHaveBeenCalledTimes(2);

    // Flush persistence timer
    svc._flush();
    expect(cfg.set).toHaveBeenCalledWith('state.notifications.inbox', expect.any(Array));
    const persisted = cfg._store['state.notifications.inbox'];
    expect(persisted.map((r) => r.title)).toEqual(['b']); // ephemeral dropped
  });
});

describe('NotificationService initialize', () => {
  test('loads persisted inbox up to the cap', () => {
    const cfg = makeFakeConfig();
    cfg._store['state.notifications.inbox'] = [
      { id: 'notif-1', origin: 'https://x.com', title: '1', timestamp: 1, read: false },
      { id: 'notif-2', origin: 'https://x.com', title: '2', timestamp: 2, read: true },
    ];
    cfg._store['settings.notifications.maxInbox'] = 200;
    svc.initialize(cfg);
    expect(svc.list()).toHaveLength(2);
    expect(svc.unreadCount()).toBe(1);
  });

  test('honors configured cap', () => {
    const cfg = makeFakeConfig();
    cfg._store['settings.notifications.maxInbox'] = 2;
    cfg._store['state.notifications.inbox'] = [
      { id: 'notif-1', origin: 'https://x.com', title: '1', timestamp: 1, read: false },
      { id: 'notif-2', origin: 'https://x.com', title: '2', timestamp: 2, read: false },
      { id: 'notif-3', origin: 'https://x.com', title: '3', timestamp: 3, read: false },
    ];
    svc.initialize(cfg);
    expect(svc.list()).toHaveLength(2);
  });
});
