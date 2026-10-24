// AgentLane — the multi-step agent loop as the panel sees it: starts runs over
// agent:start, maps every agent:* event onto the transcript, answer view and
// history, renders the approval prompt and egress scope, and drives
// pause/reattach and the quality mode.
// State lives on the panel (host) so its long-standing field names stay valid.

const { ipcRenderer } = require('electron');
const ProjectComposer = require('../../agent/ProjectComposer');
const { escapeHtml } = require('../../agent/format');
const { iconHTML } = require('../../Icon');
const configBridge = require('../../../core/configBridge');
const { errMsg } = require('../../../../shared/errMsg');
const fx = require('../../../fx');
const ApprovalCard = require('../ApprovalCard');
const { CHAT_HISTORY_TURNS } = require('../AssistantController');
const toast = require('../../Toast');

const QUALITY_MODES = ['efficient', 'balanced', 'ultra'];

// Runtime termination reasons are internal codes; the answer pane needs the
// user-facing sentence, and an unmapped code still says something concrete.
const AGENT_REASON_MESSAGES = {
  empty_response: 'The model returned no answer text and no tool call. If it is a reasoning model, it may have spent its whole token budget thinking — raise the response length in Settings → LLM, or switch the remote tool format to Native in Settings → LLM → Advanced.',
  reasoning_budget_exhausted: 'The model gathered what it needed but ran out of tokens while thinking, twice, so it never wrote the answer. Raise the response length in Settings → LLM, or use a model with shorter reasoning.',
  max_steps_exceeded: 'The agent hit its step limit before reaching an answer. Raise Max steps in Settings → Agent, or narrow the task.',
  budget_exceeded: 'The agent hit its budget limit for this task.',
  stopped: 'Stopped.',
  hook_error: 'The agent could not start a step because a pre-step hook failed.',
  awaiting_user: 'The agent is waiting on your answer to continue.',
};

class AgentLane {
  /** @param {import('../../AgentPanel')} host */
  constructor(host) {
    this.host = host;
    /** @type {ApprovalCard|null} */
    this.approvals = null;
  }

  // Quality buttons are wired here, before the AssistantMenu adopts the vault:
  // adoption reparents them out of `content`.
  /** @param {HTMLElement} content */
  mount(content) {
    const h = this.host;
    h.approvalEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-approval'));
    this.approvals = new ApprovalCard({
      container: h.approvalEl,
      focusRoot: () => h.overlay,
      onDrained: (hadFocus) => { if (hadFocus) h._focusComposer(); },
      sessionLabel: (p) => this.approvalSessionLabel(p),
    });
    h._sessionStore.on('session', () => this.approvals.relabel());
    h._egressEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-egress'));
    h._qualityMode = 'balanced';
    h._paused = false;
    content.querySelectorAll('.agent-panel-quality-btn').forEach((raw) => {
      const btn = /** @type {HTMLElement} */ (raw);
      btn.addEventListener('click', () => this.setQualityMode(btn.dataset.mode));
    });
  }

