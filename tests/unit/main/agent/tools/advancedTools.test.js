const cdpSessions = require('../../../../../main/services/CdpSessionManager');
const advancedTools = require('../../../../../main/agent/tools/advancedTools');

function byName(name) { return advancedTools.find((t) => t.name === name); }

function makeAttachedWc(id, { send, exec, goBack, goForward, canBack = true, canForward = true } = {}) {
  const listeners = new Map();
  const dbg = {
    isAttached: () => true,
    attach: jest.fn(),
    detach: jest.fn(),
    sendCommand: jest.fn(async (method, params) => (send ? send(method, params) : { ok: true })),
    on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); },
    removeListener: (ev, fn) => {
      const arr = listeners.get(ev) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    emit: (ev, ...args) => { (listeners.get(ev) || []).slice().forEach((fn) => fn(...args)); },
  };
  const wcListeners = new Map();
  const wc = {
    id,
    debugger: dbg,
    once: (ev, fn) => { wcListeners.set(ev, fn); },
    removeListener: (ev, fn) => { if (wcListeners.get(ev) === fn) wcListeners.delete(ev); },
    emit: (ev, ...args) => { const fn = wcListeners.get(ev); if (fn) { wcListeners.delete(ev); fn(...args); } },
    executeJavaScript: exec || (() => Promise.resolve({ ok: false, error: 'no_exec' })),
    goBack: goBack || jest.fn(),
    goForward: goForward || jest.fn(),
    canGoBack: () => canBack,
    canGoForward: () => canForward,
  };
  return wc;
}

