// PermissionPromptService — mediator between PermissionService 'prompt'
// decisions and the renderer prompt UI.

jest.mock('electron', () => ({ app: { getPath: jest.fn(() => '/tmp-mock') } }));

let svc;
let fakePermissionService;

beforeEach(() => {
  jest.resetModules();
  svc = require('../../../../main/services/PermissionPromptService');
  svc.removeAllListeners();
  svc._pending.clear();
  svc._inflightByKey.clear();
  fakePermissionService = { setOverride: jest.fn() };
  svc.initialize({ permissionService: fakePermissionService });
});

describe('PermissionPromptService', () => {
  test('requestDecision emits a prompt event with a unique id and origin/permission', () => {
    const seen = jest.fn();
    svc.on('prompt', seen);
    svc.requestDecision('https://x.com', 'notifications');
    expect(seen).toHaveBeenCalledTimes(1);
    const arg = seen.mock.calls[0][0];
    expect(arg.id).toMatch(/^perm-/);
    expect(arg.origin).toBe('https://x.com');
    expect(arg.permission).toBe('notifications');
  });

  test('duplicate concurrent requests share one prompt', () => {
    const seen = jest.fn();
    svc.on('prompt', seen);
    const p1 = svc.requestDecision('https://x.com', 'notifications');
    const p2 = svc.requestDecision('https://x.com', 'notifications');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);
  });

  test('resolve("allow") resolves the promise with "allow"', async () => {
    const spy = jest.fn();
    svc.on('prompt', spy);
    const promise = svc.requestDecision('https://x.com', 'notifications');
    const id = spy.mock.calls[0][0].id;
    const resolved = svc.resolve(id, 'allow', false);
    expect(resolved).toBe(true);
    await expect(promise).resolves.toBe('allow');
  });

  test('resolve sanitises unknown decisions to "deny"', async () => {
    const spy = jest.fn();
    svc.on('prompt', spy);
    const promise = svc.requestDecision('https://x.com', 'notifications');
    const id = spy.mock.calls[0][0].id;
    svc.resolve(id, 'maybe', false);
    await expect(promise).resolves.toBe('deny');
  });

  test('remember=true persists the decision through permissionService.setOverride', async () => {
    const spy = jest.fn();
    svc.on('prompt', spy);
    const promise = svc.requestDecision('https://x.com', 'notifications');
    const id = spy.mock.calls[0][0].id;
    svc.resolve(id, 'allow', true);
    await promise;
    expect(fakePermissionService.setOverride).toHaveBeenCalledWith('https://x.com', 'notifications', 'allow', { ephemeral: false });
  });

  test('remember=false does NOT persist', async () => {
    const spy = jest.fn();
    svc.on('prompt', spy);
    const promise = svc.requestDecision('https://x.com', 'notifications');
    const id = spy.mock.calls[0][0].id;
    svc.resolve(id, 'allow', false);
    await promise;
    expect(fakePermissionService.setOverride).not.toHaveBeenCalled();
  });

  test('a private-session prompt is flagged for the UI and remembered only for that session', async () => {
    const spy = jest.fn();
    svc.on('prompt', spy);
    const promise = svc.requestDecision('https://x.com', 'notifications', undefined, { ephemeral: true });
    expect(spy.mock.calls[0][0]).toMatchObject({ origin: 'https://x.com', permission: 'notifications', ephemeral: true });
    svc.resolve(spy.mock.calls[0][0].id, 'allow', true);
    await promise;
    expect(fakePermissionService.setOverride).toHaveBeenCalledWith('https://x.com', 'notifications', 'allow', { ephemeral: true });
  });

  test('a private and a normal request for the same site and permission are asked separately', () => {
    const spy = jest.fn();
    svc.on('prompt', spy);
    const normal = svc.requestDecision('https://x.com', 'notifications');
    const priv = svc.requestDecision('https://x.com', 'notifications', undefined, { ephemeral: true });
    expect(priv).not.toBe(normal);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0].ephemeral).toBe(false);
  });

  test('resolve returns false for unknown id', () => {
    expect(svc.resolve('perm-unknown', 'allow', false)).toBe(false);
  });

  test('denyAllPending resolves every outstanding prompt with deny', async () => {
    const promise = svc.requestDecision('https://x.com', 'notifications');
    const promise2 = svc.requestDecision('https://y.com', 'notifications');
    svc.denyAllPending();
    await expect(promise).resolves.toBe('deny');
    await expect(promise2).resolves.toBe('deny');
  });

  test('second request for same (origin, permission) AFTER resolve is a fresh prompt', async () => {
    const spy = jest.fn();
    svc.on('prompt', spy);
    const p1 = svc.requestDecision('https://x.com', 'notifications');
    svc.resolve(spy.mock.calls[0][0].id, 'allow', false);
    await p1;
    svc.requestDecision('https://x.com', 'notifications');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('the prompt event carries the detail text for the UI', () => {
    const seen = jest.fn();
    svc.on('prompt', seen);
    svc.requestDecision('https://x.com', 'openExternal:mailto', 'mailto:a@b.c');
    expect(seen.mock.calls[0][0].detail).toBe('mailto:a@b.c');
  });

  test('an unanswered prompt is denied after the timeout and announced as resolved', async () => {
    jest.useFakeTimers();
    try {
      const resolved = jest.fn();
      svc.on('resolved', resolved);
      const promise = svc.requestDecision('https://x.com', 'geolocation');
      jest.advanceTimersByTime(svc.PROMPT_TIMEOUT_MS - 1);
      expect(resolved).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      await expect(promise).resolves.toBe('deny');
      expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', permission: 'geolocation' }));
      expect(fakePermissionService.setOverride).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('an answered prompt is not denied later by its timeout', async () => {
    jest.useFakeTimers();
    try {
      const spy = jest.fn();
      svc.on('prompt', spy);
      const promise = svc.requestDecision('https://x.com', 'geolocation');
      svc.resolve(spy.mock.calls[0][0].id, 'allow', false);
      const resolved = jest.fn();
      svc.on('resolved', resolved);
      jest.advanceTimersByTime(svc.PROMPT_TIMEOUT_MS);
      await expect(promise).resolves.toBe('allow');
      expect(resolved).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    ['a shell reload', 'did-start-navigation', { isMainFrame: true, isSameDocument: false }],
    ['a shell crash', 'render-process-gone', {}],
  ])('%s denies every pending prompt', async (_label, event, details) => {
    const { EventEmitter } = require('events');
    const wc = new EventEmitter();
    svc.denyOnRendererReset(wc);
    const promise = svc.requestDecision('https://x.com', 'media');
    wc.emit(event, details);
    await expect(promise).resolves.toBe('deny');
    expect(svc.listPending()).toEqual([]);
  });

  test('an artifact iframe loading in the shell leaves pending prompts open', () => {
    const { EventEmitter } = require('events');
    const wc = new EventEmitter();
    svc.denyOnRendererReset(wc);
    svc.requestDecision('https://x.com', 'media');
    wc.emit('did-start-loading');
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(svc.listPending()).toHaveLength(1);
    svc.denyAllPending();
  });

  test('a failed remember still answers the request and is logged', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    fakePermissionService.setOverride.mockImplementation(() => { throw new Error('disk full'); });
    const spy = jest.fn();
    svc.on('prompt', spy);
    const promise = svc.requestDecision('https://x.com', 'notifications');
    svc.resolve(spy.mock.calls[0][0].id, 'allow', true);
    await expect(promise).resolves.toBe('allow');
    expect(err).toHaveBeenCalledWith('[PermissionPromptService] could not remember the decision:', expect.any(Error));
    err.mockRestore();
  });
});
