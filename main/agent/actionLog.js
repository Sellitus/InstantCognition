// actionLog — append-only JSONL writer for per-task agent runs.
//
// Every observe/plan/act turn and every tool invocation is recorded so users
// can audit what the agent did, replay a run, or fork from step N (future).
// Logs live in {userData}/agent-runs/<task-id>.jsonl (one file per task).
//
// Writes are best-effort: a disk-full / read-only FS never propagates up and
// stops the agent. We also fail loud into the console for diagnostic signal.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { errMsg } = require('../../shared/errMsg');

const DEFAULT_PREVIEW_BYTES = 1024;

function truncate(s, max) {
  const limit = max || DEFAULT_PREVIEW_BYTES;
  if (s == null) return '';
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length <= limit ? str : str.slice(0, limit) + `…[truncated ${str.length - limit}]`;
}

function safeStringify(obj) {
  try { return JSON.stringify(obj); }
  catch (_) { return JSON.stringify({ _unserializable: true }); }
}

class ActionLogWriter {
  constructor({ taskId, baseDir }) {
    this._taskId = taskId || `task_${Date.now()}`;
    this._baseDir = baseDir || path.join(os.tmpdir(), 'instantcognition-agent-runs');
    this._file = path.join(this._baseDir, `${this._taskId}.jsonl`);
    this._metaFile = path.join(this._baseDir, `${this._taskId}.meta.json`);
    this._tokensUsed = 0;
    this._started = Date.now();
    this._steps = 0;
    this._navigations = 0;
    this._closed = false;
    try { fs.mkdirSync(this._baseDir, { recursive: true }); } catch (err) { console.error('actionLog mkdir failed:', errMsg(err)); }
  }

  get filePath() { return this._file; }
  get tokensUsed() { return this._tokensUsed; }
  get elapsedMs() { return Date.now() - this._started; }
  get stepsCompleted() { return this._steps; }
  get navigations() { return this._navigations; }

  writeRaw(entry) {
    if (this._closed) return;
    try { fs.appendFileSync(this._file, safeStringify(entry) + '\n'); }
    catch (err) { console.error('actionLog write failed:', errMsg(err)); }
  }

  logTaskStart({ description, mode, budget, webContentsId, scope, tabId, persona, routerSource }) {
    const title = deriveTitle(description);
    const normScope = scope === 'tab' ? 'tab' : 'global';
    const normTabId = normScope === 'tab' && tabId ? String(tabId) : null;
    this.writeRaw({
      ts: Date.now(), taskId: this._taskId, kind: 'task-start',
      description, title, mode: mode && mode.name, budget, webContentsId,
      scope: normScope, tabId: normTabId, persona, routerSource,
    });
    // Seed sidecar meta with an auto-derived title so history listings have a
    // label even while the run is still in progress. Never overwrite an
    // existing meta (user-edited rename must win). scope/tabId go in the
    // sidecar so AgentHistoryService.list can filter without parsing JSONL.
    try {
      if (!fs.existsSync(this._metaFile)) {
        fs.writeFileSync(this._metaFile, JSON.stringify({
          title, pinned: false, createdAt: Date.now(),
          scope: normScope, tabId: normTabId,
        }));
      }
    } catch (err) { console.error('actionLog meta seed failed:', errMsg(err)); }
  }

  logResponseBegin({ summary }) {
    this.writeRaw({ ts: Date.now(), kind: 'response-begin', summary: summary || '' });
  }

  logStep({ step, url, toolCalls, results, latencyMs, tokens }) {
    this._steps = Math.max(this._steps, (step || 0) + 1);
    if (Number.isFinite(tokens)) this._tokensUsed += tokens;
    // Count navigations for budget enforcement.
    if (Array.isArray(toolCalls)) {
      for (const c of toolCalls) {
        if (c && (c.name === 'browser.navigate' || c.name === 'browser.open_tab')) this._navigations += 1;
      }
    }
    this.writeRaw({
      ts: Date.now(), kind: 'step', step, url,
      tools: (toolCalls || []).map((c) => ({ id: c.id, name: c.name, args: c.args })),
      results: (results || []).map((r) => ({
        id: r.id, name: r.name,
        ok: !!(r.result && r.result.ok !== false),
        preview: truncate(r.result, 512),
      })),
      latencyMs: latencyMs || null,
      tokens: Number.isFinite(tokens) ? tokens : null,
    });
  }

  logApproval({ call, decision, actionClass, origin, reason }) {
    this.writeRaw({
      ts: Date.now(), kind: 'approval',
      tool: call && call.name, class: actionClass, origin, decision, reason: reason || null,
    });
  }

  logBudget({ reason, usage, budget }) {
    this.writeRaw({ ts: Date.now(), kind: 'budget-breach', reason, usage, budget });
  }

  /** @param {{ ok?: boolean, summary?: string, reason?: string }} outcome */
  logTaskEnd({ ok, summary, reason }) {
    this.writeRaw({
      ts: Date.now(), kind: 'task-end',
      ok: !!ok, summary: summary || '', summary_markdown: summary || '',
      reason: reason || null,
      tokensUsed: this._tokensUsed, elapsedMs: this.elapsedMs,
      steps: this._steps, navigations: this._navigations,
    });
    this._closed = true;
  }
}

// First-80-char, single-line title from the task description. Used for
// auto-seeding the sidecar meta file so history rows have a label.
function deriveTitle(description) {
  const s = String(description || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Untitled task';
  return s.length <= 80 ? s : s.slice(0, 77) + '…';
}

function createWriter(opts) { return new ActionLogWriter(opts || {}); }

module.exports = { createWriter, ActionLogWriter, deriveTitle };
