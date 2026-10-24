const cdpSessions = require('../../../../main/services/CdpSessionManager');

function makeWc(id, attachImpl) {
  let attached = false;
  const listeners = {};
  const onListeners = {};
  const debuggerObj = {
    isAttached: () => attached,
    attach: jest.fn(() => {
      if (attachImpl === 'fail') throw new Error('already open');
      attached = true;
    }),
    detach: jest.fn(() => { attached = false; }),
    sendCommand: jest.fn(async (method, params) => ({ echoed: method, params })),
  };
  return {
    id,
    debugger: debuggerObj,
    once: (ev, fn) => { listeners[ev] = fn; },
    on: (ev, fn) => { (onListeners[ev] = onListeners[ev] || []).push(fn); },
    _fireDestroyed: () => { if (listeners.destroyed) listeners.destroyed(); },
    _fireNavigate: (url, inPage) => {
      const key = inPage ? 'did-navigate-in-page' : 'did-navigate';
      (onListeners[key] || []).forEach((fn) => fn({}, url));
    },
  };
}

describe('CdpSessionManager', () => {
  beforeEach(() => { cdpSessions._reset(); });

  test('tryAttach succeeds and isAttached reports true', () => {
    const wc = makeWc(1);
    expect(cdpSessions.tryAttach(wc)).toBe(true);
    expect(cdpSessions.isAttached(wc)).toBe(true);
    expect(wc.debugger.attach).toHaveBeenCalledWith('1.3');
  });

  test('tryAttach returns false when debugger.attach throws (does not propagate)', () => {
    const wc = makeWc(2, 'fail');
    expect(cdpSessions.tryAttach(wc)).toBe(false);
    expect(cdpSessions.isAttached(wc)).toBe(false);
  });

  test('send forwards to debugger.sendCommand when attached', async () => {
    const wc = makeWc(3);
    cdpSessions.tryAttach(wc);
    const res = await cdpSessions.send(wc, 'Accessibility.enable', { foo: 1 });
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Accessibility.enable', { foo: 1 });
    expect(res).toEqual({ echoed: 'Accessibility.enable', params: { foo: 1 } });
  });

  test('send auto-attaches on first call if not yet attached', async () => {
    const wc = makeWc(4);
    await cdpSessions.send(wc, 'DOM.enable', {});
    expect(wc.debugger.attach).toHaveBeenCalled();
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('DOM.enable', {});
  });

  test('send throws cdp_not_attached when attach cannot succeed', async () => {
    const wc = makeWc(5, 'fail');
    await expect(cdpSessions.send(wc, 'DOM.enable', {})).rejects.toThrow(/cdp_not_attached/);
  });

  test('destroyed event clears the session so it no longer reports attached', () => {
    const wc = makeWc(6);
    cdpSessions.tryAttach(wc);
    expect(cdpSessions.isAttached(wc)).toBe(true);
    wc._fireDestroyed();
    expect(cdpSessions.isAttached(wc)).toBe(false);
  });

  test('setSnapshot / getSnapshot round-trip a snapshot per wc', () => {
    const wc = makeWc(7);
    cdpSessions.tryAttach(wc);
    const snap = { token: 'abcd1234', elements: [{ idx: 0 }] };
    cdpSessions.setSnapshot(wc, snap);
    expect(cdpSessions.getSnapshot(wc)).toBe(snap);
  });

  test('did-navigate clears the cached snapshot and marks it stale', () => {
    const wc = makeWc(8);
    cdpSessions.tryAttach(wc);
    cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0 }] });
    expect(cdpSessions.getSnapshot(wc)).not.toBeNull();
    expect(cdpSessions.isStaleDueToNavigation(wc)).toBe(false);

    wc._fireNavigate('https://example.com/next', false);

    expect(cdpSessions.getSnapshot(wc)).toBeNull();
    expect(cdpSessions.isStaleDueToNavigation(wc)).toBe(true);
  });

  test('did-navigate-in-page (SPA route change) also invalidates the snapshot', () => {
    const wc = makeWc(9);
    cdpSessions.tryAttach(wc);
    cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0 }] });
    wc._fireNavigate('https://app.example/route-b', true);
    expect(cdpSessions.getSnapshot(wc)).toBeNull();
    expect(cdpSessions.isStaleDueToNavigation(wc)).toBe(true);
  });

  test('a fresh setSnapshot after navigation clears the stale flag', () => {
    const wc = makeWc(10);
    cdpSessions.tryAttach(wc);
    cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0 }] });
    wc._fireNavigate('https://example.com/next', false);
    expect(cdpSessions.isStaleDueToNavigation(wc)).toBe(true);
    cdpSessions.setSnapshot(wc, { token: 't2', elements: [{ idx: 0 }, { idx: 1 }] });
    expect(cdpSessions.isStaleDueToNavigation(wc)).toBe(false);
    expect(cdpSessions.getSnapshot(wc)).not.toBeNull();
  });

  test('isStaleDueToNavigation is false before any snapshot is taken (no navigation)', () => {
    const wc = makeWc(11);
    cdpSessions.tryAttach(wc);
    expect(cdpSessions.isStaleDueToNavigation(wc)).toBe(false);
  });

  test('detach leaves the session recorded but not attached', () => {
    const wc = makeWc(12);
    cdpSessions.tryAttach(wc);
    cdpSessions.detach(wc);
    expect(cdpSessions.isAttached(wc)).toBe(false);
    expect(wc.debugger.detach).toHaveBeenCalled();
  });
});
