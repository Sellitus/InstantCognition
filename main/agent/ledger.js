// ledger — structured plan ledger re-injected across turns (Magentic-One v2).
//
// Replaces the free-form "agent.set_plan" steps array with a stable JSON
// object the agent reads AND writes. Critical for long-horizon tasks: the
// agent doesn't have to re-derive context each turn, and the UI can render
// the ledger visually.
//
// Shape:
//   {
//     task: string,
//     facts_known: string[],
//     facts_to_verify: string[],
//     plan: Array<{ step: string, status: 'todo' | 'doing' | 'done' | 'blocked', note?: string }>,
//     progress: string,
//     blockers: string[],
//   }

function init(opts) {
  return {
    task: (opts && opts.task) || '',
    facts_known: [],
    facts_to_verify: [],
    plan: [],
    progress: '',
    blockers: [],
  };
}

function isArr(a) { return Array.isArray(a); }

function coerceStep(s) {
  if (typeof s === 'string') return { step: s, status: 'todo' };
  if (s && typeof s === 'object' && typeof s.step === 'string') {
    const status = ['todo', 'doing', 'done', 'blocked'].includes(s.status) ? s.status : 'todo';
    const out = { step: s.step, status };
    if (typeof s.note === 'string') out.note = s.note;
    return out;
  }
  return null;
}

// Accept a patch that may include any of:
//   - facts_known / facts_to_verify / blockers: string[] (replace) or {add,remove}
//   - plan: Array<{step,status?,note?}> (full replace) or { set:[], update:{index,...}, append:[], remove:[index] }
//   - progress: string
//   - steps: string[] (legacy from agent.set_plan tool — maps to plan with status=todo)
function patch(ledger, updates) {
  const out = { ...ledger };
  if (!updates || typeof updates !== 'object') return out;

  if (isArr(updates.facts_known)) out.facts_known = updates.facts_known.map(String);
  if (isArr(updates.facts_to_verify)) out.facts_to_verify = updates.facts_to_verify.map(String);
  if (isArr(updates.blockers)) out.blockers = updates.blockers.map(String);

  if (updates.facts_known_add) out.facts_known = [...out.facts_known, ...updates.facts_known_add.map(String)];
  if (updates.facts_to_verify_add) out.facts_to_verify = [...out.facts_to_verify, ...updates.facts_to_verify_add.map(String)];

  if (typeof updates.progress === 'string') out.progress = updates.progress;
  if (typeof updates.task === 'string') out.task = updates.task;

  if (isArr(updates.steps)) {
    out.plan = updates.steps.map((s) => coerceStep(s)).filter(Boolean);
  } else if (isArr(updates.plan)) {
    out.plan = updates.plan.map((s) => coerceStep(s)).filter(Boolean);
  } else if (updates.plan && typeof updates.plan === 'object') {
    let plan = [...out.plan];
    if (isArr(updates.plan.set)) plan = updates.plan.set.map(coerceStep).filter(Boolean);
    if (isArr(updates.plan.append)) plan = [...plan, ...updates.plan.append.map(coerceStep).filter(Boolean)];
    if (updates.plan.update && typeof updates.plan.update === 'object' && Number.isFinite(updates.plan.update.index)) {
      const i = updates.plan.update.index;
      if (i >= 0 && i < plan.length) {
        const merged = { ...plan[i], ...updates.plan.update };
        delete merged.index;
        const coerced = coerceStep(merged);
        if (coerced) plan[i] = coerced;
      }
    }
    if (Number.isFinite(updates.plan.remove) && updates.plan.remove >= 0 && updates.plan.remove < plan.length) {
      plan.splice(updates.plan.remove, 1);
    }
    out.plan = plan;
  }
  return out;
}

// Render as a compact block to inject in the system/user message each turn.
function render(ledger) {
  if (!ledger) return '';
  const lines = [];
  lines.push(`Ledger for task: ${ledger.task}`);
  if (ledger.progress) lines.push(`Progress: ${ledger.progress}`);
  if (ledger.facts_known.length) lines.push(`Facts known:\n  - ${ledger.facts_known.join('\n  - ')}`);
  if (ledger.facts_to_verify.length) lines.push(`Facts to verify:\n  - ${ledger.facts_to_verify.join('\n  - ')}`);
  if (ledger.plan.length) {
    const ps = ledger.plan.map((p, i) => {
      const mark = p.status === 'done' ? '[x]' : p.status === 'doing' ? '[~]' : p.status === 'blocked' ? '[!]' : '[ ]';
      return `  ${i + 1}. ${mark} ${p.step}${p.note ? ` — ${p.note}` : ''}`;
    });
    lines.push(`Plan:\n${ps.join('\n')}`);
  }
  if (ledger.blockers.length) lines.push(`Blockers: ${ledger.blockers.join('; ')}`);
  return lines.join('\n');
}

module.exports = { init, patch, render };
