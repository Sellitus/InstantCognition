// AgentPanel — the Assistant (Cmd+Shift+A). A facade over the assistant/
// modules: it owns the panel state, builds the DOM and exposes the public API
// (open, openWithTask, openChat, openChatAction, close, isOpen, onOpenChange,
// toggle, `.input`). ViewShellManager places the DOM: a right sidebar in
// browser mode, the main pane in assistant mode.
// The modules receive this instance as `host` and keep their state on it, so
// field names such as _chatHistory or _answerView mean the same thing everywhere.

const AssistantMenu = require('./agent/AssistantMenu');
const configBridge = require('../core/configBridge');
const { DEFAULT_CHAT_FEATURES } = require('../utils/chatContext');
const { panelTemplate } = require('./assistant/panelTemplate');
const { AssistantController } = require('./assistant/AssistantController');
const { SidePanes } = require('./assistant/AssistantShell');
const TranscriptView = require('./assistant/TranscriptView');
const Composer = require('./assistant/Composer');
const EngineControls = require('./agent/EngineControls');
const PersonaControl = require('./assistant/PersonaControl');
const ChatLane = require('./assistant/lanes/ChatLane');
const AgentLane = require('./assistant/lanes/AgentLane');
const CouncilLane = require('./assistant/lanes/CouncilLane');
const { SessionStore } = require('./assistant/SessionStore');
const { ChatThread } = require('./assistant/ChatThread');
const { PlanPanel } = require('./assistant/PlanPanel');
const toast = require('./Toast');
const modalStack = require('../utils/modalStack');
const { ViewShellManager } = require('../managers/ViewShellManager');

