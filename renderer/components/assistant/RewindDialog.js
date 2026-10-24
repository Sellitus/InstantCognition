// RewindDialog — the in-panel "Rewind to here" confirmation. It previews what
// checkpoint:preview reports (files restored, deleted, unchanged or in
// conflict) plus the conversation rewind, lets the user leave files alone or
// force past conflicts, and only then calls session:rewind. Cancel sends no IPC.
//
// The dialog traps Tab inside itself and nothing else: the rest of the app
// is never made inert. Esc cancels. A turn without a file checkpoint (a chat
// turn, or an agent turn that changed no files) can still rewind the
// conversation, with file restore switched off.

const toast = require('../Toast');
const { errMsg } = require('../../../shared/errMsg');

const STATUS_LABELS = { restore: 'Restore', delete: 'Delete', unchanged: 'Unchanged', conflict: 'Conflict' };
const ERRORS = {
  checkpoint_not_found: 'No file checkpoint exists for that message.',
  checkpoints_unavailable: 'File checkpoints are not available.',
  session_busy: 'Wait for the current run to finish first.',
  not_a_user_message: 'Only your own messages can be rewound to.',
};
const friendly = (code) => ERRORS[code] || String(code || 'Request failed.');

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

/** @param {string} className @param {string} label @returns {{ wrap: HTMLLabelElement, input: HTMLInputElement }} */
function checkbox(className, label) {
  const wrap = /** @type {HTMLLabelElement} */ (node('label', className));
  const input = document.createElement('input');
  input.type = 'checkbox';
  wrap.append(input, node('span', '', label));
  return { wrap, input };
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

class RewindDialog {
  /**
   * @param {{ ipc?: { invoke: Function }, getRoot: () => (HTMLElement|null),
   *   onRewound?: (result: any, context: any) => void }} opts
   */
  constructor(opts) {
    if (!opts || typeof opts.getRoot !== 'function') throw new TypeError('RewindDialog requires getRoot');
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    this._getRoot = opts.getRoot;
    this._onRewound = typeof opts.onRewound === 'function' ? opts.onRewound : () => {};
    /** @type {HTMLElement|null} */ this.el = null;
    this._req = null;
    this._returnFocus = null;
    this._submitting = false;
  }

  isOpen() { return !!this.el; }

  /**
   * Preview first; the dialog opens only when there is something to confirm.
   * @param {{ sessionId: string, turnId: string, context?: any }} req
   * @returns {Promise<boolean>} whether the dialog opened
   */
  async open(req) {
    if (!req || !req.sessionId || !req.turnId) throw new TypeError('RewindDialog.open needs sessionId and turnId');
    this.close();
    let preview;
    try {
      preview = await this._ipc.invoke('checkpoint:preview', { sessionId: req.sessionId, turnId: req.turnId });
    } catch (err) {
      toast.error(`Couldn’t preview the rewind: ${errMsg(err)}`);
      return false;
    }
    if (!preview || !preview.ok) {
      const code = preview && preview.error;
      if (code !== 'checkpoint_not_found') {
        toast.error(`Couldn’t preview the rewind: ${friendly(code)}`);
        return false;
      }
      toast.error(`${friendly(code)} Only the conversation can rewind.`);
      preview = null;
    }
    const root = this._getRoot();
    if (!root) throw new Error('RewindDialog: the panel is not mounted');
    this._req = req;
    this._returnFocus = /** @type {HTMLElement|null} */ (document.activeElement);
    this.el = this._build(preview);
    root.appendChild(this.el);
    this._focusFirst();
    return true;
  }

  _build(preview) {
    const files = preview && Array.isArray(preview.files) ? preview.files : [];
    const changing = files.filter((f) => f.status !== 'unchanged');
    const conflicts = files.filter((f) => f.status === 'conflict');

    const backdrop = node('div', 'rewind-dialog');
    const box = node('div', 'rewind-dialog__box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'rewind-dialog-title');
    box.setAttribute('aria-describedby', 'rewind-dialog-desc');
    box.appendChild(node('h2', 'rewind-dialog__title', 'Rewind to here')).id = 'rewind-dialog-title';
    box.appendChild(node('p', 'rewind-dialog__desc',
      'The conversation returns to just before this message, and the message goes back to the composer. Later messages stay reachable as another version.')).id = 'rewind-dialog-desc';

    this._filesOpt = checkbox('rewind-dialog__opt rewind-dialog__files-opt', 'Also restore files');
    this._forceOpt = checkbox('rewind-dialog__opt rewind-dialog__force-opt', 'Overwrite files changed outside the agent');
    this._forceOpt.wrap.hidden = !conflicts.length;

    const fileSection = node('section', 'rewind-dialog__files');
    fileSection.setAttribute('aria-label', 'Files');
    if (!preview) {
      this._filesOpt.input.checked = false;
      this._filesOpt.input.disabled = true;
      fileSection.appendChild(node('p', 'rewind-dialog__note', 'No file checkpoint exists for this message, so only the conversation rewinds.'));
    } else if (!changing.length) {
      this._filesOpt.input.checked = false;
      this._filesOpt.input.disabled = true;
      fileSection.appendChild(node('p', 'rewind-dialog__note', 'No files changed since this message.'));
    } else {
      this._filesOpt.input.checked = true;
      fileSection.appendChild(this._fileList(files));
    }
    this._conflictsEl = node('div', 'rewind-dialog__conflicts');
    this._conflictsEl.setAttribute('role', 'alert');
    this._renderConflicts(conflicts);

    box.append(this._filesOpt.wrap, fileSection, this._conflictsEl, this._forceOpt.wrap);
    box.appendChild(node('p', 'rewind-dialog__note rewind-dialog__untracked',
      'Shell side effects are not tracked: commands the agent ran (installs, network calls, files outside the workspace) are not undone.'));

    this._errorEl = node('div', 'rewind-dialog__error');
    this._errorEl.setAttribute('role', 'alert');
    this._errorEl.hidden = true;
    const row = node('div', 'rewind-dialog__actions');
    this._cancelBtn = button('rewind-dialog__cancel', 'Cancel');
    this._confirmBtn = button('rewind-dialog__confirm', 'Rewind');
    row.append(this._cancelBtn, this._confirmBtn);
    box.append(this._errorEl, row);
    backdrop.appendChild(box);

    this._filesOpt.input.addEventListener('change', () => this._syncForce());
    this._cancelBtn.addEventListener('click', () => this.cancel());
    this._confirmBtn.addEventListener('click', () => this.confirm());
    backdrop.addEventListener('keydown', (e) => this._onKey(e));
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) this.cancel(); });
    this._box = box;
    return backdrop;
  }

  _fileList(files) {
    const ul = node('ul', 'rewind-dialog__file-list');
    for (const f of files) {
      const li = node('li', `rewind-dialog__file rewind-dialog__file--${f.status}`);
      li.appendChild(node('span', 'rewind-dialog__file-status', STATUS_LABELS[f.status] || String(f.status)));
      li.appendChild(node('span', 'rewind-dialog__file-path', String(f.rel || f.path || '')));
      if (f.reason) li.appendChild(node('span', 'rewind-dialog__file-reason', String(f.reason)));
      ul.appendChild(li);
    }
    return ul;
  }

  _renderConflicts(conflicts) {
    this._conflictsEl.innerHTML = '';
    this._conflictsEl.hidden = !conflicts.length;
    if (!conflicts.length) return;
    this._conflictsEl.appendChild(node('p', '', `${conflicts.length} file${conflicts.length === 1 ? ' was' : 's were'} changed after the agent wrote ${conflicts.length === 1 ? 'it' : 'them'}. Nothing rewinds until you overwrite ${conflicts.length === 1 ? 'it' : 'them'} or skip files.`));
    const ul = node('ul', 'rewind-dialog__conflict-list');
    conflicts.forEach((c) => ul.appendChild(node('li', '', `${c.rel || c.path}${c.reason ? ` (${c.reason})` : ''}`)));
    this._conflictsEl.appendChild(ul);
    this._forceOpt.wrap.hidden = false;
    this._syncForce();
  }

  _syncForce() {
    const filesOn = this._filesOpt.input.checked;
    this._forceOpt.input.disabled = !filesOn;
    if (!filesOn) this._forceOpt.input.checked = false;
  }

  _focusFirst() {
    const first = this._focusables()[0];
    if (first) first.focus();
  }

  _focusables() {
    return this._box ? /** @type {HTMLElement[]} */ (Array.from(this._box.querySelectorAll(FOCUSABLE))) : [];
  }

  _onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancel(); return; }
    if (e.key !== 'Tab') return;
    const items = this._focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !this._box.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !this._box.contains(active))) { e.preventDefault(); first.focus(); }
  }

  cancel() { this.close(); }

  close() {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    this._box = null;
    this._req = null;
    this._submitting = false;
    const back = this._returnFocus;
    this._returnFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  }

  _showError(message) {
    this._errorEl.textContent = message;
    this._errorEl.hidden = false;
  }

  /** @returns {Promise<any>} the rewind result, or null when nothing rewound */
  async confirm() {
    if (!this._req || this._submitting) return null;
    const req = this._req;
    const files = this._filesOpt.input.checked;
    const force = files && this._forceOpt.input.checked;
    this._submitting = true;
    this._confirmBtn.disabled = true;
    this._errorEl.hidden = true;
    let res;
    try {
      res = await this._ipc.invoke('session:rewind', { sessionId: req.sessionId, turnId: req.turnId, files, force });
    } catch (err) {
      res = { ok: false, error: errMsg(err) };
    }
    if (!this.el || this._req !== req) return null;
    this._submitting = false;
    this._confirmBtn.disabled = false;
    if (!res || !res.ok) {
      const message = `Couldn’t rewind: ${friendly(res && res.error)}`;
      toast.error(message);
      this._showError(message);
      return null;
    }
    if (!res.conversationRewound) {
      this._renderConflicts(Array.isArray(res.conflicts) ? res.conflicts : []);
      this._showError('Some files changed since the agent wrote them. Overwrite them, or turn off file restore.');
      return null;
    }
    const context = req.context;
    this.close();
    this._onRewound(res, context);
    return res;
  }
}

module.exports = RewindDialog;
