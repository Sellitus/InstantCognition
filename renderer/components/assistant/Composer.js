// Composer — the Assistant panel's input area: textarea keys (send vs.
// newline, prompt-history recall), Send/Stop/Pause buttons, voice dictation,
// starter tasks, the Auto/Chat/Agent route switch, the permission-mode pill,
// the `/` and `@` inline palette, the context-window meter (and `/compact`),
// the Projects composer and the keyboard-shortcuts sheet.
// State lives on the panel (host) so its long-standing field names stay valid.

const { ipcRenderer } = require('electron');
const Dropdown = require('../dropdown/Dropdown');
const ModeSwitch = require('../agent/ModeSwitch');
const PermissionModeSwitch = require('./PermissionModeSwitch');
const InlinePalette = require('./InlinePalette');
const ContextMeter = require('./ContextMeter');
const ProjectComposer = require('../agent/ProjectComposer');
const { createVoiceInputButton } = require('../VoiceInputButton');
const configBridge = require('../../core/configBridge');
const toast = require('../Toast');
const { errMsg } = require('../../../shared/errMsg');
const { SLASH_ACTIONS } = require('../../utils/chatContext');

// The three persisted answer-routing values (settings.chat.mode). 'auto' is the
// default: every manual send goes through routeIntent. Slash commands and openWithTask
// bypass this entirely — they carry an explicit destination of their own.
const ROUTE_MODES = ['auto', 'chat', 'agent'];

// `/<name>` that leads a message, in the skill-name grammar main validates
// (main/ipc/skillHandlers.js NAME_RE); the rest of the message is the task.
const SKILL_CALL_RE = /^\/([a-z0-9-]{1,64})(?:\s+([\s\S]*))?$/;
// Commands the composer or the run path handle themselves; never looked up as skills.
const BUILTIN_SLASH = new Set([...SLASH_ACTIONS, 'compact']);

const PROMPT_HISTORY_KEY = 'agent.promptHistory';
const PROMPT_HISTORY_MAX = 50;
const ENTER_TO_SEND_KEY = 'agent.enterToSend';

class Composer {
  /** @param {import('../AgentPanel')} host */
  constructor(host) {
    this.host = host;
    /** @type {PermissionModeSwitch|null} */
    this.permissionMode = null;
    /** @type {InlinePalette|null} */
    this.palette = null;
    /** @type {ContextMeter|null} */
    this.contextMeter = null;
    /** @type {boolean} true while a `/skill` send is resolving, so a repeat Enter cannot start it twice */
    this._skillPending = false;
  }