describe('advancedTools', () => {
  beforeEach(() => { cdpSessions._reset(); jest.useRealTimers(); });

  describe('browser.wait_for', () => {
    test('rejects when no condition given', async () => {
      const wc = makeAttachedWc(1);
      const res = await byName('browser.wait_for').handler({}, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'no_condition' });
    });

    test('resolves with via:selector from the polling script', async () => {
      const exec = jest.fn(async () => ({ ok: true, via: 'selector' }));
      const wc = makeAttachedWc(2, { exec });
      const res = await byName('browser.wait_for').handler({ selector: '.x' }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: true, via: 'selector' });
      // Script must embed a promise + selector literal.
      expect(exec.mock.calls[0][0]).toContain('document.querySelector');
      expect(exec.mock.calls[0][0]).toContain('".x"');
    });

    test('returns the polling script timeout when nothing matches', async () => {
      const exec = jest.fn(async () => ({ ok: false, error: 'timeout', wordCount: 3 }));
      const wc = makeAttachedWc(3, { exec });
      const res = await byName('browser.wait_for').handler({ min_words: 500, timeoutMs: 50 }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'timeout' });
      expect(exec.mock.calls[0][0]).toContain('minWords = 500');
    });

    test('network_idle resolves after the quiet period elapses with zero in-flight', async () => {
      jest.useFakeTimers();
      const wc = makeAttachedWc(4);
      const p = byName('browser.wait_for').handler({ network_idle: true, timeoutMs: 10000, quietMs: 500 }, { defaultWebContents: wc });
      // Flush microtasks so Network.enable + listener registration complete,
      // then advance past the quiet window.
      await jest.advanceTimersByTimeAsync(600);
      const res = await p;
      expect(res).toMatchObject({ ok: true, via: 'network_idle' });
    });

    test('network_idle arms only after in-flight returns to zero', async () => {
      jest.useFakeTimers();
      const wc = makeAttachedWc(5);
      const p = byName('browser.wait_for').handler({ network_idle: true, timeoutMs: 5000, quietMs: 400 }, { defaultWebContents: wc });
      await jest.advanceTimersByTimeAsync(200);
      wc.debugger.emit('message', {}, 'Network.requestWillBeSent');
      await jest.advanceTimersByTimeAsync(1000); // plenty of quiet if the timer had armed
      wc.debugger.emit('message', {}, 'Network.loadingFinished');
      await jest.advanceTimersByTimeAsync(500);
      const res = await p;
      expect(res).toMatchObject({ ok: true, via: 'network_idle' });
    });
  });

  describe('browser.locate', () => {
    test('returns matches from an existing snapshot by role + name substring', async () => {
      const wc = makeAttachedWc(10);
      cdpSessions.setSnapshot(wc, {
        token: 'abc',
        elements: [
          { idx: 0, role: 'button', name: 'Submit form' },
          { idx: 1, role: 'button', name: 'Cancel' },
          { idx: 2, role: 'link', name: 'Learn more' },
        ],
      });
      const res = await byName('browser.locate').handler({ role: 'button', name: 'submit' }, { defaultWebContents: wc });
      expect(res.ok).toBe(true);
      expect(res.matches).toEqual([{ idx: 0, role: 'button', name: 'Submit form', value: undefined }]);
      expect(res.freshSnapshot).toBe(false);
    });

    test('supports name_pattern regex with flags', async () => {
      const wc = makeAttachedWc(11);
      cdpSessions.setSnapshot(wc, { token: 't', elements: [
        { idx: 0, role: 'link', name: 'Top stories (42)' },
        { idx: 1, role: 'link', name: 'Comments' },
      ]});
      const res = await byName('browser.locate').handler({ name_pattern: 'top stories \\(\\d+\\)' }, { defaultWebContents: wc });
      expect(res.matches.map((m) => m.idx)).toEqual([0]);
    });

    test('auto-snapshots when none is cached', async () => {
      const wc = makeAttachedWc(12, {
        send: (method) => {
          if (method === 'Accessibility.getFullAXTree') {
            return { nodes: [{ backendDOMNodeId: 1, role: { value: 'button' }, name: { value: 'Go' } }] };
          }
          return { ok: true };
        },
      });
      const res = await byName('browser.locate').handler({ role: 'button' }, { defaultWebContents: wc });
      expect(res.ok).toBe(true);
      expect(res.freshSnapshot).toBe(true);
      expect(res.matches[0]).toMatchObject({ idx: 0, role: 'button', name: 'Go' });
    });

    test('returns empty matches list when nothing matches rather than erroring', async () => {
      const wc = makeAttachedWc(13);
      cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0, role: 'button', name: 'Submit' }] });
      const res = await byName('browser.locate').handler({ role: 'textbox' }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: true, matches: [] });
    });
  });

  describe('browser.scroll_to_idx', () => {
    test('requires a snapshot', async () => {
      const wc = makeAttachedWc(20);
      const res = await byName('browser.scroll_to_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'idx_not_in_snapshot', reason: 'no_snapshot' });
    });

    test('sends DOM.scrollIntoViewIfNeeded with the backendNodeId', async () => {
      const send = jest.fn(async () => ({ ok: true }));
      const wc = makeAttachedWc(21, { send });
      cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0, role: 'button', name: 'Go', backendNodeId: 77 }] });
      const res = await byName('browser.scroll_to_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(res.ok).toBe(true);
      expect(send).toHaveBeenCalledWith('DOM.scrollIntoViewIfNeeded', { backendNodeId: 77 });
    });
  });

  describe('browser.go_back / browser.go_forward', () => {
    test('go_back refuses when canGoBack is false', async () => {
      const wc = makeAttachedWc(30, { canBack: false });
      const res = await byName('browser.go_back').handler({}, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'no_history' });
    });

    test('go_forward resolves on did-stop-loading', async () => {
      const goForward = jest.fn();
      const wc = makeAttachedWc(31, { goForward });
      const p = byName('browser.go_forward').handler({}, { defaultWebContents: wc });
      // Give the handler a tick to attach the listener, then fire the event.
      setImmediate(() => wc.emit('did-stop-loading'));
      const res = await p;
      expect(res).toEqual({ ok: true });
      expect(goForward).toHaveBeenCalled();
    });

    test('go_back returns webcontents_unavailable when wc lacks goBack', async () => {
      const res = await byName('browser.go_back').handler({}, { defaultWebContents: { id: 1 } });
      expect(res).toEqual({ ok: false, error: 'webcontents_unavailable' });
    });

    test('go_back returns webcontents_unavailable when no wc resolves at all', async () => {
      const res = await byName('browser.go_back').handler({}, {});
      expect(res).toEqual({ ok: false, error: 'webcontents_unavailable' });
    });

    test('go_back proceeds when canGoBack is missing (typeof check false arm)', async () => {
      const goBack = jest.fn();
      const wc = makeAttachedWc(32, { goBack });
      delete wc.canGoBack; // no canGoBack fn → skip the no_history guard
      const p = byName('browser.go_back').handler({}, { defaultWebContents: wc });
      setImmediate(() => wc.emit('did-stop-loading'));
      const res = await p;
      expect(res).toEqual({ ok: true });
      expect(goBack).toHaveBeenCalled();
    });

    test('go_back times out when the page never stops loading', async () => {
      jest.useFakeTimers();
      const wc = makeAttachedWc(33, { goBack: jest.fn() });
      const p = byName('browser.go_back').handler({ timeoutMs: 100 }, { defaultWebContents: wc });
      await jest.advanceTimersByTimeAsync(150);
      const res = await p;
      expect(res).toEqual({ ok: false, error: 'timeout' });
      jest.useRealTimers();
    });

    test('go_back surfaces a synchronous goBack() throw', async () => {
      const wc = makeAttachedWc(34, { goBack: jest.fn(() => { throw new Error('nav-boom'); }) });
      const res = await byName('browser.go_back').handler({}, { defaultWebContents: wc });
      expect(res).toEqual({ ok: false, error: 'nav-boom' });
    });

    test('go_back default timeout used when timeoutMs omitted (|| 8000 arm)', async () => {
      const goBack = jest.fn();
      const wc = makeAttachedWc(35, { goBack });
      const p = byName('browser.go_back').handler({}, { defaultWebContents: wc });
      setImmediate(() => wc.emit('did-stop-loading'));
      expect(await p).toEqual({ ok: true });
    });
  });

  describe('activeWc resolution', () => {
    test('spaceId resolves via resolveWc', async () => {
      const wc = makeAttachedWc(40);
      cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0, role: 'button', name: 'Go' }] });
      const res = await byName('browser.locate').handler(
        { spaceId: 's1', role: 'button' },
        { resolveWc: (s) => (s === 's1' ? wc : null), defaultWebContents: makeAttachedWc(99) }
      );
      expect(res.ok).toBe(true);
      expect(res.matches[0].name).toBe('Go');
    });

    test('spaceId with resolveWc miss falls back to defaultWebContents', async () => {
      const dflt = makeAttachedWc(41);
      cdpSessions.setSnapshot(dflt, { token: 't', elements: [{ idx: 0, role: 'link', name: 'D' }] });
      const res = await byName('browser.locate').handler(
        { spaceId: 'nope', role: 'link' },
        { resolveWc: () => null, defaultWebContents: dflt }
      );
      expect(res.matches[0].name).toBe('D');
    });

    test('no spaceId picks the active tab from the registry', async () => {
      const wc = makeAttachedWc(42);
      cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0, role: 'button', name: 'Reg' }] });
      const reg = {
        list: () => [
          { spaceId: 'x', webContentsId: null, isActive: true },     // no webContentsId → skipped
          { spaceId: 'a', webContentsId: 1, isActive: true },        // chosen
        ],
      };
      const res = await byName('browser.locate').handler(
        { role: 'button' },
        { tabRegistry: reg, resolveWc: (s) => (s === 'a' ? wc : null), defaultWebContents: makeAttachedWc(98) }
      );
      expect(res.matches[0].name).toBe('Reg');
    });

    test('no spaceId, registry active tab but resolveWc misses → default', async () => {
      const dflt = makeAttachedWc(43);
      cdpSessions.setSnapshot(dflt, { token: 't', elements: [{ idx: 0, role: 'button', name: 'Def' }] });
      const reg = { list: () => [{ spaceId: 'a', webContentsId: 1, isActive: true }] };
      const res = await byName('browser.locate').handler(
        { role: 'button' },
        { tabRegistry: reg, resolveWc: () => null, defaultWebContents: dflt }
      );
      expect(res.matches[0].name).toBe('Def');
    });

    test('no registry → defaultWebContents', async () => {
      const dflt = makeAttachedWc(44);
      cdpSessions.setSnapshot(dflt, { token: 't', elements: [{ idx: 0, role: 'button', name: 'OnlyDef' }] });
      const res = await byName('browser.locate').handler({ role: 'button' }, { defaultWebContents: dflt });
      expect(res.matches[0].name).toBe('OnlyDef');
    });
  });

  describe('wait_for additional branches', () => {
    test('returns webcontents_unavailable when no wc resolves', async () => {
      const res = await byName('browser.wait_for').handler({ selector: '.x' }, {});
      expect(res).toEqual({ ok: false, error: 'webcontents_unavailable' });
    });

    test('a thrown executeJavaScript is caught and returned as a non-ok result', async () => {
      const exec = jest.fn(async () => { throw new Error('poll-died'); });
      const wc = makeAttachedWc(50, { exec });
      const res = await byName('browser.wait_for').handler({ selector: '.x', timeoutMs: 50 }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'poll-died' });
    });

    test('network_idle times out when nothing settles', async () => {
      jest.useFakeTimers();
      const wc = makeAttachedWc(51);
      const p = byName('browser.wait_for').handler({ network_idle: true, timeoutMs: 80, quietMs: 9999 }, { defaultWebContents: wc });
      // Keep a request in-flight so armIdle never fires before the deadline.
      await jest.advanceTimersByTimeAsync(10);
      wc.debugger.emit('message', {}, 'Network.requestWillBeSent');
      await jest.advanceTimersByTimeAsync(200);
      const res = await p;
      expect(res).toMatchObject({ ok: false, error: 'timeout' });
      jest.useRealTimers();
    });

    test('network_idle returns cdp_no_listener when dbg.on throws', async () => {
      jest.useFakeTimers();
      const wc = makeAttachedWc(52);
      wc.debugger.on = () => { throw new Error('no listener support'); };
      const p = byName('browser.wait_for').handler({ network_idle: true, timeoutMs: 5000 }, { defaultWebContents: wc });
      await jest.advanceTimersByTimeAsync(10);
      const res = await p;
      expect(res).toMatchObject({ ok: false, error: 'cdp_no_listener' });
      jest.useRealTimers();
    });

    test('network_idle when CDP cannot attach surfaces the attach error', async () => {
      const wc = makeAttachedWc(53);
      wc.debugger.isAttached = () => false;
      wc.debugger.attach = () => { throw new Error('attach fail'); };
      const res = await byName('browser.wait_for').handler({ network_idle: true, timeoutMs: 100 }, { defaultWebContents: wc });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('cdp_unavailable');
    });

    test('selector wins over a non-ok network_idle when both are requested', async () => {
      jest.useFakeTimers();
      const exec = jest.fn(async () => ({ ok: true, via: 'selector' }));
      const wc = makeAttachedWc(54, { exec });
      const p = byName('browser.wait_for').handler(
        { selector: '.x', network_idle: true, timeoutMs: 200, quietMs: 9999 },
        { defaultWebContents: wc }
      );
      // Promise.all waits for BOTH tasks: the selector exec resolves at once,
      // but network_idle only settles (timeout) at its 200ms deadline. Once
      // both have settled, the ok:true selector result is the chosen winner.
      await jest.advanceTimersByTimeAsync(250);
      const res = await p;
      expect(res).toMatchObject({ ok: true, via: 'selector' });
      jest.useRealTimers();
    });

    test('falls back to the first non-ok result when nothing wins', async () => {
      const exec = jest.fn(async () => ({ ok: false, error: 'timeout', wordCount: 0 }));
      const wc = makeAttachedWc(55, { exec });
      const res = await byName('browser.wait_for').handler({ text: 'never', timeoutMs: 30 }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'timeout' });
    });

    test('network_idle re-arms after an in-flight request finishes (decrement path)', async () => {
      jest.useFakeTimers();
      const wc = makeAttachedWc(56);
      const p = byName('browser.wait_for').handler(
        { network_idle: true, timeoutMs: 10000, quietMs: 300 },
        { defaultWebContents: wc }
      );
      await jest.advanceTimersByTimeAsync(10);
      // Two requests start (inflight=2, idleTimer cleared on the first), then
      // both finish → inflight returns to 0 → armIdle → quiet window → resolve.
      wc.debugger.emit('message', {}, 'Network.requestWillBeSent');
      wc.debugger.emit('message', {}, 'Network.requestWillBeSent');
      wc.debugger.emit('message', {}, 'Network.loadingFinished');
      wc.debugger.emit('message', {}, 'Network.loadingFailed');
      await jest.advanceTimersByTimeAsync(400);
      const res = await p;
      expect(res).toMatchObject({ ok: true, via: 'network_idle' });
      jest.useRealTimers();
    });

    test('a non-network CDP message does not disturb the idle timer', async () => {
      jest.useFakeTimers();
      const wc = makeAttachedWc(57);
      const p = byName('browser.wait_for').handler(
        { network_idle: true, timeoutMs: 10000, quietMs: 300 },
        { defaultWebContents: wc }
      );
      await jest.advanceTimersByTimeAsync(10);
      // Unrelated event → neither branch of onMessage fires; idle still arms.
      wc.debugger.emit('message', {}, 'Page.frameNavigated');
      await jest.advanceTimersByTimeAsync(400);
      const res = await p;
      expect(res).toMatchObject({ ok: true, via: 'network_idle' });
      jest.useRealTimers();
    });

    test('non-Error executeJavaScript rejection is stringified in the catch', async () => {
      const exec = jest.fn(async () => { throw 'string-poll-fail'; }); // eslint-disable-line no-throw-literal
      const wc = makeAttachedWc(58, { exec });
      const res = await byName('browser.wait_for').handler({ selector: '.x', timeoutMs: 40 }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'string-poll-fail' });
    });

    test('hasJsCond true but wc has no executeJavaScript and no network_idle → no_runnable_condition', async () => {
      // wc resolves (truthy) but lacks executeJavaScript, and network_idle not
      // requested → tasks stays empty → no_runnable_condition guard.
      const wc = { id: 1 }; // no executeJavaScript, no debugger
      const res = await byName('browser.wait_for').handler({ selector: '.x' }, { defaultWebContents: wc });
      expect(res).toEqual({ ok: false, error: 'no_runnable_condition' });
    });
  });

  describe('buildWaitPollScript arg defaults', () => {
    test('embeds caller-provided text + min_words + custom timeout', async () => {
      const exec = jest.fn(async () => ({ ok: true, via: 'text' }));
      const wc = makeAttachedWc(60, { exec });
      await byName('browser.wait_for').handler(
        { text: 'Loaded', min_words: 30, timeoutMs: 1234 },
        { defaultWebContents: wc }
      );
      const src = exec.mock.calls[0][0];
      expect(src).toContain('"Loaded"');
      expect(src).toContain('minWords = 30');
      expect(src).toContain('Date.now() + 1234');
    });
  });

  describe('buildMatcher branches via locate', () => {
    function snap(wc, els) { cdpSessions.setSnapshot(wc, { token: 't', elements: els }); }

    test('invalid regex name_pattern falls through to substring/everything', async () => {
      const wc = makeAttachedWc(70);
      snap(wc, [{ idx: 0, role: 'button', name: 'Alpha' }, { idx: 1, role: 'button', name: 'Beta' }]);
      // Unbalanced group → RegExp ctor throws → matcher falls through. No name/
      // text provided either → match-everything matcher.
      const res = await byName('browser.locate').handler({ name_pattern: '(' }, { defaultWebContents: wc });
      expect(res.matches.map((m) => m.idx)).toEqual([0, 1]);
    });

    test('matches by `text` alias when no name is given', async () => {
      const wc = makeAttachedWc(71);
      snap(wc, [{ idx: 0, role: 'link', name: 'Read more here' }, { idx: 1, role: 'link', name: 'Other' }]);
      const res = await byName('browser.locate').handler({ text: 'read more' }, { defaultWebContents: wc });
      expect(res.matches.map((m) => m.idx)).toEqual([0]);
    });

    test('matches against the element value when name does not match', async () => {
      const wc = makeAttachedWc(72);
      snap(wc, [{ idx: 0, role: 'textbox', name: 'Field', value: 'searchterm' }]);
      const res = await byName('browser.locate').handler({ name: 'searchterm' }, { defaultWebContents: wc });
      expect(res.matches).toHaveLength(1);
    });

    test('empty-string name and empty-string text fall to match-everything', async () => {
      const wc = makeAttachedWc(73);
      snap(wc, [{ idx: 0, role: 'button', name: 'A' }]);
      const res = await byName('browser.locate').handler({ name: '', text: '' }, { defaultWebContents: wc });
      expect(res.matches).toHaveLength(1);
    });

    test('limit is clamped between 1 and 50', async () => {
      const wc = makeAttachedWc(74);
      snap(wc, Array.from({ length: 60 }, (_, i) => ({ idx: i, role: 'button', name: 'b' + i })));
      const big = await byName('browser.locate').handler({ role: 'button', limit: 999 }, { defaultWebContents: wc });
      expect(big.matches).toHaveLength(50); // clamped to 50
      const zero = await byName('browser.locate').handler({ role: 'button', limit: 0 }, { defaultWebContents: wc });
      expect(zero.matches).toHaveLength(20); // 0 → falls to default 20
    });

    test('locate returns webcontents_unavailable when no wc resolves', async () => {
      const res = await byName('browser.locate').handler({ role: 'button' }, {});
      expect(res).toEqual({ ok: false, error: 'webcontents_unavailable' });
    });

    test('locate surfaces the snapshot error when AX tree retrieval throws', async () => {
      const wc = makeAttachedWc(75, {
        send: (m) => { if (m === 'Accessibility.getFullAXTree') throw new Error('ax-boom'); return { ok: true }; },
      });
      const res = await byName('browser.locate').handler({ role: 'button' }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'ax-boom' });
    });

    test('locate returns cdp_unavailable when no snapshot and CDP attach fails', async () => {
      const wc = makeAttachedWc(76);
      wc.debugger.isAttached = () => false;
      wc.debugger.attach = () => { throw new Error('cannot attach'); };
      const res = await byName('browser.locate').handler({ role: 'button' }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'cdp_unavailable' });
    });
  });

  describe('scroll_to_idx additional branches', () => {
    test('out-of-range idx returns idx_not_in_snapshot/out_of_range', async () => {
      const wc = makeAttachedWc(80);
      cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0, role: 'button', name: 'Go', backendNodeId: 1 }] });
      const res = await byName('browser.scroll_to_idx').handler({ idx: 9 }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'idx_not_in_snapshot', reason: 'out_of_range', snapshotElementCount: 1 });
    });

    test('element without backendNodeId returns no_backend_node_id', async () => {
      const wc = makeAttachedWc(81);
      cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0, role: 'button', name: 'Go' }] });
      const res = await byName('browser.scroll_to_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(res).toEqual({ ok: false, error: 'no_backend_node_id' });
    });

    test('CDP send error during scroll is caught', async () => {
      const wc = makeAttachedWc(82, {
        send: (m) => { if (m === 'DOM.scrollIntoViewIfNeeded') throw new Error('scroll-boom'); return { ok: true }; },
      });
      cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0, role: 'button', name: 'Go', backendNodeId: 5 }] });
      const res = await byName('browser.scroll_to_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'scroll-boom' });
    });

    test('scroll_to_idx returns the attach error when CDP cannot attach', async () => {
      const wc = makeAttachedWc(83);
      wc.debugger.isAttached = () => false;
      wc.debugger.attach = () => { throw new Error('no-cdp'); };
      const res = await byName('browser.scroll_to_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'cdp_unavailable' });
    });
  });

  describe('ensureSnapshot reuse', () => {
    test('reuses a cached snapshot without re-running the AX tree query', async () => {
      const send = jest.fn(async () => ({ ok: true }));
      const wc = makeAttachedWc(90, { send });
      cdpSessions.setSnapshot(wc, { token: 'cached', elements: [{ idx: 0, role: 'button', name: 'Cached' }] });
      const res = await byName('browser.locate').handler({ role: 'button' }, { defaultWebContents: wc });
      expect(res.freshSnapshot).toBe(false);
      expect(res.snapshotToken).toBe('cached');
      // No Accessibility.getFullAXTree call since the snapshot was cached.
      expect(send).not.toHaveBeenCalledWith('Accessibility.getFullAXTree', expect.anything());
    });
  });

  describe('non-Error throw fallbacks (String(err) arms)', () => {
    test('ensureSnapshot stringifies a non-Error AX-tree throw', async () => {
      const wc = makeAttachedWc(91, {
        send: (m) => { if (m === 'Accessibility.getFullAXTree') throw 'ax-str'; return { ok: true }; }, // eslint-disable-line no-throw-literal
      });
      const res = await byName('browser.locate').handler({ role: 'button' }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'ax-str' });
    });

    test('scroll_to_idx stringifies a non-Error CDP send throw', async () => {
      const wc = makeAttachedWc(92, {
        send: (m) => { if (m === 'DOM.scrollIntoViewIfNeeded') throw 'scroll-str'; return { ok: true }; }, // eslint-disable-line no-throw-literal
      });
      cdpSessions.setSnapshot(wc, { token: 't', elements: [{ idx: 0, role: 'button', name: 'Go', backendNodeId: 9 }] });
      const res = await byName('browser.scroll_to_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(res).toMatchObject({ ok: false, error: 'scroll-str' });
    });

    test('go_back stringifies a non-Error navigation throw', async () => {
      const wc = makeAttachedWc(93, { goBack: jest.fn(() => { throw 'nav-str'; }) }); // eslint-disable-line no-throw-literal
      const res = await byName('browser.go_back').handler({}, { defaultWebContents: wc });
      expect(res).toEqual({ ok: false, error: 'nav-str' });
    });
  });

  describe('ensureCdp guard', () => {
    test('scroll_to_idx with no resolvable wc returns webcontents_unavailable via ensureCdp', async () => {
      // activeWc returns undefined → ensureCdp(undefined) → !wc arm.
      const res = await byName('browser.scroll_to_idx').handler({ idx: 0 }, {});
      expect(res).toEqual({ ok: false, error: 'webcontents_unavailable' });
    });
  });
});
