// Plan-mode tools.
//
// agent.todo_write — full replace of the run's todo list (the ledger plan).
//   At most one item may be in_progress, so the list always names the single
//   step being worked on. Statuses map onto the ledger's vocabulary:
//   pending → todo, in_progress → doing, completed → done.
// agent.exit_plan — ends a Plan-mode run with the proposed plan. The runtime
//   stops on `awaiting: 'plan_approval'`; the session layer holds the plan
//   until the user approves, edits or rejects it (session:plan-decision).

const ledgerModule = require('../ledger');

const STATUS_MAP = Object.freeze({ pending: 'todo', in_progress: 'doing', completed: 'done' });
const MAX_PLAN_ITEMS = 50;
const MAX_TEXT = 500;

/**
 * Validates a todo list. Returns { todos } or { error }.
 * @param {any} raw
 */
function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return { error: 'todos must be an array' };
  if (raw.length > MAX_PLAN_ITEMS) return { error: `at most ${MAX_PLAN_ITEMS} todos` };
  const todos = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!t || typeof t !== 'object') return { error: `todos[${i}] must be an object` };
    const content = typeof t.content === 'string' ? t.content.trim() : '';
    if (!content) return { error: `todos[${i}].content is required` };
    if (!Object.prototype.hasOwnProperty.call(STATUS_MAP, t.status)) return { error: `todos[${i}].status must be pending, in_progress or completed` };
    const item = { content: content.slice(0, MAX_TEXT), status: t.status };
    if (typeof t.activeForm === 'string' && t.activeForm.trim()) item.activeForm = t.activeForm.trim().slice(0, MAX_TEXT);
    todos.push(item);
  }
  if (todos.filter((t) => t.status === 'in_progress').length > 1) return { error: 'only one todo may be in_progress' };
  return { todos };
}

const toLedgerPlan = (todos) => todos.map((t) => ({ step: t.content, status: STATUS_MAP[t.status] }));

const todoWrite = {
  name: 'agent.todo_write',
  description: 'Replace the task todo list. Pass the FULL list every call: todos = [{content, status: pending|in_progress|completed, activeForm?}]. Keep exactly one item in_progress while working; mark items completed as soon as they are done.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  handler: async (args, toolCtx, invCtx) => {
    const { todos, error } = normalizeTodos(args && args.todos);
    if (error) return { ok: false, error };
    const plan = toLedgerPlan(todos);
    if (toolCtx && toolCtx.ledger) Object.assign(toolCtx.ledger, ledgerModule.patch(toolCtx.ledger, { plan }));
    if (toolCtx) toolCtx.todos = todos;
    if (invCtx && typeof invCtx.emit === 'function') invCtx.emit('plan-updated', { plan, todos });
    return { ok: true, count: todos.length };
  },
};

const exitPlan = {
  name: 'agent.exit_plan',
  description: 'Plan mode only: finish research and propose the plan for the user to approve. summary = what you will do and why; todos = the steps (same shape as agent.todo_write). Execution tools unlock only after the user approves.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      todos: { type: 'array', items: { type: 'object' } },
    },
    required: ['summary'],
  },
  handler: async (args, toolCtx) => {
    if (!toolCtx || toolCtx.permissionMode !== 'plan') return { ok: false, error: 'not_in_plan_mode' };
    const summary = typeof (args && args.summary) === 'string' ? args.summary.trim().slice(0, 8000) : '';
    if (!summary) return { ok: false, error: 'summary is required' };
    const raw = args && args.todos !== undefined ? args.todos : (toolCtx.todos || []);
    const { todos, error } = normalizeTodos(raw);
    if (error) return { ok: false, error };
    if (toolCtx.ledger) Object.assign(toolCtx.ledger, ledgerModule.patch(toolCtx.ledger, { plan: toLedgerPlan(todos) }));
    return { ok: true, awaiting: 'plan_approval', plan: { summary, todos } };
  },
};

/** Validates a plan supplied with an 'edit' decision. Returns { plan } or { error }. */
function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'plan must be an object' };
  const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 8000) : '';
  if (!summary) return { error: 'plan.summary is required' };
  const { todos, error } = normalizeTodos(raw.todos === undefined ? [] : raw.todos);
  if (error) return { error };
  return { plan: { summary, todos } };
}

module.exports = [todoWrite, exitPlan];
module.exports.normalizeTodos = normalizeTodos;
module.exports.normalizePlan = normalizePlan;
module.exports.STATUS_MAP = STATUS_MAP;
