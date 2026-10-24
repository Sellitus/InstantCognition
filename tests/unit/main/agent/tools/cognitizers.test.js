const cognitizerTools = require('../../../../../main/agent/tools/cognitizers');
const { listEnabledAiServices, buildInjectScript } = cognitizerTools;

const broadcastTool = cognitizerTools[0];

describe('cognitizers tool — schema', () => {
  test('exports a single side-effecting tool', () => {
    expect(cognitizerTools.length).toBe(1);
    expect(broadcastTool.name).toBe('agent.broadcast_to_cognitizers');
    expect(broadcastTool.sideEffect).toBe(true);
    expect(broadcastTool.parameters.required).toEqual(['prompt']);
  });
});

describe('listEnabledAiServices', () => {
  const spaces = {
    custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/', type: 'ai-service' },
    custom2: { name: 'Claude', url: 'https://claude.ai/new', type: 'ai-service' },
    custom3: { name: 'Google', url: 'https://google.com', type: 'web-page' },
    'llm-chat': { name: 'Local LLM', url: 'ic://llm-chat/', type: 'local-llm' },
  };

  test('returns only ai-service spaces by default', () => {
    const r = listEnabledAiServices(spaces);
    expect(r.map((x) => x.id)).toEqual(['custom1', 'custom2']);
    expect(r[0].name).toBe('ChatGPT');
    expect(r[0].url).toBe('https://chatgpt.com/');
  });

  test('filters by name when services arg provided', () => {
    const r = listEnabledAiServices(spaces, ['Claude']);
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe('Claude');
  });

  test('filters by id when services arg provided', () => {
    const r = listEnabledAiServices(spaces, ['custom1']);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('custom1');
  });

  test('case-insensitive match', () => {
    const r = listEnabledAiServices(spaces, ['CHATGPT']);
    expect(r).toHaveLength(1);
  });

  test('returns empty when no ai-service spaces configured', () => {
    expect(listEnabledAiServices({ web: { name: 'Web', url: 'https://x.com', type: 'web-page' } })).toEqual([]);
  });

  test('caps fan-out at 8 spaces', () => {
    const big = {};
    for (let i = 0; i < 20; i++) big['c' + i] = { name: 'AI' + i, url: 'https://ai' + i + '.test', type: 'ai-service' };
    expect(listEnabledAiServices(big)).toHaveLength(8);
  });

  test('skips ai-service entries with no url and falsy/null space objects', () => {
    const r = listEnabledAiServices({
      good: { name: 'Good', url: 'https://good.test', type: 'ai-service' },
      noUrl: { name: 'NoUrl', type: 'ai-service' },          // sp.url falsy → excluded
      nullSp: null,                                            // sp falsy → excluded
      wrongType: { name: 'X', url: 'https://x', type: 'web-page' },
    });
    expect(r.map((x) => x.id)).toEqual(['good']);
  });

  test('null/undefined spacesCfg yields an empty list (|| {} arm)', () => {
    expect(listEnabledAiServices(null)).toEqual([]);
    expect(listEnabledAiServices(undefined)).toEqual([]);
  });

  test('falls back to id when a matched space has no name (sp.name || id)', () => {
    const r = listEnabledAiServices({
      noName: { url: 'https://nn.test', type: 'ai-service' },
    });
    expect(r).toEqual([{ id: 'noName', name: 'noName', url: 'https://nn.test' }]);
  });

  test('empty requestedNames array falls back to default (length === 0 arm)', () => {
    const r = listEnabledAiServices(
      { c1: { name: 'A', url: 'https://a.test', type: 'ai-service' } },
      []
    );
    expect(r.map((x) => x.id)).toEqual(['c1']);
  });
});

describe('buildInjectScript value coercion', () => {
  test('null prompt is coerced to an empty JSON string (s == null arm)', () => {
    const script = buildInjectScript(null, true);
    expect(script).toContain('const text="";');
  });

  test('numeric prompt is String()-coerced before JSON.stringify', () => {
    const script = buildInjectScript(42, false);
    expect(script).toContain('const text="42";');
  });
});

describe('buildInjectScript', () => {
  test('escapes the user prompt safely', () => {
    const script = buildInjectScript('hello "world" \n\\backslash', true);
    // The text appears as a JSON-stringified value, so quotes/newlines are escaped.
    expect(script).toContain('hello \\"world\\"');
  });

  test('encodes autoSubmit flag', () => {
    expect(buildInjectScript('x', true)).toContain('autoSubmit=true');
    expect(buildInjectScript('x', false)).toContain('autoSubmit=false');
  });

  test('produces an IIFE', () => {
    const script = buildInjectScript('hi', true);
    expect(script.startsWith('(function()')).toBe(true);
    expect(script.endsWith(')();')).toBe(true);
  });
});

