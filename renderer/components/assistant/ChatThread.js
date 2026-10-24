// ChatThread — the persisted, branching conversation inside the Assistant
// panel's transcript. It renders every message as Markdown (MessageView),
// rebuilds the whole head path from the session tree when the path changes
// (open, branch switch, edit, regenerate, rewind), keeps version switchers in
// step with the tree, and performs the per-message session actions.
//
// The live turn still streams through TranscriptView / AnswerView / ToolStream;
// once its nodes are persisted, the thread binds their ids to the views so the
// turn gains the same actions as every earlier message.
// State shared with the lanes lives on the panel (host).

const MessageView = require('./MessageView');
const { ToolCallGroup } = require('./ToolCallGroup');
const RewindDialog = require('./RewindDialog');
const { CHAT_HISTORY_TURNS } = require('./AssistantController');
const toast = require('../Toast');
const { errMsg } = require('../../../shared/errMsg');
const { afterCompaction } = require('../../../main/agent/sessions/contextProjection');

const SESSION_ERRORS = {
  session_busy: 'Wait for the current run to finish first.',
  not_a_user_message: 'Only your own messages can be used for that.',
  session_not_found: 'This conversation no longer exists.',
  invalid_content: 'Write a message to send.',
};

const friendly = (code) => SESSION_ERRORS[code] || String(code || 'Request failed.');

const isMessage = (n) => n && n.kind === 'message' && (n.role === 'user' || n.role === 'assistant');
const laneOf = (userNode) => (userNode && userNode.data && userNode.data.lane === 'chat' ? 'chat' : 'agent');

/** @param {string} tag @param {string} [className] @param {string} [text] */
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {string} className @param {string} text @returns {HTMLButtonElement} */
function button(className, text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  return b;
}

function copyText(text) {
  const { clipboard } = require('electron');
  if (clipboard && typeof clipboard.writeText === 'function') {
    clipboard.writeText(text);
    return Promise.resolve();
  }
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
  if (!clip || typeof clip.writeText !== 'function') return Promise.reject(new Error('Clipboard is unavailable'));
  return Promise.resolve(clip.writeText(text));
}

function transcriptMarkdown(messages) {
  return messages
    .map((m) => `## ${m.role === 'user' ? 'You' : 'Assistant'}\n\n${m.content}`)
    .join('\n\n');
}

class ChatThread {
  /**
   * @param {any} host the AgentPanel
   * @param {{ store: import('./SessionStore').SessionStore, ipc?: { invoke: Function } }} opts
   */
  constructor(host, opts) {
    if (!opts || !opts.store) throw new TypeError('ChatThread requires a SessionStore');
    this.host = host;
    this.store = opts.store;
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    /** @type {Map<string, MessageView>} */ this._byNode = new Map();
    /** @type {WeakMap<Element, MessageView>} */ this._byEl = new WeakMap();
    /** @type {MessageView|null} */ this._liveUser = null;
    /** @type {MessageView|null} */ this._liveBar = null;
    this._liveLane = null;
    /** @type {{ view: MessageView|null, tools: ToolCallGroup|null }|null} */ this._bgTurn = null;
    this._busy = false;
    this._actions = {
      onCopy: (v) => this.copy(v),
      onEdit: (v, text) => this.editAndResend(v, text),
      onRegenerate: (v) => this.regenerate(v),
      onFork: (v) => this.fork(v),
      onRewind: (v) => this.rewind(v),
      onSkill: (v) => this.draftSkill(v),
      onExport: (v) => this.exportUpTo(v),
      onBranch: (_v, siblingId) => this.switchBranch(siblingId),
    };
    this.rewindDialog = new RewindDialog({
      ipc: this._ipc,
      getRoot: () => host.overlay,
      onRewound: (res, view) => this._afterRewind(res, view),
    });
  }

  get transcriptEl() { return this.host._transcriptEl; }

  _track(view) {
    this._byEl.set(view.el, view);
    if (view.nodeId) this._byNode.set(view.nodeId, view);
    view.setBusy(this._busy);
    return view;
  }

  _view(role, text, nodeId, lane) {
    return this._track(new MessageView({ role, text, nodeId, lane, actions: this._actions }));
  }

  // -- Live turn ------------------------------------------------------------