  wireIpc() {
    const h = this.host;
    ipcRenderer.on('agent:task-started', (_e, payload) => this.onTaskStarted(payload));
    // A foreground run of another session is not what this panel shows.
    const mine = (payload) => h._sessionStore.belongs(payload);
    ipcRenderer.on('agent:step-planned', (_e, payload) => { if (mine(payload)) this.onStepPlanned(payload); });
    ipcRenderer.on('agent:step-acted', (_e, payload) => { if (mine(payload)) this.onStepActed(payload); });
    ipcRenderer.on('agent:step-parse-retry', (_e, payload) => { if (mine(payload)) this.onParseRetry(payload); });
    ipcRenderer.on('agent:plan-updated', (_e, payload) => {
      if (!mine(payload)) return;
      const steps = (payload && payload.steps) || [];
      if (steps.length) {
        // Plan updates render as their own header row (not a step group).
        const li = document.createElement('li');
        li.className = 'agent-step-plan';
        li.textContent = 'Plan: ' + steps.join(' → ');
        h._transcriptEl.appendChild(li);
      }
    });
    ipcRenderer.on('agent:task-completed', (_e, result) => this.onTaskCompleted(result));
    ipcRenderer.on('agent:task-failed', (_e, payload) => {
      if (!h._scopeMatches(payload) || !mine(payload)) return;
      this.dropApprovalsFor(payload);
      h._transcript.setStatus('error');
      if (h._toolStream) {
        h._toolStream.markAllFinished();
        h._toolStream.setOverallStatus('failed');
      }
      h._answerView.present(`Task failed: ${(payload && payload.error) || 'unknown error'}`);
      if (h._activeTaskId) {
        h._history.markFinal({ taskId: h._activeTaskId, status: 'failed' });
        h._history.refresh();
      }
      this.bindOutcome(payload, '');
    });
    ipcRenderer.on('agent:task-paused', () => {
      h._paused = true;
      if (h.pauseBtn) h.pauseBtn.textContent = 'Resume';
    });
    ipcRenderer.on('agent:task-resumed', () => {
      h._paused = false;
      if (h.pauseBtn) h.pauseBtn.textContent = 'Pause';
    });
    ipcRenderer.on('agent:task-orphaned', () => h._reattach.show());
    ipcRenderer.on('agent:task-reattached', () => h._reattach.hide());
    ipcRenderer.on('agent:throughput', (_e, payload) => h._answerView.updateThroughput(payload || {}));
    ipcRenderer.on('agent:assistant-chunk', (_e, payload) => {
      if (!mine(payload)) return;
      // Stream tokens into the AnswerView as they arrive from the runtime.
      // The runtime emits these only during forced/final summary calls — the
      // common agent.done path returns the summary all at once via task-completed.
      if (h._answerView && payload && typeof payload.text === 'string') {
        h._answerView.appendChunk(payload.text);
      }
    });
    ipcRenderer.on('agent:budget-breach', (_e, payload) => {
      const reason = (payload && payload.reason) || 'budget';
      if (h.budgetEl) h.budgetEl.textContent = `hit ${reason}`;
    });
    ipcRenderer.on('agent:approval-request', (_e, payload) => this.renderApprovalPrompt(payload));
    ipcRenderer.on('agent:approval-resolved', (_e, payload) => this.dropResolvedApproval(payload));
    // Any session's stream, subagents' included: their cards share this queue.
    ipcRenderer.on('session:event', (_e, ev) => {
      if (ev && ev.channel === 'approval-resolved') this.dropResolvedApproval(ev.payload);
    });
  }

  onTaskStarted(payload) {
    const h = this.host;
    if (!h._scopeMatches(payload)) return;
    // A run main started without a session got one of its own; later turns
    // continue in it.
    const sid = (payload && payload.sessionId) || null;
    if (sid) h._sessionStore.adopt(sid);
    if (!h._sessionStore.belongs(payload)) return;
    this.dropApprovalsFor(payload);
    const turnNodeId = (payload && payload.turnNodeId) || null;
    // A resend answers a user turn the thread already shows.
    const resend = !!(h._resendNodeId && turnNodeId === h._resendNodeId);
    h._resendNodeId = null;
    // Within a session the conversation spans lanes, so a cold agent run
    // after chat turns still continues the visible thread.
    const isFollowUp = !!(payload && payload.isFollowUp) || (!!sid && h._transcriptEl.children.length > 0);
    if (resend) h._answerView.clear();
    else if (isFollowUp) h._transcript.prepareFollowUpTurn();
    else h._transcript.reset();
    h._personaControl.renderPill(payload);
    h._activePersona = payload && payload.persona ? { name: payload.persona, label: payload.personaLabel || payload.persona, source: payload.routerSource || 'auto' } : null;
    if (h._answerView && h._activePersona) {
      h._answerView.setPersonaContext({ personaLabel: h._activePersona.label, source: h._activePersona.source, followUps: [] });
    }
    h._transcript.setStatus('running');
    this.renderEgressScope();
    const desc = (payload && payload.task && payload.task.description) || '';
    h._activeDescription = desc;
    h._activeTaskId = payload && payload.taskId;
    // Bind the now-live agent workspace to this conversation so all tab
    // ops persist into <taskId>.meta.json.
    if (h._activeTaskId) {
      try { ipcRenderer.send('agent-workspace:bind-conversation-id', { taskId: h._activeTaskId }); } catch (err) { console.error('bind-conversation-id failed', (err instanceof Error && err.message) || err); }
    }
    if (resend) h._chatThread.bindTurn({ userNodeId: turnNodeId, lane: 'agent' });
    else h._transcript.renderUserMessage(desc, { nodeId: turnNodeId, lane: 'agent' });
    h._history.prependRunning({
      taskId: h._activeTaskId,
      description: desc,
      title: desc.slice(0, 80),
      mode: payload && payload.mode,
    });
  }

