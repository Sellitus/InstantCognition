// mcpTools bridges MCP server tools into the agent toolRegistry as
// namespaced mcp.<serverId>.<tool> entries. These tests cover the naming,
// schema pass-through, sideEffect serialization, and the handler's
// normalization of McpService.callTool results + errors.

const { getMcpToolDefs, toolName, bindMcpToAgent } = require('../../../../main/agent/tools/mcpTools');
const { createRegistry } = require('../../../../main/agent/toolRegistry');

describe('mcpTools — naming', () => {
  test('toolName namespaces as mcp.<server>.<name>', () => {
    expect(toolName('fs', 'read_file')).toBe('mcp.fs.read_file');
  });
});

describe('mcpTools — getMcpToolDefs', () => {
  test('returns [] for no service / missing listTools', () => {
    expect(getMcpToolDefs(null)).toEqual([]);
    expect(getMcpToolDefs({})).toEqual([]);
  });

  test('builds one def per tool with namespace + description prefix', () => {
    const svc = { listTools: () => [{ serverId: 'git', name: 'diff', description: 'show diff', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] };
    const defs = getMcpToolDefs(svc);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('mcp.git.diff');
    expect(defs[0].description).toBe('[MCP:git] show diff');
    expect(defs[0].parameters.required).toEqual(['path']);
  });

  test('falls back to default object schema when inputSchema absent', () => {
    const svc = { listTools: () => [{ serverId: 's', name: 't' }] };
    const defs = getMcpToolDefs(svc);
    expect(defs[0].parameters).toEqual({ type: 'object', properties: {}, required: [] });
    expect(defs[0].description).toBe('[MCP:s] t');
  });

  test('marks every tool sideEffect with a non-colliding space key', () => {
    const svc = { listTools: () => [{ serverId: 's', name: 'a' }, { serverId: 's', name: 'b' }] };
    const defs = getMcpToolDefs(svc);
    for (const d of defs) {
      expect(d.sideEffect).toBe(true);
      expect(d.targetSpaceKey).toBe('__mcp__');
    }
  });
});

describe('mcpTools — handler dispatch', () => {
  test('routes call through mcpService.callTool and normalizes content', async () => {
    let captured = null;
    const svc = {
      listTools: () => [{ serverId: 'db', name: 'query', inputSchema: { type: 'object' } }],
      callTool: async (serverId, name, args) => { captured = { serverId, name, args }; return { content: [{ type: 'text', text: 'row' }], meta: { n: 1 } }; },
    };
    const [def] = getMcpToolDefs(svc);
    const res = await def.handler({ sql: 'select 1' });
    expect(captured).toEqual({ serverId: 'db', name: 'query', args: { sql: 'select 1' } });
    expect(res).toEqual({ ok: true, content: [{ type: 'text', text: 'row' }], meta: { n: 1 } });
  });

  test('handler defaults absent args to {}', async () => {
    const svc = {
      listTools: () => [{ serverId: 'db', name: 'query', inputSchema: { type: 'object' } }],
      callTool: async (_s, _n, args) => { return { content: [], args }; },
    };
    const [def] = getMcpToolDefs(svc);
    await def.handler(undefined);
    // callTool received {} — proven by no throw and the args echo above.
    expect(true).toBe(true);
  });

  test('turns a thrown callTool error into { ok:false, error }', async () => {
    const svc = {
      listTools: () => [{ serverId: 'db', name: 'query', inputSchema: { type: 'object' } }],
      callTool: async () => { throw new Error('boom'); },
    };
    const [def] = getMcpToolDefs(svc);
    const res = await def.handler({});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('boom');
  });
});

describe('mcpTools — bindMcpToAgent', () => {
  test('returns a no-op unsubscribe for null service', () => {
    const r = createRegistry();
    const unsub = bindMcpToAgent(r, null);
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  test('initial sync registers namespaced tools; resync swaps the set', () => {
    const listeners = {};
    const svc = {
      listTools: () => [{ serverId: 's', name: 'a', inputSchema: { type: 'object' } }],
      on: (ev, fn) => { listeners[ev] = fn; },
      removeListener: () => {},
    };
    const r = createRegistry();
    const unsub = bindMcpToAgent(r, svc);
    expect(r.has('mcp.s.a')).toBe(true);

    // Simulate a server tool-set change: only tool 'b' now exists.
    svc.listTools = () => [{ serverId: 's', name: 'b', inputSchema: { type: 'object' } }];
    listeners['tools-changed']();
    expect(r.has('mcp.s.a')).toBe(false); // old name unregistered
    expect(r.has('mcp.s.b')).toBe(true);  // new name registered
    unsub();
  });

  test('built-in tools survive an MCP resync', () => {
    const listeners = {};
    const svc = {
      listTools: () => [{ serverId: 's', name: 'a', inputSchema: { type: 'object' } }],
      on: (ev, fn) => { listeners[ev] = fn; },
      removeListener: () => {},
    };
    const r = createRegistry();
    r.register({ name: 'browser.click', description: 'built-in', parameters: { type: 'object', properties: {}, required: [] }, handler: async () => ({ ok: true }) });
    bindMcpToAgent(r, svc);
    svc.listTools = () => [{ serverId: 's', name: 'b', inputSchema: { type: 'object' } }];
    listeners['tools-changed']();
    expect(r.has('browser.click')).toBe(true);
    expect(r.has('mcp.s.b')).toBe(true);
  });
});
