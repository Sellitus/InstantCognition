// roleAlternation — makes a chat request acceptable to strict chat templates
// (Mistral, Gemma, llama-server --jinja), which reject a conversation whose
// user/assistant turns do not alternate. Tool-call turns (an assistant message
// with tool_calls and the tool results answering it) sit outside that check.
//
// A failed or stopped turn leaves its user message (or its tool results)
// without a reply; the next request would then raise "roles must alternate"
// on every turn for the rest of the session. A short assistant note marks the
// gap instead, and back-to-back plain assistant texts merge into one.

const NO_REPLY_NOTE = '(No reply was given to the previous message.)';

const isToolCallTurn = (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;

/**
 * @param {Array<{ role: string, content?: any, tool_calls?: any[] }>} messages
 * @returns {Array<any>} a new array; the input and its messages are not modified
 */
function alternateRoles(messages) {
  if (!Array.isArray(messages)) throw new TypeError('alternateRoles: messages must be an array');
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && m.role === 'user' && (prev.role === 'user' || prev.role === 'tool')) {
      out.push({ role: 'assistant', content: NO_REPLY_NOTE });
    } else if (prev && m.role === 'assistant' && prev.role === 'assistant' && !isToolCallTurn(m) && !isToolCallTurn(prev)
      && typeof m.content === 'string' && typeof prev.content === 'string') {
      out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${m.content}` };
      continue;
    }
    out.push(m);
  }
  return out;
}

module.exports = { alternateRoles, NO_REPLY_NOTE };
