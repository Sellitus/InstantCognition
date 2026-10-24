// statusChips — pure mapping from run / engine state to the Assistant header
// chips and empty-state hero copy. No DOM, so every branch is unit-testable.

const RUN_STATUS_LABELS = {
  idle: 'Ready',
  running: 'Working…',
  done: 'Done',
  error: 'Error',
};

function runStatusLabel(status) {
  return RUN_STATUS_LABELS[status] || 'Ready';
}

function modelName(path) {
  if (!path || typeof path !== 'string') return '';
  return path.split(/[\\/]/).pop().replace(/\.gguf$/i, '');
}

/**
 * @param {{status?: string, backend?: string|null, model?: string|null, isRemote?: boolean, lastError?: string|null}|null} s
 * @returns {{tone: 'ok'|'busy'|'off'|'error', label: string, title: string, ready: boolean}}
 */
function engineChipState(s) {
  const st = (s && s.status) || 'unknown';
  const name = modelName(s && s.model);
  if (s && s.isRemote) {
    return { tone: 'ok', label: name || 'Remote model', title: 'Using a remote endpoint. Manage it in Settings → LLM.', ready: true };
  }
  if (st === 'running') {
    const label = name || (s && s.backend) || 'Local model';
    return { tone: 'ok', label, title: `${label} is running. Manage models in Settings → LLM.`, ready: true };
  }
  if (st === 'unknown') return { tone: 'busy', label: 'Checking model…', title: 'Checking the model status.', ready: false };
  if (st === 'starting') return { tone: 'busy', label: 'Starting…', title: 'The local model is starting.', ready: false };
  if (st === 'stopping') return { tone: 'busy', label: 'Stopping…', title: 'The local model is stopping.', ready: false };
  if (st === 'error') {
    const detail = s && s.lastError ? `: ${s.lastError}` : '';
    return { tone: 'error', label: 'Model error', title: `The model failed${detail}. Open Settings → LLM.`, ready: false };
  }
  return { tone: 'off', label: 'Set up a model', title: 'No model is running. Open Settings → LLM to start or connect one.', ready: false };
}

module.exports = { RUN_STATUS_LABELS, runStatusLabel, engineChipState, modelName };
