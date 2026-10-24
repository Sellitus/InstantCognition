// McpService tests. The MCP SDK is an external boundary; these tests exercise
// the config/lifecycle/dispatch logic via the _setAvailable / _setConnection
// test seams (no module mocking — robust against jest worker cache reuse).
// Live SDK import paths are covered by McpService.sdk-paths.test.js.

const { McpService } = require('../../../../main/services/McpService');

function fakeCs(mcp) {
  let data = { settings: { mcp } };
  const listeners = {};
  return {
    get: (p, fb) => { const ks = p.split('.'); let c = data; for (const k of ks) c = (c && typeof c === 'object') ? c[k] : undefined; return c === undefined ? fb : c; },
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    _emit: (ev) => { (listeners[ev] || []).forEach((f) => f()); },
  };
}

describe('McpService — availability + config', () => {
  test('isAvailable false when SDK is unavailable', () => {
    const svc = new McpService();
    svc._setAvailable(false);
    expect(svc.isAvailable()).toBe(false);
    svc._setAvailable(true);
    expect(svc.isAvailable()).toBe(true);
  });

  test('bindConfig reads settings.mcp and tolerates absence', () => {
    const svc = new McpService();
    svc.bindConfig(fakeCs({ enabled: false, servers: [] }));
    expect(svc.getStatus()).toEqual([]);
  });

  test('bindConfig(null) is a safe no-op', () => {
    const svc = new McpService();
    expect(() => svc.bindConfig(null)).not.toThrow();
  });

  test('_connect records a per-server error when the SDK is unavailable', async () => {
    const svc = new McpService();
    svc._setAvailable(false);
    svc._config = { servers: [{ id: 's', transport: 'stdio', command: 'x' }] };
    await svc._connect('s');
    const status = svc.getStatus();
    expect(status[0].status).toBe('error');
    expect(status[0].error).toMatch(/SDK/);
    svc._setAvailable(true);
  });
});

describe('McpService — status + tools', () => {
  test('listTools only surfaces connected servers', () => {
    const svc = new McpService();
    svc._setConnection('a', { status: 'connected', tools: [{ name: 't1', description: 'd', inputSchema: { type: 'object' } }] });
    svc._setConnection('b', { status: 'connecting', tools: [] });
    svc._setConnection('c', { status: 'error', tools: [] });
    const tools = svc.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ serverId: 'a', name: 't1', description: 'd' });
  });

  test('listTools defaults missing inputSchema', () => {
    const svc = new McpService();
    svc._setConnection('a', { status: 'connected', tools: [{ name: 'x' }] });
    expect(svc.listTools()[0].inputSchema).toEqual({ type: 'object', properties: {} });
  });

  test('getStatus merges config servers with connection state', () => {
    const svc = new McpService();
    svc._config = { servers: [{ id: 's1', name: 'One', transport: 'stdio', enabled: true }] };
    svc._setConnection('s1', { status: 'connected', tools: [{}, {}], error: null });
    const [row] = svc.getStatus();
    expect(row).toMatchObject({ id: 's1', name: 'One', status: 'connected', toolCount: 2 });
  });

  test('getStatus reports disconnected for unconfigured-but-known servers', () => {
    const svc = new McpService();
    svc._config = { servers: [{ id: 's2', name: 'Two', transport: 'http', enabled: false }] };
    const [row] = svc.getStatus();
    expect(row.status).toBe('disconnected');
    expect(row.toolCount).toBe(0);
  });
});

