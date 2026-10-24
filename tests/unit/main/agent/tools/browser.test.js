const browserTools = require('../../../../../main/agent/tools/browser');

function byName(name) { return browserTools.find((t) => t.name === name); }

function makeWc(observation) {
  return {
    executeJavaScript: jest.fn(async (src) => {
      if (src.includes('mainText')) return observation;
      if (src.includes('interactives')) return { url: 'u', title: 't', text: 'fallback' };
      if (src.includes('window.getSelection')) return 'hello';
      return { ok: true };
    }),
    loadURL: jest.fn(async () => {}),
  };
}

function fakeRegistry(tabs) {
  const m = new Map(tabs.map((t) => [t.spaceId, t]));
  return {
    list: () => Array.from(m.values()),
    get: (sid) => m.get(sid) || null,
  };
}

describe('browser tool handlers', () => {
  test('list_tabs returns active-annotated agent-workspace tabs only', async () => {
    const tool = byName('browser.list_tabs');
    const reg = fakeRegistry([
      { spaceId: 'a', webContentsId: 1, name: 'ChatGPT', title: 'ChatGPT', url: 'https://chat',   isActive: true,  kind: 'agent' },
      { spaceId: 'b', webContentsId: 2, name: 'Claude',  title: 'Claude',  url: 'https://claude', isActive: false, kind: 'agent' },
      { spaceId: 'c', webContentsId: null,                                                                          kind: 'agent' },
      { spaceId: 'd', webContentsId: 3, name: 'User',    title: 'User',    url: 'https://u',      isActive: false, kind: 'user'  },
    ]);
    const res = await tool.handler({}, { tabRegistry: reg }, {});
    expect(res.ok).toBe(true);
    // 'c' filtered (no webContentsId), 'd' filtered (kind=user — agent's tools
    // never see the user's tabs since they live in a separate view).
    expect(res.tabs).toHaveLength(2);
    expect(res.tabs.map((t) => t.spaceId)).toEqual(['a', 'b']);
    expect(res.tabs[0].isActive).toBe(true);
  });

  test('read_tab returns readable output when extractor succeeds', async () => {
    const tool = byName('browser.read_tab');
    const wc = makeWc({ title: 'Hello', url: 'u', mainText: 'body', wordCount: 1 });
    const res = await tool.handler({}, { defaultWebContents: wc }, {});
    expect(res.ok).toBe(true);
    expect(res.title).toBe('Hello');
  });

  test('read_tab falls back to dom extractor when readable returns no mainText', async () => {
    const tool = byName('browser.read_tab');
    const wc = makeWc({ title: 'Hello', url: 'u', mainText: '' });
    const res = await tool.handler({}, { defaultWebContents: wc }, {});
    expect(res.ok).toBe(true);
    expect(res.mainText).toBe('fallback');
  });

  test('click targets provided spaceId via resolveWc', async () => {
    const tool = byName('browser.click');
    const wcA = makeWc({});
    const wcB = makeWc({});
    const ctx = {
      defaultWebContents: wcA,
      resolveWc: (sid) => (sid === 'b' ? wcB : null),
    };
    await tool.handler({ spaceId: 'b', selector: '#go' }, ctx, {});
    expect(wcA.executeJavaScript).not.toHaveBeenCalled();
    expect(wcB.executeJavaScript).toHaveBeenCalled();
  });

  test('click without spaceId falls back to default webContents', async () => {
    const tool = byName('browser.click');
    const wc = makeWc({});
    await tool.handler({ selector: '#x' }, { defaultWebContents: wc }, {});
    expect(wc.executeJavaScript).toHaveBeenCalled();
  });

  test('navigate calls loadURL with supplied URL', async () => {
    const tool = byName('browser.navigate');
    const wc = makeWc({});
    await tool.handler({ url: 'https://x' }, { defaultWebContents: wc }, {});
    expect(wc.loadURL).toHaveBeenCalledWith('https://x');
  });

  test('with HTTPS-only on, navigate loads the https URL itself instead of an http load the upgrade cancels', async () => {
    const { EventEmitter } = require('events');
    const privacy = require('../../../../../main/services/BrowsingPrivacyService');
    const settings = { 'settings.httpsOnly': true, spaces: {} };
    privacy.initialize({ get: (path, fallback) => (path in settings ? settings[path] : fallback) }, {
      app: new EventEmitter(),
      session: { defaultSession: { webRequest: { onBeforeSendHeaders: jest.fn(), onHeadersReceived: jest.fn() } } },
    });
    const wc = makeWc({});
    await byName('browser.navigate').handler({ url: 'http://plain.example/a' }, { defaultWebContents: wc }, {});
    expect(wc.loadURL).toHaveBeenCalledWith('https://plain.example/a');
    settings['settings.httpsOnly'] = false;
  });

  test('screenshot_tabs returns vision_disabled when invCtx.visionEnabled is false', async () => {
    const tool = byName('browser.screenshot_tabs');
    const res = await tool.handler({ spaceIds: ['a'] }, { tabRegistry: fakeRegistry([]), screenshots: {} }, { visionEnabled: false });
    expect(res).toEqual({ ok: false, error: 'vision_disabled' });
  });

  test('screenshot_tabs gathers images when vision is enabled', async () => {
    const tool = byName('browser.screenshot_tabs');
    const reg = fakeRegistry([{ spaceId: 'a', webContentsId: 1 }]);
    const ss = { captureById: jest.fn(async () => 'data:image/png;base64,AAAA') };
    const res = await tool.handler({ spaceIds: ['a'] }, { tabRegistry: reg, screenshots: ss }, { visionEnabled: true });
    expect(res.ok).toBe(true);
    expect(res.images).toEqual([{ spaceId: 'a', dataUrl: 'data:image/png;base64,AAAA' }]);
  });

  test('click is marked sideEffect, read_tab is not', () => {
    expect(byName('browser.click').sideEffect).toBe(true);
    expect(byName('browser.read_tab').sideEffect).toBeFalsy();
  });

  test('get_selection returns selected text via executeJavaScript', async () => {
    const tool = byName('browser.get_selection');
    const wc = makeWc({});
    const res = await tool.handler({}, { defaultWebContents: wc }, {});
    expect(res).toEqual({ ok: true, text: 'hello' });
  });

  describe('activeWc resolution', () => {
    test('spaceId with no resolveWc on ctx falls back to defaultWebContents', async () => {
      const tool = byName('browser.read_tab');
      const wc = makeWc({ title: 'D', url: 'u', mainText: 'body text here', wordCount: 50 });
      // ctx has a spaceId arg but NO resolveWc fn → returns defaultWebContents.
      const res = await tool.handler({ spaceId: 'x' }, { defaultWebContents: wc }, {});
      expect(res.ok).toBe(true);
      expect(res.title).toBe('D');
    });

    test('spaceId resolveWc returning falsy falls back to defaultWebContents', async () => {
      const tool = byName('browser.read_tab');
      const fallback = makeWc({ title: 'FB', url: 'u', mainText: 'lots of words here now', wordCount: 50 });
      const res = await tool.handler(
        { spaceId: 'missing' },
        { defaultWebContents: fallback, resolveWc: () => null },
        {}
      );
      expect(res.title).toBe('FB');
    });

    test('no spaceId: picks the active AGENT tab from the registry', async () => {
      const tool = byName('browser.read_tab');
      const agentWc = makeWc({ title: 'AgentTab', url: 'u', mainText: 'a b c d e f g h i j k l m n o p q r s t u', wordCount: 50 });
      const reg = fakeRegistry([
        { spaceId: 'u1', webContentsId: 9, isActive: true, kind: 'user' },   // user active — must be ignored
        { spaceId: 'a1', webContentsId: 1, isActive: true, kind: 'agent' },  // agent active — chosen
      ]);
      const res = await tool.handler(
        {},
        { tabRegistry: reg, resolveWc: (sid) => (sid === 'a1' ? agentWc : null), defaultWebContents: makeWc({}) },
        {}
      );
      expect(res.title).toBe('AgentTab');
    });

    test('no spaceId, registry has an active agent tab but resolveWc misses → default', async () => {
      const tool = byName('browser.read_tab');
      const dflt = makeWc({ title: 'Def', url: 'u', mainText: 'enough words to be useful here ok', wordCount: 50 });
      const reg = fakeRegistry([{ spaceId: 'a1', webContentsId: 1, isActive: true, kind: 'agent' }]);
      const res = await tool.handler(
        {},
        { tabRegistry: reg, resolveWc: () => null, defaultWebContents: dflt },
        {}
      );
      expect(res.title).toBe('Def');
    });

    test('no spaceId and no registry → defaultWebContents', async () => {
      const tool = byName('browser.read_tab');
      const dflt = makeWc({ title: 'OnlyDefault', url: 'u', mainText: 'words words words words words', wordCount: 50 });
      const res = await tool.handler({}, { defaultWebContents: dflt }, {});
      expect(res.title).toBe('OnlyDefault');
    });
  });

  describe('read_tab edge cases', () => {
    test('returns webcontents_unavailable when no wc resolves', async () => {
      const tool = byName('browser.read_tab');
      const res = await tool.handler({}, {}, {});
      expect(res).toEqual({ ok: false, error: 'webcontents_unavailable' });
    });

    test('returns webcontents_unavailable when wc lacks executeJavaScript', async () => {
      const tool = byName('browser.read_tab');
      const res = await tool.handler({}, { defaultWebContents: { foo: 1 } }, {});
      expect(res).toEqual({ ok: false, error: 'webcontents_unavailable' });
    });

    test('surfaces an SPA recovery hint on a known SPA host with too few words', async () => {
      const tool = byName('browser.read_tab');
      const wc = {
        executeJavaScript: jest.fn(async (src) => {
          if (src.includes('mainText')) return { title: 'Reddit', url: 'https://www.reddit.com/r/x', mainText: 'shell', wordCount: 2 };
          return { url: 'u', title: 't', text: 'tiny' };
        }),
        getURL: () => 'https://www.reddit.com/r/x',
      };
      const res = await tool.handler({}, { defaultWebContents: wc }, {});
      expect(res.ok).toBe(true);
      expect(res.hint).toMatch(/old\.reddit\.com|SPA shell/);
    });

    test('no hint for a non-SPA host even with few words', async () => {
      const tool = byName('browser.read_tab');
      const wc = {
        executeJavaScript: jest.fn(async (src) => {
          if (src.includes('mainText')) return { title: 'Blog', url: 'https://example.com/p', mainText: 'short', wordCount: 1 };
          return { url: 'u', title: 't', text: 'x' };
        }),
        getURL: () => 'https://example.com/p',
      };
      const res = await tool.handler({}, { defaultWebContents: wc }, {});
      expect(res.hint).toBeUndefined();
    });

    test('uses result.url when wc.getURL is absent for the SPA-host check', async () => {
      const tool = byName('browser.read_tab');
      const wc = {
        // No getURL → falls back to result.url for spaHintForUrl.
        executeJavaScript: jest.fn(async (src) => {
          if (src.includes('mainText')) return { title: 'X', url: 'https://twitter.com/home', mainText: 'a', wordCount: 1 };
          return { url: 'u', title: 't', text: 'x' };
        }),
      };
      const res = await tool.handler({}, { defaultWebContents: wc }, {});
      expect(res.hint).toMatch(/SPA shell/);
    });

    test('catches executeJavaScript throw and returns the error message', async () => {
      const tool = byName('browser.read_tab');
      const wc = { executeJavaScript: jest.fn(async () => { throw new Error('exec-died'); }) };
      const res = await tool.handler({}, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: false, error: 'exec-died' });
    });
  });

  describe('screenshot_tabs edge cases', () => {
    test('screenshots service missing → screenshots_unavailable', async () => {
      const tool = byName('browser.screenshot_tabs');
      const res = await tool.handler({ spaceIds: ['a'] }, { tabRegistry: fakeRegistry([]) }, { visionEnabled: true });
      expect(res).toEqual({ ok: false, error: 'screenshots_unavailable' });
    });

    test('skips spaceIds whose registry entry is missing or has no webContentsId', async () => {
      const tool = byName('browser.screenshot_tabs');
      const reg = fakeRegistry([{ spaceId: 'a', webContentsId: null }]);
      const ss = { captureById: jest.fn(async () => 'data:img') };
      const res = await tool.handler({ spaceIds: ['a', 'ghost'] }, { tabRegistry: reg, screenshots: ss }, { visionEnabled: true });
      expect(res).toEqual({ ok: true, images: [] });
      expect(ss.captureById).not.toHaveBeenCalled();
    });

    test('caps at 4 tabs and tolerates a per-tab capture failure', async () => {
      const tool = byName('browser.screenshot_tabs');
      const reg = fakeRegistry(
        ['a', 'b', 'c', 'd', 'e'].map((s, i) => ({ spaceId: s, webContentsId: i + 1 }))
      );
      const ss = {
        captureById: jest.fn(async (id) => {
          if (id === 2) throw new Error('capture-fail'); // tab 'b' fails, skipped
          return 'data:img' + id;
        }),
      };
      const res = await tool.handler({ spaceIds: ['a', 'b', 'c', 'd', 'e'] }, { tabRegistry: reg, screenshots: ss }, { visionEnabled: true });
      // 'e' never attempted (cap 4); 'b' failed and skipped → 3 images.
      expect(res.ok).toBe(true);
      expect(res.images.map((i) => i.spaceId)).toEqual(['a', 'c', 'd']);
      expect(ss.captureById).toHaveBeenCalledTimes(4);
    });

    test('defaults spaceIds to [] when omitted', async () => {
      const tool = byName('browser.screenshot_tabs');
      const res = await tool.handler({}, { tabRegistry: fakeRegistry([]), screenshots: { captureById: jest.fn() } }, { visionEnabled: true });
      expect(res).toEqual({ ok: true, images: [] });
    });

    test('vision_disabled when invCtx is entirely absent', async () => {
      const tool = byName('browser.screenshot_tabs');
      const res = await tool.handler({ spaceIds: ['a'] }, { tabRegistry: fakeRegistry([]), screenshots: {} });
      expect(res).toEqual({ ok: false, error: 'vision_disabled' });
    });

    test('uses invCtx.screenshotLongEdgePx when provided (|| 1280 arm)', async () => {
      const tool = byName('browser.screenshot_tabs');
      const reg = fakeRegistry([{ spaceId: 'a', webContentsId: 1 }]);
      const ss = { captureById: jest.fn(async () => 'data:img') };
      await tool.handler({ spaceIds: ['a'] }, { tabRegistry: reg, screenshots: ss }, { visionEnabled: true, screenshotLongEdgePx: 640 });
      expect(ss.captureById).toHaveBeenCalledWith(1, { format: 'dataUrl', maxDim: 640 });
    });
  });

  describe('list_tabs', () => {
    test('returns empty list when there is no registry', async () => {
      const tool = byName('browser.list_tabs');
      const res = await tool.handler({}, {}, {});
      expect(res).toEqual({ ok: true, tabs: [] });
    });

    test('falls back to empty name/title/url fields', async () => {
      const tool = byName('browser.list_tabs');
      const reg = fakeRegistry([{ spaceId: 'a', webContentsId: 1, kind: 'agent' }]);
      const res = await tool.handler({}, { tabRegistry: reg }, {});
      expect(res.tabs[0]).toEqual({ spaceId: 'a', name: '', title: '', url: '', isActive: false });
    });
  });

  describe('side-effecting tools', () => {
    test('click returns webcontents_unavailable when no wc resolves', async () => {
      const res = await byName('browser.click').handler({ selector: '#x' }, {}, {});
      expect(res).toEqual({ ok: false, error: 'webcontents_unavailable' });
    });

    test('click catches a runner throw and returns the message', async () => {
      const wc = { executeJavaScript: jest.fn(async () => { throw new Error('click-boom'); }) };
      const res = await byName('browser.click').handler({ selector: '#x' }, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: false, error: 'click-boom' });
    });

    test('navigate returns loadURL_unavailable when wc has no loadURL', async () => {
      const wc = { executeJavaScript: jest.fn() }; // no loadURL
      const res = await byName('browser.navigate').handler({ url: 'https://x' }, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: false, error: 'loadURL_unavailable' });
    });

    test('navigate resolves ok when loadURL succeeds', async () => {
      const wc = makeWc({});
      const res = await byName('browser.navigate').handler({ url: 'https://y' }, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: true });
    });

    test('scroll uses default direction/amount when omitted', async () => {
      const wc = makeWc({});
      await byName('browser.scroll').handler({}, { defaultWebContents: wc }, {});
      const src = wc.executeJavaScript.mock.calls[0][0];
      expect(typeof src).toBe('string');
    });

    test('type passes empty string when text omitted (|| "" arm)', async () => {
      const wc = makeWc({});
      const res = await byName('browser.type').handler({ selector: '#i' }, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: true });
    });

    test('press_key dispatches a synthetic keyboard event script', async () => {
      const wc = { executeJavaScript: jest.fn(async () => ({ ok: true })) };
      const res = await byName('browser.press_key').handler({ key: 'Enter' }, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: true });
      expect(wc.executeJavaScript.mock.calls[0][0]).toContain('KeyboardEvent');
    });
  });

  describe('extract / get_selection error paths', () => {
    test('extract returns webcontents_unavailable with no wc', async () => {
      const res = await byName('browser.extract').handler({ selector: '.x' }, {}, {});
      expect(res).toEqual({ ok: false, error: 'webcontents_unavailable' });
    });

    test('extract catches executeJavaScript throw', async () => {
      const wc = { executeJavaScript: jest.fn(async () => { throw new Error('ex'); }) };
      const res = await byName('browser.extract').handler({ selector: '.x' }, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: false, error: 'ex' });
    });

    test('get_selection returns webcontents_unavailable with no wc', async () => {
      const res = await byName('browser.get_selection').handler({}, {}, {});
      expect(res).toEqual({ ok: false, error: 'webcontents_unavailable' });
    });

    test('get_selection catches executeJavaScript throw', async () => {
      const wc = { executeJavaScript: jest.fn(async () => { throw new Error('sel-boom'); }) };
      const res = await byName('browser.get_selection').handler({}, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: false, error: 'sel-boom' });
    });

    test('get_selection returns empty string when selection is empty (|| "" arm)', async () => {
      const wc = { executeJavaScript: jest.fn(async () => '') };
      const res = await byName('browser.get_selection').handler({}, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: true, text: '' });
    });
  });

  describe('spaHintForUrl host normalization', () => {
    test('strips www./m./mobile. prefix and maps to the right hint key', async () => {
      const tool = byName('browser.read_tab');
      const wc = {
        executeJavaScript: jest.fn(async (src) => {
          if (src.includes('mainText')) return { title: 'LI', url: 'https://m.linkedin.com/feed', mainText: 'x', wordCount: 1 };
          return { url: 'u', title: 't', text: 'x' };
        }),
        getURL: () => 'https://m.linkedin.com/feed',
      };
      const res = await tool.handler({}, { defaultWebContents: wc }, {});
      expect(res.hint).toMatch(/feed-shared-update-v2|SPA shell/);
    });

    test('malformed URL yields no hint (catch arm in spaHintForUrl)', async () => {
      const tool = byName('browser.read_tab');
      const wc = {
        executeJavaScript: jest.fn(async (src) => {
          if (src.includes('mainText')) return { title: 'X', url: 'not a url', mainText: 'x', wordCount: 1 };
          return { url: 'u', title: 't', text: 'x' };
        }),
        getURL: () => 'not a url',
      };
      const res = await tool.handler({}, { defaultWebContents: wc }, {});
      expect(res.hint).toBeUndefined();
    });

    test('t.co host (matches SPA regex, no specific hint key) falls back to the reddit hint', async () => {
      const tool = byName('browser.read_tab');
      const wc = {
        executeJavaScript: jest.fn(async (src) => {
          if (src.includes('mainText')) return { title: 'TC', url: 'https://t.co/abc', mainText: 'x', wordCount: 1 };
          return { url: 'u', title: 't', text: 'x' };
        }),
        getURL: () => 'https://t.co/abc',
      };
      const res = await tool.handler({}, { defaultWebContents: wc }, {});
      // key 'tco'-ish has no entry → SPA_RECOVERY_HINTS.reddit fallback.
      expect(res.hint).toMatch(/old\.reddit\.com/);
    });

    test('empty URL everywhere → spaHintForUrl !url arm, no hint', async () => {
      const tool = byName('browser.read_tab');
      const wc = {
        executeJavaScript: jest.fn(async (src) => {
          if (src.includes('mainText')) return { title: 'NoUrl', url: '', mainText: 'x', wordCount: 1 };
          return { url: '', title: 't', text: 'x' };
        }),
        getURL: () => '',
      };
      const res = await tool.handler({}, { defaultWebContents: wc }, {});
      expect(res.hint).toBeUndefined();
    });
  });

  describe('isAgentTab kind defaulting', () => {
    test('list_tabs excludes a tab whose kind is absent (defaults to "user")', async () => {
      const tool = byName('browser.list_tabs');
      // No `kind` field → (t.kind || "user") === "user" → not an agent tab.
      const reg = fakeRegistry([{ spaceId: 'k', webContentsId: 1, name: 'NoKind' }]);
      const res = await tool.handler({}, { tabRegistry: reg }, {});
      expect(res.tabs).toEqual([]);
    });

    test('no spaceId + registry list has NO active agent tab → defaultWebContents', async () => {
      const tool = byName('browser.read_tab');
      const dflt = makeWc({ title: 'Fallback', url: 'u', mainText: 'plenty of useful words present here', wordCount: 50 });
      // Active tab is a user tab → isAgentTab false → `if (active)` false arm.
      const reg = fakeRegistry([{ spaceId: 'u', webContentsId: 1, isActive: true, kind: 'user' }]);
      const res = await tool.handler(
        {},
        { tabRegistry: reg, resolveWc: (s) => (s === 'u' ? makeWc({}) : null), defaultWebContents: dflt },
        {}
      );
      expect(res.title).toBe('Fallback');
    });
  });

  describe('non-Error throw fallbacks (String(err) arms)', () => {
    test('read_tab stringifies a non-Error throw', async () => {
      const tool = byName('browser.read_tab');
      const wc = { executeJavaScript: jest.fn(async () => { throw 'plain-fail'; }) }; // eslint-disable-line no-throw-literal
      const res = await tool.handler({}, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: false, error: 'plain-fail' });
    });

    test('side-effect tool stringifies a non-Error throw', async () => {
      const wc = { executeJavaScript: jest.fn(async () => { throw 'sfx-fail'; }) }; // eslint-disable-line no-throw-literal
      const res = await byName('browser.click').handler({ selector: '#x' }, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: false, error: 'sfx-fail' });
    });

    test('extract stringifies a non-Error throw', async () => {
      const wc = { executeJavaScript: jest.fn(async () => { throw 'ex-fail'; }) }; // eslint-disable-line no-throw-literal
      const res = await byName('browser.extract').handler({ selector: '.x' }, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: false, error: 'ex-fail' });
    });

    test('get_selection stringifies a non-Error throw', async () => {
      const wc = { executeJavaScript: jest.fn(async () => { throw 'gs-fail'; }) }; // eslint-disable-line no-throw-literal
      const res = await byName('browser.get_selection').handler({}, { defaultWebContents: wc }, {});
      expect(res).toEqual({ ok: false, error: 'gs-fail' });
    });
  });

  describe('screenshot_tabs falsy capture result', () => {
    test('captureById returning falsy is not pushed to images (if (dataUrl) arm)', async () => {
      const tool = byName('browser.screenshot_tabs');
      const reg = fakeRegistry([{ spaceId: 'a', webContentsId: 1 }]);
      const ss = { captureById: jest.fn(async () => null) };
      const res = await tool.handler({ spaceIds: ['a'] }, { tabRegistry: reg, screenshots: ss }, { visionEnabled: true });
      expect(res).toEqual({ ok: true, images: [] });
    });
  });

  describe('read_tab readable-vs-fallback word counting', () => {
    test('computes wordCount from mainText when extractor omits it', async () => {
      const tool = byName('browser.read_tab');
      // Readable output WITHOUT wordCount and with plenty of words → no hint,
      // wordCount derived from mainText split.
      const wc = {
        executeJavaScript: jest.fn(async (src) => {
          if (src.includes('mainText')) return { title: 'Doc', url: 'https://example.com', mainText: 'one two three four five six seven eight nine ten eleven twelve' };
          return { url: 'u', title: 't', text: 'x' };
        }),
        getURL: () => 'https://example.com',
      };
      const res = await tool.handler({}, { defaultWebContents: wc }, {});
      expect(res.ok).toBe(true);
      expect(res.hint).toBeUndefined();
    });
  });
});