  onTaskCompleted(result) {
    const h = this.host;
    if (!h._scopeMatches(result) || !h._sessionStore.belongs(result)) return;
    this.dropApprovalsFor(result);
    // A run that produced no answer text is a failed run whatever its ok flag says.
    const summaryText = String((result && result.summary) || '').trim();
    const taskOk = !!(result && result.ok) && !!summaryText;
    const stopped = !!(result && result.reason === 'stopped');
    h._transcript.setStatus(taskOk ? 'done' : (stopped ? 'idle' : 'error'));
    if (h._toolStream) {
      h._toolStream.markAllFinished();
      // Reflect TASK outcome on the stream header — transient tool failures
      // the agent recovered from get a "N step(s) with errors" note, but
      // only an actually-failed task brands the whole stream red.
      h._toolStream.setOverallStatus(taskOk ? 'ok' : 'failed');
      h._toolStream.collapse();
    }
    const summary = summaryText || this.friendlyReason(result && result.reason);
    const isPartial = result && (result.reason === 'maxstepsexceeded_soft' || result.reason === 'forced_summary' || result.reason === 'parse_loop_recovered');
    // Hydrate follow-up chips from the resolved persona's followUps list.
    if (h._answerView && h._activePersona) {
      const p = (h._personaList || []).find((x) => x.name === h._activePersona.name);
      const followUps = (p && Array.isArray(p.followUps)) ? p.followUps : [];
      h._answerView.setPersonaContext({
        personaLabel: h._activePersona.label,
        source: h._activePersona.source,
        followUps: taskOk ? followUps : [],
        onFollowUp: (text) => { if (h.input) { h.input.value = text; h.input.focus(); } },
        partial: isPartial ? (result.reason === 'maxstepsexceeded_soft' ? 'partial — ran out of steps' : 'partial — recovered from a parse error') : null,
      });
    }
    h._answerView.present(summary);
    // Record the turn in the shared thread so a following chat message sees
    // what the agent answered. Only a real answer is recorded — a failure
    // notice is UI text, not something the model should read back as its own.
    if (taskOk) h._controller.pushThreadTurn(h._activeDescription, summaryText);
    if (h._activeTaskId) {
      h._history.markFinal({ taskId: h._activeTaskId, status: taskOk ? 'ok' : (stopped ? 'stopped' : 'failed'), summary });
      h._history.refresh();
    }
    this.bindOutcome(result, summary);
  }

  // Binding the run's outcome node gives the live answer its actions and
  // version switcher. task-completed names it (assistantNodeId); without the
  // id the node is the session head once a refresh has fetched it. A plan
  // proposal's node is not an answer and is never bound.
  bindOutcome(payload, answer) {
    const h = this.host;
    const store = h._sessionStore;
    const sid = payload && payload.sessionId;
    if (!sid || sid !== store.activeSessionId) return Promise.resolve(false);
    const nodeId = payload.assistantNodeId;
    if (typeof nodeId === 'string' && nodeId) {
      if (payload.reason === 'awaiting_plan_approval') return Promise.resolve(false);
      h._chatThread.bindTurn({ assistantNodeId: nodeId, lane: 'agent', answer });
      return Promise.resolve(true);
    }
    return store.refresh().then((snap) => {
      const head = snap && store.node(snap.headId);
      if (!head || head.role !== 'assistant' || (head.kind !== 'message' && head.kind !== 'error')) return false;
      h._chatThread.bindTurn({ assistantNodeId: head.id, lane: 'agent', answer });
      return true;
    }, (err) => {
      console.error('[AgentLane] session refresh failed:', errMsg(err));
      return false;
    });
  }