  /** @param {HTMLElement} content */
  mount(content) {
    const h = this.host;
    h.input = /** @type {HTMLTextAreaElement} */ (content.querySelector('.agent-panel-input'));
    h.runBtn = /** @type {HTMLButtonElement} */ (content.querySelector('.agent-panel-run'));
    h.stopBtn = /** @type {HTMLButtonElement} */ (content.querySelector('.agent-panel-stop'));
    h.pauseBtn = /** @type {HTMLButtonElement} */ (content.querySelector('.agent-panel-pause'));
    h.voiceBtn = createVoiceInputButton({
      target: h.input,
      label: 'Dictate to the Assistant',
      getConfig: () => configBridge.get('settings.voice', {}) || {},
    });
    const controls = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-controls'));
    if (controls && h.stopBtn) controls.insertBefore(h.voiceBtn, h.stopBtn);
    // Answer-mode override: auto routing, or force every manual send down chat/agent.
    h._modeSwitch = new ModeSwitch({ onSelect: (mode) => this.setRouteMode(mode) });
    const modeSlot = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-mode-slot'));
    modeSlot.appendChild(h._modeSwitch.el);
    // Any open listbox in the composer (the @-mention list, the inline
    // palette) owns Shift+Tab, so the permission mode only cycles without one.
    const composerEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-composer'));
    this.permissionMode = new PermissionModeSwitch({
      getInput: () => h.input,
      isPopupOpen: () => !!composerEl.querySelector('[role="listbox"]:not([hidden])'),
      isShiftTabEnabled: () => configBridge.get('settings.assistant.shiftTabCycles', true) !== false,
    });
    modeSlot.insertAdjacentElement('afterend', this.permissionMode.el);
    this.permissionMode.load();
    this.contextMeter = new ContextMeter({
      scopeMatches: (p) => typeof h._scopeMatches !== 'function' || h._scopeMatches(p),
    });
    const budget = controls && controls.querySelector('.agent-panel-budget');
    if (budget) budget.insertAdjacentElement('afterend', this.contextMeter.el);
    else if (controls) controls.appendChild(this.contextMeter.el);
    // The pill and the meter follow whichever session the panel shows.
    h.onSessionChange((id) => this.trackSession(id));
    this.trackSession(h.activeSessionId());
    h._startersEl = /** @type {HTMLElement} */ (content.querySelector('.agent-panel-starters'));
    if (h._startersEl) {
      // Starters run immediately through the same auto-routing path a typed send uses.
      h._startersEl.addEventListener('click', (e) => {
        const tgt = /** @type {HTMLElement} */ (e.target);
        const btn = tgt && tgt.closest && /** @type {HTMLElement} */ (tgt.closest('button[data-starter]'));
        if (!btn || !h.input) return;
        try { h._run(btn.dataset.starter || ''); } catch (err) { console.error('starter run failed', (err instanceof Error && err.message) || err); }
      });
    }
    h._projectComposer = new ProjectComposer({
      host: /** @type {HTMLElement} */ (content.querySelector('.agent-panel-project-slot')),
      input: h.input,
    });
    h._projectComposer.mount().catch((err) => console.error('ProjectComposer mount failed', (err instanceof Error && err.message) || err));
    // After the project composer wired its input listener, so the palette reads
    // the @-mention menu's state for the same keystroke and stays out of its way.
    this.palette = new InlinePalette({
      input: h.input,
      container: composerEl,
      onCommand: (cmd) => this.runCommand(cmd),
    });
    h.runBtn.addEventListener('click', () => this.send());
    h.stopBtn.addEventListener('click', () => h._controller.stop());
    h.pauseBtn.addEventListener('click', () => this.togglePause());
  }

  // Runs after the AssistantMenu adopted the actions row, so the checkbox is
  // looked up in its new home rather than in the panel content.
  /** @param {HTMLInputElement | null} checkbox */
  bindEnterToSend(checkbox) {
    const h = this.host;
    h._enterToSendCb = checkbox;
    const savedPref = this.loadEnterPref();
    if (h._enterToSendCb) {
      h._enterToSendCb.checked = savedPref;
      h._enterToSendCb.addEventListener('change', () => {
        this.saveEnterPref(!!h._enterToSendCb.checked);
        h._refreshInputHint();
      });
    }
    h._refreshInputHint();
    h.input.addEventListener('keydown', (e) => this.onInputKey(e));
  }

