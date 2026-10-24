// sessionRecorder — persists one agent run into the session store: the user
// turn, each acted step (assistant tool_calls + tool results), and the
// outcome. contextProjection replays these nodes, so a session resumes with
// its tool history after a restart.
//
// Stored tool arguments and results are size-capped (a fs.write can carry a
// megabyte of content); the cap is marked in the text so a replay never
// mistakes a clipped value for the original.

const { RESULT_MAX_CHARS } = require('./contextProjection');

const ARG_STRING_MAX = 8 * 1024;

function clip(s, max) {
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}

function clipArgs(v, depth = 0) {
  if (typeof v === 'string') return clip(v, ARG_STRING_MAX);
  if (!v || typeof v !== 'object' || depth > 4) return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => clipArgs(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipArgs(x, depth + 1)]));
}

function planText(plan) {
  if (!plan || typeof plan !== 'object') return '';
  const todos = Array.isArray(plan.todos) ? plan.todos.map((t, i) => `${i + 1}. ${t.content}`).join('\n') : '';
  return [plan.summary || '', todos].filter(Boolean).join('\n\n');
}

/**
 * @param {{ store: import('./sessionStore').SessionStore }} deps
 */
function createSessionSink({ store }) {
  if (!store) throw new Error('store required');

  /** @param {{ sessionId?: string|null, title?: string, source?: string, workspaceRoot?: string|null }} opts */
  function open(opts = {}) {
    const sessionId = opts.sessionId
      ? (store.exists(opts.sessionId) ? opts.sessionId : (() => { throw new Error('session_not_found'); })())
      : store.create({ source: opts.source || 'agent' }).id;
    let turnId = null;
    return {
      sessionId,
      get turnId() { return turnId; },
      headId: () => store.get(sessionId).meta.headId,
      meta: () => store.get(sessionId).meta,
      priorPath: () => store.getPath(sessionId),
      /** Appends the user turn; reuseNodeId resumes from an existing user node (edit / regenerate). */
      user(content, data, reuseNodeId) {
        if (reuseNodeId) {
          const node = store.getPath(sessionId, reuseNodeId).pop();
          if (!node || node.role !== 'user') throw new Error('not_a_user_message');
          store.setHead(sessionId, node.id);
          turnId = node.id;
          return node;
        }
        const node = store.append(sessionId, { role: 'user', content: String(content), data });
        turnId = node.id;
        return node;
      },
      step({ calls, results, mode }) {
        const cs = (Array.isArray(calls) ? calls : []).map((c) => ({ id: String(c.id), name: String(c.name), args: clipArgs(c.args || {}) }));
        store.append(sessionId, { role: 'assistant', kind: 'tool_calls', content: '', data: { calls: cs, mode } });
        const rs = (Array.isArray(results) ? results : []).map((r) => ({
          id: String(r.id), name: String(r.name), content: clip(JSON.stringify(r.result === undefined ? {} : r.result), RESULT_MAX_CHARS),
        }));
        store.append(sessionId, { role: 'tool', kind: 'tool_results', content: '', data: { results: rs } });
      },
      finish(result) {
        const r = result || {};
        if (r.ok && r.summary) return store.append(sessionId, { role: 'assistant', content: String(r.summary), data: { reason: r.reason || null, turnId } });
        if (r.reason === 'awaiting_plan_approval') return store.append(sessionId, { role: 'assistant', kind: 'plan', content: planText(r.result && r.result.plan), data: { plan: r.result && r.result.plan, turnId } });
        if (r.reason === 'awaiting_user' && r.question) return store.append(sessionId, { role: 'assistant', content: String(r.question), data: { awaitingUser: true, turnId } });
        return store.append(sessionId, { role: 'assistant', kind: 'error', content: `Run ended: ${r.reason || 'unknown'}`, data: { reason: r.reason || null, turnId } });
      },
      fail(err) {
        return store.append(sessionId, { role: 'assistant', kind: 'error', content: (err instanceof Error && err.message) || String(err), data: { turnId } });
      },
    };
  }

  return { open, store };
}

module.exports = { createSessionSink, clipArgs, planText };
