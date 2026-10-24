// PermissionModeSwitch — the composer's permission-mode pill (Ask / Auto-edit
// / Plan / Bypass) over the permissions:get / permissions:set-mode IPC.
//
// Bypass needs an in-panel confirmation the first time per session; the mode
// is applied optimistically and reverts, with a visible error, when main
// refuses it. Shift+Tab in the composer cycles the modes (Bypass only once it
// was confirmed for the session), so the keyboard never opens a prompt.

const { iconHTML } = require('../Icon');
const { errMsg } = require('../../../shared/errMsg');

const MODES = [
  { id: 'ask', label: 'Ask', hint: 'Ask before edits, commands and unlisted tools' },
  { id: 'auto-edit', label: 'Auto-edit', hint: 'Apply file edits in the workspace without asking' },
  { id: 'plan', label: 'Plan', hint: 'Read-only: research and propose a plan, no changes' },
  { id: 'bypass', label: 'Bypass', hint: 'Skip approval prompts; deny rules still apply' },
];
const MODE_IDS = MODES.map((m) => m.id);
const labelOf = (id) => (MODES.find((m) => m.id === id) || MODES[0]).label;

/** @param {string} tag @param {string} [className] @param {string} [text] */
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

class PermissionModeSwitch {
  /**
   * @param {{
   *   ipc?: { invoke: Function },
   *   getInput?: () => (HTMLElement|null),
   *   isPopupOpen?: () => boolean,
   *   isShiftTabEnabled?: () => boolean,
   * }} [opts]
   *   getInput: the composer textarea Shift+Tab is bound to.
   *   isPopupOpen: true while a composer palette/list owns the keyboard.
   */
  constructor(opts) {
    const o = opts || {};
    this._ipc = o.ipc || require('electron').ipcRenderer;
    /** @type {string|null} null: the pill reads and writes the default mode. */
    this._sessionId = null;
    this._getInput = typeof o.getInput === 'function' ? o.getInput : () => null;
    this._isPopupOpen = typeof o.isPopupOpen === 'function' ? o.isPopupOpen : () => false;
    this._isShiftTabEnabled = typeof o.isShiftTabEnabled === 'function' ? o.isShiftTabEnabled : () => true;
    this.mode = 'ask';
    this._seq = 0;
    /** @type {{ promise: Promise<boolean>|null, resolve: (ok: boolean) => void, returnFocus: Element|null }|null} */
    this._pendingConfirm = null;
    /** Session keys ('' = no session) whose Bypass was confirmed. */
    this._bypassConfirmed = new Set();
    this._onDocPointer = (e) => {
      if (!(e.target instanceof Node) || !this.el.contains(e.target)) this.closeMenu(false);
    };
    this._build();
  }

