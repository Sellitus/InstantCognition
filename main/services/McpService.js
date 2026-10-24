// McpService — manages Model Context Protocol server connections and exposes
// their tools to the agent via the existing toolRegistry.
//
// Transports:
//   stdio — spawn a child process (the MCP server) and speak JSON-RPC over its
//           stdio. Lifecycle: connect on enable, kill on disable/quit.
//   http  — connect to a running StreamableHTTP endpoint. Reconnect on failure.
//
// Each enabled server's tools are surfaced as toolRegistry entries (see
// main/agent/tools/mcpTools.js) named `mcp.<serverId>.<toolName>`. When the
// tool set changes (server added/removed/connected/errored) McpService emits
// 'tools-changed' so AgentService can re-register.
//
// Mirrors the singleton-with-bindConfig shape of the other services. Config:
//   settings.mcp = { enabled: bool, servers: [McpServer] }
//   McpServer = { id, name, transport:'stdio'|'http', enabled,
//                 command?, args?, env?, url?, headers? }
//
// The MCP SDK is require()'d lazily inside connect steps; if it is absent the
// service reports unavailable and the UI hides MCP controls gracefully (same
// posture as VoiceService).

const EventEmitter = require('events');

const SERVER_DEFAULTS = {
  transport: 'stdio',
  enabled: true,
  args: [],
  env: {},
  headers: {},
};

// The MCP SDK's package.json `exports` maps subpaths (./client,
// ./client/stdio.js, ./client/streamableHttp.js) to both CJS (dist/cjs/*) and
// ESM (dist/esm/*) builds, but the bare root entry (".") is broken in 1.29.0 —
// dist/{cjs,esm}/index.js are both absent — so imports MUST use the explicit
// subpaths. Availability probes the ./client subpath with an actual require
// (not require.resolve) so a broken-build that resolves but fails to load is
// still detected; the lazy transport lookup happens in _connect so a per-file
// resolution failure is recorded per-server, not at boot.
const SDK = '@modelcontextprotocol/sdk';
let _unavailable = false;
let _clientCtor = null;
try {
  _clientCtor = require(`${SDK}/client`).Client;
} catch (err) {
  // SDK is optional — when absent, MCP tools are hidden from the renderer via
  // isAvailable(). Warn once so the absence is observable, not silent.
  _unavailable = true;
  if (!process.env.MCP_SDK_QUIET) console.warn('McpService: SDK not loadable — MCP tool servers disabled.', (err instanceof Error && err.message) || err);
}

async function loadClient() {
  if (_clientCtor) return _clientCtor;
  try {
    _clientCtor = require(`${SDK}/client`).Client;
  } catch (requireErr) {
    // CJS build missing for this subpath — try the ESM build via dynamic import.
    // The SDK ships both; the bare subpath may resolve to a broken index in some versions.
    try {
      _clientCtor = (await import(`${SDK}/client`)).Client;
    } catch (_importErr) {
      const msg = (requireErr instanceof Error && requireErr.message) || String(requireErr);
      throw new Error(`McpService: SDK client load failed (require + import): ${msg}`);
    }
  }
  return _clientCtor;
}

async function loadTransportClass(file) {
  try {
    return require(`${SDK}/client/${file}`);
  } catch (requireErr) {
    try {
      return await import(`${SDK}/client/${file}`);
    } catch (_importErr) {
      const msg = (requireErr instanceof Error && requireErr.message) || String(requireErr);
      throw new Error(`McpService: SDK transport load failed (${file}): ${msg}`);
    }
  }
}

async function loadTransport(transport, cfg) {
  if (transport === 'http') {
    const { StreamableHTTPClientTransport } = await loadTransportClass('streamableHttp.js');
    return new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers || {} } });
  }
  const { StdioClientTransport } = await loadTransportClass('stdio.js');
  return new StdioClientTransport({ command: cfg.command, args: cfg.args || [], env: { ...process.env, ...(cfg.env || {}) } });
}

class McpService extends EventEmitter {
  constructor() {
    super();
    this._config = null;
    this._configService = null;
    this._connections = new Map(); // serverId -> { client, transport, tools: [], status, error }
    this._bootHandle = null;
    this.on('error', () => {}); // floor listener
  }

  isAvailable() { return !_unavailable; }

  // Test seam: simulate the SDK being present/absent without module mocking.
  _setAvailable(flag) { _unavailable = !flag; }

  bindConfig(configService) {
    this._configService = configService || null;
    if (!configService) return;
    this._config = configService.get('settings.mcp', { enabled: false, servers: [] }) || { enabled: false, servers: [] };
    // React to config edits from the UI or migrations.
    configService.on('change:settings.mcp', () => this._reload());
    configService.on('change:settings.mcp.enabled', () => this._reload());
    // Start async — don't block initialize(). Held so stopAll() can cancel a
    // boot that has not fired yet; otherwise it lands after teardown.
    this._bootHandle = setImmediate(() => {
      this._bootHandle = null;
      this._reload().catch((err) => this._emitError(err));
    });
  }