  onStepPlanned(payload) {
    const step = Number(payload && payload.step) || 0;
    const calls = Array.isArray(payload && payload.calls) ? payload.calls : [];
    this.host._transcript.ensureToolStream().addStepPlanned({ step, calls });
    fx.agentStepPlanned(payload);
  }

  onStepActed(payload) {
    const step = Number(payload && payload.step) || 0;
    this.host._transcript.ensureToolStream().setStepResults({
      step,
      calls: Array.isArray(payload.calls) ? payload.calls : null,
      results: Array.isArray(payload.results) ? payload.results : [],
      latencyMs: payload.latencyMs,
    });
    this.captureResearchSources(payload);
    fx.agentStepActed(payload);
  }

  onParseRetry(payload) {
    const step = Number(payload && payload.step) || 0;
    this.host._transcript.ensureToolStream().addParseRetry({
      step,
      contentPreview: payload && payload.contentPreview,
    });
  }

  // Research Report Mode: when browser.open_research_sources runs, capture its
  // {index→spaceId} map so [N] citations in the report become clickable, and
  // reveal the agent workspace side-by-side so the opened sources are visible.
  captureResearchSources(payload) {
    const h = this.host;
    const results = Array.isArray(payload && payload.results) ? payload.results : [];
    let sources = null;
    for (const r of results) {
      const res = r && r.result;
      if (r && r.name === 'browser.open_research_sources'
        && res && Array.isArray(res.sources) && res.sources.length) {
        sources = res.sources;
        break;
      }
    }
    if (!sources) return;
    const map = {};
    for (const s of sources) {
      if (s && s.index != null && s.spaceId) map[String(s.index)] = s.spaceId;
    }
    if (!Object.keys(map).length) return;
    const ctx = (h.contextProvider && h.contextProvider()) || {};
    const awm = ctx.agentWorkspaceManager;
    if (h._answerView && typeof h._answerView.setCitationMap === 'function') {
      h._answerView.setCitationMap(map, (sid) => {
        if (awm && typeof awm.focusSource === 'function') awm.focusSource(sid);
      });
    }
    if (awm && typeof awm.revealWorkspace === 'function') awm.revealWorkspace();
  }

  // Per-task trust surface: a one-line summary of where the agent may go,
  // shown at the top of every run so the scope is never a surprise.
  renderEgressScope() {
    const h = this.host;
    const elx = /** @type {any} */ (h._egressEl);
    if (!elx) return;
    const eg = configBridge.get('settings.llm.agent.egress', null);
    const mode = eg && (eg.mode === 'allowlist' || eg.mode === 'blocklist') ? eg.mode : 'open';
    const allow = (eg && Array.isArray(eg.allow) ? eg.allow : []).filter(Boolean);
    const block = (eg && Array.isArray(eg.block) ? eg.block : []).filter(Boolean);
    if (mode === 'open' && !block.length) { elx.hidden = true; elx.innerHTML = ''; return; }

    let label;
    let detail;
    if (mode === 'allowlist') {
      label = 'Allow-list';
      detail = allow.length ? `${allow.length} site${allow.length === 1 ? '' : 's'}` : 'no sites — agent navigation is fully blocked';
    } else if (mode === 'blocklist') {
      label = 'Block-list';
      detail = `${block.length} site${block.length === 1 ? '' : 's'} blocked`;
    } else {
      label = 'Open';
      detail = `${block.length} site${block.length === 1 ? '' : 's'} blocked`;
    }
    const onv = eg && eg.onViolation === 'deny' ? 'refused silently' : 'asks you';
    elx.hidden = false;
    elx.innerHTML = ''
      + `<span class="agent-panel-egress-icon" aria-hidden="true">${iconHTML('shield')}</span>`
      + `<span class="agent-panel-egress-label">Egress: ${escapeHtml(label)}</span>`
      + `<span class="agent-panel-egress-detail">${escapeHtml(detail)}</span>`
      + (mode === 'allowlist' ? `<span class="agent-panel-egress-detail">· off-list ${escapeHtml(onv)}</span>` : '')
      + '<button type="button" class="agent-panel-egress-edit" title="Open Agent safety settings">Change</button>';
    const editBtn = elx.querySelector('.agent-panel-egress-edit');
    if (editBtn) editBtn.addEventListener('click', () => h._openSettingsTab('agent-safety'));
  }

