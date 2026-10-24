// ToolCallGroup — one agent turn's tool calls inside the chat thread. Wraps
// ToolStream so persisted turns (tool_calls / tool_results session nodes) and
// a live background run render exactly like the foreground agent's stream.

const ToolStream = require('../agent/ToolStream');

// Persisted tool results carry the runtime's result object as JSON; a result
// that is not JSON is shown verbatim, and unreadable JSON is shown as a failure.
function parseResult(content) {
  if (content && typeof content === 'object') return content;
  const text = String(content === undefined || content === null ? '' : content);
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return { ok: true, preview: text };
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : { ok: true, preview: text };
  } catch (err) {
    return { ok: false, error: `Unreadable tool result: ${(err instanceof Error && err.message) || String(err)}` };
  }
}

class ToolCallGroup {
  /** @param {{ root: HTMLElement }} opts */
  constructor(opts) {
    if (!opts || !opts.root) throw new TypeError('ToolCallGroup expects a root element');
    this.stream = new ToolStream({ root: opts.root });
    this.el = this.stream._el;
    this._nextStep = 0;
    /** @type {Map<number, any[]>} */ this._calls = new Map();
  }

  /** A persisted assistant tool_calls node. */
  addCallsNode(n) {
    const calls = (n && n.data && Array.isArray(n.data.calls)) ? n.data.calls : [];
    this.planned({ step: this._nextStep, calls });
    this._nextStep += 1;
  }

  /** A persisted tool_results node answers the most recent calls. */
  addResultsNode(n) {
    const step = Math.max(0, this._nextStep - 1);
    const results = (n && n.data && Array.isArray(n.data.results)) ? n.data.results : [];
    this.acted({
      step,
      calls: null,
      results: results.map((r) => ({ id: r && r.id, name: r && r.name, result: parseResult(r && r.content) })),
      latencyMs: undefined,
    });
  }

  /** @param {{ step: any, calls: any[] }} p */
  planned({ step, calls }) {
    const s = Number(step) || 0;
    const list = Array.isArray(calls) ? calls : [];
    this._calls.set(s, list);
    this._nextStep = Math.max(this._nextStep, s + 1);
    this.stream.addStepPlanned({ step: s, calls: list });
  }

  /** @param {{ step: any, calls?: any[]|null, results?: any[], latencyMs?: number }} p */
  acted({ step, calls, results, latencyMs }) {
    const s = Number(step) || 0;
    this.stream.setStepResults({
      step: s,
      calls: Array.isArray(calls) ? calls : (this._calls.get(s) || null),
      results: Array.isArray(results) ? results : [],
      latencyMs,
    });
  }

  /** @param {boolean} ok */
  finish(ok) {
    this.stream.markAllFinished();
    this.stream.setOverallStatus(ok ? 'ok' : 'failed');
    this.stream.collapse();
  }
}

module.exports = { ToolCallGroup, parseResult };
