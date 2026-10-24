// TranscriptView — the conversation surface of the Assistant panel: user
// turns, the agent's tool stream, the answer slot, run status, starters,
// scope label, tail-follow scrolling and Markdown export.
// State lives on the panel (host) so its long-standing field names stay valid.

const ToolStream = require('../agent/ToolStream');
const AnswerView = require('../agent/AnswerView');
const ReattachPrompt = require('../agent/ReattachPrompt');
const { runStatusLabel } = require('../agent/statusChips');
const { formatCall, formatCallResult } = require('../agent/format');
const toast = require('../Toast');
const { errMsg } = require('../../../shared/errMsg');
const fx = require('../../fx');

const FOLLOW_THRESHOLD_PX = 24;

class TranscriptView {
  /** @param {import('../AgentPanel')} host */
  constructor(host) {
    this.host = host;
  }

  /** @param {HTMLElement} content */
  mount(content) {
    const h = this.host;
    h._transcriptEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-transcript'));
    h.statusEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-status'));
    h.scopeEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-scope'));
    h.budgetEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-budget'));
    h.costEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-cost'));
    h._scrollEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-scroll'));
    h._emptyEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-empty'));
    h._answerView = new AnswerView({ root: /** @type {HTMLElement} */ (content.querySelector('.agent-panel-answer-slot')) });
    h._reattach = new ReattachPrompt({ root: /** @type {HTMLElement} */ (content.querySelector('.agent-panel-reattach-slot')), getContext: () => h.contextProvider() });
  }

