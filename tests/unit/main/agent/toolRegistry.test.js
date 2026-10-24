const { createRegistry } = require('../../../../main/agent/toolRegistry');

function makeTool(name, overrides = {}) {
  return {
    name,
    description: `test ${name}`,
    parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: [] },
    handler: jest.fn(async () => ({ ok: true, tool: name })),
    ...overrides,
  };
}

describe('toolRegistry', () => {
  test('register + list produces OpenAI-style tools array', () => {
    const r = createRegistry();
    r.register(makeTool('browser.click', { sideEffect: true }));
    r.register(makeTool('browser.read_tab'));
    const list = r.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ type: 'function', function: { name: 'browser.click' } });
    expect(list[0].function.parameters.type).toBe('object');
  });

  test('unregister removes a tool and returns whether it existed', () => {
    const r = createRegistry();
    r.register(makeTool('mcp.fs.read'));
    expect(r.has('mcp.fs.read')).toBe(true);
    expect(r.unregister('mcp.fs.read')).toBe(true);
    expect(r.has('mcp.fs.read')).toBe(false);
    // Removing a name that was never registered is a safe no-op (returns false),
    // and never throws — the re-sync loop relies on this for stale name sets.
    expect(r.unregister('mcp.fs.read')).toBe(false);
    expect(r.unregister('never.registered')).toBe(false);
    // Built-in tools are untouched by namespaced unregisters.
    r.register(makeTool('browser.click'));
    r.unregister('mcp.other.tool');
    expect(r.has('browser.click')).toBe(true);
  });

  test('validate catches missing required args and type mismatches', () => {
    const r = createRegistry();
    r.register({
      name: 't', description: '', handler: async () => ({ ok: true }),
      parameters: { type: 'object', properties: { url: { type: 'string' }, n: { type: 'number' } }, required: ['url'] },
    });
    expect(r.validate('t', {}).errors).toContain('missing:url');
    expect(r.validate('t', { url: 'x', n: 'oops' }).errors.some((e) => e.startsWith('type:n'))).toBe(true);
    expect(r.validate('t', { url: 'x', n: 3 }).ok).toBe(true);
    expect(r.validate('unknown', {})).toEqual({ ok: false, errors: ['unknown_tool:unknown'] });
  });

  test('invoke runs handler and returns result', async () => {
    const r = createRegistry();
    r.register(makeTool('x'));
    const res = await r.invoke('x', {}, {}, {});
    expect(res).toEqual({ ok: true, tool: 'x' });
  });

  test('invoke times out a hung handler', async () => {
    const r = createRegistry();
    r.register({
      name: 'slow', description: '', parameters: { type: 'object', properties: {}, required: [] },
      handler: () => new Promise(() => {}), // never resolves
    });
    const res = await r.invoke('slow', {}, {}, { toolTimeoutMs: 20 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('tool_timeout');
  });

  test('invokeParallel dispatches concurrent calls preserving order', async () => {
    const r = createRegistry();
    r.register(makeTool('a'));
    r.register(makeTool('b'));
    r.register(makeTool('c'));
    const res = await r.invokeParallel(
      [{ id: '1', name: 'a', args: {} }, { id: '2', name: 'b', args: {} }, { id: '3', name: 'c', args: {} }],
      {},
      {}
    );
    expect(res.map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(res.map((r) => r.result.tool)).toEqual(['a', 'b', 'c']);
  });

  test('invokeParallel rejects intra-tab conflicts on side-effect tools', async () => {
    const r = createRegistry();
    const click = makeTool('click', { sideEffect: true });
    r.register(click);
    r.register(makeTool('read', { sideEffect: false }));
    const res = await r.invokeParallel(
      [
        { id: 'c1', name: 'click', args: { spaceId: 'tab1' } },
        { id: 'c2', name: 'click', args: { spaceId: 'tab1' } },
        { id: 'c3', name: 'click', args: { spaceId: 'tab2' } },
        { id: 'r1', name: 'read', args: { spaceId: 'tab1' } },
      ],
      {},
      {}
    );
    const byId = Object.fromEntries(res.map((r) => [r.id, r]));
    expect(byId.c1.result.ok).toBe(true);
    expect(byId.c2.result.error).toBe('intra_tab_conflict');
    expect(byId.c2.result.conflict_with).toBe('c1');
    expect(byId.c3.result.ok).toBe(true); // different tab — allowed in parallel
    expect(byId.r1.result.ok).toBe(true); // read-only — allowed same tab
    // only two click handler invocations actually ran (c2 rejected, c1 + c3 accepted)
    expect(click.handler).toHaveBeenCalledTimes(2);
  });

  test('invokeParallel maps handler throws to error result', async () => {
    const r = createRegistry();
    r.register({
      name: 'boom', description: '', parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => { throw new Error('boom'); },
    });
    const res = await r.invokeParallel([{ id: '1', name: 'boom', args: {} }], {}, {});
    expect(res[0].result.ok).toBe(false);
    expect(res[0].result.error).toBe('boom');
  });

  describe('register validation', () => {
    test('throws when tool is missing / name is not a string', () => {
      const r = createRegistry();
      expect(() => r.register(null)).toThrow('tool.name required');
      expect(() => r.register({})).toThrow('tool.name required');
      expect(() => r.register({ name: 42 })).toThrow('tool.name required');
    });

    test('throws when handler is not a function (name in message)', () => {
      const r = createRegistry();
      expect(() => r.register({ name: 'no.handler' })).toThrow('tool no.handler: handler required');
      expect(() => r.register({ name: 'bad.handler', handler: 'nope' }))
        .toThrow('tool bad.handler: handler required');
    });

    test('applies side-effect / targetSpaceKey / parameters defaults', async () => {
      const r = createRegistry();
      // No parameters, no sideEffect, no targetSpaceKey → defaults filled in.
      r.register({ name: 'bare', handler: async () => ({ ok: true }) });
      const got = r.get('bare');
      expect(got.sideEffect).toBe(false);
      expect(got.targetSpaceKey).toBe('spaceId');
      expect(got.parameters).toEqual({ type: 'object', properties: {}, required: [] });
      // list() falls back to '' description for a tool with none.
      expect(r.list()[0].function.description).toBe('');
    });

    test('registerAll handles a null list (|| [] arm) and a populated list', () => {
      const r = createRegistry();
      expect(() => r.registerAll(null)).not.toThrow();
      expect(r.list()).toHaveLength(0);
      r.registerAll([makeTool('x'), makeTool('y')]);
      expect(r.list().map((t) => t.function.name).sort()).toEqual(['x', 'y']);
    });
  });

  describe('has / get', () => {
    test('has reflects registration; get returns null for unknown (|| null arm)', () => {
      const r = createRegistry();
      r.register(makeTool('present'));
      expect(r.has('present')).toBe(true);
      expect(r.has('absent')).toBe(false);
      expect(r.get('present')).toMatchObject({ name: 'present' });
      expect(r.get('absent')).toBeNull();
    });
  });

  describe('validate branch coverage', () => {
    test('array-typed property accepts array, rejects non-array', () => {
      const r = createRegistry();
      r.register({
        name: 'arr', description: '', handler: async () => ({ ok: true }),
        parameters: { type: 'object', properties: { ids: { type: 'array' } }, required: [] },
      });
      expect(r.validate('arr', { ids: [1, 2] }).ok).toBe(true);
      expect(r.validate('arr', { ids: 'nope' }).errors[0]).toMatch(/^type:ids:string!=array$/);
    });

    test('union type array (want is array) matches any listed type', () => {
      const r = createRegistry();
      r.register({
        name: 'uni', description: '', handler: async () => ({ ok: true }),
        parameters: { type: 'object', properties: { v: { type: ['string', 'number'] } }, required: [] },
      });
      expect(r.validate('uni', { v: 'a' }).ok).toBe(true);
      expect(r.validate('uni', { v: 7 }).ok).toBe(true);
      expect(r.validate('uni', { v: true }).errors[0]).toBe('type:v:boolean!=string|number');
    });

    test('property with no declared type is skipped (no error)', () => {
      const r = createRegistry();
      r.register({
        name: 'untyped', description: '', handler: async () => ({ ok: true }),
        parameters: { type: 'object', properties: { anything: {} }, required: [] },
      });
      expect(r.validate('untyped', { anything: { nested: 1 } }).ok).toBe(true);
    });

    test('null arg for an optional typed property is skipped, not a type error', () => {
      const r = createRegistry();
      r.register({
        name: 'opt', description: '', handler: async () => ({ ok: true }),
        parameters: { type: 'object', properties: { s: { type: 'string' } }, required: [] },
      });
      expect(r.validate('opt', { s: null }).ok).toBe(true);
      expect(r.validate('opt', {}).ok).toBe(true);
    });

    test('validate tolerates missing parameters object entirely', () => {
      const r = createRegistry();
      r.register({ name: 'noparams', handler: async () => ({ ok: true }) });
      // Default parameters {type:object,properties:{},required:[]} → always ok.
      expect(r.validate('noparams', { whatever: 1 }).ok).toBe(true);
    });

    test('validate handles a tool whose parameters/properties/required are explicitly absent', () => {
      const r = createRegistry();
      r.register(makeTool('shaped'));
      // Reach into the stored tool and blank out the schema fields so the
      // `|| {}`, `|| {}`, `Array.isArray(...) ? : []` fallbacks all fire.
      const stored = r.get('shaped');
      stored.parameters = null;
      stored.parameters = { required: 'not-an-array' };
      // properties absent → props || {} arm; required non-array → [] arm.
      expect(r.validate('shaped', { x: 1 }).ok).toBe(true);
      // args null → (args || {}) arm.
      expect(r.validate('shaped', null).ok).toBe(true);
    });

    test('validate falls back when parameters itself is missing on the stored tool', () => {
      const r = createRegistry();
      r.register(makeTool('p2'));
      r.get('p2').parameters = undefined; // params || {} arm[1]
      expect(r.validate('p2', { y: 2 }).ok).toBe(true);
    });
  });

  describe('invoke branch coverage', () => {
    test('unknown tool short-circuits before validate/handler', async () => {
      const r = createRegistry();
      const res = await r.invoke('missing', {}, {}, {});
      expect(res).toEqual({ ok: false, error: 'unknown_tool:missing' });
    });

    test('invalid args returns invalid_args with details, handler never runs', async () => {
      const r = createRegistry();
      const handler = jest.fn(async () => ({ ok: true }));
      r.register({
        name: 'needsUrl', description: '', handler,
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      });
      const res = await r.invoke('needsUrl', {}, {}, {});
      expect(res).toMatchObject({ ok: false, error: 'invalid_args', details: ['missing:url'] });
      expect(handler).not.toHaveBeenCalled();
    });

    test('uses DEFAULT_TIMEOUT_MS when invCtx has no toolTimeoutMs (|| arm)', async () => {
      const r = createRegistry();
      r.register(makeTool('quick'));
      // invCtx undefined → falls back to default timeout; handler resolves fast.
      const res = await r.invoke('quick', {});
      expect(res).toEqual({ ok: true, tool: 'quick' });
    });

    test('handler returning null/undefined is normalized to { ok: true }', async () => {
      const r = createRegistry();
      r.register({
        name: 'voidret', description: '', parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => undefined,
      });
      expect(await r.invoke('voidret', {}, {}, {})).toEqual({ ok: true });
    });

    test('synchronous handler throw is caught and stringified', async () => {
      const r = createRegistry();
      r.register({
        name: 'syncthrow', description: '', parameters: { type: 'object', properties: {}, required: [] },
        handler: () => { throw new Error('kaboom'); },
      });
      expect(await r.invoke('syncthrow', {}, {}, {})).toEqual({ ok: false, error: 'kaboom' });
    });

    test('non-Error rejection is stringified (String(err) arm)', async () => {
      const r = createRegistry();
      r.register({
        name: 'strthrow', description: '', parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => { throw 'plain string failure'; }, // eslint-disable-line no-throw-literal
      });
      expect(await r.invoke('strthrow', {}, {}, {})).toEqual({ ok: false, error: 'plain string failure' });
    });

    test('result after timeout is ignored (done guard) — no double resolve', async () => {
      jest.useFakeTimers();
      let resolveLate;
      const r = createRegistry();
      r.register({
        name: 'late', description: '', parameters: { type: 'object', properties: {}, required: [] },
        handler: () => new Promise((res) => { resolveLate = res; }),
      });
      const p = r.invoke('late', {}, {}, { toolTimeoutMs: 10 });
      await jest.advanceTimersByTimeAsync(20);
      const res = await p;
      expect(res).toEqual({ ok: false, error: 'tool_timeout', timeoutMs: 10 });
      // Late resolution must not throw or change the already-settled result.
      expect(() => resolveLate({ ok: true, late: true })).not.toThrow();
      jest.useRealTimers();
    });

    test('handler that resolves before the timeout clears the timer (done guard in timeout fn)', async () => {
      jest.useFakeTimers();
      const r = createRegistry();
      r.register({
        name: 'fast', description: '', parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => ({ ok: true, who: 'fast' }),
      });
      const p = r.invoke('fast', {}, {}, { toolTimeoutMs: 1000 });
      await jest.advanceTimersByTimeAsync(0); // flush the resolved handler microtask
      const res = await p;
      expect(res).toEqual({ ok: true, who: 'fast' });
      // Firing the (now-cleared) timer must not flip the settled result.
      await jest.advanceTimersByTimeAsync(2000);
      jest.useRealTimers();
    });

    test('late rejection after timeout is swallowed (done guard in catch)', async () => {
      jest.useFakeTimers();
      let rejectLate;
      const r = createRegistry();
      r.register({
        name: 'rejlate', description: '', parameters: { type: 'object', properties: {}, required: [] },
        handler: () => new Promise((_res, rej) => { rejectLate = rej; }),
      });
      const p = r.invoke('rejlate', {}, {}, { toolTimeoutMs: 10 });
      await jest.advanceTimersByTimeAsync(20);
      const res = await p;
      expect(res).toEqual({ ok: false, error: 'tool_timeout', timeoutMs: 10 });
      // The late rejection hits the catch but `done` is already true → ignored.
      expect(() => rejectLate(new Error('too late'))).not.toThrow();
      await Promise.resolve();
      jest.useRealTimers();
    });
  });

  describe('invokeParallel default-arg branches', () => {
    test('preserves order and fills lost results for unknown calls', async () => {
      const r = createRegistry();
      r.register(makeTool('known'));
      const res = await r.invokeParallel(
        [{ id: 'k', name: 'known', args: {} }, { id: 'u', name: 'ghost', args: {} }],
        {},
        {}
      );
      expect(res.map((x) => x.id)).toEqual(['k', 'u']);
      expect(res[0].result).toEqual({ ok: true, tool: 'known' });
      expect(res[1].result).toEqual({ ok: false, error: 'unknown_tool:ghost' });
    });

    test('empty calls list yields an empty result array', async () => {
      const r = createRegistry();
      const res = await r.invokeParallel([], {}, {});
      expect(res).toEqual([]);
    });

    test('side-effect tool with no spaceId is not treated as a conflict', async () => {
      const r = createRegistry();
      const click = makeTool('clk', { sideEffect: true });
      r.register(click);
      const res = await r.invokeParallel(
        [{ id: '1', name: 'clk', args: {} }, { id: '2', name: 'clk', args: {} }],
        {},
        {}
      );
      // No spaceId on either → both run (the `sideEffect && sid` guard is false).
      expect(res.every((x) => x.result.ok)).toBe(true);
      expect(click.handler).toHaveBeenCalledTimes(2);
    });

    test('duplicate side-effect on same space: rejected entry restitched by id, second call accepted', async () => {
      const r = createRegistry();
      const click = makeTool('clk2', { sideEffect: true });
      r.register(click);
      const res = await r.invokeParallel(
        [
          { id: 'a', name: 'clk2', args: { spaceId: 's1' } },
          { id: 'b', name: 'clk2', args: { spaceId: 's1' } },
        ],
        {},
        {}
      );
      const byId = Object.fromEntries(res.map((x) => [x.id, x]));
      expect(byId.a.result.ok).toBe(true);
      expect(byId.b.result).toMatchObject({ ok: false, error: 'intra_tab_conflict', conflict_with: 'a' });
    });

  });

  describe('list(pred) tier ordering and filtering', () => {
    test('sorts by catalog tier and keeps registration order within a tier', () => {
      const r = createRegistry();
      ['browser.screenshot_tabs', 'browser.click', 'mcp.gh.search', 'browser.read_tab', 'fs.read', 'browser.teleport']
        .forEach((n) => r.register(makeTool(n)));
      expect(r.list().map((t) => t.function.name)).toEqual([
        'mcp.gh.search', 'fs.read', // tier 1
        'browser.click', 'browser.read_tab', 'browser.teleport', // tier 2 (unknown sits at 2)
        'browser.screenshot_tabs', // tier 3
      ]);
    });

    test('pred(name, tool) narrows the list; a non-function pred is ignored', () => {
      const r = createRegistry();
      r.register(makeTool('fs.read'));
      r.register(makeTool('fs.write', { sideEffect: true }));
      r.register(makeTool('browser.click', { sideEffect: true }));
      const seen = [];
      const readOnly = r.list((name, tool) => { seen.push([name, tool.sideEffect]); return !tool.sideEffect; });
      expect(readOnly.map((t) => t.function.name)).toEqual(['fs.read']);
      expect(seen).toContainEqual(['fs.write', true]);
      expect(r.list(null)).toHaveLength(3);
      expect(r.list((n) => n === 'nothing')).toEqual([]);
    });
  });

  describe('per-tool timeoutMs', () => {
    afterEach(() => { jest.useRealTimers(); });

    test('tool.timeoutMs overrides invCtx.toolTimeoutMs', async () => {
      jest.useFakeTimers();
      const r = createRegistry();
      r.register(makeTool('slow', { timeoutMs: 50, handler: () => new Promise(() => {}) }));
      const p = r.invoke('slow', {}, {}, { toolTimeoutMs: 60000 });
      jest.advanceTimersByTime(50);
      await expect(p).resolves.toEqual({ ok: false, error: 'tool_timeout', timeoutMs: 50 });
    });

    test('a non-positive tool.timeoutMs falls back to invCtx.toolTimeoutMs', async () => {
      jest.useFakeTimers();
      const r = createRegistry();
      r.register(makeTool('slow', { timeoutMs: -5, handler: () => new Promise(() => {}) }));
      const p = r.invoke('slow', {}, {}, { toolTimeoutMs: 30 });
      jest.advanceTimersByTime(30);
      await expect(p).resolves.toEqual({ ok: false, error: 'tool_timeout', timeoutMs: 30 });
    });
  });

  describe('invoke abort', () => {
    test('aborting invCtx.signal resolves aborted while the handler is still running', async () => {
      const r = createRegistry();
      const ctrl = new AbortController();
      let handlerSignal = null;
      r.register(makeTool('hang', { handler: (_a, _t, inv) => { handlerSignal = inv.signal; return new Promise(() => {}); } }));
      const p = r.invoke('hang', {}, {}, { signal: ctrl.signal, toolTimeoutMs: 60000 });
      await Promise.resolve(); await Promise.resolve();
      expect(handlerSignal).toBe(ctrl.signal);
      ctrl.abort();
      await expect(p).resolves.toEqual({ ok: false, error: 'aborted' });
    });

    test('an already-aborted signal never calls the handler', async () => {
      const r = createRegistry();
      const tool = makeTool('x');
      r.register(tool);
      const ctrl = new AbortController(); ctrl.abort();
      await expect(r.invoke('x', {}, {}, { signal: ctrl.signal })).resolves.toEqual({ ok: false, error: 'aborted' });
      expect(tool.handler).not.toHaveBeenCalled();
    });

    test('a result that lands before abort wins; a later abort changes nothing', async () => {
      const r = createRegistry();
      r.register(makeTool('x'));
      const ctrl = new AbortController();
      const res = await r.invoke('x', {}, {}, { signal: ctrl.signal });
      ctrl.abort();
      expect(res).toEqual({ ok: true, tool: 'x' });
    });

    test('invokeParallel propagates the signal to every call', async () => {
      const r = createRegistry();
      r.register(makeTool('a', { handler: () => new Promise(() => {}) }));
      r.register(makeTool('b', { handler: () => new Promise(() => {}) }));
      const ctrl = new AbortController();
      const p = r.invokeParallel([{ id: '1', name: 'a', args: {} }, { id: '2', name: 'b', args: {} }], {}, { signal: ctrl.signal, toolTimeoutMs: 60000 });
      ctrl.abort();
      const res = await p;
      expect(res.map((x) => x.result)).toEqual([{ ok: false, error: 'aborted' }, { ok: false, error: 'aborted' }]);
    });
  });
});
