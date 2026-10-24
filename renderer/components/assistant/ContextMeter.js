// ContextMeter — the composer's context-window ring. Fills with the share of
// the model's context the session's next turn would use; warns at 80% and
// turns red at 95%. Clicking it (or sending `/compact`) asks the main process
// to summarize the session into a compaction node (session:compact).
//
// Usage arrives three ways: agent:tokens during a foreground run, session:event
// 'agent-tokens' during a background run, and session:context-usage on demand
// (after a session change or a compaction). The ring follows one session; a
// run that starts in this panel's scope adopts its session.

const toast = require('../Toast');
const { errMsg } = require('../../../shared/errMsg');

const WARN_RATIO = 0.8;
const DANGER_RATIO = 0.95;
const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** @param {number|null} ratio @returns {'unknown'|'ok'|'warn'|'danger'} */
function levelFor(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return 'unknown';
  if (ratio >= DANGER_RATIO) return 'danger';
  if (ratio >= WARN_RATIO) return 'warn';
  return 'ok';
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

/** @param {string} tag @param {Record<string, string>} attrs */
function svg(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

class ContextMeter {
  /**
   * @param {{
   *   ipc?: { invoke: Function, on: Function, removeListener: Function },
   *   onError?: (message: string) => void,
   *   scopeMatches?: (payload: any) => boolean,
   * }} [opts]
   *   scopeMatches: whether a foreground agent:* event belongs to this panel.
   */
  constructor(opts = {}) {
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    this._onError = typeof opts.onError === 'function' ? opts.onError : (m) => toast.error(m);
    this._scopeMatches = typeof opts.scopeMatches === 'function' ? opts.scopeMatches : () => true;
    /** @type {string|null} */
    this._sessionId = null;
    this._tokens = 0;
    this._contextSize = 0;
    this._busy = false;
    this._seq = 0;

    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'context-meter';
    const ring = svg('svg', { class: 'context-meter__ring', viewBox: '0 0 18 18', width: '18', height: '18', 'aria-hidden': 'true', focusable: 'false' });
    ring.appendChild(svg('circle', { class: 'context-meter__track', cx: '9', cy: '9', r: String(RING_RADIUS) }));
    this._arc = svg('circle', {
      class: 'context-meter__arc', cx: '9', cy: '9', r: String(RING_RADIUS),
      'stroke-dasharray': `${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`, 'stroke-dashoffset': String(RING_CIRCUMFERENCE),
      transform: 'rotate(-90 9 9)',
    });
    ring.appendChild(this._arc);
    this.el.appendChild(ring);
    this.el.addEventListener('click', () => { this.compact(); });

    this._onTokens = (_e, p) => {
      if (!p || typeof p !== 'object' || !this._scopeMatches(p)) return;
      if (typeof p.sessionId === 'string' && p.sessionId) {
        if (!this._sessionId) this._sessionId = p.sessionId;
        else if (p.sessionId !== this._sessionId) return;
      }
      this._ingestTokens(p);
    };
    this._onTaskStarted = (_e, p) => {
      if (p && typeof p.sessionId === 'string' && p.sessionId && this._scopeMatches(p)) this.setSessionId(p.sessionId);
    };
    this._onCompacted = (_e, p) => {
      if (p && typeof p.sessionId === 'string' && p.sessionId !== this._sessionId) return;
      this.refresh();
    };
    this._onSessionEvent = (_e, ev) => {
      if (!ev || ev.sessionId !== this._sessionId || !this._sessionId) return;
      if (ev.channel === 'agent-tokens') this._ingestTokens(ev.payload);
      else if (ev.channel === 'compacted' || ev.channel === 'agent-compacted') this.refresh();
    };
    this._ipc.on('agent:tokens', this._onTokens);
    this._ipc.on('agent:task-started', this._onTaskStarted);
    this._ipc.on('agent:compacted', this._onCompacted);
    this._ipc.on('session:event', this._onSessionEvent);
    this._render();
  }

  get sessionId() { return this._sessionId; }

  /** @param {string|null} sessionId */
  setSessionId(sessionId) {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : null;
    if (id === this._sessionId) return Promise.resolve();
    this._sessionId = id;
    this._tokens = 0;
    this._contextSize = 0;
    this._render();
    return id ? this.refresh() : Promise.resolve();
  }

  /** @param {{ tokens?: number, contextSize?: number }} usage */
  update(usage) {
    const tokens = Number(usage && usage.tokens);
    const size = Number(usage && usage.contextSize);
    if (Number.isFinite(tokens) && tokens >= 0) this._tokens = tokens;
    if (Number.isFinite(size) && size >= 0) this._contextSize = size;
    this._render();
  }

  // agent-tokens: contextTokens is the latest prompt size, i.e. what the next
  // request re-sends. tokensUsed is cumulative spend across steps and would
  // overstate the window, so it is never shown; contextTokens 0 means the
  // server reported no usage and the last known size stays.
  _ingestTokens(p) {
    if (!p || typeof p !== 'object') return;
    const tokens = Number.isFinite(p.contextTokens) && p.contextTokens > 0 ? p.contextTokens : undefined;
    this.update({ tokens, contextSize: p.contextSize });
  }

  ratio() { return this._contextSize > 0 ? this._tokens / this._contextSize : null; }

  level() { return levelFor(this.ratio()); }

  /** Re-reads the session's usage from the main process. */
  refresh() {
    const sessionId = this._sessionId;
    if (!sessionId) return Promise.resolve();
    const seq = ++this._seq;
    return Promise.resolve()
      .then(() => this._ipc.invoke('session:context-usage', { sessionId }))
      .then((res) => {
        if (seq !== this._seq || sessionId !== this._sessionId) return;
        if (!res || res.ok === false) throw new Error((res && res.error) || 'context_usage_unavailable');
        this.update(res);
      })
      .catch((err) => {
        if (seq !== this._seq || sessionId !== this._sessionId) return;
        this._onError(`Couldn’t read the context size: ${errMsg(err)}`);
      });
  }

  /** Summarizes the session (session:compact). Resolves true when it compacted. */
  compact() {
    const sessionId = this._sessionId;
    if (!sessionId) {
      this._onError('Nothing to compact yet — start a conversation first.');
      return Promise.resolve(false);
    }
    if (this._busy) return Promise.resolve(false);
    this._busy = true;
    this._render();
    return Promise.resolve()
      .then(() => this._ipc.invoke('session:compact', { sessionId }))
      .then((res) => {
        if (!res || res.ok === false) throw new Error((res && res.error) || 'compact_failed');
        toast.success(`Compacted ${Number(res.coveredMessages) || 0} messages into a summary.`);
        return this.refresh().then(() => true);
      })
      .catch((err) => {
        this._onError(`Couldn’t compact the conversation: ${errMsg(err)}`);
        return false;
      })
      .finally(() => { this._busy = false; this._render(); });
  }

  _render() {
    const ratio = this.ratio();
    const level = levelFor(ratio);
    const fill = ratio === null ? 0 : Math.min(1, Math.max(0, ratio));
    this._arc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - fill)));
    this.el.dataset.level = level;
    this.el.setAttribute('aria-busy', this._busy ? 'true' : 'false');
    const usage = ratio === null
      ? 'Context usage unknown'
      : `${fmt(this._tokens)} / ${fmt(this._contextSize)} tokens (${Math.round(ratio * 100)}%)`;
    const action = this._busy ? 'Compacting…' : 'Click to compact the conversation';
    this.el.title = `${usage}. ${action}`;
    this.el.setAttribute('aria-label', `Context window: ${usage}. ${action}`);
  }

  destroy() {
    this._seq++;
    this._ipc.removeListener('agent:tokens', this._onTokens);
    this._ipc.removeListener('agent:task-started', this._onTaskStarted);
    this._ipc.removeListener('agent:compacted', this._onCompacted);
    this._ipc.removeListener('session:event', this._onSessionEvent);
    this.el.remove();
  }
}

module.exports = ContextMeter;
module.exports.levelFor = levelFor;
module.exports.WARN_RATIO = WARN_RATIO;
module.exports.DANGER_RATIO = DANGER_RATIO;
