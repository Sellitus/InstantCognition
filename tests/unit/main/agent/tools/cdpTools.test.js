const cdpSessions = require('../../../../../main/services/CdpSessionManager');
const cdpTools = require('../../../../../main/agent/tools/cdpTools');

function byName(name) { return cdpTools.find((t) => t.name === name); }

function makeAttachedWc(id, sendImpl) {
  const debuggerObj = {
    isAttached: () => true,
    attach: jest.fn(),
    detach: jest.fn(),
    sendCommand: jest.fn(async (method, params) => (sendImpl ? sendImpl(method, params) : { ok: true })),
  };
  return { id, debugger: debuggerObj, once: () => {} };
}

function makeUnattachableWc(id) {
  const debuggerObj = {
    isAttached: () => false,
    attach: () => { throw new Error('blocked'); },
    detach: jest.fn(),
    sendCommand: jest.fn(),
  };
  return { id, debugger: debuggerObj, once: () => {} };
}

describe('cdpTools', () => {
  beforeEach(() => { cdpSessions._reset(); });

  test('snapshot_ax stores a snapshot that subsequent tools can resolve by idx', async () => {
    const wc = makeAttachedWc(10, (method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 1, backendDOMNodeId: 100, role: { value: 'button' }, name: { value: 'Submit' } },
            { nodeId: 2, backendDOMNodeId: 200, role: { value: 'textbox' }, name: { value: 'Query' } },
          ],
        };
      }
      return { ok: true };
    });
    const snap = await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
    expect(snap.ok).toBe(true);
    expect(snap.elementCount).toBe(2);
    expect(snap.elements[0]).toMatchObject({ idx: 0, role: 'button', name: 'Submit', backendNodeId: 100 });
    expect(snap.rendered).toContain('[0] button "Submit"');
    expect(cdpSessions.getSnapshot(wc).token).toBe(snap.token);
  });

  test('snapshot_ax returns cdp_unavailable when debugger cannot attach', async () => {
    const wc = makeUnattachableWc(11);
    const snap = await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
    expect(snap).toMatchObject({ ok: false, error: 'cdp_unavailable' });
  });

  test('click_idx requires a prior snapshot', async () => {
    const wc = makeAttachedWc(12);
    const res = await byName('browser.click_idx').handler({ idx: 0 }, { defaultWebContents: wc });
    expect(res).toMatchObject({ ok: false, error: 'idx_not_in_snapshot' });
  });

  test('click_idx dispatches move + press + release at the element center', async () => {
    const wc = makeAttachedWc(13, (method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ backendDOMNodeId: 42, role: { value: 'button' }, name: { value: 'Go' } }] };
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { width: 100, height: 40, content: [100, 200, 200, 200, 200, 240, 100, 240] } };
      }
      return { ok: true };
    });
    await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
    const res = await byName('browser.click_idx').handler({ idx: 0 }, { defaultWebContents: wc });
    expect(res.ok).toBe(true);
    expect(res.at).toEqual({ x: 150, y: 220 });
    const mouseCalls = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Input.dispatchMouseEvent');
    expect(mouseCalls.map((c) => c[1].type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  test('type_text focuses the idx element then calls Input.insertText', async () => {
    const wc = makeAttachedWc(14, (method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ backendDOMNodeId: 7, role: { value: 'textbox' }, name: { value: 'Search' } }] };
      }
      return { ok: true };
    });
    await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
    const res = await byName('browser.type_text').handler({ idx: 0, text: 'hello' }, { defaultWebContents: wc });
    expect(res).toMatchObject({ ok: true, typed: 5 });
    const methods = wc.debugger.sendCommand.mock.calls.map((c) => c[0]);
    expect(methods).toContain('DOM.focus');
    expect(methods).toContain('Input.insertText');
  });

  test('press_key_real dispatches keyDown + keyUp with mapped code', async () => {
    const wc = makeAttachedWc(15);
    const res = await byName('browser.press_key_real').handler({ key: 'Enter', modifiers: ['ctrl'] }, { defaultWebContents: wc });
    expect(res.ok).toBe(true);
    const keyCalls = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Input.dispatchKeyEvent');
    expect(keyCalls).toHaveLength(2);
    expect(keyCalls[0][1]).toMatchObject({ type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
    expect(keyCalls[1][1]).toMatchObject({ type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
  });

  test('wait_for_load resolves immediately when the wc reports idle', async () => {
    const wc = { id: 16, isLoading: () => false, once: jest.fn(), removeListener: jest.fn() };
    const res = await byName('browser.wait_for_load').handler({ timeoutMs: 500 }, { defaultWebContents: wc });
    expect(res).toMatchObject({ ok: true, detail: 'already-idle' });
  });

  test('snapshot_ax has sideEffect:false (read-only parallelizable)', () => {
    expect(byName('browser.snapshot_ax').sideEffect).toBeFalsy();
  });

  test('click_idx / type_text / press_key_real / hover_idx / wait_for_load are sideEffect:true', () => {
    for (const n of ['browser.click_idx', 'browser.type_text', 'browser.press_key_real', 'browser.hover_idx', 'browser.wait_for_load']) {
      expect(byName(n).sideEffect).toBe(true);
    }
  });

  describe('activeWc resolution', () => {
    test('resolves via toolCtx.resolveWc when a spaceId is given', async () => {
      const wc = makeAttachedWc(20, (m) => (m === 'Accessibility.getFullAXTree' ? { nodes: [] } : { ok: true }));
      const resolveWc = jest.fn(() => wc);
      const r = await byName('browser.snapshot_ax').handler({ spaceId: 's1' }, { resolveWc, defaultWebContents: null });
      expect(resolveWc).toHaveBeenCalledWith('s1');
      expect(r.ok).toBe(true);
    });

    test('falls back to defaultWebContents when resolveWc misses for the spaceId', async () => {
      const fallback = makeAttachedWc(21, (m) => (m === 'Accessibility.getFullAXTree' ? { nodes: [] } : { ok: true }));
      const r = await byName('browser.snapshot_ax').handler(
        { spaceId: 'gone' },
        { resolveWc: () => null, defaultWebContents: fallback },
      );
      expect(r.ok).toBe(true);
    });

    test('uses the active tab from the registry when no spaceId is given', async () => {
      const wc = makeAttachedWc(22, (m) => (m === 'Accessibility.getFullAXTree' ? { nodes: [] } : { ok: true }));
      const tabRegistry = { list: () => [{ spaceId: 'sA', isActive: true, webContentsId: 22 }] };
      const r = await byName('browser.snapshot_ax').handler({}, {
        tabRegistry, resolveWc: (sid) => (sid === 'sA' ? wc : null), defaultWebContents: null,
      });
      expect(r.ok).toBe(true);
    });
  });

  describe('snapshot_ax error path', () => {
    test('returns the thrown error message when getFullAXTree fails', async () => {
      const wc = makeAttachedWc(23, (m) => {
        if (m === 'Accessibility.getFullAXTree') throw new Error('ax exploded');
        return { ok: true };
      });
      const r = await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'ax exploded' });
    });
  });

  describe('idxErr shaping', () => {
    test('out_of_range reports the valid idx range', async () => {
      const wc = makeAttachedWc(24, (m) => {
        if (m === 'Accessibility.getFullAXTree') {
          return { nodes: [{ backendDOMNodeId: 1, role: { value: 'button' }, name: { value: 'A' } }] };
        }
        return { ok: true };
      });
      await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
      const r = await byName('browser.click_idx').handler({ idx: 9 }, { defaultWebContents: wc });
      expect(r).toMatchObject({
        ok: false, error: 'idx_not_in_snapshot', reason: 'out_of_range',
        requestedIdx: 9, snapshotElementCount: 1, validIdxRange: [0, 0],
      });
    });

    test('negative idx is also out_of_range', async () => {
      const wc = makeAttachedWc(25, (m) => (m === 'Accessibility.getFullAXTree'
        ? { nodes: [{ backendDOMNodeId: 1, role: { value: 'link' }, name: { value: 'L' } }] }
        : { ok: true }));
      await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
      const r = await byName('browser.hover_idx').handler({ idx: -1 }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, reason: 'out_of_range' });
    });
  });

  describe('click_idx edge cases', () => {
    test('returns no_backend_node_id when the element lacks a backend node', async () => {
      const wc = makeAttachedWc(26, (m) => (m === 'Accessibility.getFullAXTree'
        ? { nodes: [{ role: { value: 'button' }, name: { value: 'NoBackend' } }] }
        : { ok: true }));
      await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
      const r = await byName('browser.click_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'no_backend_node_id' });
    });

    test('returns box_model_unavailable when DOM.getBoxModel yields nothing usable', async () => {
      const wc = makeAttachedWc(27, (m) => {
        if (m === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 5, role: { value: 'button' }, name: { value: 'B' } }] };
        if (m === 'DOM.getBoxModel') return { model: { content: [1, 2] } }; // too short
        return { ok: true };
      });
      await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
      const r = await byName('browser.click_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'box_model_unavailable' });
    });

    test('surfaces a thrown error during the click dispatch', async () => {
      const wc = makeAttachedWc(28, (m) => {
        if (m === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 9, role: { value: 'button' }, name: { value: 'C' } }] };
        if (m === 'DOM.getBoxModel') return { model: { width: 10, height: 10, content: [0, 0, 10, 0, 10, 10, 0, 10] } };
        if (m === 'Input.dispatchMouseEvent') throw new Error('input refused');
        return { ok: true };
      });
      await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
      const r = await byName('browser.click_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'input refused' });
    });

    test('cdp attach failure short-circuits before resolving idx', async () => {
      const wc = makeUnattachableWc(29);
      const r = await byName('browser.click_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'cdp_unavailable' });
    });
  });

  describe('hover_idx', () => {
    test('moves the pointer to the element center and reports the hovered node', async () => {
      const wc = makeAttachedWc(30, (m) => {
        if (m === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 3, role: { value: 'menuitem' }, name: { value: 'Menu' } }] };
        if (m === 'DOM.getBoxModel') return { model: { width: 20, height: 20, content: [0, 0, 20, 0, 20, 20, 0, 20] } };
        return { ok: true };
      });
      await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
      const r = await byName('browser.hover_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: true, hovered: { idx: 0, role: 'menuitem', name: 'Menu' } });
      const moves = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Input.dispatchMouseEvent');
      expect(moves[moves.length - 1][1]).toMatchObject({ type: 'mouseMoved', x: 10, y: 10 });
    });

    test('returns box_model_unavailable when the element has no box', async () => {
      const wc = makeAttachedWc(31, (m) => {
        if (m === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 3, role: { value: 'link' }, name: { value: 'X' } }] };
        if (m === 'DOM.getBoxModel') throw new Error('no box');
        return { ok: true };
      });
      await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
      const r = await byName('browser.hover_idx').handler({ idx: 0 }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'box_model_unavailable' });
    });
  });

  describe('type_text variants', () => {
    test('without idx inserts text directly (no DOM.focus)', async () => {
      const wc = makeAttachedWc(32);
      const r = await byName('browser.type_text').handler({ text: 'abc' }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: true, typed: 3 });
      const methods = wc.debugger.sendCommand.mock.calls.map((c) => c[0]);
      expect(methods).not.toContain('DOM.focus');
      expect(methods).toContain('Input.insertText');
    });

    test('clearFirst issues select-all + backspace key events before typing', async () => {
      const wc = makeAttachedWc(33);
      await byName('browser.type_text').handler({ text: 'z', clearFirst: true }, { defaultWebContents: wc });
      const keyCalls = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Input.dispatchKeyEvent');
      expect(keyCalls.length).toBeGreaterThanOrEqual(4);
      expect(keyCalls.some((c) => c[1].key === 'a' && c[1].modifiers === 4)).toBe(true);
      expect(keyCalls.some((c) => c[1].key === 'Backspace')).toBe(true);
    });

    test('delayMs > 0 inserts one character at a time', async () => {
      const wc = makeAttachedWc(34);
      const r = await byName('browser.type_text').handler({ text: 'hey', delayMs: 1 }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: true, typed: 3 });
      const inserts = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Input.insertText');
      expect(inserts.map((c) => c[1].text)).toEqual(['h', 'e', 'y']);
    });

    test('idx that misses the snapshot returns idx_not_in_snapshot', async () => {
      const wc = makeAttachedWc(35);
      const r = await byName('browser.type_text').handler({ idx: 0, text: 'x' }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'idx_not_in_snapshot', reason: 'no_snapshot' });
    });

    test('surfaces a thrown error from insertText', async () => {
      const wc = makeAttachedWc(36, (m) => {
        if (m === 'Input.insertText') throw new Error('insert failed');
        return { ok: true };
      });
      const r = await byName('browser.type_text').handler({ text: 'x' }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'insert failed' });
    });
  });

  describe('press_key_real', () => {
    test('uses the raw key for an unmapped key and no modifiers', async () => {
      const wc = makeAttachedWc(37);
      const r = await byName('browser.press_key_real').handler({ key: 'q' }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: true, key: 'q' });
      const k = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Input.dispatchKeyEvent');
      expect(k[0][1]).toMatchObject({ key: 'q', code: 'q', modifiers: 0, windowsVirtualKeyCode: 0 });
    });

    test('parses a comma/plus-delimited modifier string', async () => {
      const wc = makeAttachedWc(38);
      await byName('browser.press_key_real').handler({ key: 'Tab', modifiers: 'shift+meta' }, { defaultWebContents: wc });
      const k = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Input.dispatchKeyEvent');
      // shift(8) | meta(4) = 12
      expect(k[0][1].modifiers).toBe(12);
    });

    test('surfaces a thrown error from the key dispatch', async () => {
      const wc = makeAttachedWc(39, (m) => {
        if (m === 'Input.dispatchKeyEvent') throw new Error('key blocked');
        return { ok: true };
      });
      const r = await byName('browser.press_key_real').handler({ key: 'Enter' }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'key blocked' });
    });

    test('cdp attach failure short-circuits', async () => {
      const r = await byName('browser.press_key_real').handler({ key: 'Enter' }, { defaultWebContents: makeUnattachableWc(40) });
      expect(r).toMatchObject({ ok: false, error: 'cdp_unavailable' });
    });
  });

  describe('wait_for_load', () => {
    test('reports webcontents_unavailable when there is no wc', async () => {
      const r = await byName('browser.wait_for_load').handler({}, { defaultWebContents: null });
      expect(r).toMatchObject({ ok: false, error: 'webcontents_unavailable' });
    });

    test('resolves on did-stop-loading while still loading', async () => {
      const listeners = {};
      const wc = {
        id: 41,
        isLoading: () => true,
        once: jest.fn((ev, fn) => { listeners[ev] = fn; }),
        removeListener: jest.fn(),
      };
      const p = byName('browser.wait_for_load').handler({ timeoutMs: 1000 }, { defaultWebContents: wc });
      listeners['did-stop-loading']();
      await expect(p).resolves.toMatchObject({ ok: true, detail: 'did-stop-loading' });
    });

    test('reports no-event-api when the wc cannot register events', async () => {
      const wc = { id: 42, isLoading: () => true }; // no once()
      const r = await byName('browser.wait_for_load').handler({ timeoutMs: 500 }, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'no-event-api' });
    });

    test('times out when nothing finishes before timeoutMs', async () => {
      jest.useFakeTimers();
      const wc = { id: 43, isLoading: () => true, once: jest.fn(), removeListener: jest.fn() };
      const p = byName('browser.wait_for_load').handler({ timeoutMs: 50 }, { defaultWebContents: wc });
      jest.advanceTimersByTime(60);
      await expect(p).resolves.toMatchObject({ ok: false, error: 'timeout' });
      jest.useRealTimers();
    });
  });

  describe('snapshot_ax_diff', () => {
    test('returns a diff plus added elements vs the previous snapshot', async () => {
      let phase = 0;
      const wc = makeAttachedWc(44, (m) => {
        if (m === 'Accessibility.getFullAXTree') {
          phase += 1;
          if (phase === 1) {
            return { nodes: [{ backendDOMNodeId: 1, role: { value: 'button' }, name: { value: 'Old' } }] };
          }
          return {
            nodes: [
              { backendDOMNodeId: 1, role: { value: 'button' }, name: { value: 'Old' } },
              { backendDOMNodeId: 2, role: { value: 'link' }, name: { value: 'New' } },
            ],
          };
        }
        return { ok: true };
      });
      await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
      const r = await byName('browser.snapshot_ax_diff').handler({}, { defaultWebContents: wc });
      expect(r.ok).toBe(true);
      expect(r.diff).toBeDefined();
      expect(Array.isArray(r.addedElements)).toBe(true);
    });

    test('cdp attach failure short-circuits', async () => {
      const r = await byName('browser.snapshot_ax_diff').handler({}, { defaultWebContents: makeUnattachableWc(45) });
      expect(r).toMatchObject({ ok: false, error: 'cdp_unavailable' });
    });

    test('surfaces a thrown error from getFullAXTree', async () => {
      const wc = makeAttachedWc(46, (m) => {
        if (m === 'Accessibility.getFullAXTree') throw new Error('diff ax fail');
        return { ok: true };
      });
      const r = await byName('browser.snapshot_ax_diff').handler({}, { defaultWebContents: wc });
      expect(r).toMatchObject({ ok: false, error: 'diff ax fail' });
    });
  });
});
