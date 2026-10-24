/**
 * scriptedLlmServer.js — an OpenAI-compatible /v1/chat/completions endpoint
 * for driving the real app deterministically. Agent requests (the ones that
 * carry `tools`) pop the next scripted step; everything else (chat turns,
 * summaries, titles) goes to the chat responder.
 *
 * It enforces the strictest chat-template rules shipping engines apply
 * (Gemma / Mistral / llama-server --jinja): after the system prompt the first
 * turn is a user turn, and user/assistant turns alternate around tool calls. A violating request
 * gets the same 400 a strict engine returns and is recorded in `violations`.
 */

const http = require('http');

const STRICT_ROLE_ERROR = 'Conversation roles must alternate user/assistant/user/assistant/...';

// Like Mistral's template, tool-call turns (an assistant message carrying
// tool_calls, and the tool results answering it) sit outside the alternation
// check; a tool result must still answer a tool-call turn.
function roleViolation(messages) {
  const roles = [];
  let inToolCall = false;
  for (const m of messages) {
    if (!m || m.role === 'system') {
      if (roles.length || inToolCall) return 'system message after the conversation started';
      continue;
    }
    if (m.role === 'tool') {
      if (!inToolCall) return 'tool result without a preceding tool-call turn';
      continue;
    }
    inToolCall = m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    if (!inToolCall) roles.push(m.role);
  }
  if (roles.length && roles[0] !== 'user') return `first turn after system is "${roles[0]}"`;
  for (let i = 1; i < roles.length; i++) {
    if (roles[i] === roles[i - 1]) return `two consecutive "${roles[i]}" turns at ${i - 1}/${i}`;
  }
  return null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.type === 'text' ? p.text : '')).join('');
  return '';
}

class ScriptedLlmServer {
  constructor() {
    this.server = null;
    this.port = 0;
    /** @type {Array<{ path: string, body: any, kind: 'agent' | 'chat' }>} */
    this.requests = [];
    /** @type {Array<{ reason: string, roles: string[] }>} */
    this.violations = [];
    /** @type {Array<any>} */
    this._agentSteps = [];
    /** @type {(body: any) => { content: string, delayMs?: number }} */
    this.chatResponder = (body) => {
      const last = body.messages.filter((m) => m.role === 'user').pop();
      return { content: `Scripted reply to: ${textOf(last && last.content).split('\n').pop().slice(0, 80)}` };
    };
  }

  async start() {
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = /** @type {import('net').AddressInfo} */ (this.server.address()).port;
    return this;
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  get baseUrl() { return `http://127.0.0.1:${this.port}`; }

  /**
   * Queue agent steps, consumed one per agent request in order. A step is
   * { calls: [{ name, args }] } for tool calls, { content } for a text reply,
   * and may carry delayMs.
   */
  queueAgent(...steps) { this._agentSteps.push(...steps); }

  get pendingAgentSteps() { return this._agentSteps.length; }

  /** Drop every unconsumed step; returns how many there were. */
  drainAgentSteps() { return this._agentSteps.splice(0).length; }

  agentRequests() { return this.requests.filter((r) => r.kind === 'agent'); }

  chatRequests() { return this.requests.filter((r) => r.kind === 'chat'); }

  _handle(req, res) {
    if (req.method === 'GET' && /\/v1\/models$/.test(req.url || '')) {
      return this._json(res, 200, { object: 'list', data: [{ id: 'e2e-scripted', object: 'model' }] });
    }
    if (req.method !== 'POST' || !/\/v1\/chat\/completions$/.test(req.url || '')) {
      return this._json(res, 404, { error: { message: `no route ${req.method} ${req.url}` } });
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch (err) {
        return this._json(res, 400, { error: { message: `bad JSON: ${err.message}` } });
      }
      const kind = Array.isArray(body.tools) && body.tools.length ? 'agent' : 'chat';
      this.requests.push({ path: req.url, body, kind });
      const violation = roleViolation(body.messages || []);
      if (violation) {
        this.violations.push({ reason: violation, roles: (body.messages || []).map((m) => m.role) });
        return this._json(res, 400, { error: { message: `${STRICT_ROLE_ERROR} (${violation})`, type: 'invalid_request_error' } });
      }
      let reply;
      if (kind === 'agent') {
        reply = this._agentSteps.shift();
        if (!reply) {
          return this._json(res, 500, { error: { message: 'scripted server: no agent step queued for this request' } });
        }
      } else {
        reply = this.chatResponder(body);
      }
      const send = () => (body.stream ? this._stream(res, reply) : this._complete(res, reply));
      if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
    });
  }

  _toolCalls(reply) {
    return (reply.calls || []).map((c, i) => ({
      id: `call_${this.requests.length}_${i}`,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
    }));
  }

  _complete(res, reply) {
    const toolCalls = this._toolCalls(reply);
    const message = { role: 'assistant', content: toolCalls.length ? null : (reply.content || '') };
    if (toolCalls.length) message.tool_calls = toolCalls;
    this._json(res, 200, {
      id: `cmpl_${this.requests.length}`,
      object: 'chat.completion',
      model: 'e2e-scripted',
      choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  }

  // Server-sent events in the OpenAI chunk shape. Content goes out in a few
  // pieces so the renderer's streaming path is exercised, not just the tail.
  _stream(res, reply) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const chunk = (delta, finish) => `data: ${JSON.stringify({
      id: `cmpl_${this.requests.length}`, object: 'chat.completion.chunk', model: 'e2e-scripted',
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    })}\n\n`;
    const toolCalls = this._toolCalls(reply);
    const parts = [];
    if (toolCalls.length) {
      toolCalls.forEach((tc, i) => parts.push(chunk({ tool_calls: [{ index: i, ...tc }] })));
    } else {
      const text = reply.content || '';
      const step = Math.max(1, Math.ceil(text.length / 3));
      for (let i = 0; i < text.length; i += step) parts.push(chunk({ content: text.slice(i, i + step) }));
    }
    parts.push(chunk({}, toolCalls.length ? 'tool_calls' : 'stop'));
    parts.push(`data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    parts.push('data: [DONE]\n\n');
    const gap = reply.chunkGapMs || 0;
    let i = 0;
    const next = () => {
      if (res.destroyed) return;
      if (i >= parts.length) { res.end(); return; }
      res.write(parts[i++]);
      if (gap) setTimeout(next, gap); else next();
    };
    next();
  }

  _json(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }
}

module.exports = { ScriptedLlmServer, roleViolation, textOf };
