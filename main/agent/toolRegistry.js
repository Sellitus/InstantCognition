// toolRegistry — registers and dispatches agent tools.
//
// A tool = {
//   name: 'namespace.verb',
//   description: 'one-liner for the LLM',
//   parameters: { type:'object', properties:{...}, required:[...] },  // OpenAI schema
//   handler: async (args, toolCtx, invCtx) => result,
//   sideEffect?: boolean,   // side-effecting tools can't parallel on the same spaceId
//   targetSpaceKey?: string // arg key that names a spaceId; default 'spaceId'
//   timeoutMs?: number      // overrides invCtx.toolTimeoutMs for this tool
// }
//
// list(pred?) returns tools in OpenAI /v1/chat/completions `tools` format,
// sorted by toolCatalog tier (stable within a tier); pred(name, tool) keeps
// only the tools it returns truthy for.
// validate(name, args) runs a minimal type/required check and returns
// { ok: boolean, errors?: string[] }.
// invoke runs a single tool with a timeout, racing invCtx.signal: an abort
// resolves { ok:false, error:'aborted' } without waiting for the handler.
// invokeParallel runs many calls concurrently, rejecting intra-spaceId
// conflicts among side-effecting tools with a structured
// {error: 'intra_tab_conflict'} result.

const { classify } = require('./permissions/toolCatalog');

const DEFAULT_TIMEOUT_MS = 15000;

function createRegistry() {
  const tools = new Map();

  function register(tool) {
    if (!tool || typeof tool.name !== 'string') throw new Error('tool.name required');
    if (typeof tool.handler !== 'function') throw new Error(`tool ${tool.name}: handler required`);
    tools.set(tool.name, {
      sideEffect: false,
      targetSpaceKey: 'spaceId',
      parameters: { type: 'object', properties: {}, required: [] },
      ...tool,
    });
  }

  function registerAll(list) { (list || []).forEach(register); }

  function unregister(name) { return tools.delete(name); }

  function has(name) { return tools.has(name); }
  function get(name) { return tools.get(name) || null; }

  function list(pred) {
    const keep = typeof pred === 'function' ? Array.from(tools.values()).filter((t) => pred(t.name, t)) : Array.from(tools.values());
    // Array.prototype.sort is stable, so registration order holds within a tier.
    return keep
      .map((t) => ({ t, tier: classify(t.name).tier }))
      .sort((a, b) => a.tier - b.tier)
      .map(({ t }) => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.parameters },
      }));
  }

  // Minimal schema validator: checks required + top-level property types.
  // Deliberately simple; tools that want strict validation can check args themselves.
  function validate(name, args) {
    const tool = tools.get(name);
    if (!tool) return { ok: false, errors: [`unknown_tool:${name}`] };
    const errs = [];
    const params = tool.parameters || {};
    const props = params.properties || {};
    const required = Array.isArray(params.required) ? params.required : [];
    const a = args || {};
    for (const r of required) {
      if (a[r] == null) errs.push(`missing:${r}`);
    }
    for (const [k, spec] of Object.entries(props)) {
      if (a[k] == null) continue;
      const want = spec && spec.type;
      if (!want) continue;
      const got = Array.isArray(a[k]) ? 'array' : typeof a[k];
      const matches = Array.isArray(want) ? want.includes(got) : want === got;
      if (!matches) errs.push(`type:${k}:${got}!=${Array.isArray(want) ? want.join('|') : want}`);
    }
    return errs.length ? { ok: false, errors: errs } : { ok: true };
  }

  async function invoke(name, args, toolCtx, invCtx) {
    const tool = tools.get(name);
    if (!tool) return { ok: false, error: `unknown_tool:${name}` };
    const check = validate(name, args);
    if (!check.ok) return { ok: false, error: 'invalid_args', details: check.errors };
    const timeoutMs = positive(tool.timeoutMs) || (invCtx && positive(invCtx.toolTimeoutMs)) || DEFAULT_TIMEOUT_MS;
    const signal = invCtx && invCtx.signal;
    if (signal && signal.aborted) return { ok: false, error: 'aborted' };
    return runWithTimeout(() => tool.handler(args || {}, toolCtx || {}, invCtx || {}), timeoutMs, signal);
  }

  // calls: [{ id, name, args }]
  // Returns array of { id, name, result } in the SAME order as input.
  async function invokeParallel(calls, toolCtx, invCtx) {
    const accepted = [];
    const rejected = [];
    groupAndRejectConflicts(calls, tools, accepted, rejected);
    const accRes = await Promise.all(accepted.map(async (c) => ({
      id: c.id, name: c.name,
      result: await invoke(c.name, c.args, toolCtx, { ...invCtx, callId: c.id }),
    })));
    const byId = new Map(accRes.map((r) => [r.id, r]));
    for (const r of rejected) byId.set(r.id, r);
    return calls.map((c) => byId.get(c.id) || { id: c.id, name: c.name, result: { ok: false, error: 'lost' } });
  }

  return { register, registerAll, unregister, has, get, list, validate, invoke, invokeParallel };
}

function positive(n) { return Number.isFinite(n) && n > 0 ? n : 0; }

// The handler is not cancelled by a timeout or an abort (handlers receive
// invCtx.signal and may honor it); its late result is discarded.
function runWithTimeout(fn, timeoutMs, signal) {
  return new Promise((resolve) => {
    let done;
    const finish = (value) => {
      if (done) return; done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish({ ok: false, error: 'aborted' });
    const timer = setTimeout(() => finish({ ok: false, error: 'tool_timeout', timeoutMs }), timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(fn).then((res) => {
      finish(res == null ? { ok: true } : res);
    }).catch((err) => {
      finish({ ok: false, error: err && err.message ? err.message : String(err) });
    });
  });
}

function groupAndRejectConflicts(calls, tools, accepted, rejected) {
  const seenSideEffectBySpace = new Map(); // spaceId -> first call id
  for (const call of calls || []) {
    const tool = tools.get(call.name);
    const sideEffect = tool && tool.sideEffect;
    const key = tool && tool.targetSpaceKey ? tool.targetSpaceKey : 'spaceId';
    const sid = call.args && call.args[key];
    if (sideEffect && sid) {
      const existing = seenSideEffectBySpace.get(sid);
      if (existing) {
        rejected.push({ id: call.id, name: call.name, result: { ok: false, error: 'intra_tab_conflict', conflict_with: existing, spaceId: sid } });
        continue;
      }
      seenSideEffectBySpace.set(sid, call.id);
    }
    accepted.push(call);
  }
}

module.exports = { createRegistry };