  // A request tagged with a session other than the one on screen (and not one
  // of its subagents) would otherwise be indistinguishable from the
  // foreground run's own request.
  approvalSessionLabel(payload) {
    const h = this.host;
    const sid = payload && payload.sessionId;
    if (typeof sid !== 'string' || !sid || h._sessionStore.ownsApproval(payload)) return null;
    const row = h._history ? h._history.get(sid) : null;
    const title = row && typeof row.title === 'string' ? row.title.trim() : '';
    return title || `Untitled session (${sid.slice(0, 8)})`;
  }

  renderApprovalPrompt(payload) {
    if (this.approvals) this.approvals.enqueue(payload);
  }

  // Main settled the request (answered, timed out or cancelled), so its card
  // is stale; an id that is not queued changes nothing.
  dropResolvedApproval(payload) {
    const id = payload && payload.requestId;
    if (!this.approvals || typeof id !== 'string' || !id) return;
    this.approvals.clear((p) => p.requestId === id);
  }

  // A foreground run that starts or ends leaves no request of its own (or of
  // its subagents) pending in main; requests tagged with another session stay queued.
  dropApprovalsFor(payload) {
    if (!this.approvals) return;
    const sid = (payload && payload.sessionId) || null;
    const store = this.host._sessionStore;
    this.approvals.clear((p) => !p.sessionId || p.sessionId === sid || store.isChildSession(p.sessionId));
  }