  /** @returns {MessageView|null} */
  addUser(text, nodeId, lane) {
    const t = String(text || '').trim();
    if (!t) return null;
    const v = this._view('user', t, nodeId || null, lane || null);
    this.transcriptEl.appendChild(v.el);
    this._liveUser = v;
    if (nodeId) this._applyBranch(v);
    return v;
  }

  // The previous live answer leaves the answer slot as a Markdown message
  // that keeps its node id, so earlier answers keep their actions.
  freezeAnswer(markdown) {
    const text = String(markdown || '');
    const nodeId = this._liveBar ? this._liveBar.nodeId : null;
    const lane = this._liveLane;
    this._dropLiveBar();
    if (!text) return null;
    const v = this._view('assistant', text, nodeId, lane);
    this.transcriptEl.appendChild(v.el);
    if (nodeId) this._applyBranch(v);
    return v;
  }

  /**
   * Bind persisted ids to the live turn's views once main has written them.
   * @param {{ userNodeId?: string|null, assistantNodeId?: string|null, lane?: string, answer?: string }} ids
   */
  bindTurn(ids) {
    const o = ids || {};
    this._liveLane = o.lane || this._liveLane;
    if (o.userNodeId && this._liveUser && !this._liveUser.nodeId) {
      this._liveUser.setNodeId(o.userNodeId);
      this._byNode.set(o.userNodeId, this._liveUser);
    }
    if (o.assistantNodeId) this._mountLiveBar(o.assistantNodeId, o.answer || '');
    this.applySnapshot();
  }

  // The live answer keeps rendering in AnswerView; its actions ride in a bar
  // under it, backed by a MessageView without a body.
  _mountLiveBar(nodeId, answer) {
    this._dropLiveBar();
    const slot = this.host._answerView && this.host._answerView._root;
    if (!slot) return;
    const v = this._view('assistant', answer, nodeId, this._liveLane);
    v.el.classList.add('chat-msg--live-bar');
    v.bodyEl.hidden = true;
    const bar = node('div', 'chat-live-actions');
    bar.appendChild(v.el);
    slot.appendChild(bar);
    this._liveBar = v;
    this._liveBarEl = bar;
    this._applyBranch(v);
  }

  _dropLiveBar() {
    if (this._liveBar && this._liveBar.nodeId) this._byNode.delete(this._liveBar.nodeId);
    if (this._liveBar) this._liveBar.destroy();
    if (this._liveBarEl) this._liveBarEl.remove();
    this._liveBar = null;
    this._liveBarEl = null;
  }

  // TranscriptView.reset empties the list; the thread forgets its views.
  clear() {
    this._dropLiveBar();
    this._byNode.clear();
    this._liveUser = null;
    this._liveLane = null;
    this._bgTurn = null;
  }

  // While a run owns the session head, edit / regenerate / branch are refused
  // by main, so the controls are disabled rather than left to fail.
  setBusy(busy) {
    this._busy = !!busy;
    for (const v of this._byNode.values()) v.setBusy(this._busy);
    if (this._liveUser) this._liveUser.setBusy(this._busy);
  }

  // -- Snapshot → views -----------------------------------------------------

  applySnapshot() {
    for (const v of this._byNode.values()) this._applyBranch(v);
  }

  _applyBranch(view) {
    view.setBranch(view.nodeId ? this.store.branchOf(view.nodeId) : null);
  }

  /** True when every persisted message on the head path already has a view, in order. */
  matchesPath() {
    const want = this.store.pathNodes().filter(isMessage).map((n) => n.id);
    const have = Array.from(this.transcriptEl.children)
      .map((el) => this._byEl.get(el))
      .filter((v) => v && v.nodeId)
      .map((v) => v.nodeId);
    if (this._liveBar && this._liveBar.nodeId) have.push(this._liveBar.nodeId);
    return want.length === have.length && want.every((id, i) => id === have[i]);
  }

