// mcpTools — bridges MCP server tools into the agent toolRegistry.
//
// Each connected MCP tool becomes a registered tool named
// `mcp.<serverId>.<toolName>` so it cannot collide with the built-in tools.
// The handler routes the call through McpService.callTool and normalizes the
// MCP response into the { ok, ... } shape the runtime expects.
//
// getMcpToolDefs(mcpService) returns a fresh array; AgentService calls it on
// every 'tools-changed' to re-register the current set.

function toolName(serverId, name) {
  return `mcp.${serverId}.${name}`;
}

function getMcpToolDefs(mcpService) {
  if (!mcpService || typeof mcpService.listTools !== 'function') return [];
  const out = [];
  for (const t of mcpService.listTools()) {
    out.push(buildDef(mcpService, t));
  }
  return out;
}

function buildDef(mcpService, t) {
  const name = toolName(t.serverId, t.name);
  const description = t.description
    ? `[MCP:${t.serverId}] ${t.description}`
    : `[MCP:${t.serverId}] ${t.name}`;
  return {
    name,
    description,
    parameters: t.inputSchema && typeof t.inputSchema === 'object'
      ? t.inputSchema
      : { type: 'object', properties: {}, required: [] },
    // MCP tools are external side-effecting services — serialize within a run.
    sideEffect: true,
    targetSpaceKey: '__mcp__', // never collides with a real spaceId
    handler: async (args) => {
      try {
        const res = await mcpService.callTool(t.serverId, t.name, args || {});
        return { ok: true, content: res && res.content, meta: res && res.meta };
      } catch (err) {
        return { ok: false, error: (err instanceof Error && err.message) || String(err) };
      }
    },
  };
}

// Attach a McpService to an agent's toolRegistry: register every connected
// server's tools, then re-sync on 'tools-changed'. Returns an unsubscribe
// function (also idempotent when mcpService is null). Names are namespaced
// (mcp.<serverId>.<tool>) so unregistration never touches built-in tools.
function bindMcpToAgent(registry, mcpService) {
  if (!mcpService) return () => {};
  let names = [];
  const sync = () => {
    if (names.length) for (const n of names) registry.unregister(n);
    const defs = getMcpToolDefs(mcpService);
    names = defs.map((d) => d.name);
    registry.registerAll(defs);
  };
  sync();
  mcpService.on('tools-changed', sync);
  return () => { try { mcpService.removeListener('tools-changed', sync); } catch (err) { console.error('mcpTools: removeListener failed:', (err instanceof Error && err.message) || err); } };
}

module.exports = { getMcpToolDefs, toolName, bindMcpToAgent };
