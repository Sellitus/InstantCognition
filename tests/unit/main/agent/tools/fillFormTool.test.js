// fillFormTool tests — browser.fill_form fills multiple AX-idx fields in one
// call. CDP boundary is faked; the snapshot is seeded via the real snapshot_ax
// tool so resolveIdx exercises the live cache path.

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
  return { id, debugger: debuggerObj, once: () => {}, on: () => {} };
}

// Seed a 2-field form (textbox Name, textbox Email) into the AX snapshot cache.
async function seedSnapshot(wc) {
  await byName('browser.snapshot_ax').handler({}, { defaultWebContents: wc });
}

function axTreeForForm() {
  return (method) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          { backendDOMNodeId: 100, role: { value: 'textbox' }, name: { value: 'Name' } },
          { backendDOMNodeId: 200, role: { value: 'textbox' }, name: { value: 'Email' } },
        ],
      };
    }
    return { ok: true };
  };
}

describe('browser.fill_form', () => {
  beforeEach(() => { cdpSessions._reset(); });

  test('exposes a parameter schema with required fields array', () => {
    const t = byName('browser.fill_form');
    expect(t).toBeTruthy();
    expect(t.parameters.required).toEqual(['fields']);
    expect(t.sideEffect).toBe(true);
  });

  test('fills every field in one call and reports per-field typed length', async () => {
    const wc = makeAttachedWc(20, axTreeForForm());
    await seedSnapshot(wc);
    const res = await byName('browser.fill_form').handler(
      { fields: [{ idx: 0, value: 'Ada' }, { idx: 1, value: 'ada@example.com' }] },
      { defaultWebContents: wc },
    );
    expect(res.ok).toBe(true);
    expect(res.filledCount).toBe(2);
    expect(res.filled).toEqual([{ idx: 0, typed: 3 }, { idx: 1, typed: 15 }]);
    // Each field focused then text inserted.
    const focusCalls = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'DOM.focus');
    const insertCalls = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Input.insertText');
    expect(focusCalls).toHaveLength(2);
    expect(insertCalls).toEqual([
      ['Input.insertText', { text: 'Ada' }],
      ['Input.insertText', { text: 'ada@example.com' }],
    ]);
  });

  test('clearFirst selects-all + backspaces each field before typing', async () => {
    const wc = makeAttachedWc(21, axTreeForForm());
    await seedSnapshot(wc);
    const res = await byName('browser.fill_form').handler(
      { fields: [{ idx: 0, value: 'x' }], clearFirst: true },
      { defaultWebContents: wc },
    );
    expect(res.ok).toBe(true);
    // For one field: 4 clear key events (a down/up + backspace down/up) + 1 insert.
    const keyCalls = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Input.dispatchKeyEvent');
    expect(keyCalls).toHaveLength(4);
    expect(keyCalls.map((c) => c[1].key)).toEqual(['a', 'a', 'Backspace', 'Backspace']);
  });

  test('empty fields array is rejected without touching CDP', async () => {
    const wc = makeAttachedWc(22, axTreeForForm());
    await seedSnapshot(wc);
    const res = await byName('browser.fill_form').handler({ fields: [] }, { defaultWebContents: wc });
    expect(res).toEqual({ ok: false, error: 'no_fields' });
    // No insertText should have been sent.
    const insertCalls = wc.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Input.insertText');
    expect(insertCalls).toHaveLength(0);
  });

  test('a field with an out-of-range idx fails and reports filledSoFar', async () => {
    const wc = makeAttachedWc(23, axTreeForForm());
    await seedSnapshot(wc);
    const res = await byName('browser.fill_form').handler(
      { fields: [{ idx: 0, value: 'Ada' }, { idx: 9, value: 'boom' }] },
      { defaultWebContents: wc },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('idx_not_in_snapshot');
    expect(res.reason).toBe('out_of_range');
    // First field filled before the bad idx.
    expect(res.filledSoFar).toEqual([{ idx: 0, typed: 3 }]);
  });

  test('fails with no_snapshot when called before snapshot_ax', async () => {
    const wc = makeAttachedWc(24);
    const res = await byName('browser.fill_form').handler(
      { fields: [{ idx: 0, value: 'x' }] },
      { defaultWebContents: wc },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('idx_not_in_snapshot');
    expect(res.reason).toBe('no_snapshot');
  });

  test('returns cdp_unavailable when the debugger cannot attach', async () => {
    const debuggerObj = {
      isAttached: () => false, attach: () => { throw new Error('blocked'); },
      detach: jest.fn(), sendCommand: jest.fn(),
    };
    const wc = { id: 25, debugger: debuggerObj, once: () => {}, on: () => {} };
    const res = await byName('browser.fill_form').handler(
      { fields: [{ idx: 0, value: 'x' }] },
      { defaultWebContents: wc },
    );
    expect(res).toMatchObject({ ok: false, error: 'cdp_unavailable' });
  });
});