  // Render the head path from scratch. The panel's shared thread history is
  // refilled from the same path so the next turn's context matches the screen.
  rebuild() {
    const h = this.host;
    h._transcript.reset();
    const nodes = this.store.pathNodes();
    /** @type {ToolCallGroup|null} */
    let tools = null;
    const closeTools = (ok) => { if (tools) { tools.finish(ok); tools = null; } };
    let lastUser = null;
    for (const n of nodes) {
      if (n.kind === 'compaction') { closeTools(true); this._renderDivider('Earlier messages were summarized to save context.'); continue; }
      if (n.role === 'system') continue;
      if (n.kind === 'tool_calls') {
        if (!tools) tools = new ToolCallGroup({ root: this.transcriptEl });
        tools.addCallsNode(n);
        continue;
      }
      if (n.kind === 'tool_results') {
        if (!tools) tools = new ToolCallGroup({ root: this.transcriptEl });
        tools.addResultsNode(n);
        continue;
      }
      closeTools(n.kind !== 'error');
      const lane = n.role === 'user' ? laneOf(n) : (lastUser ? laneOf(lastUser) : null);
      let v = null;
      if (n.kind === 'error') v = this._view('error', n.content, n.id, lane);
      else if (n.kind === 'plan') v = this._view('plan', n.content || this._planText(n), n.id, lane);
      else if (isMessage(n)) v = this._view(n.role, n.content, n.id, lane);
      if (!v) continue;
      this.transcriptEl.appendChild(v.el);
      this._applyBranch(v);
      if (n.role === 'user') { lastUser = n; this._liveUser = v; }
    }
    closeTools(true);
    h._chatHistory = this.historyFromPath(nodes);
    h._transcript.setStartersVisible(nodes.filter(isMessage).length === 0);
    h._transcript.setStatus('idle');
  }

  _planText(n) {
    const plan = n.data && n.data.plan;
    if (!plan) return 'Proposed a plan.';
    const todos = Array.isArray(plan.todos) ? plan.todos.map((t) => `- ${t.content}`).join('\n') : '';
    return [plan.summary, todos].filter(Boolean).join('\n\n');
  }

  _renderDivider(text) {
    const li = node('li', 'chat-divider', text);
    li.setAttribute('role', 'separator');
    this.transcriptEl.appendChild(li);
  }

  // Complete user→assistant pairs after the newest compaction only (its
  // summary rides in the system prompt): a trailing user turn is the one about
  // to be answered and is sent separately.
  historyFromPath(nodes) {
    const out = [];
    let pendingUser = null;
    for (const n of afterCompaction(nodes).rest) {
      if (!isMessage(n)) continue;
      if (n.role === 'user') { pendingUser = n; continue; }
      if (pendingUser && String(n.content || '').trim()) {
        out.push({ role: 'user', content: pendingUser.content }, { role: 'assistant', content: n.content });
      }
      pendingUser = null;
    }
    return out.slice(-CHAT_HISTORY_TURNS * 2);
  }

  /** The newest compaction summary on the open session's path; '' without one. */
  compactionSummary() {
    const { summary } = afterCompaction(this.store.pathNodes());
    return summary ? String(summary.content || '') : '';
  }

  /** The conversation as shown, oldest first, through `uptoView` when given. */
  messagesShown(uptoView) {
    const out = [];
    for (const el of Array.from(this.transcriptEl.children)) {
      const v = this._byEl.get(el);
      if (!v || (v.role !== 'user' && v.role !== 'assistant')) continue;
      out.push({ role: v.role, content: v.text });
      if (v === uptoView) return out;
    }
    const live = this.host._answerView && this.host._answerView.getMarkdown();
    if (live) out.push({ role: 'assistant', content: live });
    return out;
  }

  // -- Actions --------------------------------------------------------------

  _sessionCall(channel, payload) {
    return Promise.resolve(this._ipc.invoke(channel, payload)).then((res) => {
      if (!res || !res.ok) throw new Error(friendly(res && res.error));
      return res;
    });
  }

  _report(prefix, err) {
    toast.error(`${prefix}: ${errMsg(err)}`);
  }

  copy(view) {
    const text = view === this._liveBar ? (this.host._answerView.getMarkdown() || view.text) : view.text;
    return copyText(text).then(
      () => toast.success('Message copied'),
      (err) => this._report('Couldn’t copy the message', err),
    );
  }

  // Edit creates a sibling user turn; the answer is then produced on the lane
  // that answered the original. Throws so the editor can show the failure.
  async editAndResend(view, text) {
    const sessionId = this.store.activeSessionId;
    if (!sessionId || !view.nodeId) throw new Error('This message is not saved yet.');
    const original = this.store.node(view.nodeId);
    const res = await this._sessionCall('session:edit', { sessionId, nodeId: view.nodeId, content: text });
    await this._resend(res.node, laneOf(original || res.node));
  }