describe('cognitizers tool — handler', () => {
  test('returns no_ai_service_spaces_configured when none exist', async () => {
    // Inject a fake configService via require cache mutation
    const cs = require('../../../../../main/services/ConfigService');
    const origGet = cs.get;
    cs.get = (path) => path === 'spaces' ? {} : origGet.call(cs, path);
    try {
      const res = await broadcastTool.handler({ prompt: 'hi' }, { tabOps: { openTab: jest.fn() } });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('no_ai_service_spaces_configured');
    } finally { cs.get = origGet; }
  });

  test('rejects empty prompt', async () => {
    const res = await broadcastTool.handler({ prompt: '   ' }, {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('empty_prompt');
  });

  test('opens a tab per ai-service and returns spaceIds', async () => {
    const cs = require('../../../../../main/services/ConfigService');
    const origGet = cs.get;
    cs.get = (path) => path === 'spaces' ? {
      custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/', type: 'ai-service' },
      custom2: { name: 'Claude', url: 'https://claude.ai/new', type: 'ai-service' },
    } : origGet.call(cs, path);
    try {
      let n = 0;
      const tabOps = { openTab: jest.fn(async () => ({ spaceId: 'agent-tab-' + (++n) })) };
      const fakeWc = { isLoading: () => false, executeJavaScript: jest.fn(async () => 'textarea') };
      const toolCtx = { tabOps, resolveWc: () => fakeWc };
      const res = await broadcastTool.handler({ prompt: 'hi all' }, toolCtx);
      expect(res.ok).toBe(true);
      expect(res.opened).toHaveLength(2);
      expect(tabOps.openTab).toHaveBeenCalledTimes(2);
      expect(fakeWc.executeJavaScript).toHaveBeenCalledTimes(2);
    } finally { cs.get = origGet; }
  });

  function withSpaces(spaces, fn) {
    const cs = require('../../../../../main/services/ConfigService');
    const origGet = cs.get;
    cs.get = (path, dflt) => (path === 'spaces' ? spaces : origGet.call(cs, path, dflt));
    return Promise.resolve()
      .then(fn)
      .finally(() => { cs.get = origGet; });
  }

  const AI = (name, url) => ({ name, url, type: 'ai-service' });

  test('rejects non-string / null prompt (String(... ) coercion + empty check)', async () => {
    expect((await broadcastTool.handler({ prompt: null }, {})).error).toBe('empty_prompt');
    expect((await broadcastTool.handler({}, {})).error).toBe('empty_prompt');
    expect((await broadcastTool.handler(null, {})).error).toBe('empty_prompt');
  });

  test('open_failed when openTab returns no spaceId — recorded in errors, ok:false', async () => {
    await withSpaces({ c1: AI('ChatGPT', 'https://chatgpt.com/') }, async () => {
      const tabOps = { openTab: jest.fn(async () => ({})) }; // no spaceId
      const res = await broadcastTool.handler({ prompt: 'hi' }, { tabOps });
      expect(res.ok).toBe(false);
      expect(res.opened).toEqual([]);
      expect(res.errors).toEqual([{ name: 'ChatGPT', error: 'open_failed' }]);
      expect(res.hint).toMatch(/No tabs opened/);
    });
  });

  test('openTab throwing is caught and reported with the thrown message', async () => {
    await withSpaces({ c1: AI('Claude', 'https://claude.ai/') }, async () => {
      const tabOps = { openTab: jest.fn(async () => { throw new Error('boom-open'); }) };
      const res = await broadcastTool.handler({ prompt: 'hi' }, { tabOps });
      expect(res.ok).toBe(false);
      expect(res.errors).toEqual([{ name: 'Claude', error: 'boom-open' }]);
    });
  });

  test('openTab throwing a non-Error falls back to "open_failed" message', async () => {
    await withSpaces({ c1: AI('Gemini', 'https://gemini.google.com/') }, async () => {
      const tabOps = { openTab: jest.fn(async () => { throw 'stringy'; }) }; // eslint-disable-line no-throw-literal
      const res = await broadcastTool.handler({ prompt: 'hi' }, { tabOps });
      expect(res.errors).toEqual([{ name: 'Gemini', error: 'open_failed' }]);
    });
  });

  test('falls back to the module-level tabOps singleton when toolCtx has none', async () => {
    const realTabOps = require('../../../../../main/services/AgentTabOpsService');
    const orig = realTabOps.openTab;
    realTabOps.openTab = jest.fn(async () => ({ spaceId: 'sing-1' }));
    try {
      await withSpaces({ c1: AI('ChatGPT', 'https://chatgpt.com/') }, async () => {
        // No tabOps on ctx, no resolveWc → opened without injection.
        const res = await broadcastTool.handler({ prompt: 'via singleton' }, {});
        expect(res.ok).toBe(true);
        expect(res.opened).toEqual([{ spaceId: 'sing-1', name: 'ChatGPT', url: 'https://chatgpt.com/' }]);
        expect(realTabOps.openTab).toHaveBeenCalledWith('https://chatgpt.com/');
      });
    } finally { realTabOps.openTab = orig; }
  });

  test('resolveWc returning null skips injection but still records the open', async () => {
    await withSpaces({ c1: AI('ChatGPT', 'https://chatgpt.com/') }, async () => {
      const tabOps = { openTab: jest.fn(async () => ({ spaceId: 's1' })) };
      const res = await broadcastTool.handler(
        { prompt: 'hi' },
        { tabOps, resolveWc: () => null }
      );
      expect(res.ok).toBe(true);
      expect(res.opened).toHaveLength(1);
    });
  });

  test('injection failure records a per-target error and continues (continue arm)', async () => {
    await withSpaces({
      c1: AI('ChatGPT', 'https://chatgpt.com/'),
      c2: AI('Claude', 'https://claude.ai/'),
    }, async () => {
      let n = 0;
      const tabOps = { openTab: jest.fn(async () => ({ spaceId: 's' + (++n) })) };
      const wcs = {
        s1: { isLoading: () => false, executeJavaScript: jest.fn(async () => { throw new Error('inject-fail'); }) },
        s2: { isLoading: () => false, executeJavaScript: jest.fn(async () => 'textarea') },
      };
      const res = await broadcastTool.handler(
        { prompt: 'hi' },
        { tabOps, resolveWc: (sid) => wcs[sid] }
      );
      // s1 injection threw → recorded in errors and NOT pushed to opened;
      // s2 succeeded → opened.
      expect(res.ok).toBe(true);
      expect(res.opened).toEqual([{ spaceId: 's2', name: 'Claude', url: 'https://claude.ai/' }]);
      expect(res.errors).toEqual([{ name: 'ChatGPT', spaceId: 's1', error: 'inject-fail' }]);
    });
  });

  test('injection failure with a non-Error uses the "inject_failed" fallback message', async () => {
    await withSpaces({ c1: AI('ChatGPT', 'https://chatgpt.com/') }, async () => {
      const tabOps = { openTab: jest.fn(async () => ({ spaceId: 's1' })) };
      const wc = { isLoading: () => false, executeJavaScript: jest.fn(async () => { throw 'bad'; }) }; // eslint-disable-line no-throw-literal
      const res = await broadcastTool.handler(
        { prompt: 'hi' },
        { tabOps, resolveWc: () => wc }
      );
      expect(res.errors).toEqual([{ name: 'ChatGPT', spaceId: 's1', error: 'inject_failed' }]);
    });
  });

  test('autoSubmit:false threads through to the injected script (=== false arm)', async () => {
    await withSpaces({ c1: AI('ChatGPT', 'https://chatgpt.com/') }, async () => {
      const tabOps = { openTab: jest.fn(async () => ({ spaceId: 's1' })) };
      const wc = { isLoading: () => false, executeJavaScript: jest.fn(async () => 'textarea') };
      await broadcastTool.handler(
        { prompt: 'hi', autoSubmit: false },
        { tabOps, resolveWc: () => wc }
      );
      expect(wc.executeJavaScript.mock.calls[0][0]).toContain('autoSubmit=false');
    });
  });

  test('waitLoadSettled waits for did-finish-load when the page is still loading', async () => {
    jest.useFakeTimers();
    try {
      await withSpaces({ c1: AI('ChatGPT', 'https://chatgpt.com/') }, async () => {
        const tabOps = { openTab: jest.fn(async () => ({ spaceId: 's1' })) };
        let finishCb = null;
        const wc = {
          isLoading: jest.fn(() => true),
          once: jest.fn((ev, cb) => { if (ev === 'did-finish-load') finishCb = cb; }),
          executeJavaScript: jest.fn(async () => 'textarea'),
        };
        const p = broadcastTool.handler({ prompt: 'hi' }, { tabOps, resolveWc: () => wc });
        // Let the handler reach waitLoadSettled and register the once() listener.
        await Promise.resolve();
        await Promise.resolve();
        expect(wc.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
        if (finishCb) finishCb(); // page finishes loading
        await jest.advanceTimersByTimeAsync(600); // settle delay
        const res = await p;
        expect(res.ok).toBe(true);
        expect(wc.executeJavaScript).toHaveBeenCalled();
      });
    } finally { jest.useRealTimers(); }
  });

  test('waitLoadSettled is a no-op when wc has no isLoading function', async () => {
    await withSpaces({ c1: AI('ChatGPT', 'https://chatgpt.com/') }, async () => {
      const tabOps = { openTab: jest.fn(async () => ({ spaceId: 's1' })) };
      // wc with executeJavaScript but NO isLoading → waitLoadSettled returns early.
      const wc = { executeJavaScript: jest.fn(async () => 'textarea') };
      const res = await broadcastTool.handler({ prompt: 'hi' }, { tabOps, resolveWc: () => wc });
      expect(res.ok).toBe(true);
      expect(wc.executeJavaScript).toHaveBeenCalled();
    });
  });
});
