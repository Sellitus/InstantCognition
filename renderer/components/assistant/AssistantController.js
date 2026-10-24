// AssistantController — the Assistant panel's send pipeline: routes each send
// to the chat, agent or council lane, owns the shared conversation thread
// (new chat, stop), the sessions list and the side panes (Sessions/Artifacts/Inbox).
// State lives on the panel (host) so its long-standing field names stay valid.

const { ipcRenderer } = require('electron');
const SessionList = require('./SessionList');
const { SidePanes } = require('./AssistantShell');
const HistoryRail = require('../agent/HistoryRail');
const { formatDuration } = require('../agent/format');
const { errMsg } = require('../../../shared/errMsg');
const { isSessionId } = require('./SessionStore');
const { parseSlashAction, routeIntent } = require('../../utils/chatContext');
const toast = require('../Toast');

// How many prior chat turns to resend for context (user+assistant = 2 msgs each).
const CHAT_HISTORY_TURNS = 8;

function formatTokensDisplay(n) {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

class AssistantController {
  /** @param {import('../AgentPanel')} host */
  constructor(host) {
    this.host = host;
  }

  /** @param {HTMLElement} content */
  mountHistory(content) {
    const h = this.host;
    const sidebarEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-sidebar'));
    h._history = new SessionList({
      root: sidebarEl,
      onCountChange: (n) => { if (h._historyRail) h._historyRail.setCount(n); },
    });
    h._historyRail = new HistoryRail({
      panelEl: content,
      sidebarEl,
      historyEl: h._history.el,
      toggleBtn: /** @type {HTMLButtonElement} */ (content.querySelector('.agent-panel-history-toggle')),
    });
    h._historyRail.setCount(h._history.count());
    // Reachable later through SidePanes.forContent(content).
    new SidePanes({
      content,
      host: h,
      getStore: () => (h._viewShell ? h._viewShell.store : null),
      sessionList: h._history,
      historyRail: h._historyRail,
    });
  }

  // Route one manual send to its answer path. Slash commands carry their own
  // destination and bypass the override; everything else follows the persisted
  // route mode (auto = per-message intent via routeIntent, chat/agent = forced
  // lane). Returns a promise that settles when the run finishes so callers can await it.
  run(prefillDescription) {
    const h = this.host;
    const text = typeof prefillDescription === 'string' && prefillDescription.trim()
      ? prefillDescription.trim() : (h.input.value || '').trim();
    if (text) this.noteUserSend();
    const slash = parseSlashAction(text);
    if (slash) {
      switch (slash.action) {
        // Return the underlying promise so `await _run()` settles when the run finishes.
        case 'research': return h._councilLane.runResearch(slash.rest);
        case 'council': return h._councilLane.runCouncil(slash.rest);
        // summarize/explain/compare stay on the fast single-turn path even under a
        // forced agent override — they are one-shot transforms, not agent tasks.
        default: return h._chatLane.run(prefillDescription);
      }
    }
    const forced = h.routeMode === 'chat' ? 'chat' : (h.routeMode === 'agent' ? 'agent' : null);
    if (!forced) {
      // Auto: explicit action phrasing runs the agent loop; everything else is a fast answer.
      return routeIntent(text) === 'agent' ? h._agentLane.run(prefillDescription) : h._chatLane.run(prefillDescription);
    }
    return forced === 'chat' ? h._chatLane.run(prefillDescription) : h._agentLane.run(prefillDescription);
  }

  // Run an enabled skill as an agent task on the target webview, as a turn in
  // the session the panel shows (when one is active), so main persists it as
  // `/<name> <task>`. skills:run
  // carries no scope, so its events reach only the global panel; a tab-scoped
  // panel runs the skill through the agent lane instead, naming it so the
  // model loads it with agent.use_skill (which narrows the run's tools).
  // Failures surface as a toast; text that never started a run goes back
  // into the composer. Resolves with the skills:run reply, or null when
  // skills:run was not called.
  /** @param {string} name @param {string} task @returns {Promise<any>} */
  async runSkill(name, task) {
    const h = this.host;
    if (h._scope === 'tab') {
      const tail = task ? `\n\nTask: ${task}` : '';
      await h._agentLane.run(`Use the "${name}" skill (load it with agent.use_skill) and follow it.${tail}`);
      return null;
    }
    const text = (h.input.value || '').trim();
    const wv = h._agentLane.resolveTargetWebview();
    let webContentsId;
    try {
      if (!wv || typeof wv.getWebContentsId !== 'function') throw new Error('No tab is open. Open a tab first.');
      webContentsId = wv.getWebContentsId();
    } catch (err) {
      toast.error(`Couldn’t run /${name}: ${errMsg(err)}`);
      return null;
    }
    this.noteUserSend();
    h._composer.recordPrompt(text);
    const startersShown = !!(h._emptyEl && !h._emptyEl.hidden);
    const taskBefore = h._activeTaskId;
    h.input.value = '';
    h.input.style.height = '';
    h._transcript.setStartersVisible(false);
    let res;
    try {
      const sessionId = h.activeSessionId();
      res = await ipcRenderer.invoke('skills:run', { name, ...(task ? { task } : {}), webContentsId, ...(sessionId ? { sessionId } : {}) });
    } catch (err) {
      res = { ok: false, error: errMsg(err) };
    }
    if (!res || (res.ok === false && res.error)) {
      toast.error(`Couldn’t run /${name}: ${(res && res.error) || 'no response'}`);
      if (h._activeTaskId === taskBefore) {
        if (!h.input.value) h.input.value = text;
        h._transcript.setStartersVisible(startersShown);
      }
    }
    return res || null;
  }

  // Append one completed turn to the shared thread, trimmed to the window both
  // lanes read back. Every lane (chat, council, agent) records through here so
  // the thread stays in one order with one bound.
  pushThreadTurn(userText, assistantText) {
    const h = this.host;
    const u = String(userText || '').trim();
    const a = String(assistantText || '').trim();
    if (!u || !a) return;
    h._chatHistory.push({ role: 'user', content: u });
    h._chatHistory.push({ role: 'assistant', content: a });
    if (h._chatHistory.length > CHAT_HISTORY_TURNS * 2) {
      h._chatHistory = h._chatHistory.slice(-CHAT_HISTORY_TURNS * 2);
    }
  }

  // Main offers the selected local engine's pending runtime update on the first user send after it was found.
  noteUserSend() {
    ipcRenderer.send('engine-updater:user-send');
  }

  stop() {
    const h = this.host;
    // Chat and agent runs are separate lanes; stop whichever is live. A chat turn holds a reqId; an in-flight agent run does not.
    if (h._chatReqId) {
      h._chatLane.cancel();          // cancel any in-flight stream (uses _chatReqId)
      h._chatLane.teardownStream(); // clears _chatReqId so a council poll loop bails
      h._transcript.setStatus('idle');
      return;
    }
    ipcRenderer.send('agent:stop');
    h._transcript.setStatus('idle');
  }

  // Clear the current conversation and reset the composer so the user can
  // start a new task without restarting the app. If an agent is still running,
  // ask the user to stop it first (safer than silently orphaning it).
  async newChat() {
    const h = this.host;
    if (h.statusEl && h.statusEl.getAttribute('data-status') === 'running') {
      const { confirm } = require('../ConfirmDialog');
      const proceed = await confirm({
        title: 'A task is still running',
        message: 'Stop it and start a new chat?',
        confirmLabel: 'Stop & new chat',
        confirmKind: 'danger',
      });
      if (!proceed) return;
      // Stop whichever lane is live before resetting (see stop).
      if (h._chatReqId) h._chatLane.cancel(); else ipcRenderer.send('agent:stop');
    }
    // The shared thread is panel-local; clear it so the new conversation starts cold.
    h._chatHistory = [];
    // The next send creates a fresh session.
    h._sessionStore.reset();
    // Next agent run opens a fresh workspace rather than inheriting this
    // conversation's tabs.
    h._agentThreadActive = false;
    h._chatLane.teardownStream();
    h._chatLane.supersede();
    // Only clear THIS scope's conversation — leaves the other scope (global
    // vs tab) intact so a stray "+ New conversation" in one panel never wipes
    // out the conversation in another.
    ipcRenderer.send('agent:reset-conversation', { scope: h._scope, tabId: h._tabId });
    h._transcript.reset();
    h._transcript.setStatus('idle');
    h._activeDescription = '';
    h._activeTaskId = null;
    if (h._history) h._history.setActive(null);
    if (h.input) {
      h.input.value = '';
      h.input.style.height = '';
      h.input.focus();
    }
    h._transcript.setStartersVisible(true);
    // Drop the agent's tabs so the workspace the user is looking at matches the
    // empty conversation. Last, so the local reset above never waits on IPC.
    try {
      await ipcRenderer.invoke('agent-workspace:set-active-conversation', { isNew: true });
    } catch (err) {
      console.error('set-active-conversation(new chat) failed', (err instanceof Error && err.message) || err);
    }
  }

  async openHistoryRun(id) {
    const h = this.host;
    try {
      const run = await ipcRenderer.invoke('agent:history-open', id);
      if (!run) return;
      // Viewing a past run implicitly ends the current live conversation —
      // the next Run from this pane starts fresh, not as a follow-up.
      // Scoped reset so the other panel's conversation is not touched.
      ipcRenderer.send('agent:reset-conversation', { scope: h._scope, tabId: h._tabId });
      // Restore the agent workspace tabs from THIS conversation's saved meta
      // so the user (in agent view) sees the prior tabs again.
      try { await ipcRenderer.invoke('agent-workspace:set-active-conversation', { taskId: id, isNew: false }); } catch (err) { console.error('set-active-conversation(resume) failed', (err instanceof Error && err.message) || err); }
      // The restored tabs ARE this thread's workspace now, so the next run must
      // not wipe them on its way in.
      h._agentThreadActive = true;
      h._chatHistory = [];
      h._sessionStore.reset();
      h._transcript.reset();
      h._transcript.setStatus(run.status === 'running' ? 'running' : (run.status === 'ok' ? 'done' : (run.status === 'failed' ? 'error' : 'idle')));
      h._activeDescription = run.description || '';
      h._transcript.setStartersVisible(false);
      h._history.setActive(id);
      h._transcript.renderUserMessage(run.description || '');
      if (Array.isArray(run.events)) {
        for (const ev of run.events) h._transcript.replayEvent(ev);
      }
      // Jump the tool-call panel to the latest entry — replay starts from
      // step 0 so the body is otherwise scrolled to top, and the user
      // expects to see the most recent activity first when reopening.
      if (h._toolStream && typeof h._toolStream.scrollToBottom === 'function') {
        h._toolStream.scrollToBottom();
      }
      if (run.summary) h._answerView.renderStatic(run.summary);
      if (run.tokensUsed && h.costEl) {
        h.costEl.textContent = `${run.stepCount || 0} steps · ${formatTokensDisplay(run.tokensUsed)} tokens · ${formatDuration(run.durationMs || 0)}`;
      }
    } catch (err) {
      h._answerView.present(`Failed to open run: ${(err instanceof Error && err.message) || err}`);
    }
  }

  async retryHistoryRun(id) {
    const h = this.host;
    try {
      const run = await ipcRenderer.invoke('agent:history-open', id);
      if (!run || !run.description) return;
      this.noteUserSend();
      // History runs are agent tasks by definition — bypass intent routing.
      await h._agentLane.run(run.description);
    } catch (err) {
      h._answerView.present(`Couldn’t run that again: ${errMsg(err)}`);
    }
  }

  // Open the prior task's prompt as a *fresh* conversation — different from
  // retryHistoryRun, which can pick up the existing scope's conversation.
  // Resets conversation state for THIS scope so the next agent:start has no
  // follow-up history.
  async openHistoryRunAsNew(id) {
    const h = this.host;
    try {
      const run = await ipcRenderer.invoke('agent:history-open', id);
      if (!run || !run.description) return;
      ipcRenderer.send('agent:reset-conversation', { scope: h._scope, tabId: h._tabId });
      h._chatHistory = [];
      h._sessionStore.reset();
      h._agentThreadActive = false;
      h._activeTaskId = null;
      if (h._history) h._history.setActive(null);
      this.noteUserSend();
      // History runs are agent tasks by definition — bypass intent routing.
      await h._agentLane.run(run.description);
    } catch (err) {
      h._answerView.present(`Couldn’t open that run as a new chat: ${errMsg(err)}`);
    }
  }

  // Show a saved session: its head path becomes the thread, the shared
  // history follows it, and the agent's in-memory conversation restarts so
  // the next turn is seeded from this session instead of the previous one.
  /** @param {string} id @returns {Promise<{ ok: boolean, error?: string }>} */
  async openSession(id) {
    const h = this.host;
    if (!isSessionId(id)) return { ok: false, error: 'invalid_session_id' };
    if (h._chatReqId || (h.statusEl && h.statusEl.getAttribute('data-status') === 'running')) {
      return { ok: false, error: 'run_in_progress' };
    }
    try {
      await h._sessionStore.open(id);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    if (h._sessionStore.activeSessionId !== id) return { ok: false, error: 'superseded' };
    h._chatLane.supersede();
    ipcRenderer.send('agent:reset-conversation', { scope: h._scope, tabId: h._tabId });
    h._agentThreadActive = false;
    h._activeTaskId = null;
    h._activeDescription = '';
    h._chatThread.rebuild();
    return { ok: true };
  }
}

module.exports = { AssistantController, CHAT_HISTORY_TURNS };
