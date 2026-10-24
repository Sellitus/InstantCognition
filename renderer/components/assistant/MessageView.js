// MessageView — one message in the chat thread: role label, version switcher,
// Markdown body, and its actions (copy, edit & resend, regenerate, and a
// "More" menu with fork, rewind, create-skill and export). The action row
// shows on hover and on keyboard focus; every action is also reachable from
// the menu button, which opens a role="menu" list driven by the arrow keys.
//
// The view renders and reports; ChatThread performs the session IPC. A
// streaming message coalesces its chunks into one render per animation frame.

const { mdToHtml, bindCodeCopy } = require('../../utils/markdown');
const { iconHTML } = require('../Icon');
const BranchNav = require('./BranchNav');

const ROLE_LABELS = { user: 'You', assistant: 'Assistant', error: 'Assistant', plan: 'Plan', compaction: 'Summary' };

/** @param {string} tag @param {string} [className] @param {string} [text] */
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {string} className @param {string} [text] @returns {HTMLButtonElement} */
function button(className, text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  if (text !== undefined) b.textContent = text;
  return b;
}

function iconButton(className, icon, label) {
  const b = button(`chat-msg__action ${className}`);
  b.innerHTML = iconHTML(icon);
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}

/**
 * @typedef {{
 *   onCopy?: (view: MessageView) => void,
 *   onEdit?: (view: MessageView, text: string) => Promise<any>,
 *   onRegenerate?: (view: MessageView) => void,
 *   onFork?: (view: MessageView) => void,
 *   onRewind?: (view: MessageView) => void,
 *   onSkill?: (view: MessageView) => void,
 *   onExport?: (view: MessageView) => void,
 *   onBranch?: (view: MessageView, siblingId: string) => void,
 * }} MessageActions
 */

class MessageView {
  /**
   * @param {{ role: string, text?: string, nodeId?: string|null, lane?: string|null,
   *   label?: string, actions?: MessageActions }} opts
   */
  constructor(opts) {
    const o = opts || /** @type {any} */ ({});
    if (!ROLE_LABELS[o.role]) throw new TypeError(`MessageView: unknown role ${String(o.role)}`);
    this.role = o.role;
    this.lane = o.lane || null;
    /** @type {string|null} */ this.nodeId = o.nodeId || null;
    this._text = String(o.text || '');
    /** @type {MessageActions} */ this._actions = o.actions || {};
    this._busy = false;
    this._frame = 0;
    this._menuOpen = false;
    this._onDocPointer = (e) => { if (!this.el.contains(/** @type {Node} */ (e.target))) this.closeMenu(); };
    this.el = this._build(o.label || (this.role === 'assistant' && this.lane === 'agent' ? 'Agent' : ROLE_LABELS[this.role]));
    if (this.nodeId) this.el.dataset.nodeId = this.nodeId;
    this._render();
    this._syncActions();
  }

  get text() { return this._text; }

  _build(label) {
    const li = node('li', `agent-msg chat-msg chat-msg--${this.role}`);
    li.classList.add(this.role === 'user' ? 'agent-msg-user' : 'agent-msg-assistant-answer');
    const head = node('div', 'chat-msg__head');
    head.appendChild(node('div', 'agent-msg-role', label));
    this.branchNav = new BranchNav({ onSelect: (id) => this._fire('onBranch', id) });
    head.appendChild(this.branchNav.el);
    head.appendChild(this._buildActions());
    li.appendChild(head);
    this.bodyEl = node('div', 'agent-msg-body chat-msg__body md');
    bindCodeCopy(this.bodyEl);
    li.appendChild(this.bodyEl);
    if (this.role === 'user') li.appendChild(this._buildEditor());
    return li;
  }

