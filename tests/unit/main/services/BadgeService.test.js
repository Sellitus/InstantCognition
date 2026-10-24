// BadgeService tests — verify per-origin aggregation and notification
// unread-count folding. We stub `app.mockSetBadgeCount` to capture writes.

const mockSetBadgeCount = jest.fn();

jest.mock('electron', () => ({
  app: { mockSetBadgeCount: (...args) => mockSetBadgeCount(...args) },
}));

let svc;

beforeEach(() => {
  jest.resetModules();
  mockSetBadgeCount.mockClear();
  svc = require('../../../../main/services/BadgeService');
  svc.clearAll();
});

function makeFakeNotificationService(initialUnread = 0) {
  const listeners = new Map();
  let unread = initialUnread;
  return {
    unreadCount: () => unread,
    setUnread: (n) => { unread = n; },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit: (event) => {
      const list = listeners.get(event) || [];
      for (const fn of list) fn();
    },
  };
}

describe('BadgeService', () => {
  test('setForOrigin aggregates counts across origins', () => {
    svc.initialize(null);
    svc.setForOrigin('https://a.com', 3);
    svc.setForOrigin('https://b.com', 2);
    expect(svc.total()).toBe(5);
  });

  test('setForOrigin(0) clears that origin', () => {
    svc.initialize(null);
    svc.setForOrigin('https://a.com', 4);
    svc.setForOrigin('https://a.com', 0);
    expect(svc.total()).toBe(0);
  });

  test('clearForOrigin removes only that origin', () => {
    svc.initialize(null);
    svc.setForOrigin('https://a.com', 3);
    svc.setForOrigin('https://b.com', 2);
    svc.clearForOrigin('https://a.com');
    expect(svc.total()).toBe(2);
  });

  test('clearAll resets everything', () => {
    svc.initialize(null);
    svc.setForOrigin('https://a.com', 3);
    svc.clearAll();
    expect(svc.total()).toBe(0);
  });

  test('initialize folds in notification unread count', () => {
    const ns = makeFakeNotificationService(4);
    svc.initialize(null, { notificationService: ns });
    svc.setForOrigin('https://a.com', 3);
    expect(svc.total()).toBe(7);
  });

  test('notification events trigger recompute', () => {
    const ns = makeFakeNotificationService(0);
    svc.initialize(null, { notificationService: ns });
    ns.setUnread(5);
    ns.emit('added');
    expect(svc.total()).toBe(5);
  });

  test('negative / NaN counts are coerced to 0', () => {
    svc.initialize(null);
    svc.setForOrigin('https://a.com', -5);
    svc.setForOrigin('https://b.com', NaN);
    expect(svc.total()).toBe(0);
  });

  test('emits "changed" event with total', () => {
    svc.initialize(null);
    const spy = jest.fn();
    svc.on('changed', spy);
    svc.setForOrigin('https://a.com', 3);
    expect(spy).toHaveBeenCalledWith({ total: 3 });
  });
});
