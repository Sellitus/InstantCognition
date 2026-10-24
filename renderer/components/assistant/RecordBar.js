// RecordBar — Record & Replay over the browser dock. Flow: Record → live
// event count → Stop → "Generating skill…" → SKILL.md preview (rendered, or
// raw source) → Save to the skills library, or Discard (which also deletes
// the saved recording). Every failure lands in an error state with a way
// forward; nothing fails silently.
//
// The bar floats over the top of #tab-bar-wrap, positioned from the wrap's
// box while visible. ShellStore.recording mirrors "a recording is live".

const { mdToHtml, bindCodeCopy } = require('../../utils/markdown');

const WRAP_ID = 'tab-bar-wrap';
const STATES = ['idle', 'starting', 'recording', 'stopping', 'generating', 'preview', 'saving', 'error'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const b = /** @type {HTMLButtonElement} */ (el('button', className, text));
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const errorOf = (res, fallback) => (res && typeof res.error === 'string' && res.error) || fallback;
const errMsg = (err) => (err instanceof Error && err.message) || String(err);

/**
 * @typedef {object} RecordBarOpts
 * @property {any} [ipc]                         ipcRenderer-shaped { invoke, on, removeListener }
 * @property {{ set: (k: string, v: any) => void }} [store]   ShellStore
 * @property {() => any} getActiveWebview
 * @property {(state: string) => void} [onStateChange]
 * @property {(skill: any) => void} [onSaved]
 */

class RecordBar {
  /** @param {RecordBarOpts} opts */
  constructor(opts) {
    if (!opts || typeof opts.getActiveWebview !== 'function') throw new TypeError('RecordBar requires getActiveWebview');
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    this._store = opts.store || null;
    this._getActiveWebview = opts.getActiveWebview;
    this._onStateChange = opts.onStateChange || null;
    this._onSaved = opts.onSaved || null;
    this.state = 'idle';
    this._id = null;
    this._count = 0;
    this._truncated = false;
    this._draft = null;
    this._raw = false;
    this._retry = null;
    this._build();
    this._onEvent = (_e, payload) => this._applyEvent(payload);
    this._ipc.on('recorder:event', this._onEvent);
    this._onResize = () => this.reposition();
    window.addEventListener('resize', this._onResize);
  }

  _build() {
    const root = el('section', 'record-bar');
    root.setAttribute('aria-label', 'Record a skill');
    root.hidden = true;
    const top = el('div', 'record-bar__top');
    this._dot = el('span', 'record-bar__dot');
    this._dot.setAttribute('aria-hidden', 'true');
    this._status = el('p', 'record-bar__status');
    this._status.setAttribute('role', 'status');
    this._status.setAttribute('aria-live', 'polite');
    this._actions = el('div', 'record-bar__actions');
    top.append(this._dot, this._status, this._actions);
    this._preview = el('div', 'record-bar__preview md');
    this._preview.hidden = true;
    bindCodeCopy(this._preview);
    this._source = /** @type {HTMLPreElement} */ (el('pre', 'record-bar__source'));
    this._source.hidden = true;
    this._notes = el('ul', 'record-bar__notes');
    this._notes.hidden = true;
    root.append(top, this._notes, this._preview, this._source);
    document.body.appendChild(root);
    this.el = root;
  }

  isActive() { return this.state !== 'idle'; }

  isRecording() { return this.state === 'starting' || this.state === 'recording' || this.state === 'stopping'; }

  /** Record when idle, stop when recording; otherwise bring the bar forward. */
  toggle() {
    if (this.state === 'idle' || (this.state === 'error' && !this._id)) return this.start();
    if (this.state === 'recording') return this.stop();
    return Promise.resolve();
  }

  async start() {
    // A failed run that still owns a saved trace must be resolved first.
    if (!(this.state === 'idle' || (this.state === 'error' && !this._id))) return;
    const wv = this._getActiveWebview();
    let webContentsId = null;
    try { webContentsId = wv && typeof wv.getWebContentsId === 'function' ? wv.getWebContentsId() : null; }
    catch (err) { this._fail(`Cannot reach this tab: ${errMsg(err)}`, null); return; }
    if (!Number.isInteger(webContentsId)) { this._fail('Open a page in the browser dock to record.', null); return; }
    this._id = null;
    this._count = 0;
    this._truncated = false;
    this._draft = null;
    this._setState('starting');
    const res = await this._invoke('recorder:start', { webContentsId });
    if (!res.ok) { this._fail(`Could not start recording: ${errorOf(res, 'unknown error')}`, null); return; }
    this._id = res.id;
    this._count = Number.isInteger(res.count) ? res.count : 0;
    this._setState('recording');
  }

  async stop() {
    if (this.state !== 'recording' || !this._id) return;
    this._setState('stopping');
    const res = await this._invoke('recorder:stop', { id: this._id });
    if (!res.ok) { this._fail(`Could not stop recording: ${errorOf(res, 'unknown error')}`, () => this._retryStop()); return; }
    const warnings = Array.isArray(res.warnings) ? res.warnings : [];
    if (!res.recording || !res.recording.eventCount) { this._fail('Nothing was recorded. Interact with the page, then stop.', null); return; }
    await this._generate(warnings);
  }

  _retryStop() {
    this._setState('recording');
    return this.stop();
  }

  async _generate(warnings = []) {
    this._setState('generating');
    const res = await this._invoke('recorder:to-skill', { id: this._id });
    if (!res.ok || typeof res.markdown !== 'string') {
      this._fail(`Could not turn the recording into a skill: ${errorOf(res, 'no draft returned')}`, () => this._generate(warnings));
      return;
    }
    this._draft = { markdown: res.markdown, skill: res.skill || null, warnings: warnings.concat(Array.isArray(res.warnings) ? res.warnings : []) };
    this._raw = false;
    this._setState('preview');
  }

  async save(overwrite = false) {
    if (!this._draft || (this.state !== 'preview' && this.state !== 'error')) return;
    this._setState('saving');
    const res = await this._invoke('skills:save', { skill: { markdown: this._draft.markdown }, overwrite });
    if (!res.ok) {
      if (res.error === 'exists') { this._fail('A skill with this name already exists.', () => this.save(true), 'Replace it'); return; }
      this._fail(`Could not save the skill: ${errorOf(res, 'unknown error')}`, () => this.save(overwrite));
      return;
    }
    if (this._onSaved) this._onSaved(res.skill || null);
    await this._deleteTrace();
  }

  async discard() {
    if (this.isRecording()) return;
    await this._deleteTrace();
  }

  async _deleteTrace() {
    const id = this._id;
    if (id) {
      const res = await this._invoke('recorder:delete', { id });
      if (!res.ok && res.error !== 'not_found') { this._fail(`Could not delete the recording: ${errorOf(res, 'unknown error')}`, () => this._deleteTrace()); return; }
    }
    this._id = null;
    this._draft = null;
    this._setState('idle');
  }

  async _invoke(channel, payload) {
    try {
      const res = await this._ipc.invoke(channel, payload);
      return res && typeof res === 'object' ? res : { ok: false, error: 'no_response' };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  _applyEvent(payload) {
    if (!payload || payload.id !== this._id || this.state !== 'recording') return;
    if (Number.isInteger(payload.count)) this._count = payload.count;
    this._truncated = payload.truncated === true;
    // The tab closed under the recording: stop to collect what was captured.
    if (payload.ended === 'destroyed') { this.stop(); return; }
    this._render();
  }

  _fail(message, retry, retryLabel = 'Retry') {
    this._error = message;
    this._retry = retry ? { fn: retry, label: retryLabel } : null;
    this._setState('error');
  }

  _setState(state) {
    if (!STATES.includes(state)) throw new TypeError(`RecordBar: unknown state ${state}`);
    this.state = state;
    if (this._store) this._store.set('recording', this.isRecording());
    this._render();
    if (this._onStateChange) this._onStateChange(state);
  }

  _render() {
    const s = this.state;
    this.el.hidden = s === 'idle';
    this.el.dataset.state = s;
    this._actions.replaceChildren();
    this._preview.hidden = true;
    this._source.hidden = true;
    this._notes.hidden = true;
    const add = (...btns) => this._actions.append(...btns);
    if (s === 'starting') this._status.textContent = 'Starting recording…';
    else if (s === 'recording') {
      const n = this._count;
      this._status.textContent = `Recording · ${n} ${n === 1 ? 'action' : 'actions'}${this._truncated ? ' (limit reached)' : ''}`;
      add(button('record-bar__btn record-bar__btn--stop', 'Stop', () => this.stop()));
    } else if (s === 'stopping') this._status.textContent = 'Stopping…';
    else if (s === 'generating') this._status.textContent = 'Generating skill…';
    else if (s === 'saving') this._status.textContent = 'Saving skill…';
    else if (s === 'preview') this._renderPreview(add);
    else if (s === 'error') {
      this._status.textContent = this._error || 'Something went wrong.';
      if (this._retry) { const r = this._retry; add(button('record-bar__btn', r.label, () => r.fn())); }
      if (this._draft) add(button('record-bar__btn', 'Back to draft', () => this._setState('preview')));
      add(button('record-bar__btn', this._id ? 'Discard' : 'Close', () => this.discard()));
    }
    this.reposition();
  }

  _renderPreview(add) {
    const d = this._draft;
    const name = d.skill && d.skill.name ? d.skill.name : 'new skill';
    this._status.textContent = `Draft skill: ${name}`;
    this._preview.innerHTML = mdToHtml(d.markdown);
    this._source.textContent = d.markdown;
    this._preview.hidden = this._raw;
    this._source.hidden = !this._raw;
    if (d.warnings.length) {
      this._notes.replaceChildren(...d.warnings.map((w) => el('li', '', String(w))));
      this._notes.hidden = false;
    }
    const rawBtn = button('record-bar__btn', this._raw ? 'Rendered' : 'Raw', () => { this._raw = !this._raw; this._render(); });
    rawBtn.setAttribute('aria-pressed', String(this._raw));
    add(rawBtn, button('record-bar__btn record-bar__btn--primary', 'Save', () => this.save()),
      button('record-bar__btn', 'Discard', () => this.discard()));
  }

  /** Re-anchor the bar to the dock's current box (resize, dock width change). */
  reposition() {
    if (this.el.hidden) return;
    const wrap = document.getElementById(WRAP_ID);
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    if (!r.width) return;
    this.el.style.left = `${Math.round(r.left)}px`;
    this.el.style.top = `${Math.round(r.top)}px`;
    this.el.style.width = `${Math.round(r.width)}px`;
  }

  destroy() {
    this._ipc.removeListener('recorder:event', this._onEvent);
    window.removeEventListener('resize', this._onResize);
    this.el.remove();
  }
}

module.exports = RecordBar;