  _buildActions() {
    const bar = node('div', 'chat-msg__actions');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Message actions');
    this.copyBtn = iconButton('chat-msg__copy', 'copy', 'Copy message');
    this.copyBtn.addEventListener('click', () => this._fire('onCopy'));
    bar.appendChild(this.copyBtn);
    if (this.role === 'user') {
      this.editBtn = iconButton('chat-msg__edit', 'edit', 'Edit and resend');
      this.editBtn.addEventListener('click', () => this.startEdit());
      bar.appendChild(this.editBtn);
    } else if (this.role === 'assistant' || this.role === 'error') {
      this.regenBtn = iconButton('chat-msg__regenerate', 'refresh', 'Regenerate response');
      this.regenBtn.addEventListener('click', () => this._fire('onRegenerate'));
      bar.appendChild(this.regenBtn);
    }
    this.moreBtn = iconButton('chat-msg__more', 'more', 'More message actions');
    this.moreBtn.setAttribute('aria-haspopup', 'menu');
    this.moreBtn.setAttribute('aria-expanded', 'false');
    this.moreBtn.addEventListener('click', () => (this._menuOpen ? this.closeMenu(true) : this.openMenu()));
    this.moreBtn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.openMenu(e.key === 'ArrowUp' ? -1 : 0); }
    });
    bar.appendChild(this.moreBtn);
    this.menuEl = this._buildMenu();
    bar.appendChild(this.menuEl);
    return bar;
  }

  _buildMenu() {
    const menu = node('ul', 'chat-msg__menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Message actions');
    menu.hidden = true;
    const items = [
      ['fork', 'Fork into a new chat', 'onFork'],
      this.role === 'user' ? ['rewind', 'Rewind to here', 'onRewind'] : null,
      ['skill', 'Create skill from this chat', 'onSkill'],
      ['export', 'Export conversation', 'onExport'],
    ].filter(Boolean);
    this._menuItems = items.map(([key, label, handler]) => {
      const li = node('li', '');
      li.setAttribute('role', 'none');
      const b = button(`chat-msg__menu-item chat-msg__menu-item--${key}`, label);
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.dataset.action = key;
      b.addEventListener('click', () => { this.closeMenu(true); this._fire(handler); });
      li.appendChild(b);
      menu.appendChild(li);
      return b;
    });
    menu.addEventListener('keydown', (e) => this._onMenuKey(e));
    return menu;
  }

  _buildEditor() {
    const form = node('form', 'chat-msg__editor');
    form.hidden = true;
    this.editInput = /** @type {HTMLTextAreaElement} */ (node('textarea', 'chat-msg__editor-input'));
    this.editInput.setAttribute('aria-label', 'Edit message');
    this.editInput.rows = 3;
    this.editError = node('div', 'chat-msg__editor-error');
    this.editError.setAttribute('role', 'alert');
    this.editError.hidden = true;
    const row = node('div', 'chat-msg__editor-actions');
    const cancel = button('chat-msg__editor-cancel', 'Cancel');
    this.editSave = button('chat-msg__editor-save', 'Save & send');
    this.editSave.type = 'submit';
    row.append(cancel, this.editSave);
    form.append(this.editInput, this.editError, row);
    cancel.addEventListener('click', () => this.cancelEdit());
    form.addEventListener('submit', (e) => { e.preventDefault(); this.submitEdit(); });
    this.editInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancelEdit(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.submitEdit(); }
    });
    this.editorEl = form;
    return form;
  }

  _fire(handler, arg) {
    const fn = this._actions[handler];
    if (typeof fn === 'function') fn(this, arg);
  }

  // -- Rendering ------------------------------------------------------------

  _render() {
    this.bodyEl.innerHTML = mdToHtml(this._text).trim();
  }

  appendStream(chunk) {
    if (typeof chunk !== 'string' || !chunk) return;
    this._text += chunk;
    if (this._frame) return;
    if (typeof requestAnimationFrame !== 'function') { this._render(); return; }
    this._frame = requestAnimationFrame(() => { this._frame = 0; this._render(); });
  }

  endStream() {
    this._cancelFrame();
    this._render();
  }

  _cancelFrame() {
    if (this._frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._frame);
    this._frame = 0;
  }

  /** @param {string|null} id */
  setNodeId(id) {
    this.nodeId = id || null;
    if (this.nodeId) this.el.dataset.nodeId = this.nodeId;
    else delete this.el.dataset.nodeId;
    this._syncActions();
  }

  setBranch(info) { this.branchNav.set(info); }

  setBusy(busy) {
    this._busy = !!busy;
    this.branchNav.setDisabled(this._busy);
    this._syncActions();
  }

  // Session actions need a persisted node and an idle session; copy and
  // export work on any message.
  _syncActions() {
    const sessionReady = !!this.nodeId;
    const idle = sessionReady && !this._busy;
    if (this.editBtn) this.editBtn.disabled = !idle;
    if (this.regenBtn) this.regenBtn.disabled = !idle;
    for (const b of this._menuItems) {
      const key = b.dataset.action;
      const enabled = key === 'export' || key === 'skill' || (key === 'fork' ? sessionReady : idle);
      b.disabled = !enabled;
      b.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }
  }

  // -- Menu -----------------------------------------------------------------

  openMenu(focusIndex = 0) {
    this._menuOpen = true;
    this.menuEl.hidden = false;
    this.moreBtn.setAttribute('aria-expanded', 'true');
    this.el.classList.add('chat-msg--menu-open');
    document.addEventListener('pointerdown', this._onDocPointer, true);
    const enabled = this._enabledItems();
    const target = focusIndex < 0 ? enabled[enabled.length - 1] : enabled[focusIndex];
    if (target) target.focus();
  }

  closeMenu(returnFocus) {
    if (!this._menuOpen) return;
    this._menuOpen = false;
    this.menuEl.hidden = true;
    this.moreBtn.setAttribute('aria-expanded', 'false');
    this.el.classList.remove('chat-msg--menu-open');
    document.removeEventListener('pointerdown', this._onDocPointer, true);
    if (returnFocus) this.moreBtn.focus();
  }

  _enabledItems() { return this._menuItems.filter((b) => !b.disabled); }

  _onMenuKey(e) {
    const items = this._enabledItems();
    const at = items.indexOf(/** @type {any} */ (document.activeElement));
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeMenu(true); return; }
    if (e.key === 'Tab') { this.closeMenu(false); return; }
    if (!items.length) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  }

  // -- Edit & resend ----------------------------------------------------------

  startEdit() {
    if (!this.editorEl || !this.nodeId || this._busy) return;
    this.editorEl.hidden = false;
    this.bodyEl.hidden = true;
    this.el.classList.add('chat-msg--editing');
    this.editInput.value = this._text;
    this.editError.hidden = true;
    this.editInput.focus();
  }

  cancelEdit() {
    if (!this.editorEl) return;
    this.editorEl.hidden = true;
    this.bodyEl.hidden = false;
    this.el.classList.remove('chat-msg--editing');
    if (this.editBtn && !this.editBtn.disabled) this.editBtn.focus();
  }

  _showEditError(message) {
    this.editError.textContent = message;
    this.editError.hidden = false;
  }

  /** @returns {Promise<boolean>} true when the edit was handed off */
  async submitEdit() {
    const text = this.editInput.value.trim();
    if (!text) { this._showEditError('Write a message to send.'); return false; }
    if (text === this._text.trim()) { this.cancelEdit(); return false; }
    const fn = this._actions.onEdit;
    if (typeof fn !== 'function') return false;
    this.editSave.disabled = true;
    try {
      await fn(this, text);
      return true;
    } catch (err) {
      this._showEditError(`Couldn’t resend: ${(err instanceof Error && err.message) || String(err)}`);
      return false;
    } finally {
      this.editSave.disabled = false;
    }
  }

  destroy() {
    this._cancelFrame();
    this.closeMenu(false);
    this.el.remove();
  }
}

module.exports = MessageView;
