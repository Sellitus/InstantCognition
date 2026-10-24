// Live SDK smoke test: verifies the MCP SDK import paths used by McpService
// resolve to real constructor functions against the actually-installed
// package. Guards against the broken-root-export regression seen in 1.29.0
// (dist/{cjs,esm}/index.js are absent; only the ./client subpath exports work).
// No mocks — this is a real require() against node_modules.

describe('MCP SDK import paths (live)', () => {
  test('the ./client subpath exports a Client constructor', () => {
    const { Client } = require('@modelcontextprotocol/sdk/client');
    expect(typeof Client).toBe('function');
  });

  test('the ./client/stdio.js subpath exports StdioClientTransport', () => {
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    expect(typeof StdioClientTransport).toBe('function');
  });

  test('the ./client/streamableHttp.js subpath exports StreamableHTTPClientTransport', () => {
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    expect(typeof StreamableHTTPClientTransport).toBe('function');
  });

  test('require.resolve succeeds for the probed subpath', () => {
    expect(() => require.resolve('@modelcontextprotocol/sdk/client')).not.toThrow();
  });
});
