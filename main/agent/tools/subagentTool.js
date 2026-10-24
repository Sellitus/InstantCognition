// subagentTool — agent.spawn_subagent: hand a self-contained sub-task to a
// child agent and get back only its summary.
//
// The child runs in its own session with a fresh context: it sees the task
// text and nothing of the parent's conversation. Its tool list is the
// parent's current list, narrowed further by `tools` when given — never
// widened; a Plan-mode parent gets a read-only child. Depth, concurrency and
// abort propagation live in sessionManager.spawnSubagent; this file only
// adapts the tool call to it.
//
// The session manager is built after the tool registry (it needs the
// foreground AgentService), so the tool resolves it at call time through
// bindSubagentManager().

/** @type {any} */
let boundManager = null;

/** Late-binds the process-wide session manager (assistantHandlers.attachSessionServices). */
function bindSubagentManager(manager) { boundManager = manager || null; }

// Longer than sessionManager's own subagent deadline, so the manager stops
// the child and reports subagent_timeout before the registry gives up on it.
const TOOL_TIMEOUT_MS = 21 * 60 * 1000;

const errText = (err) => (err instanceof Error && err.message) || String(err);

/** @param {{ getManager?: () => any }} [deps] */
function createSubagentTool(deps) {
  const getManager = deps && typeof deps.getManager === 'function' ? deps.getManager : () => boundManager;
  return {
    name: 'agent.spawn_subagent',
    description: 'Delegate a self-contained sub-task to a helper agent that starts with a blank context and returns only a short summary (max 4KB). '
      + 'Write `task` so it stands alone: include every URL, path, name and constraint the helper needs. '
      + 'Optional `tools` limits the helper to those tool names (it can never use a tool you lack); optional `maxSteps` bounds its effort.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete, standalone instructions for the helper.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool names the helper may use, e.g. ["browser.web_search","browser.read_tab"].' },
        maxSteps: { type: 'number', description: 'Step budget for the helper (default from settings).' },
      },
      required: ['task'],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    handler: async (args, toolCtx, invCtx) => {
      const manager = getManager();
      if (!manager || typeof manager.spawnSubagent !== 'function') return { ok: false, error: 'subagents_unavailable' };
      const ctx = toolCtx || {};
      const inv = invCtx || {};
      try {
        return await manager.spawnSubagent({
          task: args.task,
          tools: args.tools,
          maxSteps: args.maxSteps,
          parentSessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : null,
          parentMode: typeof ctx.permissionMode === 'string' ? ctx.permissionMode : null,
          parentFilter: typeof inv.toolFilter === 'function' ? inv.toolFilter : null,
          signal: inv.signal || null,
        });
      } catch (err) {
        return { ok: false, error: errText(err) };
      }
    },
  };
}

/**
 * Register agent.spawn_subagent on a tool registry.
 * @param {{ register: Function }} registry
 * @param {{ getManager?: () => any }} [deps]
 */
function registerSubagentTools(registry, deps) {
  registry.register(createSubagentTool(deps));
}

module.exports = { createSubagentTool, registerSubagentTools, bindSubagentManager, TOOL_TIMEOUT_MS };
