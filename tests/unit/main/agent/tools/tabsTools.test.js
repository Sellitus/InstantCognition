const tabsTools = require('../../../../../main/agent/tools/tabsTools');

function byName(n) { return tabsTools.find((t) => t.name === n); }

function fakeOps(behavior = {}) {
  return {
    openTab: jest.fn(async (url) => ({ ok: true, spaceId: behavior.newSpaceId || 'tab_1', url })),
    closeTab: jest.fn(async () => ({ ok: true })),
    focusTab: jest.fn(async () => ({ ok: true })),
    duplicateTab: jest.fn(async () => ({ ok: true })),
  };
}

function fakeReg(entries) {
  const m = new Map((entries || []).map((e) => [e.spaceId, e]));
  return { get: (sid) => m.get(sid) || null, list: () => Array.from(m.values()) };
}

describe('tabsTools', () => {
  test('open_tab delegates to tabOps.openTab and returns the new spaceId', async () => {
    const ops = fakeOps({ newSpaceId: 'tab_42' });
    const res = await byName('browser.open_tab').handler({ url: 'https://example.com' }, { tabOps: ops });
    expect(ops.openTab).toHaveBeenCalledWith('https://example.com');
    expect(res).toMatchObject({ ok: true, spaceId: 'tab_42', url: 'https://example.com' });
  });

  test('open_tab rejects missing url via schema validator (unit here checks handler runs on ops.error)', async () => {
    const ops = { openTab: jest.fn(async () => { throw new Error('boom'); }) };
    const res = await byName('browser.open_tab').handler({ url: 'x' }, { tabOps: ops });
    expect(res).toMatchObject({ ok: false, error: 'boom' });
  });

  test('close_tab delegates and echoes spaceId', async () => {
    const ops = fakeOps();
    const res = await byName('browser.close_tab').handler({ spaceId: 's1' }, { tabOps: ops });
    expect(ops.closeTab).toHaveBeenCalledWith('s1');
    expect(res).toEqual({ ok: true, spaceId: 's1' });
  });

  test('focus_tab delegates and echoes spaceId', async () => {
    const ops = fakeOps();
    const res = await byName('browser.focus_tab').handler({ spaceId: 's7' }, { tabOps: ops });
    expect(ops.focusTab).toHaveBeenCalledWith('s7');
    expect(res).toEqual({ ok: true, spaceId: 's7' });
  });

  test('duplicate_tab reads source url from registry and opens a new tab', async () => {
    const ops = fakeOps({ newSpaceId: 'tab_clone' });
    const reg = fakeReg([{ spaceId: 's1', url: 'https://a.com/x', webContentsId: 1 }]);
    const res = await byName('browser.duplicate_tab').handler({ spaceId: 's1' }, { tabOps: ops, tabRegistry: reg });
    expect(ops.openTab).toHaveBeenCalledWith('https://a.com/x');
    expect(res).toMatchObject({ ok: true, fromSpaceId: 's1', spaceId: 'tab_clone', url: 'https://a.com/x' });
  });

  test('duplicate_tab fails when source not in registry', async () => {
    const ops = fakeOps();
    const reg = fakeReg([]);
    const res = await byName('browser.duplicate_tab').handler({ spaceId: 'missing' }, { tabOps: ops, tabRegistry: reg });
    expect(res).toMatchObject({ ok: false, error: 'source_tab_not_found' });
    expect(ops.openTab).not.toHaveBeenCalled();
  });

  test('all tab tools are sideEffect:true with targetSpaceKey=_tabOp (serialize across tab-level ops)', () => {
    for (const name of ['browser.open_tab', 'browser.close_tab', 'browser.focus_tab', 'browser.duplicate_tab', 'browser.fork_tab']) {
      const tool = byName(name);
      expect(tool.sideEffect).toBe(true);
      expect(tool.targetSpaceKey).toBe('_tabOp');
    }
  });

  test('fork_tab opens a duplicate then restores focus to the source', async () => {
    const ops = fakeOps({ newSpaceId: 'fork_1' });
    const reg = fakeReg([{ spaceId: 's1', url: 'https://a.com', webContentsId: 1 }]);
    const res = await byName('browser.fork_tab').handler({ spaceId: 's1' }, { tabOps: ops, tabRegistry: reg });
    expect(res).toMatchObject({ ok: true, fromSpaceId: 's1', spaceId: 'fork_1', url: 'https://a.com' });
    expect(ops.openTab).toHaveBeenCalledWith('https://a.com');
    expect(ops.focusTab).toHaveBeenCalledWith('s1');
  });

  test('fork_tab fails when the source tab is not in the registry', async () => {
    const ops = fakeOps();
    const reg = fakeReg([]);
    const res = await byName('browser.fork_tab').handler({ spaceId: 'ghost' }, { tabOps: ops, tabRegistry: reg });
    expect(res).toMatchObject({ ok: false, error: 'source_tab_not_found' });
    expect(ops.openTab).not.toHaveBeenCalled();
  });

  test('fork_tab tolerates focusTab rejecting (non-fatal)', async () => {
    const ops = fakeOps({ newSpaceId: 'fork_x' });
    ops.focusTab = jest.fn(async () => { throw new Error('focus failed'); });
    const reg = fakeReg([{ spaceId: 's1', url: 'https://a.com', webContentsId: 1 }]);
    const res = await byName('browser.fork_tab').handler({ spaceId: 's1' }, { tabOps: ops, tabRegistry: reg });
    expect(res).toMatchObject({ ok: true, spaceId: 'fork_x' });
  });

  test('open_tab waits for the new tab to settle via resolveWc', async () => {
    const ops = fakeOps({ newSpaceId: 'tab_w' });
    // wc reports it is loading, then fires did-finish-load.
    const listeners = {};
    const wc = {
      isLoading: jest.fn(() => true),
      once: jest.fn((ev, fn) => { listeners[ev] = fn; }),
    };
    const resolveWc = jest.fn(() => wc);
    const p = byName('browser.open_tab').handler({ url: 'https://x' }, { tabOps: ops, resolveWc });
    // The waitForLoadSettled promise registers a did-finish-load listener;
    // fire it so the settle resolves (the trailing setTimeout(400) is the
    // jest-immediate mock so it does not block).
    await Promise.resolve();
    if (listeners['did-finish-load']) listeners['did-finish-load']();
    const res = await p;
    expect(res).toMatchObject({ ok: true, spaceId: 'tab_w', url: 'https://x' });
    expect(resolveWc).toHaveBeenCalledWith('tab_w');
    expect(wc.isLoading).toHaveBeenCalled();
  });

  test('open_tab returns immediately when resolveWc yields no webContents', async () => {
    const ops = fakeOps({ newSpaceId: 'tab_n' });
    const res = await byName('browser.open_tab').handler(
      { url: 'https://y' },
      { tabOps: ops, resolveWc: () => null },
    );
    expect(res).toMatchObject({ ok: true, spaceId: 'tab_n' });
  });

  test('open_tab handles a null spaceId from tabOps', async () => {
    const ops = { openTab: jest.fn(async () => ({ ok: true })) }; // no spaceId
    const res = await byName('browser.open_tab').handler({ url: 'https://z' }, { tabOps: ops });
    expect(res).toMatchObject({ ok: true, spaceId: null, url: 'https://z' });
  });

  test('duplicate_tab without a tabRegistry in ctx falls back to the module registry', async () => {
    const ops = fakeOps();
    // No tabRegistry in toolCtx -> module-level registry (empty) -> not found.
    const res = await byName('browser.duplicate_tab').handler({ spaceId: 'whatever' }, { tabOps: ops });
    expect(res).toMatchObject({ ok: false, error: 'source_tab_not_found' });
  });

  test('close_tab surfaces a non-Error rejection from tabOps as a string', async () => {
    const ops = { closeTab: jest.fn(async () => { throw 'plain string failure'; }) };
    const res = await byName('browser.close_tab').handler({ spaceId: 's1' }, { tabOps: ops });
    expect(res).toMatchObject({ ok: false, error: 'plain string failure' });
  });
});