describe('McpService — callTool guards', () => {
  test('rejects when server not connected', async () => {
    const svc = new McpService();
    await expect(svc.callTool('nope', 't', {})).rejects.toThrow(/not connected/);
  });

  test('rejects when server exists but is in error state', async () => {
    const svc = new McpService();
    svc._setConnection('e', { status: 'error', client: null, tools: [] });
    await expect(svc.callTool('e', 't', {})).rejects.toThrow(/not connected/);
  });

  test('forwards arguments to a connected client', async () => {
    const svc = new McpService();
    let captured = null;
    svc._setConnection('ok', { status: 'connected', client: { callTool: async (req) => { captured = req; return { content: [{ type: 'text', text: 'hi' }] }; } }, tools: [] });
    const res = await svc.callTool('ok', 'doThing', { a: 1 });
    expect(captured).toEqual({ name: 'doThing', arguments: { a: 1 } });
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

describe('McpService — teardown', () => {
  test('stopAll disconnects every connection', async () => {
    const svc = new McpService();
    let closed = 0;
    const conn = { status: 'connected', client: { close: async () => { closed += 1; } }, transport: { close: async () => {} }, tools: [] };
    svc._setConnection('x', conn);
    svc._setConnection('y', { ...conn });
    await svc.stopAll();
    expect(closed).toBe(2);
    expect(svc.listTools()).toHaveLength(0);
  });

  test('emits tools-changed on disconnect', async () => {
    const svc = new McpService();
    let fires = 0;
    svc.on('tools-changed', () => { fires += 1; });
    svc._setConnection('x', { status: 'connected', client: { close: async () => {} }, transport: { close: async () => {} }, tools: [{}] });
    await svc._disconnect('x');
    expect(fires).toBeGreaterThanOrEqual(1);
  });
});

describe('McpService — _reload orchestration', () => {
  test('disconnects servers no longer in the wanted set', async () => {
    const svc = new McpService();
    const disconnected = [];
    svc._setConnection('keep', { status: 'connected', client: { close: async () => { disconnected.push('keep'); } }, transport: { close: async () => {} }, tools: [] });
    svc._setConnection('drop', { status: 'connected', client: { close: async () => { disconnected.push('drop'); } }, transport: { close: async () => {} }, tools: [] });
    // only 'keep' is wanted; SDK available so no new connection attempts
    svc._setAvailable(true);
    svc._configService = { get: () => ({ enabled: true, servers: [{ id: 'keep', transport: 'stdio', enabled: true }] }) };
    // Skip the real connect attempt by pre-registerring 'keep' as connected so _reload skips it.
    await svc._reload();
    expect(disconnected).toEqual(['drop']);
  });

  test('records an error per wanted-but-unavailable server (does not throw)', async () => {
    const svc = new McpService();
    svc._setAvailable(false);
    svc._config = { enabled: true, servers: [{ id: 'ghost', transport: 'stdio', command: 'x', enabled: true }] };
    // _reload reads from _configService when one is bound; bypass by binding a stub.
    svc._configService = { get: () => svc._config };
    const errors = [];
    svc.on('error', (e) => errors.push(e));
    await svc._reload();
    // ghost attempted but SDK absent → recorded as a per-server error
    const status = svc.getStatus();
    expect(status[0].status).toBe('error');
    expect(status[0].error).toMatch(/SDK/);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    svc._setAvailable(true);
  });

  test('wanted set is empty when settings.mcp.enabled is false (no connect attempts)', async () => {
    const svc = new McpService();
    svc._setAvailable(true);
    svc._configService = { get: () => ({ enabled: false, servers: [{ id: 's', transport: 'stdio', enabled: true }] }) };
    await svc._reload();
    // No connections were attempted, even though the server has enabled:true
    expect(svc._connections.has('s')).toBe(false);
  });

  test('a settings.mcp edit reloads the servers', async () => {
    const svc = new McpService();
    svc._setAvailable(true);
    const cs = fakeCs({ enabled: false, servers: [] });
    svc.bindConfig(cs);
    clearImmediate(svc._bootHandle);
    svc._bootHandle = null;

    let reloads = 0;
    svc._reload = async () => { reloads += 1; };
    cs._emit('change:settings.mcp');
    cs._emit('change:settings.mcp.enabled');

    expect(reloads).toBe(2);
  });
});

describe('McpService — deferred boot', () => {
  test('bindConfig defers the first reload so initialize() never blocks', async () => {
    const svc = new McpService();
    svc._setAvailable(true);
    svc.bindConfig(fakeCs({ enabled: false, servers: [] }));
    expect(svc._bootHandle).not.toBeNull();

    await new Promise((r) => setImmediate(r));
    expect(svc._bootHandle).toBeNull();
  });

  test('stopAll cancels a boot that has not fired, so nothing lands after teardown', async () => {
    const svc = new McpService();
    svc._setAvailable(true);
    svc.bindConfig(fakeCs({ enabled: false, servers: [] }));

    let reloads = 0;
    svc._reload = async () => { reloads += 1; };
    await svc.stopAll();
    await new Promise((r) => setImmediate(r));

    expect(svc._bootHandle).toBeNull();
    expect(reloads).toBe(0);
  });

  test('a boot failure is emitted rather than becoming an unhandled rejection', async () => {
    const svc = new McpService();
    const errors = [];
    svc.on('error', (e) => errors.push(e.message));
    svc._reload = async () => { throw new Error('boot broke'); };
    svc.bindConfig(fakeCs({ enabled: true, servers: [] }));

    await new Promise((r) => setImmediate(r));
    await Promise.resolve();

    expect(errors).toContain('boot broke');
  });
});

describe('McpService — visibility parking', () => {
  function connectedService(mcp) {
    const svc = new McpService();
    svc._setAvailable(true);
    svc.bindConfig(fakeCs(mcp));
    clearImmediate(svc._bootHandle);
    svc._bootHandle = null;
    return svc;
  }

  test('hiding the window tears down live stdio children', async () => {
    const svc = connectedService({ enabled: true, servers: [{ id: 's', name: 'S', transport: 'stdio', enabled: true }] });
    let closed = 0;
    svc._setConnection('s', { status: 'connected', client: { close: async () => { closed += 1; } }, transport: { close: async () => {} }, tools: [] });

    await svc.pauseForVisibility();

    expect(closed).toBe(1);
    expect(svc._connections.size).toBe(0);
  });

  test('with MCP disabled there is nothing to park', async () => {
    const svc = connectedService({ enabled: false, servers: [] });
    let closed = 0;
    svc._setConnection('s', { status: 'connected', client: { close: async () => { closed += 1; } }, transport: { close: async () => {} }, tools: [] });

    await svc.pauseForVisibility();

    expect(closed).toBe(0);
    expect(svc._connections.size).toBe(1);
  });

  test('parking with no live connection does no work', async () => {
    const svc = connectedService({ enabled: true, servers: [] });
    let reloads = 0;
    svc._disconnect = async () => { reloads += 1; };
    await svc.pauseForVisibility();
    expect(reloads).toBe(0);
  });

  test('showing the window reconnects from current config', async () => {
    const svc = connectedService({ enabled: true, servers: [] });
    let reloads = 0;
    svc._reload = async () => { reloads += 1; };
    await svc.resumeFromVisibility();
    expect(reloads).toBe(1);
  });

  test('resume without a bound config is a no-op', async () => {
    const svc = new McpService();
    let reloads = 0;
    svc._reload = async () => { reloads += 1; };
    await svc.resumeFromVisibility();
    expect(reloads).toBe(0);
  });

  test('a failed resume is reported, not swallowed', async () => {
    const svc = connectedService({ enabled: true, servers: [] });
    const errors = [];
    svc.on('error', (e) => errors.push(e.message));
    svc._reload = async () => { throw new Error('reconnect refused'); };

    await svc.resumeFromVisibility();

    expect(errors).toEqual(['reconnect refused']);
  });
});

describe('McpService — disconnect resilience', () => {
  test('a client that fails to close still releases the connection slot', async () => {
    const svc = new McpService();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let transportClosed = false;
    svc._setConnection('x', {
      status: 'connected',
      client: { close: async () => { throw new Error('already dead'); } },
      transport: { close: async () => { transportClosed = true; } },
      tools: [],
    });

    await svc._disconnect('x');

    // A broken client must not strand the transport or the map entry.
    expect(transportClosed).toBe(true);
    expect(svc._connections.has('x')).toBe(false);
    expect(console.error).toHaveBeenCalled();
    console.error.mockRestore();
  });

  test('disconnecting an unknown server is a no-op', async () => {
    const svc = new McpService();
    let fires = 0;
    svc.on('tools-changed', () => { fires += 1; });
    await svc._disconnect('nope');
    expect(fires).toBe(0);
  });
});
