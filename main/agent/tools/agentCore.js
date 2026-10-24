// Core agent control tools: done, ask_user, set_plan, update_ledger.
//
// `done` terminates the loop with a summary returned to the caller.
// `ask_user` pauses the loop until the user responds.
// `set_plan` takes a legacy steps array and maps it to the structured plan
//   ledger (for backward compatibility with older prompts).
// `update_ledger` is the preferred patch API — write/add facts, update plan
//   step status, set progress. The ledger is re-injected at every turn.

const DONE_MIN_LEN = 20;
const DONE_MAX_SHORT_RETRIES = 2;

const done = {
  name: 'agent.done',
  description: 'Finish the task and return a summary to the user. The summary MUST directly answer the task in the user\'s words — include the actual findings (list items, comparisons, extracted values), not just "task completed". If you have not yet read the page(s) needed to answer, read them first. Called exactly once per task.',
  parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  handler: async (args, toolCtx, invCtx) => {
    const summary = String((args && args.summary) || '').trim();
    const ctx = toolCtx || {};
    const attempts = Number(ctx._doneShortAttempts) || 0;
    if (summary.length < DONE_MIN_LEN && attempts < DONE_MAX_SHORT_RETRIES) {
      ctx._doneShortAttempts = attempts + 1;
      const taskHint = invCtx && invCtx.taskDescription
        ? ` The user asked: "${String(invCtx.taskDescription).slice(0, 200)}". Answer THAT question with concrete content.`
        : '';
      const elaborate = attempts >= 1
        ? ' This is your final retry — write at least 2 sentences with specific details from what you read.'
        : '';
      return {
        ok: false,
        error: 'summary_too_short',
        hint: 'Provide the actual answer to the task, not a status message. Read the page(s) you navigated to, then call agent.done with the findings.' + taskHint + elaborate,
      };
    }
    // After DONE_MAX_SHORT_RETRIES short attempts we accept whatever the model produced —
    // returning something to the user beats burning the rest of the step budget on a
    // model that can't pad its summary. The result is still ok=true so the runtime exits.
    return { ok: true, summary, shortAcceptedAfterRetries: summary.length < DONE_MIN_LEN };
  },
};

const askUser = {
  name: 'agent.ask_user',
  description: 'Pause and ask the user a clarifying question. Use sparingly — only when the task cannot proceed without input.',
  parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  handler: async (args) => ({ ok: true, awaitingUser: true, question: String(args.question || '') }),
};

const ledgerModule = require('../ledger');

const setPlan = {
  name: 'agent.set_plan',
  description: 'Record or replace the multi-step plan (steps = array of strings). Writes into the structured ledger.',
  parameters: { type: 'object', properties: { steps: { type: 'array' } }, required: ['steps'] },
  handler: async (args, toolCtx, invCtx) => {
    const steps = Array.isArray(args.steps) ? args.steps.map(String) : [];
    if (toolCtx && toolCtx.ledger) {
      const next = ledgerModule.patch(toolCtx.ledger, { steps });
      // Mutate in place so all later turns see the update (toolCtx.ledger is
      // the same object referenced by AgentService._ledgerState).
      Object.assign(toolCtx.ledger, next);
    }
    if (invCtx && typeof invCtx.emit === 'function') invCtx.emit('plan-updated', { steps });
    return { ok: true, steps };
  },
};

const updateLedger = {
  name: 'agent.update_ledger',
  description: 'Patch the plan ledger. Pass any of: progress (string), facts_known (string[]), facts_to_verify (string[]), blockers (string[]), plan (array or {set, append, update:{index,status?,note?}, remove:index}), facts_known_add (string[]), facts_to_verify_add (string[]). The ledger is re-injected to you each turn so you never need to repeat known facts.',
  parameters: {
    type: 'object',
    properties: {
      progress: { type: 'string' },
      facts_known: { type: 'array' },
      facts_to_verify: { type: 'array' },
      blockers: { type: 'array' },
      facts_known_add: { type: 'array' },
      facts_to_verify_add: { type: 'array' },
      plan: { type: ['array', 'object'] },
      steps: { type: 'array' },
    },
    required: [],
  },
  handler: async (args, toolCtx, invCtx) => {
    if (!toolCtx || !toolCtx.ledger) return { ok: false, error: 'no_ledger' };
    const next = ledgerModule.patch(toolCtx.ledger, args || {});
    Object.assign(toolCtx.ledger, next);
    if (invCtx && typeof invCtx.emit === 'function') invCtx.emit('plan-updated', { ledger: { ...toolCtx.ledger } });
    return { ok: true, ledger: toolCtx.ledger };
  },
};

module.exports = [done, askUser, setPlan, updateLedger];