  setQualityMode(mode) {
    if (!QUALITY_MODES.includes(mode)) return;
    this.host._qualityMode = mode;
    // Quality buttons are adopted into the portalled menu (document.body),
    // not nested in the panel overlay.
    document.querySelectorAll('.agent-panel-quality-btn').forEach(raw => {
      const b = /** @type {HTMLElement} */ (raw);
      const active = b.dataset.mode === mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  friendlyReason(reason) {
    const r = String(reason || '');
    if (AGENT_REASON_MESSAGES[r]) return AGENT_REASON_MESSAGES[r];
    return r ? `The agent ended without an answer (${r}).` : 'The agent ended without an answer.';
  }

  async run(prefillDescription) {
    const h = this.host;
    const raw = typeof prefillDescription === 'string' && prefillDescription.trim()
      ? prefillDescription.trim() : (h.input.value || '').trim();
    const description = ProjectComposer.stripMentionTokens(raw);
    if (!description) return;
    h._transcript.setStartersVisible(false);
    h._composer.recordPrompt(description);
    const wv = this.resolveTargetWebview();
    if (!wv || typeof wv.getWebContentsId !== 'function') {
      h._answerView.present(h._scope === 'tab'
        ? 'This tab no longer has a webview to control.'
        : 'No active webview to control. Open a tab first.');
      return;
    }
    let id;
    try { id = wv.getWebContentsId(); }
    catch (e) { h._answerView.present(`Cannot resolve webview id: ${errMsg(e)}`); return; }
    if (typeof prefillDescription === 'string') h.input.value = description;
    // Clear immediately so the user sees their message move into the
    // transcript — agent:start can block for seconds on the initial
    // observation and waiting until after the await feels broken.
    const prevValue = h.input.value;
    h.input.value = '';
    h.input.style.height = '';
    if (h._projectComposer) h._projectComposer.clearPending();
    h._pendingProjectImages = [];
    // Show the answer pane in its waiting state immediately so the user gets
    // feedback before agent:task-started fires (which can be a few seconds).
    // The previous answer moves into the thread first or markWaiting wipes it.
    h._transcript.prepareFollowUpTurn();
    h._answerView.markWaiting();
    // Only a NEW conversation clears the agent workspace. A follow-up turn keeps
    // the tabs earlier turns opened — wiping them mid-thread makes "open the
    // third result" impossible and reads as the conversation having restarted.
    // AgentWorkspaceService binds to the real taskId in onTaskStarted.
    // The first agent turn of a new chat runs without a session: main creates
    // one for it and onTaskStarted adopts it from the task-started payload.
    const sessionId = h._sessionStore.activeSessionId;
    const isNewThread = !h._agentThreadActive;
    h._agentThreadActive = true;
    if (isNewThread) {
      // A failed bind silently drops tab binding for the whole thread
      // (taskId.meta.json + restore are lost), so retry once before
      // surfacing a toast. The run itself proceeds either way — the agent
      // start path is independent.
      const invoke = () => ipcRenderer.invoke('agent-workspace:set-active-conversation', { isNew: true });
      try {
        await invoke();
      } catch (err) {
        try { await invoke(); } catch (err2) {
          console.error('set-active-conversation(isNew) failed', errMsg(err2));
          toast.error('Agent workspace tabs are unavailable — workspace tabs and restore are disabled for this task.', { title: 'Agent workspace' });
        }
      }
    }
    try {
      await ipcRenderer.invoke('agent:start', {
        ...this.startOptions(id),
        description,
        ...(sessionId ? { sessionId } : {}),
      });
    } catch (err) {
      h._transcript.setStatus('error');
      h._answerView.present(`Start failed: ${(err instanceof Error && err.message) || String(err)}`);
      // Restore so the user doesn't lose their typing on a start failure.
      h.input.value = prevValue;
      h._transcript.setStartersVisible(true);
    }
  }

  startOptions(webContentsId) {
    const h = this.host;
    const qualitySkillOverride = h._qualityMode && h._qualityMode !== 'balanced'
      ? { name: h._qualityMode } : null;
    return {
      webContentsId, qualitySkillOverride,
      scope: h._scope, tabId: h._tabId,
      // Seeds a cold agent conversation with the thread so far; the service
      // ignores it once its own conversation exists.
      priorTurns: h._chatHistory.slice(-CHAT_HISTORY_TURNS * 2),
    };
  }

  // Answer an existing user turn of the session again (edit & resend,
  // regenerate): main reuses the node instead of appending a new message.
  async resend(userNode) {
    const h = this.host;
    const sessionId = h._sessionStore.activeSessionId;
    if (!sessionId || !userNode || !userNode.id) throw new Error('This message is not saved yet.');
    const wv = this.resolveTargetWebview();
    if (!wv || typeof wv.getWebContentsId !== 'function') throw new Error('No active webview to control. Open a tab first.');
    const webContentsId = wv.getWebContentsId();
    h._transcript.setStartersVisible(false);
    h._answerView.markWaiting();
    h._agentThreadActive = true;
    h._resendNodeId = userNode.id;
    try {
      await ipcRenderer.invoke('agent:start', {
        ...this.startOptions(webContentsId),
        description: String(userNode.content || ''),
        sessionId,
        fromNodeId: userNode.id,
      });
    } catch (err) {
      h._resendNodeId = null;
      h._transcript.setStatus('error');
      h._answerView.present(`Start failed: ${errMsg(err)}`);
      throw err;
    }
  }

  // For tab-scoped runs: target THIS panel's tab regardless of which tab is
  // currently focused, so the agent always operates on the tab the user
  // launched the per-tab strip from. For global runs, fall back to the
  // currently focused tab.
  resolveTargetWebview() {
    const h = this.host;
    if (h._scope === 'tab' && h._tabId) {
      const wv = /** @type {any} */ (document.getElementById(h._tabId));
      if (wv) return wv;
    }
    const ctx = h.contextProvider() || {};
    return ctx.navigationManager && typeof ctx.navigationManager.getActiveWebview === 'function'
      ? ctx.navigationManager.getActiveWebview() : null;
  }
}

module.exports = AgentLane;