  _build() {
    this.el = node('div', 'permission-mode');
    this.pill = node('button', 'permission-mode__pill');
    this.pill.setAttribute('type', 'button');
    this.pill.setAttribute('aria-haspopup', 'menu');
    this.pill.setAttribute('aria-expanded', 'false');
    this._pillLabel = node('span', 'permission-mode__label');
    this.pill.innerHTML = `<span class="permission-mode__icon" aria-hidden="true">${iconHTML('shield')}</span>`;
    this.pill.appendChild(this._pillLabel);
    this.pill.addEventListener('click', () => (this.menu.hidden ? this.openMenu() : this.closeMenu(true)));

    this.menu = node('div', 'permission-mode__menu');
    this.menu.setAttribute('role', 'menu');
    this.menu.setAttribute('aria-label', 'Permission mode');
    this.menu.hidden = true;
    this._items = MODES.map((m) => {
      const item = node('button', `permission-mode__item permission-mode__item--${m.id}`);
      item.setAttribute('type', 'button');
      item.setAttribute('role', 'menuitemradio');
      item.dataset.mode = m.id;
      item.tabIndex = -1;
      item.append(node('span', 'permission-mode__item-label', m.label), node('span', 'permission-mode__item-hint', m.hint));
      item.addEventListener('click', () => { this.closeMenu(true); this.requestMode(m.id); });
      this.menu.appendChild(item);
      return item;
    });
    this.menu.addEventListener('keydown', (e) => this._onMenuKey(e));

    this.confirmEl = node('div', 'permission-mode__confirm');
    this.confirmEl.setAttribute('role', 'alertdialog');
    this.confirmEl.setAttribute('aria-label', 'Turn on Bypass');
    this.confirmEl.hidden = true;
    const text = node('p', 'permission-mode__confirm-text', 'Bypass lets the agent edit files and run commands without asking for the rest of this session. Deny rules still apply.');
    this._confirmYes = node('button', 'permission-mode__confirm-yes', 'Turn on Bypass');
    this._confirmYes.setAttribute('type', 'button');
    this._confirmNo = node('button', 'permission-mode__confirm-no', 'Cancel');
    this._confirmNo.setAttribute('type', 'button');
    this._confirmYes.addEventListener('click', () => this._resolveConfirm(true));
    this._confirmNo.addEventListener('click', () => this._resolveConfirm(false));
    this.confirmEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this._resolveConfirm(false); }
    });
    const actions = node('div', 'permission-mode__confirm-actions');
    actions.append(this._confirmYes, this._confirmNo);
    this.confirmEl.append(text, actions);

    this.errorEl = node('div', 'permission-mode__error');
    this.errorEl.setAttribute('role', 'alert');
    this.errorEl.title = 'Click to dismiss';
    this.errorEl.hidden = true;
    this.errorEl.addEventListener('click', () => this._showError(''));
    this.liveEl = node('span', 'permission-mode__live');
    this.liveEl.setAttribute('aria-live', 'polite');

    this.el.append(this.pill, this.menu, this.confirmEl, this.errorEl, this.liveEl);
    this._paint();
  }

  _sessionKey() { return this._sessionId || ''; }

  /**
   * Scope the pill to a session (per-session mode) or back to the default.
   * @param {string|null} sessionId
   */
  setSessionId(sessionId) {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : null;
    if (id === this._sessionId) return Promise.resolve();
    this._sessionId = id;
    return this.load();
  }

  _paint() {
    this.el.dataset.mode = this.mode;
    this.pill.classList.toggle('is-danger', this.mode === 'bypass');
    this._pillLabel.textContent = labelOf(this.mode);
    this.pill.setAttribute('aria-label', `Permission mode: ${labelOf(this.mode)}`);
    this.pill.title = `Permission mode: ${labelOf(this.mode)} (Shift+Tab in the composer to cycle)`;
    for (const item of this._items) item.setAttribute('aria-checked', item.dataset.mode === this.mode ? 'true' : 'false');
  }

  _showError(message) {
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message || '';
    this.el.classList.toggle('has-error', !!message);
  }

  _announce(text) {
    this.liveEl.textContent = '';
    this.liveEl.textContent = text;
  }

  /** Reads the effective mode for the current session from main. */
  load() {
    const seq = ++this._seq;
    const sessionId = this._sessionKey();
    return Promise.resolve()
      .then(() => this._ipc.invoke('permissions:get', sessionId ? { sessionId } : {}))
      .then((r) => {
        if (seq !== this._seq) return;
        if (!r || r.ok !== true) throw new Error((r && r.error) || 'no response');
        const mode = MODE_IDS.includes(r.effectiveMode) ? r.effectiveMode : r.mode;
        if (!MODE_IDS.includes(mode)) throw new Error(`unknown mode ${String(mode)}`);
        this.mode = mode;
        this._showError('');
        this._paint();
      })
      .catch((err) => {
        if (seq !== this._seq) return;
        this._showError(`Couldn't read the permission mode: ${errMsg(err)}`);
      });
  }

  /**
   * User asked for `mode`. Bypass asks for confirmation first unless this
   * session already confirmed it.
   * @returns {Promise<boolean>} whether the mode was applied
   */
  requestMode(mode) {
    if (!MODE_IDS.includes(mode)) return Promise.resolve(false);
    if (mode === this.mode) return Promise.resolve(true);
    if (mode === 'bypass' && !this._bypassConfirmed.has(this._sessionKey())) {
      return this._confirmBypass().then((ok) => (ok ? this._apply(mode) : false));
    }
    return this._apply(mode);
  }

  /** @returns {Promise<boolean>} */
  _confirmBypass() {
    if (this._pendingConfirm) return this._pendingConfirm.promise;
    const returnFocus = document.activeElement;
    /** @type {Promise<boolean>} */
    const promise = new Promise((resolve) => {
      this._pendingConfirm = { promise: null, resolve, returnFocus };
    });
    this._pendingConfirm.promise = promise;
    this.confirmEl.hidden = false;
    this._confirmNo.focus();
    return promise;
  }

  _resolveConfirm(ok) {
    const pending = this._pendingConfirm;
    if (!pending) return;
    this._pendingConfirm = null;
    this.confirmEl.hidden = true;
    if (ok) this._bypassConfirmed.add(this._sessionKey());
    const back = /** @type {HTMLElement|null} */ (pending.returnFocus);
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
    else this.pill.focus();
    pending.resolve(ok);
  }

  _apply(mode) {
    const prev = this.mode;
    const seq = ++this._seq;
    const sessionId = this._sessionKey();
    this.mode = mode;
    this._showError('');
    this._paint();
    return Promise.resolve()
      .then(() => this._ipc.invoke('permissions:set-mode', sessionId ? { mode, sessionId } : { mode }))
      .then((r) => {
        if (!r || r.ok !== true) throw new Error((r && r.error) || 'no response');
        if (seq === this._seq) this._announce(`Permission mode: ${labelOf(mode)}`);
        return true;
      })
      .catch((err) => {
        if (seq === this._seq) {
          this.mode = prev;
          this._paint();
          this._showError(`Couldn't switch to ${labelOf(mode)}: ${errMsg(err)}. Still ${labelOf(prev)}.`);
        }
        return false;
      });
  }

  /** Next mode in order; Bypass is skipped until confirmed this session. */
  _next(dir) {
    const allowBypass = this._bypassConfirmed.has(this._sessionKey());
    const order = allowBypass ? MODE_IDS : MODE_IDS.filter((m) => m !== 'bypass');
    const at = order.indexOf(this.mode);
    const i = at < 0 ? 0 : (at + dir + order.length) % order.length;
    return order[i];
  }

  /**
   * Composer keydown hook. Returns true when the key cycled the mode.
   * @param {KeyboardEvent} e
   */
  onComposerKey(e) {
    if (e.key !== 'Tab' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
    const input = this._getInput();
    if (!input || e.target !== input || document.activeElement !== input) return false;
    if (this._isPopupOpen() || !this._isShiftTabEnabled()) return false;
    e.preventDefault();
    this.requestMode(this._next(1));
    return true;
  }

  openMenu() {
    if (!this.menu.hidden) return;
    this.menu.hidden = false;
    this.pill.setAttribute('aria-expanded', 'true');
    const current = this._items.find((i) => i.dataset.mode === this.mode) || this._items[0];
    current.focus();
    document.addEventListener('pointerdown', this._onDocPointer, true);
    this.load();
  }

  /** @param {boolean} refocus return focus to the pill */
  closeMenu(refocus) {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.pill.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this._onDocPointer, true);
    if (refocus) this.pill.focus();
  }

  /** @param {KeyboardEvent} e */
  _onMenuKey(e) {
    const idx = this._items.indexOf(/** @type {any} */ (document.activeElement));
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeMenu(true); return; }
    if (e.key === 'Tab') { this.closeMenu(false); return; }
    let next = -1;
    if (e.key === 'ArrowDown') next = (idx + 1) % this._items.length;
    else if (e.key === 'ArrowUp') next = (idx - 1 + this._items.length) % this._items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = this._items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    this._items[next].focus();
  }

  destroy() {
    document.removeEventListener('pointerdown', this._onDocPointer, true);
    if (this._pendingConfirm) this._resolveConfirm(false);
    this.el.remove();
  }
}

module.exports = PermissionModeSwitch;
module.exports.MODES = MODES;
