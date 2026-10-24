// ToolStream — ONE collapsible per task that holds every tool call from
// every step. Replaces the old per-step collapsibles so the conversation
// reads as "user prompt → [▾ tool use] → answer" instead of a ladder of
// individual toggles. The body scrolls internally when expanded so a long
// run never pushes the composer off-screen.

const { formatCall, formatCallResult, formatDuration, escapeHtml } = require('./format');

class ToolStream {
  constructor({ root }) {
    this._root = root;
    this._stepsById = new Map();
    this._collapsed = false;
    // Overall task status — null during the run, 'ok' or 'failed' once the
    // task ends. The header only flags the whole stream as failed when the
    // TASK failed; transient tool-call failures the agent recovered from
    // are counted as "had errors" but never brand the whole conversation.
    this._overallStatus = null;
    this._el = this._build();
    root.appendChild(this._el);
    this._renderHeader();
  }

  _build() {
    const li = document.createElement('li');
    li.className = 'agent-tool-stream is-running';
    li.innerHTML = ''
      + '<button type="button" class="agent-tool-stream-header" aria-expanded="true">'
      + '  <span class="agent-tool-stream-caret" aria-hidden="true">▾</span>'
      + '  <span class="agent-tool-stream-label">Tool use</span>'
      + '  <span class="agent-tool-stream-meta"></span>'
      + '</button>'
      + '<div class="agent-tool-stream-body">'
      + '  <ul class="agent-tool-stream-steps"></ul>'
      + '</div>';
    this._header = li.querySelector('.agent-tool-stream-header');
    this._meta = li.querySelector('.agent-tool-stream-meta');
    this._stepsEl = li.querySelector('.agent-tool-stream-steps');
    this._bodyEl = li.querySelector('.agent-tool-stream-body');
    this._header.addEventListener('click', () => this.toggle());

    // Tail-follow inside the body: max-height + overflow-y:auto makes this
    // an inner scroll viewport, so the OUTER transcript's MutationObserver
    // can't keep the latest tool call visible — we have to scroll the body
    // ourselves whenever new content appears, while still respecting a user
    // who has scrolled up to read earlier steps.
    this._followBottom = true;
    this._autoScrolling = false;
    if (this._bodyEl) {
      this._bodyEl.addEventListener('scroll', () => {
        if (this._autoScrolling) return;
        const el = this._bodyEl;
        this._followBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) <= 24;
      }, { passive: true });
      if (typeof MutationObserver !== 'undefined') {
        this._observer = new MutationObserver(() => this._scrollBodyToBottom());
        this._observer.observe(this._bodyEl, { childList: true, subtree: true, characterData: true });
      }
    }
    return li;
  }

  _scrollBodyToBottom() {
    if (!this._followBottom || this._collapsed || !this._bodyEl) return;
    const el = this._bodyEl;
    this._autoScrolling = true;
    el.scrollTop = el.scrollHeight;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { this._autoScrolling = false; });
    } else {
      setTimeout(() => { this._autoScrolling = false; }, 0);
    }
  }

  addStepPlanned({ step, calls }) {
    const group = this._ensureStep(step);
    group.calls = Array.isArray(calls) ? calls.slice() : [];
    group.results = [];
    group.running = true;
    group.latencyMs = null;
    this._renderStep(group);
    this._renderHeader();
  }

  setStepResults({ step, calls, results, latencyMs }) {
    const group = this._ensureStep(step);
    if (Array.isArray(calls)) group.calls = calls.slice();
    group.results = Array.isArray(results) ? results.slice() : [];
    if (Number.isFinite(latencyMs)) group.latencyMs = latencyMs;
    group.running = false;
    this._renderStep(group);
    this._renderHeader();
  }

  // Renders steps where the LLM emitted prose/reasoning instead of a tool call
  // and was asked to retry. Without this row the step number jumps in the
  // transcript (e.g. "Step 2 → Step 6") and the user can't tell what happened.
  addParseRetry({ step, contentPreview }) {
    const group = this._ensureStep(step);
    group.calls = [];
    group.results = [];
    group.running = false;
    group.parseRetry = true;
    group.parseRetryPreview = String(contentPreview || '').trim();
    this._renderStep(group);
    this._renderHeader();
  }

  markAllFinished() {
    for (const g of this._stepsById.values()) g.running = false;
    this._renderHeader();
  }

  // Called from AgentPanel on agent:task-completed / agent:task-failed so the
  // header reflects the OVERALL task outcome — not just the OR of every
  // intermediate tool call. status: 'ok' | 'failed'. Anything else is treated
  // as null (no overall status yet).
  setOverallStatus(status) {
    this._overallStatus = (status === 'ok' || status === 'failed') ? status : null;
    this._renderHeader();
  }

  _ensureStep(step) {
    let g = this._stepsById.get(step);
    if (g) return g;
    const el = document.createElement('li');
    el.className = 'agent-tool-stream-step';
    el.innerHTML = ''
      + '<div class="agent-tool-stream-step-head">'
      + `  <span class="agent-tool-stream-step-num">Step ${step + 1}</span>`
      + '  <span class="agent-tool-stream-step-meta"></span>'
      + '</div>'
      + '<ul class="agent-tool-stream-calls"></ul>';
    g = { step, el, calls: [], results: [], running: true, latencyMs: null };
    this._stepsById.set(step, g);
    this._stepsEl.appendChild(el);
    return g;
  }

  _renderStep(group) {
    const ok = group.results.filter((r) => r && r.result && r.result.ok !== false).length;
    const fail = group.results.length - ok;
    const parts = [];
    if (group.parseRetry) parts.push('no tool call · asked to retry');
    if (group.calls.length) parts.push(`${group.calls.length} call${group.calls.length === 1 ? '' : 's'}`);
    if (group.results.length) parts.push(fail ? `${ok} ok · ${fail} err` : `${ok} ok`);
    else if (group.running) parts.push('running…');
    if (group.latencyMs) parts.push(formatDuration(group.latencyMs));
    group.el.querySelector('.agent-tool-stream-step-meta').textContent = parts.join(' · ');
    group.el.classList.toggle('is-running', !!group.running);
    group.el.classList.toggle('has-failure', fail > 0);
    group.el.classList.toggle('is-parse-retry', !!group.parseRetry);
    const callsEl = group.el.querySelector('.agent-tool-stream-calls');
    callsEl.innerHTML = '';
    if (group.parseRetry) {
      const li = document.createElement('li');
      li.className = 'agent-tool-stream-call is-parse-retry';
      const preview = group.parseRetryPreview ? `: "${group.parseRetryPreview.slice(0, 140)}${group.parseRetryPreview.length > 140 ? '…' : ''}"` : '';
      li.innerHTML = `<span class="agent-tool-stream-call-main">model emitted reasoning instead of a tool call${escapeHtml(preview)}</span>`;
      callsEl.appendChild(li);
    }
    for (let i = 0; i < group.calls.length; i++) {
      const call = group.calls[i];
      const res = group.results[i] && group.results[i].result;
      const isOk = res ? res.ok !== false : null;
      const li = document.createElement('li');
      li.className = 'agent-tool-stream-call' + (isOk === false ? ' is-err' : (isOk === true ? ' is-ok' : ' is-pending'));
      const callText = formatCall(call);
      const resultText = res ? formatCallResult(call, res) : '';
      li.innerHTML = `<span class="agent-tool-stream-call-main">${escapeHtml(callText)}</span>`
        + (resultText ? `<span class="agent-tool-stream-call-result">${escapeHtml(resultText)}</span>` : '');
      callsEl.appendChild(li);
    }
  }

  _renderHeader() {
    const groups = [...this._stepsById.values()];
    const totalCalls = groups.reduce((n, g) => n + g.calls.length, 0);
    const totalLatency = groups.reduce((n, g) => n + (g.latencyMs || 0), 0);
    const stepsWithFailures = groups.filter((g) => g.results.some((r) => r && r.result && r.result.ok === false)).length;
    const running = groups.some((g) => g.running);
    const parts = [];
    parts.push(`${totalCalls} call${totalCalls === 1 ? '' : 's'}`);
    if (groups.length) parts.push(`${groups.length} step${groups.length === 1 ? '' : 's'}`);
    if (totalLatency) parts.push(formatDuration(totalLatency));
    if (running) parts.push('running…');
    if (this._overallStatus === 'failed') {
      // Only when the TASK ended in failure — not when transient tool calls
      // failed but the agent recovered and called agent.done.
      parts.push('failed');
    } else if (stepsWithFailures > 0) {
      // Recovered case (or still mid-run): surface that some calls failed
      // without branding the whole run. Coexists with "running…" so users
      // see live failure counts as they accumulate.
      parts.push(`${stepsWithFailures} step${stepsWithFailures === 1 ? '' : 's'} with errors`);
    }
    this._meta.textContent = parts.join(' · ');
    this._el.classList.toggle('is-running', running);
    // Stream-level red flag is reserved for actual task failure. Per-step and
    // per-call .has-failure / .is-err classes still highlight individual
    // failed calls in the body.
    this._el.classList.toggle('has-failure', this._overallStatus === 'failed');
  }

  collapse() { this._collapsed = true; this._el.classList.add('is-collapsed'); this._header.setAttribute('aria-expanded', 'false'); }
  expand()   { this._collapsed = false; this._el.classList.remove('is-collapsed'); this._header.setAttribute('aria-expanded', 'true'); this._scrollBodyToBottom(); }
  toggle()   { if (this._collapsed) this.expand(); else this.collapse(); }

  // Public: jump straight to the bottom of the tool log. Used by AgentPanel
  // after replaying a past run from history so the user lands on the LATEST
  // tool call (not the top of a long step list). Re-arms tail-follow and
  // uses a double-rAF so layout has settled before we read scrollHeight —
  // panel-was-hidden and CSS-transition cases would otherwise clamp scrollTop.
  scrollToBottom() {
    this._followBottom = true;
    const run = () => this._scrollBodyToBottom();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(run));
    } else {
      setTimeout(run, 32);
    }
  }
}

module.exports = ToolStream;