  async regenerate(view) {
    const sessionId = this.store.activeSessionId;
    if (!sessionId || !view.nodeId) return;
    try {
      const res = await this._sessionCall('session:regenerate', { sessionId, nodeId: view.nodeId });
      await this._resend(res.node, laneOf(res.node));
    } catch (err) {
      this._report('Couldn’t regenerate', err);
    }
  }

  async _resend(userNode, lane) {
    if (!userNode || !userNode.id) throw new Error('Main returned no message to answer.');
    await this.store.refresh();
    this.rebuild();
    if (lane === 'chat') await this.host._chatLane.resend(userNode);
    else await this.host._agentLane.resend(userNode);
  }

  async switchBranch(siblingId) {
    const sessionId = this.store.activeSessionId;
    if (!sessionId) return;
    try {
      const res = await this._sessionCall('session:branch', { sessionId, nodeId: siblingId });
      this.store.setSnapshot(res);
      this.rebuild();
    } catch (err) {
      this._report('Couldn’t switch versions', err);
    }
  }

  async fork(view) {
    const sessionId = this.store.activeSessionId;
    if (!sessionId || !view.nodeId) return;
    try {
      const res = await this._sessionCall('session:fork', { sessionId, nodeId: view.nodeId });
      await this.host._openSession(res.session.id);
      toast.success('Forked into a new chat');
    } catch (err) {
      this._report('Couldn’t fork the chat', err);
    }
  }

  rewind(view) {
    const sessionId = this.store.activeSessionId;
    if (!sessionId || !view.nodeId || view.role !== 'user') return Promise.resolve(false);
    return this.rewindDialog.open({ sessionId, turnId: view.nodeId, context: view });
  }

  async _afterRewind(res, view) {
    try {
      await this.store.refresh();
      this.rebuild();
    } catch (err) {
      this._report('Rewound, but couldn’t reload the conversation', err);
    }
    // The rewound prompt returns to the composer so it can be revised and resent.
    const h = this.host;
    if (view && h.input && !h.input.value.trim()) h.input.value = view.text;
    const files = (res.restored || []).length + (res.deleted || []).length;
    toast.success(files ? `Rewound the conversation and ${files} file${files === 1 ? '' : 's'}` : 'Rewound the conversation');
  }

  exportUpTo(view) {
    const md = transcriptMarkdown(this.messagesShown(view === this._liveBar ? null : view));
    return copyText(md).then(
      () => toast.success('Conversation copied as Markdown'),
      (err) => this._report('Couldn’t copy the conversation', err),
    );
  }

  async draftSkill(view) {
    const messages = this.messagesShown(view === this._liveBar ? null : view)
      .filter((m) => String(m.content || '').trim());
    if (!messages.length) { toast.info('There is nothing in this chat to turn into a skill yet.'); return null; }
    let res;
    try {
      res = await this._ipc.invoke('skills:draft-from-session', { messages });
    } catch (err) {
      this._report('Couldn’t draft a skill', err);
      return null;
    }
    if (!res || !res.ok || typeof res.markdown !== 'string') {
      this._report('Couldn’t draft a skill', new Error((res && res.error) || 'no draft returned'));
      return null;
    }
    return this._showSkillDraft(res, view);
  }