class AgentPanel {
  constructor() {
    this.contextProvider = null;
    /** @type {HTMLElement} */ this.overlay = null;
    /** @type {ViewShellManager|null} */ this._viewShell = null;
    this._isOpen = false;
    /** @type {Set<(open: boolean) => void>} */ this._openListeners = new Set();

    // Composer
    /** @type {HTMLTextAreaElement} */ this.input = null;
    /** @type {HTMLButtonElement} */ this.runBtn = null;
    /** @type {HTMLButtonElement} */ this.stopBtn = null;
    /** @type {HTMLButtonElement} */ this.pauseBtn = null;
    /** @type {HTMLElement} */ this.voiceBtn = null;
    /** @type {HTMLInputElement} */ this._enterToSendCb = null;
    this._modeSwitch = null;
    /** @type {HTMLElement} */ this._startersEl = null;
    this._projectComposer = null;
    /** @type {string[]} */ this._promptHistory = null;
    this._promptHistoryIdx = -1;
    this._shortcutsDropdown = null;
    this._assistantMenu = null;

    // Transcript + run status
    /** @type {HTMLElement} */ this.statusEl = null;
    /** @type {HTMLElement} */ this.scopeEl = null;
    /** @type {HTMLElement} */ this.budgetEl = null;
    /** @type {HTMLElement} */ this.costEl = null;
    /** @type {HTMLElement} */ this.approvalEl = null;
    /** @type {HTMLElement} */ this._egressEl = null;
    /** @type {HTMLElement} */ this._transcriptEl = null;
    /** @type {HTMLElement} */ this._scrollEl = null;
    /** @type {HTMLElement} */ this._emptyEl = null;
    this._answerView = null;
    this._reattach = null;
    this._toolStream = null;
    this._assistantLabelRendered = false;
    this._followTail = true;
    this._autoScrolling = false;
    this._followObserver = null;
    this._followResizeObserver = null;
    this._history = null;
    this._historyRail = null;

    // Conversation
    this._activeTaskId = null;
    this._activeDescription = '';
    this._scope = 'global';
    this._tabId = null;
    this._tabTitle = null;
    // Answer routing (settings.chat.mode): 'auto' routes each message by intent;
    // the menu override persists a forced path. Programmatic dispatch and slash
    // commands bypass this — they carry their own explicit destination.
    this.routeMode = 'auto';   // 'auto' | 'chat' | 'agent' (persisted)
    // One thread across both lanes: chat turns and agent turns land here, so a
    // chat message after an agent run (or the reverse) continues the same
    // conversation instead of starting cold every time routing switches lanes.
    this._chatHistory = [];   // [{role, content}]
    // False until the agent lane runs in this thread. Gates the agent-workspace
    // reset so only a new conversation clears the agent's tabs — a follow-up
    // turn keeps the pages the earlier turns opened.
    this._agentThreadActive = false;
    this._chatReqId = null;
    this._chatTokenHandler = null;
    this._chatSeq = 0;
    // Chat capability toggles (settings.chat.features), kept in sync with
    // Settings → Chat. Inline @-context tokens are parsed per message at send
    // time, so there is no persistent chip state.
    this._chatFeatures = { ...DEFAULT_CHAT_FEATURES };
    this._pendingProjectImages = [];
    this._qualityMode = 'balanced';
    this._paused = false;
    this._activePersona = null;
    /** @type {HTMLSelectElement} */ this._personaSelect = null;
    this._personaList = [];
    this._personaLock = null;

    // Inference engine
    /** @type {HTMLButtonElement} */ this.engineChip = null;
    /** @type {HTMLElement} */ this._heroEngineEl = null;
    /** @type {HTMLButtonElement} */ this.engineBtn = null;
    /** @type {HTMLElement} */ this.enginePopover = null;
    /** @type {HTMLSelectElement} */ this.engineBackendSelect = null;
    /** @type {HTMLSelectElement} */ this.engineModelSelect = null;
    /** @type {HTMLButtonElement} */ this.engineStartStopBtn = null;
    this._engineStatus = null;
    this._engineBackends = null;
    this._engineActionPending = false;

    this._controller = new AssistantController(this);
    this._transcript = new TranscriptView(this);
    this._composer = new Composer(this);
    this._engineControl = new EngineControls(this);
    this._personaControl = new PersonaControl(this);
    this._chatLane = new ChatLane(this);
    this._agentLane = new AgentLane(this);
    this._councilLane = new CouncilLane(this);

    // Persisted, branching session behind the conversation.
    this._sessionStore = new SessionStore();
    /** @type {ChatThread} */ this._chatThread = new ChatThread(this, { store: this._sessionStore });
    this._planPanel = new PlanPanel();
    /** @type {string|null} the user turn an edit/regenerate is answering */ this._resendNodeId = null;
    /** @type {Set<(sessionId: string|null) => void>} */ this._sessionListeners = new Set();
    this._persistWarned = false;
    /** @type {string|null} the sticky persist-failure toast currently shown */ this._persistToastId = null;
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  /**
   * Bind the shell that places the panel. renderer.js injects the app's
   * manager before initialize(); a standalone panel creates its own.
   * @param {ViewShellManager} manager
   */
  setViewShell(manager) {
    if (!manager || typeof manager.attachPanel !== 'function') throw new TypeError('AgentPanel.setViewShell expects a ViewShellManager');
    if (this._viewShell) throw new Error('AgentPanel.setViewShell: a view shell is already bound');
    this._viewShell = manager;
    manager.attachPanel({
      getContent: () => {
        if (!this.overlay) this._buildDom();
        return this.overlay;
      },
      focusComposer: () => this._focusComposer(),
    });
    manager.onVisibilityChange((visible) => this._onVisibilityChange(visible));
  }

  _shell() {
    if (!this._viewShell) this.setViewShell(new ViewShellManager());
    return this._viewShell;
  }

  _scopeMatches(payload) {
    // Filter incoming agent events to only those that belong to whichever
    // scope this panel instance is currently displaying. Untagged legacy
    // events default to 'global' so they remain visible in the global panel.
    const evScope = payload && payload.scope === 'tab' ? 'tab' : 'global';
    if (evScope !== this._scope) return false;
    if (this._scope === 'tab') {
      const evTabId = payload && payload.tabId ? String(payload.tabId) : null;
      if (evTabId !== this._tabId) return false;
    }
    return true;
  }

  initialize(contextProvider) {
    this.contextProvider = typeof contextProvider === 'function' ? contextProvider : () => ({});
    this._buildDom();
    this._agentLane.wireIpc();
    this._wireSession();
    this._engineControl.wireIpc();
    // Hydrate the persisted chat settings once; both guard for a not-yet-built
    // DOM so calling them before initialize is harmless.
    this._chatLane.loadFeatures();
    this._composer.loadRouteMode();
  }

  _buildDom() {
    if (!document || !document.body) return;
    if (this.overlay) return;

    const content = document.createElement('div');
    content.className = 'agent-panel agent-panel-v2';
    content.innerHTML = panelTemplate();
    this.overlay = content;
    this._transcript.mount(content);
    this._agentLane.mount(content);
    this._planPanel.mount(/** @type {HTMLElement} */ (this.approvalEl.parentNode), this.approvalEl);
    this._sessionStore.setApprovalQueue(this._agentLane.approvals);
    this._composer.mount(content);
    this._personaControl.mount(content);
    this._engineControl.mount(content);
    this._controller.mountHistory(content);
    /** @type {HTMLButtonElement} */ (content.querySelector('.agent-panel-close')).addEventListener('click', () => this.close());
    /** @type {HTMLButtonElement} */ (content.querySelector('.agent-panel-new')).addEventListener('click', () => this._newChat());
    this._subscribeChatSettings();
    /** @type {HTMLButtonElement} */ (content.querySelector('.agent-panel-export')).addEventListener('click', () => this._exportTranscript());
    /** @type {HTMLButtonElement} */ (content.querySelector('.agent-panel-shortcuts')).addEventListener('click', () => this._composer.showShortcuts());
    const actionsWrap = this._mountAssistantMenu(content);
    this._composer.bindEnterToSend(/** @type {HTMLInputElement} */ (actionsWrap.querySelector('.agent-panel-enter-to-send-cb')));
    this._transcript.setupAutoFollow();
  }

  // Keep feature flags and route override (settings.chat.*) synced with
  // Settings → Chat. The panel is a long-lived singleton, so these
  // subscriptions live for the app's lifetime — no teardown on close.
  _subscribeChatSettings() {
    // Path listeners match exact paths only, so each leaf key gets its own subscription (Settings writes per-key).
    ['settings.chat.features.webSearch', 'settings.chat.features.readTopPage', 'settings.chat.features.thinkStepByStep'].forEach((p) => configBridge.onPathChange(p, () => this._chatLane.loadFeatures()));
    configBridge.onPathChange('settings.chat.mode', () => this._composer.loadRouteMode());
    // Bulk refresh (config:update / config:replace) re-reads the bridge's cache without re-firing the
    // path listeners above, so a full settings reset would leave these stale. Re-hydrate on bulk payloads.
    configBridge.onChange((payload) => {
      if (payload && (payload.kind === 'update' || payload.kind === 'replace')) {
        this._chatLane.loadFeatures();
        this._composer.loadRouteMode();
      }
    });
  }

  // AssistantMenu rehosts every secondary header control (engine, quality,
  // persona, conversation actions, project bar) into a single ⋯ popover.
  // Listeners on the vault elements are wired before this runs, so
  // reparenting carries them along. Returns the adopted actions row.
  /** @param {HTMLElement} content */
  _mountAssistantMenu(content) {
    this._assistantMenu = new AssistantMenu({
      host: /** @type {HTMLElement} */ (content.querySelector('.agent-panel-menu-slot')),
      // Land on the Chat tab — the chat feature toggles the panel exposes
      // live here. The engine chip is the shortcut to Settings → LLM.
      onOpenSettings: () => this._openSettingsTab('chat'),
    });
    this._assistantMenu.mount();
    this._assistantMenu.adopt('engine', this.engineBtn);
    this._assistantMenu.adopt('backend', this.engineBackendSelect);
    this._assistantMenu.adopt('model', this.engineModelSelect);
    this._assistantMenu.adopt('quality', /** @type {HTMLElement} */ (content.querySelector('.agent-panel-quality')));
    this._assistantMenu.adopt('persona', /** @type {HTMLElement} */ (content.querySelector('.agent-panel-persona-wrap')));
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'assistant-menu-actions';
    actionsWrap.appendChild(/** @type {HTMLElement} */ (content.querySelector('.agent-panel-export')));
    actionsWrap.appendChild(/** @type {HTMLElement} */ (content.querySelector('.agent-panel-shortcuts')));
    actionsWrap.appendChild(/** @type {HTMLElement} */ (content.querySelector('.agent-panel-enter-to-send')));
    this._assistantMenu.adopt('actions', actionsWrap);
    this._assistantMenu.adopt('project', /** @type {HTMLElement} */ (content.querySelector('.agent-panel-project-slot')));
    return actionsWrap;
  }

  _refreshInputHint() {
    if (!this.input) return;
    this.input.setAttribute('placeholder', this._composer.inputHint());
  }

  _openSettingsTab(tab) {
    const ctx = (this.contextProvider && this.contextProvider()) || {};
    const sm = ctx.settingsMenu;
    if (sm && typeof sm.showTab === 'function') sm.showTab(tab);
  }

  // The session store drives the plan panel, the thread's version switchers,
  // any background run of the shown session and every onSessionChange
  // subscriber (the composer's permission pill and context meter among them).
  _wireSession() {
    const store = this._sessionStore;
    store.wire();
    store.on('session', (id) => {
      this.clearPersistWarning();
      this._planPanel.clear();
      for (const cb of Array.from(this._sessionListeners)) cb(id);
    });
    store.on('snapshot', (_snap, meta) => {
      const idle = !this._chatReqId && (!this.statusEl || this.statusEl.getAttribute('data-status') !== 'running');
      if (meta && meta.headChanged && idle && !this._chatThread.matchesPath()) this._chatThread.rebuild();
      else this._chatThread.applySnapshot();
    });
    store.on('plan', (plan) => this._planPanel.setPlan(plan));
    store.on('plan-proposed', (p) => this._planPanel.showProposal(p));
    store.on('plan-decided', () => this._planPanel.hideProposal());
    store.on('event', (ev) => this._chatThread.onSessionEvent(ev));
    store.on('persist-failed', ({ error }) => this.warnPersistFailure(`This conversation is not being saved: ${error}`));
  }

  // Persist failures are data loss, not a transient hiccup: the warning is
  // sticky (timeout 0 — never auto-dismisses) and carries an action, and it
  // is shown once per failure episode until a later persist succeeds or the
  // session changes (both call clearPersistWarning).
  warnPersistFailure(message) {
    if (this._persistWarned) return;
    this._persistWarned = true;
    const id = toast.warn(message, { timeout: 0, action: { label: 'Open sessions', onClick: () => this._openHistory() } });
    if (id) this._persistToastId = id;
  }

  // Recovery: a later successful persist or a session switch proves the
  // conversation is safe — drop the warning and re-arm for the next failure.
  clearPersistWarning() {
    this._persistWarned = false;
    if (this._persistToastId) {
      toast.dismiss(this._persistToastId);
      this._persistToastId = null;
    }
  }

  /** @param {{ toggle?: boolean }} [opts] @returns {boolean} whether history is showing */
  _showHistory(opts) {
    const panes = this.overlay ? SidePanes.forContent(this.overlay) : null;
    return panes ? panes.showHistory(opts) : false;
  }

  _openHistory() { this._showHistory(); }

  /**
   * Public: show a saved session in the panel (sessions list, inbox, launcher).
   * @param {string} sessionId
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  loadSession(sessionId) {
    if (!this.overlay) this._buildDom();
    if (!this.overlay) return Promise.resolve({ ok: false, error: 'panel_unavailable' });
    return this._controller.openSession(sessionId);
  }

  /**
   * Public: follow the session the panel shows. The callback receives the new
   * session id (null for an unsaved new chat); it is not called at subscribe
   * time. Returns an unsubscribe function.
   * @param {(sessionId: string|null) => void} cb
   * @returns {() => void}
   */
  onSessionChange(cb) {
    if (typeof cb !== 'function') throw new TypeError('AgentPanel.onSessionChange expects a function');
    this._sessionListeners.add(cb);
    return () => { this._sessionListeners.delete(cb); };
  }

  /** @returns {string|null} the session the panel shows */
  activeSessionId() { return this._sessionStore.activeSessionId; }

  // -- Private entry points the existing AgentPanel tests drive directly ----
  _run(prefillDescription) { return this._controller.run(prefillDescription); }
  _newChat() { return this._controller.newChat(); }
  _openHistoryRun(id) { return this._controller.openHistoryRun(id); }
  _retryHistoryRun(id) { return this._controller.retryHistoryRun(id); }
  _openHistoryRunAsNew(id) { return this._controller.openHistoryRunAsNew(id); }
  _setStatus(status) { this._transcript.setStatus(status); }
  _setStartersVisible(visible) { this._transcript.setStartersVisible(visible); }
  _renderUserMessage(description) { this._transcript.renderUserMessage(description); }
  _renderAssistantLabel() { this._transcript.renderAssistantLabel(); }
  _resetTranscript() { this._transcript.reset(); }
  _prepareFollowUpTurn() { this._transcript.prepareFollowUpTurn(); }
  _replayEvent(ev) { this._transcript.replayEvent(ev); }
  _exportTranscript() { this._transcript.exportMarkdown(); }
  _setRouteMode(mode) { this._composer.setRouteMode(mode); }
  _renderEngineButton() { this._engineControl.renderButton(); }
  _toggleEngine() { return this._engineControl.toggle(); }
  _loadChatFeatures() { this._chatLane.loadFeatures(); }
  _setQualityMode(mode) { this._agentLane.setQualityMode(mode); }
  _renderEgressScope() { this._agentLane.renderEgressScope(); }
  _renderApprovalPrompt(payload) { this._agentLane.renderApprovalPrompt(payload); }
  _delay(ms) { return this._councilLane.delay(ms); }
  _openSession(id) { return this._controller.openSession(id); }

  // opts.mode 'assistant' flips to the full assistant view; otherwise browser
  // mode shows the sidebar and assistant mode just focuses the composer.
  open(opts) {
    if (!this.overlay) this._buildDom();
    if (!this.overlay) return;
    const nextScope = opts && opts.scope === 'tab' ? 'tab' : 'global';
    const nextTabId = nextScope === 'tab' && opts && opts.tabId ? String(opts.tabId) : null;
    const nextTitle = (opts && opts.tabTitle) || null;
    const scopeChanged = (nextScope !== this._scope) || (nextTabId !== this._tabId);
    this._scope = nextScope;
    this._tabId = nextTabId;
    this._tabTitle = nextTitle;
    if (scopeChanged) {
      this._transcript.reset();
      this._transcript.setStatus('idle');
      // A different scope is a different thread: its own history, its own workspace.
      this._chatHistory = [];
      this._agentThreadActive = false;
      this._activeTaskId = null;
      this._activeDescription = '';
      this._sessionStore.reset();
      this._transcript.setStartersVisible(true);
    }
    this._transcript.renderScopeLabel();
    const wasOpen = this._isOpen;
    const shell = this._shell();
    if (opts && opts.mode === 'assistant') shell.setMode('assistant', { focus: false });
    else if (shell.getMode() === 'browser') shell.openSidebar();
    // Becoming visible already refreshed via _onVisibilityChange.
    if (wasOpen) this._refreshOnShow();
    this._focusComposer();
  }

  _refreshOnShow() {
    // Refresh history on show so the user sees their latest runs (scoped).
    if (this._history) this._history.refresh();
    // Populate the inline Backend/Model selects once the panel is live, so
    // they're ready when the user opens the Assistant menu.
    if (!this._engineBackends) this._engineControl.refreshPopover();
  }

  // Public: open the panel and immediately run an agent task with the given text. Used by NewTabPicker's quick-ask box, routines, packs, and other surfaces that want to send a task without re-typing. Programmatic dispatch always runs the agent loop (callers track completion via agent:* events), bypassing intent routing entirely. `opts.userSend` marks a task the user sent by hand (not a scheduled routine).
  openWithTask(text, opts) {
    this.open(opts);
    if (this.input) this.input.value = String(text || '');
    if (typeof text === 'string' && text.trim()) {
      if (opts && opts.userSend) this._controller.noteUserSend();
      // Defer one frame so the panel finishes opening (focus + layout)
      // before we kick off the task — keeps the UX consistent with manual run.
      // Force the agent lane: programmatic dispatch must not depend on intent routing.
      const start = () => { try { this._agentLane.run(text); } catch (err) { console.error('quick-task run failed', (err instanceof Error && err.message) || err); } };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(start);
      else setTimeout(start, 0);
    }
  }

  // Public: open the unified chat focused for typing, optionally with a prefill. Lets CommandPalette page tools ("Ask About This Page") and slash seeds (/council, /research) land in the one surface instead of a separate overlay. `context` is accepted for call-site compatibility; context attaches automatically (active page always; @selection/@spaces/@browsing via typed tokens).
  openChat(opts = {}) {
    this.open(opts);
    if (this.input && typeof opts.prefill === 'string') this.input.value = opts.prefill;
    const focus = () => {
      if (!this.input) return;
      this.input.focus();
      // Put the caret after any seeded slash-command so the user types right in.
      const end = this.input.value.length;
      if (typeof this.input.setSelectionRange === 'function') this.input.setSelectionRange(end, end);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
    else setTimeout(focus, 0);
  }

  // Public: open the unified chat and immediately run a transform slash-action
  // (summarize/explain/compare) against the active page, selection, or panes. Runs through _run
  // so routing applies — these actions land on the fast answer path by design.
  openChatAction(action, opts = {}) {
    this.open(opts);
    const cmd = '/' + String(action || '').trim();
    const start = () => { try { this._run(cmd); } catch (err) { console.error('slash-action _run failed', err instanceof Error ? err.message : err); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(start); else setTimeout(start, 0);
  }

  // Browser mode: collapse the sidebar and hand focus back to the page.
  // Assistant mode: leave for browser mode with the sidebar closed, since
  // "close the Assistant" cannot mean an empty main pane.
  close() {
    if (!this._viewShell || !this._isOpen) return;
    const shell = this._viewShell;
    if (shell.getMode() === 'assistant') {
      shell.store.set('sidebarOpen', false);
      shell.setMode('browser');
    } else {
      shell.closeSidebar();
    }
  }

  _focusComposer() {
    if (this.input && this.input.isConnected) this.input.focus();
  }

  /** @returns {boolean} true while the panel is open. */
  isOpen() { return this._isOpen; }

  /**
   * Subscribe to open/close transitions. The callback receives the new state
   * (true on open, false once fully closed); it is not called for the current
   * state at subscribe time. Returns an unsubscribe function.
   * @param {(open: boolean) => void} cb
   * @returns {() => void}
   */
  onOpenChange(cb) {
    if (typeof cb !== 'function') throw new TypeError('AgentPanel.onOpenChange expects a function');
    this._openListeners.add(cb);
    return () => { this._openListeners.delete(cb); };
  }

  _emitOpenChange(open) {
    for (const cb of Array.from(this._openListeners)) cb(open);
  }

  // Fires on every shown/hidden transition: open(), close(), Esc, the flip
  // shortcut, and the toolbar pills.
  _onVisibilityChange(visible) {
    if (visible === this._isOpen) return;
    this._isOpen = visible;
    if (visible) {
      document.addEventListener('keydown', this._onKeyDown);
      this._refreshOnShow();
    } else {
      document.removeEventListener('keydown', this._onKeyDown);
    }
    this._emitOpenChange(visible);
  }

  // The sidebar is not modal: panel keys apply only while focus is inside it,
  // so Cmd+K on the toolbar still opens the palette.
  _keyInPanel(e) {
    const shell = this._viewShell;
    if (!shell) return false;
    const target = e.target instanceof Node ? e.target : null;
    return shell.contains(target) || shell.contains(document.activeElement);
  }

  toggle() { if (this._isOpen) this.close(); else this.open(); }

  _onKeyDown(e) {
    if (!this._keyInPanel(e)) return;
    if (e.key === 'Escape') {
      // An open modal layer owns Esc; the sidebar stays as it is underneath.
      if (modalStack.depth() > 0) return;
      e.preventDefault();
      if (this._answerView && this._answerView._typer && this._answerView._typer.isRunning()) {
        this._answerView.skip();
        return;
      }
      // Assistant mode is a view, not an overlay: Esc does not leave it. In
      // browser mode Esc closes the sidebar and the shell hands focus back to
      // the page (the webview the user came from, else the active one).
      if (this._viewShell && this._viewShell.getMode() === 'browser') this.close();
      return;
    }
    // Cmd/Ctrl+K belongs to the remappable global palette; the panel must not bind it.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      if (this._showHistory({ toggle: true }) && this._historyRail && this._historyRail.isOpen() && this._history) this._history.focusSearch();
      return;
    }
    this._personaControl.onPanelKey(e);
  }
}

module.exports = new AgentPanel();