  async _reload() {
    if (!this._configService) return;
    this._config = this._configService.get('settings.mcp', { enabled: false, servers: [] }) || { enabled: false, servers: [] };
    const wanted = new Set(this._config.enabled ? this._config.servers.filter((s) => s.enabled).map((s) => s.id) : []);

    // Disconnect any no-longer-wanted servers.
    for (const id of [...this._connections.keys()]) {
      if (!wanted.has(id)) await this._disconnect(id);
    }
    // Connect any new wanted servers (lazy, best-effort — failures recorded per-server).
    for (const id of wanted) {
      if (!this._connections.has(id)) this._connect(id).catch((err) => this._recordError(id, err));
    }
    this._emitToolsChanged();
  }

  // SDK access goes through these two so a caller can substitute the boundary.
  // The subpaths resolve to different builds depending on the requiring file,
  // which makes module-level mocking of them unreliable.
  async _loadClient() { return loadClient(); }
  async _loadTransport(transport, cfg) { return loadTransport(transport, cfg); }

  _serverConfig(id) {
    const list = (this._config && Array.isArray(this._config.servers)) ? this._config.servers : [];
    return list.find((s) => s.id === id) || null;
  }

  async _connect(id) {
    if (_unavailable) { this._recordError(id, new Error('MCP SDK not installed')); return; }
    const raw = this._serverConfig(id);
    if (!raw) { this._recordError(id, new Error('server config not found')); return; }
    const cfg = { ...SERVER_DEFAULTS, ...raw };
    await this._disconnect(id); // never two connections for one server

    this._connections.set(id, { client: null, transport: null, tools: [], status: 'connecting', error: null });

    try {
      const Client = await this._loadClient();
      const transport = await this._loadTransport(cfg.transport, cfg);
      const client = new Client({ name: 'instantcognition', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      const toolsRes = await client.listTools();
      const tools = Array.isArray(toolsRes && toolsRes.tools) ? toolsRes.tools : [];
      this._connections.set(id, { client, transport, tools, status: 'connected', error: null });
      this._emitToolsChanged();
    } catch (err) {
      this._recordError(id, err);
    }
  }

  async _disconnect(id) {
    const conn = this._connections.get(id);
    if (!conn) return;
    try {
      if (conn.client && typeof conn.client.close === 'function') await conn.client.close();
    } catch (err) { console.error(`McpService: client.close failed for ${id}:`, (err instanceof Error && err.message) || err); }
    try {
      if (conn.transport && typeof conn.transport.close === 'function') await conn.transport.close();
    } catch (err) { console.error(`McpService: transport.close failed for ${id}:`, (err instanceof Error && err.message) || err); }
    this._connections.delete(id);
    this._emitToolsChanged();
  }

  _recordError(id, err) {
    this._connections.set(id, { client: null, transport: null, tools: [], status: 'error', error: err && err.message ? err.message : String(err) });
    this._emitToolsChanged();
    this._emitError(err);
  }

  _emitError(err) {
    this.emit('error', err);
  }

  _emitToolsChanged() {
    this.emit('tools-changed', { tools: this.listTools() });
  }

  /** Snapshot of all tools across connected servers, each namespaced. */
  listTools() {
    const out = [];
    for (const [id, conn] of this._connections.entries()) {
      if (conn.status !== 'connected') continue;
      for (const t of conn.tools) {
        out.push({ serverId: id, name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object', properties: {} } });
      }
    }
    return out;
  }

  /** Per-server status for the UI. */
  getStatus() {
    const out = [];
    const list = (this._config && Array.isArray(this._config.servers)) ? this._config.servers : [];
    for (const s of list) {
      const conn = this._connections.get(s.id);
      out.push({ id: s.id, name: s.name, transport: s.transport, enabled: !!s.enabled, status: conn ? conn.status : 'disconnected', toolCount: conn ? conn.tools.length : 0, error: conn ? conn.error : null });
    }
    return out;
  }

  /** Invoke a namespaced tool. Returns the MCP result content. */
  async callTool(serverId, toolName, args) {
    const conn = this._connections.get(serverId);
    if (!conn || conn.status !== 'connected' || !conn.client) {
      throw new Error(`MCP server ${serverId} not connected`);
    }
    const res = await conn.client.callTool({ name: toolName, arguments: args || {} });
    return res;
  }

  /** Teardown on quit — kill every stdio child process. */
  async stopAll() {
    if (this._bootHandle) { clearImmediate(this._bootHandle); this._bootHandle = null; }
    const ids = [...this._connections.keys()];
    await Promise.all(ids.map((id) => this._disconnect(id)));
  }

  // Park stdio MCP children while the window is hidden. visibilityThrottling
  // lifts the suspend during an active agent run, so a run keeps its MCP tool
  // sessions alive — only an idle-hide actually tears them down.
  async pauseForVisibility() {
    if (!this._config || !this._config.enabled) return;
    if (!this._connections.size) return;
    await this.stopAll();
  }

  async resumeFromVisibility() {
    // _reload picks up the current settings.mcp config and reconnects. If the
    // user toggled MCP off while hidden, nothing reconnects — that's the right
    // outcome (config is the source of truth).
    if (!this._configService) return;
    try { await this._reload(); } catch (err) { this._emitError(err); }
  }

  // ---- test seams ----
  _setConnection(id, conn) { this._connections.set(id, conn); }
  _clearConnections() { this._connections.clear(); }
}

const instance = new McpService();

module.exports = instance;
module.exports.McpService = McpService;
module.exports.SERVER_DEFAULTS = SERVER_DEFAULTS;