  _showSkillDraft(res, view) {
    if (this._skillCard) this._skillCard.remove();
    const card = node('li', 'chat-skill-draft');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Skill draft');
    const skill = res.skill || {};
    card.appendChild(node('div', 'chat-skill-draft__title', `New skill: ${skill.name || 'untitled'}`));
    if (skill.description) card.appendChild(node('p', 'chat-skill-draft__desc', skill.description));
    const warnings = Array.isArray(res.warnings) ? res.warnings.filter(Boolean) : [];
    if (warnings.length) {
      const ul = node('ul', 'chat-skill-draft__warnings');
      warnings.forEach((w) => ul.appendChild(node('li', '', String(w))));
      card.appendChild(ul);
    }
    const area = /** @type {HTMLTextAreaElement} */ (node('textarea', 'chat-skill-draft__markdown'));
    area.value = res.markdown;
    area.rows = 10;
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Skill file (SKILL.md)');
    const err = node('div', 'chat-skill-draft__error');
    err.setAttribute('role', 'alert');
    err.hidden = true;
    const row = node('div', 'chat-skill-draft__actions');
    const discard = button('chat-skill-draft__discard', 'Discard');
    const save = button('chat-skill-draft__save', 'Save skill');
    const replace = button('chat-skill-draft__replace', 'Replace existing');
    replace.hidden = true;
    row.append(discard, replace, save);
    card.append(area, err, row);

    const doSave = async (overwrite) => {
      save.disabled = true; replace.disabled = true;
      err.hidden = true;
      let out;
      try {
        out = await this._ipc.invoke('skills:save', { skill: { markdown: area.value }, overwrite });
      } catch (e) {
        out = { ok: false, error: errMsg(e) };
      }
      save.disabled = false; replace.disabled = false;
      if (out && out.ok) {
        card.remove();
        this._skillCard = null;
        toast.success(`Saved skill ${skill.name ? `“${skill.name}”` : ''}`.trim());
        return true;
      }
      const code = (out && out.error) || 'save failed';
      err.textContent = code === 'exists' ? 'A skill with this name already exists.' : `Couldn’t save the skill: ${code}`;
      err.hidden = false;
      replace.hidden = code !== 'exists';
      return false;
    };
    save.addEventListener('click', () => doSave(false));
    replace.addEventListener('click', () => doSave(true));
    discard.addEventListener('click', () => { card.remove(); this._skillCard = null; });

    const anchor = view && view !== this._liveBar && view.el.parentNode === this.transcriptEl ? view.el.nextSibling : null;
    this.transcriptEl.insertBefore(card, anchor);
    this._skillCard = card;
    area.focus();
    return card;
  }

  // -- Background run of the active session (session:event only) -------------

  onSessionEvent({ channel, payload }) {
    const p = payload || {};
    if (channel === 'task-started') {
      this.setBusy(true);
      this.store.refresh().then(() => this._rebuildKeepingBgTurn(), (err) => this._report('Couldn’t load the running turn', err));
      return;
    }
    if (channel === 'assistant-chunk' && typeof p.text === 'string') {
      this._ensureBgTurn().view.appendStream(p.text);
      return;
    }
    if (channel === 'compacted') {
      this.store.refresh().then(() => this.rebuild(), (err) => this._report('Couldn’t reload the conversation', err));
      return;
    }
    if (channel === 'step-planned') { this._ensureBgTools().planned({ step: p.step, calls: p.calls }); return; }
    if (channel === 'step-acted') { this._ensureBgTools().acted(p); return; }
    if (channel === 'task-completed' || channel === 'task-failed') {
      if (this._bgTurn) {
        this._bgTurn.view.endStream();
        if (this._bgTurn.tools) this._bgTurn.tools.finish(channel === 'task-completed' && p.ok !== false);
      }
      this._bgTurn = null;
      this.setBusy(false);
      this.store.refresh().then(() => this.rebuild(), (err) => this._report('Couldn’t reload the conversation', err));
    }
  }

  // Output that streamed in before the refreshed path arrived stays on screen,
  // re-attached after the rebuilt history.
  _rebuildKeepingBgTurn() {
    const prev = this._startBgTurn();
    this.rebuild();
    this._bgTurn = prev;
    if (prev.tools) this.transcriptEl.appendChild(prev.tools.el);
    if (prev.view) { this._track(prev.view); this.transcriptEl.appendChild(prev.view.el); }
    this.setBusy(true);
  }

  _startBgTurn() {
    if (!this._bgTurn) this._bgTurn = { view: null, tools: null };
    return this._bgTurn;
  }

  _ensureBgTools() {
    const t = this._startBgTurn();
    if (!t.tools) t.tools = new ToolCallGroup({ root: this.transcriptEl });
    return t.tools;
  }

  _ensureBgTurn() {
    const t = this._startBgTurn();
    if (!t.view) {
      t.view = this._view('assistant', '', null, 'agent');
      t.view.el.classList.add('chat-msg--streaming');
      this.transcriptEl.appendChild(t.view.el);
    }
    return { view: /** @type {MessageView} */ (t.view), tools: t.tools };
  }
}

module.exports = { ChatThread, transcriptMarkdown, laneOf };