  // Tail-follow the conversation: as steps, tools and the streaming answer
  // arrive, keep the latest output visible. If the user scrolls up to read,
  // stop following; once they scroll back to the bottom, resume following.
  setupAutoFollow() {
    const h = this.host;
    if (!h._scrollEl) return;
    h._followTail = true;
    h._autoScrolling = false;

    const isAtBottom = () => {
      const el = h._scrollEl;
      return (el.scrollHeight - el.scrollTop - el.clientHeight) <= FOLLOW_THRESHOLD_PX;
    };

    const scrollToBottom = () => {
      if (!h._followTail) return;
      const el = h._scrollEl;
      h._autoScrolling = true;
      el.scrollTop = el.scrollHeight;
      // Drop the guard on the next frame — the synthetic scroll event lands
      // asynchronously and we don't want it to flip _followTail.
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { h._autoScrolling = false; });
      } else {
        setTimeout(() => { h._autoScrolling = false; }, 0);
      }
    };

    h._scrollEl.addEventListener('scroll', () => {
      if (h._autoScrolling) return;
      h._followTail = isAtBottom();
    }, { passive: true });

    if (typeof MutationObserver !== 'undefined') {
      h._followObserver = new MutationObserver(scrollToBottom);
      h._followObserver.observe(h._scrollEl, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    // The composer grows with its textarea and the approval card can appear,
    // shrinking the scroll area. Re-pin to bottom on resize so the latest
    // output doesn't slip out of view as available height changes.
    if (typeof ResizeObserver !== 'undefined') {
      h._followResizeObserver = new ResizeObserver(scrollToBottom);
      h._followResizeObserver.observe(h._scrollEl);
    }
  }

  // Every message renders as Markdown through the chat thread, which also
  // carries its actions once the turn is saved to the session.
  /** @param {string} description @param {{ nodeId?: string|null, lane?: string }} [opts] */
  renderUserMessage(description, opts) {
    const o = opts || {};
    return this.host._chatThread.addUser(description, o.nodeId || null, o.lane || null);
  }

  renderAssistantLabel() {
    const h = this.host;
    // Insert a small "Agent" divider above the first step so the role shift
    // reads as a conversation turn, not a bare tool log.
    if (h._assistantLabelRendered) return;
    h._assistantLabelRendered = true;
    const li = document.createElement('li');
    li.className = 'agent-msg agent-msg-assistant-label';
    li.innerHTML = '<div class="agent-msg-role">Agent</div>';
    h._transcriptEl.appendChild(li);
  }

  ensureToolStream() {
    const h = this.host;
    if (!h._toolStream) {
      this.renderAssistantLabel();
      h._toolStream = new ToolStream({ root: h._transcriptEl });
    }
    return h._toolStream;
  }

  reset() {
    const h = this.host;
    h._transcriptEl.innerHTML = '';
    h._chatThread.clear();
    h._toolStream = null;
    h._assistantLabelRendered = false;
    h._answerView.clear();
    if (h.budgetEl) h.budgetEl.textContent = '';
    if (h.costEl) h.costEl.textContent = '';
    this.syncApprovals();
    h._reattach.hide();
    // Fresh turn — re-engage tail follow regardless of where the user was.
    h._followTail = true;
  }

  // The approval queue outlives a turn: a request still pending in main (a
  // background session's, say) must stay visible or it times out unseen.
  syncApprovals() {
    const lane = this.host._agentLane;
    if (lane && lane.approvals) lane.approvals.sync();
  }

  // Preserve prior transcript, but freeze the previous answer into the
  // transcript as a Markdown message (keeping its session node and actions)
  // so it doesn't get overwritten when the next turn's answer starts typing.
  prepareFollowUpTurn() {
    const h = this.host;
    const prevAnswer = h._answerView && typeof h._answerView.getMarkdown === 'function'
      ? h._answerView.getMarkdown() : '';
    h._chatThread.freezeAnswer(prevAnswer);
    h._answerView.clear();
    h._toolStream = null;
    h._assistantLabelRendered = false;
    if (h.budgetEl) h.budgetEl.textContent = '';
    this.syncApprovals();
    // Fresh follow-up turn — re-engage tail follow.
    h._followTail = true;
  }

  // Reconstruct the transcript from a replayed action log event.
  replayEvent(ev) {
    if (!ev || !ev.kind) return;
    if (ev.kind === 'step') {
      const step = Number(ev.step) || 0;
      const stream = this.ensureToolStream();
      stream.addStepPlanned({ step, calls: ev.tools || [] });
      stream.setStepResults({
        step,
        calls: ev.tools || [],
        results: (ev.results || []).map((r) => ({ id: r.id, name: r.name, result: { ok: !!r.ok, preview: r.preview } })),
        latencyMs: ev.latencyMs,
      });
    }
  }

  exportMarkdown() {
    const h = this.host;
    const lines = [];
    const heading = h._activeDescription ? `# ${h._activeDescription}\n` : '# Agent run\n';
    lines.push(heading);
    const stream = h._toolStream;
    if (stream) {
      for (const [step, group] of stream._stepsById) {
        lines.push(`\n## Step ${step + 1}`);
        for (let i = 0; i < group.calls.length; i++) {
          const c = group.calls[i];
          const r = group.results[i] && group.results[i].result;
          lines.push(`- ${formatCall(c)}${r ? '  \n  ' + formatCallResult(c, r) : ''}`);
        }
      }
    }
    const md = h._answerView.getMarkdown();
    if (md) lines.push('\n## Answer\n', md);
    const text = lines.join('\n');
    const copied = () => toast.success('Transcript copied as Markdown');
    const failed = (err) => toast.error(`Couldn’t copy the transcript: ${errMsg(err)}`);
    try {
      const { clipboard } = require('electron');
      clipboard.writeText(text);
      copied();
    } catch (_electronErr) {
      // Electron's clipboard is unavailable in some sandboxed contexts; the web
      // clipboard is the fallback, and only its failure is reported.
      try { Promise.resolve(navigator.clipboard.writeText(text)).then(copied, failed); }
      catch (err) { failed(err); }
    }
  }

  setStatus(status) {
    const h = this.host;
    if (!h.statusEl) return;
    h.statusEl.textContent = runStatusLabel(status);
    h.statusEl.setAttribute('data-status', status);
    const running = status === 'running';
    h._chatThread.setBusy(running);
    if (h.runBtn) h.runBtn.disabled = running;
    if (h.stopBtn) { h.stopBtn.disabled = !running; h.stopBtn.hidden = !running; }
    // Pause only exists for agent runs; a chat turn (holds _chatReqId) can only stop.
    if (h.pauseBtn) {
      h.pauseBtn.disabled = !running;
      h.pauseBtn.hidden = !running || !!h._chatReqId;
    }
    if (!running && h.pauseBtn) { h._paused = false; h.pauseBtn.textContent = 'Pause'; }
    fx.agentActivity(running);
    if (!running) fx.councilStop();
  }

  renderScopeLabel() {
    const h = this.host;
    if (!h.scopeEl) return;
    if (h._scope === 'tab') {
      h.scopeEl.setAttribute('data-scope', 'tab');
      h.scopeEl.textContent = h._tabTitle ? `Tab: ${h._tabTitle}` : 'Tab';
    } else {
      h.scopeEl.setAttribute('data-scope', 'global');
      h.scopeEl.textContent = 'Global';
    }
  }

  // The empty-state hero + starters show only while the conversation is empty.
  setStartersVisible(visible) {
    const h = this.host;
    if (h._emptyEl) h._emptyEl.hidden = !visible;
  }
}

module.exports = TranscriptView;
