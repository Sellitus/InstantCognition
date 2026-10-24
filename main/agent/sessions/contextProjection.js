// contextProjection — turns a session path (root→head nodes from
// sessionStore) into the message arrays the LLM layers consume.
//
//   toAgentMessages(nodes, { mode })  — AgentRuntime shapes. 'tools' (native)
//     replays assistant tool_calls + role:'tool' results; 'json' replays the
//     assistant's text and rolls results into one "Results:" user message,
//     exactly as AgentRuntime._appendTurn writes them.
//   toChatMessages(nodes, { budgetTokens, system }) — plain user/assistant
//     turns for the chat lane, oldest turns dropped to fit the token budget.
//
// The newest compaction node on the path replaces everything before it with
// its summary: compactionRecap() for the agent's system prompt (a recap turn
// ahead of the first user turn breaks strict-alternation chat templates), a
// summary system line for the chat lane. Error and plan nodes are UI records
// and never reach the model.

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
const RESULT_MAX_CHARS = 8 * 1024;

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

function messageTokens(m) {
  const extra = m.tool_calls ? JSON.stringify(m.tool_calls).length / CHARS_PER_TOKEN : 0;
  return MESSAGE_OVERHEAD_TOKENS + estimateTokens(m.content) + Math.ceil(extra);
}

function afterCompaction(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let at = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].kind === 'compaction') { at = i; break; }
  }
  return { summary: at >= 0 ? list[at] : null, rest: at >= 0 ? list.slice(at + 1) : list.slice() };
}

const isTurn = (n) => n && n.kind === 'message' && (n.role === 'user' || n.role === 'assistant');

function truncate(s) {
  const str = String(s == null ? '' : s);
  return str.length > RESULT_MAX_CHARS ? `${str.slice(0, RESULT_MAX_CHARS)}…[truncated ${str.length - RESULT_MAX_CHARS} bytes]` : str;
}

function callsOf(node) {
  const calls = node && node.data && Array.isArray(node.data.calls) ? node.data.calls : [];
  return calls.filter((c) => c && typeof c.name === 'string');
}

function resultsOf(node) {
  const results = node && node.data && Array.isArray(node.data.results) ? node.data.results : [];
  return results.filter((r) => r && typeof r === 'object');
}

/** @param {any[]} nodes @param {{ mode?: 'tools'|'json' }} [opts] */
function toAgentMessages(nodes, opts = {}) {
  const native = opts.mode === 'tools';
  const { rest } = afterCompaction(nodes);
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const n = rest[i];
    if (isTurn(n)) { out.push({ role: n.role, content: n.content }); continue; }
    if (n.kind === 'tool_calls') {
      const calls = callsOf(n);
      const next = rest[i + 1];
      // Native tool messages must answer an assistant tool_calls turn one to
      // one; a call list whose results never landed is replayed as text.
      if (native && calls.length && next && next.kind === 'tool_results') {
        out.push({
          role: 'assistant', content: n.content || '',
          tool_calls: calls.map((c) => ({ id: String(c.id), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
        });
      } else {
        out.push({ role: 'assistant', content: n.content || JSON.stringify(calls.map((c) => ({ tool: c.name, args: c.args || {} }))) });
      }
      continue;
    }
    if (n.kind === 'tool_results') {
      const prev = rest[i - 1];
      const results = resultsOf(n);
      if (native && prev && prev.kind === 'tool_calls' && callsOf(prev).length) {
        for (const r of results) out.push({ role: 'tool', tool_call_id: String(r.id), content: truncate(r.content) });
      } else {
        out.push({ role: 'user', content: `Results:\n${results.map((r, k) => `${k + 1}. ${r.name} → ${truncate(r.content)}`).join('\n')}` });
      }
    }
  }
  return out;
}

/** The newest compaction summary on the path, worded for the agent's system prompt; '' without one. @param {any[]} nodes */
function compactionRecap(nodes) {
  const { summary } = afterCompaction(nodes);
  return summary ? `[Compacted earlier turns] Summary of prior progress:\n${summary.content}` : '';
}

/** @param {any[]} nodes @param {{ budgetTokens?: number, system?: string }} [opts] */
function toChatMessages(nodes, opts = {}) {
  const { summary, rest } = afterCompaction(nodes);
  const head = [];
  if (opts.system) head.push({ role: 'system', content: String(opts.system) });
  if (summary) head.push({ role: 'system', content: `Summary of the earlier conversation:\n${summary.content}` });
  const turns = rest.filter(isTurn).map((n) => ({ role: n.role, content: n.content }));
  const budget = Number(opts.budgetTokens);
  if (!Number.isFinite(budget) || budget <= 0) return [...head, ...turns];
  let used = head.reduce((s, m) => s + messageTokens(m), 0);
  const kept = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = messageTokens(turns[i]);
    // The newest turn is always sent: dropping it would answer nothing.
    if (kept.length && used + cost > budget) break;
    kept.unshift(turns[i]);
    used += cost;
  }
  return [...head, ...kept];
}

function countTokens(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((s, m) => s + messageTokens(m), 0);
}

module.exports = { toAgentMessages, toChatMessages, compactionRecap, estimateTokens, countTokens, afterCompaction, RESULT_MAX_CHARS };
