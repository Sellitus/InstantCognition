// McpService connect path. The SDK is the external boundary and is substituted
// through the service's _loadClient/_loadTransport seams; everything above it —
// server config merge, transport selection, tool listing, error recording — is
// real. Module-mocking the SDK subpaths is not an option: they resolve to
// different builds depending on which file requires them.
// The remaining lifecycle tests live in McpService.test.js.

const { McpService } = require('../../../../main/services/McpService');

const clients = [];
const stdioArgs = [];
const httpArgs = [];

class FakeClient {
  constructor(info, opts) {
    this.info = info;
    this.opts = opts;
    this.connected = null;
    this.closed = false;
    this.tools = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];
    clients.push(this);
  }

  async connect(transport) { this.connected = transport; }
  async listTools() { return { tools: this.tools }; }
  async callTool(req) { return { content: [{ type: 'text', text: 'ok:' + req.name }] }; }
  async close() { this.closed = true; }
}

class FakeTransport {
  constructor(kind) { this.kind = kind; this.closed = false; }
  async close() { this.closed = true; }
}

function fakeCs(mcp) {
  const data = { settings: { mcp } };
  return {
    get: (p, fb) => {
      let cur = data;
      for (const k of p.split('.')) cur = (cur && typeof cur === 'object') ? cur[k] : undefined;
      return cur === undefined ? fb : cur;
    },
    on: () => {},
  };
}

/** Service bound to `mcp` config, SDK stubbed, deferred boot cancelled. */
function boundService(mcp) {
  const svc = new McpService();
  svc._setAvailable(true);
  svc.bindConfig(fakeCs(mcp));
  if (svc._bootHandle) { clearImmediate(svc._bootHandle); svc._bootHandle = null; }
  svc._loadClient = async () => FakeClient;
  // Mirrors loadTransport: the transport kind and its construction arguments
  // are what the real SDK would receive.
  svc._loadTransport = async (kind, cfg) => {
    if (kind === 'http') {
      httpArgs.push({ url: new URL(cfg.url), headers: cfg.headers || {} });
      return new FakeTransport('http');
    }
    stdioArgs.push({ command: cfg.command, args: cfg.args || [], env: { ...process.env, ...(cfg.env || {}) } });
    return new FakeTransport('stdio');
  };
  return svc;
}

const STDIO_SERVER = { id: 's1', name: 'Files', transport: 'stdio', enabled: true, command: 'mcp-files', args: ['--root', '/tmp'] };

describe('McpService connect', () => {
  beforeEach(() => {
    clients.length = 0;
    stdioArgs.length = 0;
    httpArgs.length = 0;
  });

  test('a stdio server connects and its tools become namespaced entries', async () => {
    const svc = boundService({ enabled: true, servers: [STDIO_SERVER] });
    await svc._connect('s1');

    expect(stdioArgs[0].command).toBe('mcp-files');
    expect(stdioArgs[0].args).toEqual(['--root', '/tmp']);
    // The child inherits the parent env so PATH-resolved commands work.
    expect(stdioArgs[0].env.PATH).toBe(process.env.PATH);
    expect(svc.listTools()).toEqual([
      { serverId: 's1', name: 'echo', description: 'Echo', inputSchema: { type: 'object' } },
    ]);
    expect(svc.getStatus()[0]).toMatchObject({ id: 's1', status: 'connected', toolCount: 1, error: null });
  });

  test('connecting emits tools-changed so AgentService re-registers', async () => {
    const svc = boundService({ enabled: true, servers: [STDIO_SERVER] });
    const seen = [];
    svc.on('tools-changed', (p) => seen.push(p.tools.length));
    await svc._connect('s1');
    expect(seen[seen.length - 1]).toBe(1);
  });

  test('an http server connects through the url and headers from config', async () => {
    const svc = boundService({
      enabled: true,
      servers: [{ id: 'h1', name: 'Remote', transport: 'http', enabled: true, url: 'https://mcp.example.com/rpc', headers: { Authorization: 'Bearer t' } }],
    });
    await svc._connect('h1');

    expect(httpArgs[0].url.toString()).toBe('https://mcp.example.com/rpc');
    expect(httpArgs[0].headers).toEqual({ Authorization: 'Bearer t' });
    expect(clients[0].connected.kind).toBe('http');
    expect(svc.getStatus()[0].status).toBe('connected');
  });

  test('a failed handshake records the error per server and surfaces no tools', async () => {
    const svc = boundService({ enabled: true, servers: [STDIO_SERVER] });
    const errors = [];
    svc.on('error', (e) => errors.push(e.message));
    svc._loadClient = async () => class Refusing extends FakeClient {
      async connect() { throw new Error('handshake refused'); }
    };

    await svc._connect('s1');

    expect(svc.getStatus()[0]).toMatchObject({ status: 'error', error: 'handshake refused', toolCount: 0 });
    expect(svc.listTools()).toEqual([]);
    expect(errors).toContain('handshake refused');
  });

  test('a transport that cannot be built is recorded, not thrown', async () => {
    const svc = boundService({ enabled: true, servers: [STDIO_SERVER] });
    svc._loadTransport = async () => { throw new Error('SDK transport load failed (stdio.js)'); };

    await expect(svc._connect('s1')).resolves.toBeUndefined();
    expect(svc.getStatus()[0].error).toMatch(/transport load failed/);
  });

  test('a server with no tools connects but contributes nothing', async () => {
    const svc = boundService({ enabled: true, servers: [STDIO_SERVER] });
    svc._loadClient = async () => class Toolless extends FakeClient {
      async listTools() { return {}; }
    };

    await svc._connect('s1');

    expect(svc.getStatus()[0].status).toBe('connected');
    expect(svc.listTools()).toEqual([]);
  });

  test('reconnecting closes the previous session instead of leaking a child', async () => {
    const svc = boundService({ enabled: true, servers: [STDIO_SERVER] });
    await svc._connect('s1');
    const first = clients[0];

    await svc._connect('s1');

    expect(first.closed).toBe(true);
    expect(clients).toHaveLength(2);
    expect(svc._connections.size).toBe(1);
  });

  test('an unknown server id is an error, not a silent no-op', async () => {
    const svc = boundService({ enabled: true, servers: [STDIO_SERVER] });
    await svc._connect('nope');
    expect(svc._connections.get('nope').status).toBe('error');
    expect(svc._connections.get('nope').error).toBe('server config not found');
  });

  test('_reload connects the enabled servers and drops the disabled ones', async () => {
    const svc = boundService({
      enabled: true,
      servers: [STDIO_SERVER, { id: 's2', name: 'Off', transport: 'stdio', enabled: false, command: 'x' }],
    });

    await svc._reload();
    await new Promise((r) => setImmediate(r));

    expect(svc._connections.has('s1')).toBe(true);
    expect(svc._connections.has('s2')).toBe(false);
    expect(svc.getStatus().map((s) => s.status)).toEqual(['connected', 'disconnected']);
  });

  test('callTool reaches the connected client', async () => {
    const svc = boundService({ enabled: true, servers: [STDIO_SERVER] });
    await svc._connect('s1');
    expect(await svc.callTool('s1', 'echo', { a: 1 })).toEqual({ content: [{ type: 'text', text: 'ok:echo' }] });
  });

  test('stopAll closes both the client and the transport', async () => {
    const svc = boundService({ enabled: true, servers: [STDIO_SERVER] });
    await svc._connect('s1');
    const client = clients[0];
    const transport = client.connected;

    await svc.stopAll();

    expect(client.closed).toBe(true);
    expect(transport.closed).toBe(true);
    expect(svc._connections.size).toBe(0);
  });
});