  /** @param {KeyboardEvent} e */
  onInputKey(e) {
    const h = this.host;
    if (this.palette && this.palette.onKey(e)) return;
    if (this.permissionMode && this.permissionMode.onComposerKey(e)) return;
    // Up/Down at start/end of textarea — cycle through recent prompt history.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && h.input) {
      const v = h.input.value || '';
      const caret = typeof h.input.selectionStart === 'number' ? h.input.selectionStart : 0;
      const atStart = caret === 0 && (e.key === 'ArrowUp');
      const atEnd = caret === v.length && (e.key === 'ArrowDown');
      if (atStart || atEnd) {
        const cycled = this.cyclePromptHistory(e.key === 'ArrowUp' ? -1 : 1);
        if (cycled !== null) { e.preventDefault(); h.input.value = cycled; try { h.input.setSelectionRange(cycled.length, cycled.length); } catch (err) { console.error('setSelectionRange failed', (err instanceof Error && err.message) || err); } return; }
      }
    }
    if (e.key !== 'Enter') return;
    if (e.isComposing) return; // IME composing — never hijack
    const enterToSend = !!(h._enterToSendCb && h._enterToSendCb.checked);
    const cmdEnter = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
    const shiftEnter = e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
    const plainEnter = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
    // Cmd/Ctrl+Enter always sends. Otherwise the checkbox decides which
    // modifier sends vs. inserts a newline.
    if (cmdEnter) { e.preventDefault(); this.send(); return; }
    if (enterToSend && plainEnter) { e.preventDefault(); this.send(); return; }
    if (!enterToSend && shiftEnter) { e.preventDefault(); this.send(); return; }
    // Everything else (including the opposite-modifier combo) falls through
    // to the textarea's default behavior, which inserts a newline.
  }

  // A manual send: composer-local commands run here, `/<skill>` runs an enabled
  // skill, everything else goes to the panel's run path (routing, slash
  // actions, chat/agent lanes). Resolves once the send was dispatched.
  /** @returns {Promise<void>} */
  send() {
    const h = this.host;
    const text = h.input ? String(h.input.value || '').trim() : '';
    if (/^\/compact$/i.test(text) && this.runCommand({ name: 'compact', kind: 'builtin' })) {
      h.input.value = '';
      h.input.dispatchEvent(new Event('input', { bubbles: true }));
      return Promise.resolve();
    }
    const call = SKILL_CALL_RE.exec(text);
    if (!call || BUILTIN_SLASH.has(call[1])) {
      h._run();
      return Promise.resolve();
    }
    return this.sendSkill(call[1], (call[2] || '').trim());
  }

  // `/<name>` runs the skill only when main lists an enabled skill by that
  // name; any other `/word` is ordinary text for the run path.
  /** @param {string} name @param {string} task */
  async sendSkill(name, task) {
    const h = this.host;
    if (this._skillPending) return;
    this._skillPending = true;
    try {
      let known;
      try {
        known = await this.isEnabledSkill(name);
      } catch (err) {
        toast.error(`Couldn’t check the /${name} skill: ${errMsg(err)}`);
        return;
      }
      if (!known) { h._run(); return; }
      await h._controller.runSkill(name, task);
    } finally {
      this._skillPending = false;
    }
  }

  /** @param {string} name @returns {Promise<boolean>} */
  async isEnabledSkill(name) {
    const res = await ipcRenderer.invoke('commands:list');
    if (!res || res.ok === false || !Array.isArray(res.commands)) throw new Error((res && res.error) || 'commands_unavailable');
    return res.commands.some((c) => c && c.kind === 'skill' && c.name === name);
  }

  /**
   * Runs a palette command that acts in place instead of being typed out.
   * Returns true when handled.
   * @param {{ name?: string, kind?: string }} cmd
   */
  runCommand(cmd) {
    if (!cmd || cmd.kind !== 'builtin' || cmd.name !== 'compact' || !this.contextMeter) return false;
    this.contextMeter.compact();
    return true;
  }

  /** Points the session-scoped controls (permission mode, context meter) at a session. */
  setSessionId(sessionId) {
    return Promise.all([
      this.permissionMode ? this.permissionMode.setSessionId(sessionId) : Promise.resolve(),
      this.contextMeter ? this.contextMeter.setSessionId(sessionId) : Promise.resolve(),
    ]);
  }

  /** @param {string|null} sessionId */
  trackSession(sessionId) {
    this.setSessionId(sessionId).catch((err) => console.error('[Composer] session-scoped controls failed to reload:', errMsg(err)));
  }

  // Hint text for the empty textarea; names whichever chord currently sends.
  inputHint() {
    const h = this.host;
    const enterToSend = !!(h._enterToSendCb && h._enterToSendCb.checked);
    const hint = enterToSend ? 'Enter to send' : 'Shift+Enter to send';
    return `Ask anything, or give a task… (${hint})`;
  }

  loadEnterPref() {
    try {
      const v = window.localStorage && window.localStorage.getItem(ENTER_TO_SEND_KEY);
      return v === '1';
    } catch (err) {
      console.warn('[AgentPanel] enter-to-send pref unreadable; using Shift+Enter:', errMsg(err));
      return false;
    }
  }

  saveEnterPref(on) {
    try {
      if (window.localStorage) window.localStorage.setItem(ENTER_TO_SEND_KEY, on ? '1' : '0');
    } catch (err) {
      toast.warn(`Couldn’t save the Enter-to-send preference: ${errMsg(err)}`);
    }
  }

  // Recent-prompts history. Stored in localStorage so it persists across
  // restarts without bloating config.json. Up/Down cycles when the cursor is
  // at the start/end of the textarea.
  loadPromptHistory() {
    const h = this.host;
    if (h._promptHistory) return h._promptHistory;
    try {
      const raw = window.localStorage && window.localStorage.getItem(PROMPT_HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      h._promptHistory = Array.isArray(arr) ? arr.slice(-PROMPT_HISTORY_MAX) : [];
    } catch (err) {
      console.warn('[AgentPanel] prompt history unreadable; starting empty:', errMsg(err));
      h._promptHistory = [];
    }
    h._promptHistoryIdx = -1;
    return h._promptHistory;
  }

  recordPrompt(text) {
    const h = this.host;
    const t = String(text || '').trim();
    if (!t) return;
    this.loadPromptHistory();
    if (h._promptHistory[h._promptHistory.length - 1] === t) return; // dedup consecutive
    h._promptHistory.push(t);
    if (h._promptHistory.length > PROMPT_HISTORY_MAX) h._promptHistory = h._promptHistory.slice(-PROMPT_HISTORY_MAX);
    h._promptHistoryIdx = -1;
    try { window.localStorage && window.localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(h._promptHistory)); } catch (err) { console.error('persist promptHistory failed', (err instanceof Error && err.message) || err); }
  }

  cyclePromptHistory(direction) {
    const h = this.host;
    const list = this.loadPromptHistory();
    if (!list.length) return null;
    if (h._promptHistoryIdx === -1) h._promptHistoryIdx = list.length;
    const next = Math.max(0, Math.min(list.length, h._promptHistoryIdx + direction));
    if (next === h._promptHistoryIdx) return null;
    h._promptHistoryIdx = next;
    if (next === list.length) return '';
    return list[next];
  }

  togglePause() {
    if (this.host._paused) ipcRenderer.send('agent:resume');
    else ipcRenderer.send('agent:pause');
  }

  // -- Answer routing ------------------------------------------------------

  // Persisted route override, written by the mode switch. The value is read
  // back on every manual send in _run; slash commands and openWithTask bypass it.
  setRouteMode(mode) { this.applyRouteMode(ROUTE_MODES.includes(mode) ? mode : 'auto', true); }

  // Apply a route value to state + the segmented control; persist only on user action.
  applyRouteMode(mode, persist) {
    const h = this.host;
    if (!ROUTE_MODES.includes(mode)) mode = 'auto';
    h.routeMode = mode;
    if (h._modeSwitch) h._modeSwitch.set(mode);
    if (!persist) return;
    try { configBridge.set('settings.chat.mode', mode); }
    catch (err) { toast.warn(`Answer mode applies to this session only — saving failed: ${errMsg(err)}`); }
  }

  loadRouteMode() {
    let mode = 'auto';
    try {
      const v = configBridge.get('settings.chat.mode');
      if (ROUTE_MODES.includes(v)) mode = v;
    } catch (err) { console.warn('[AgentPanel] settings.chat.mode unreadable; using auto:', errMsg(err)); }
    // No persist: this is the read-back of what a user action already wrote.
    this.applyRouteMode(mode, false);
  }

  // Keyboard-shortcuts reference sheet. Built once as a standalone Dropdown so
  // it inherits the app's overlay/backdrop/focus behavior and shares the kbd
  // styling with the CommandPalette footer.
  showShortcuts() {
    const h = this.host;
    if (h._shortcutsDropdown) { h._shortcutsDropdown.open(); return; }
    const content = document.createElement('div');
    content.className = 'agent-panel-shortcuts';
    /** @type {[string, string[]][]} */
    const rows = [
      ['Run task', ['Cmd/Ctrl', 'Enter']],
      ['Show / hide history', ['Cmd/Ctrl', 'Shift', 'H']],
      ['Export transcript', ['Cmd/Ctrl', 'Shift', 'E']],
      ['Close / skip typewriter', ['Esc']],
      ['Toggle all steps', ['Alt', 'Click']],
    ];
    rows.forEach(([label, keys]) => {
      const row = document.createElement('div');
      row.className = 'agent-panel-shortcuts-row';
      const span = document.createElement('span');
      span.className = 'agent-panel-shortcuts-label';
      span.textContent = label;
      const kbdWrap = document.createElement('span');
      kbdWrap.className = 'agent-panel-shortcuts-kbd';
      keys.forEach((k) => {
        const kbd = document.createElement('kbd');
        kbd.textContent = k;
        kbdWrap.appendChild(kbd);
      });
      row.appendChild(span);
      row.appendChild(kbdWrap);
      content.appendChild(row);
    });
    h._shortcutsDropdown = new Dropdown({
      id: 'agent-panel-shortcuts',
      size: 'sm',
      ariaLabel: 'Keyboard shortcuts',
    });
    h._shortcutsDropdown.mount(content);
    h._shortcutsDropdown.open();
  }
}

module.exports = Composer;
