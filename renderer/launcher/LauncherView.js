// LauncherView — renderer for the quick launcher window (launcher.html): one
// input and one streamed markdown answer. Enter sends launcher:submit, which
// opens a session in main; 'launcher:stream' {sessionId, type, delta?, error?}
// events are applied only when they carry the sessionId of the latest submit,
// so a late chunk from an earlier question never bleeds into the current
// answer. Events that arrive before the submit reply (an engine-busy error can
// beat it) are held and replayed once the sessionId is known.
const { mdToHtml, bindCodeCopy } = require('../utils/markdown');

const FRIENDLY_ERRORS = {
  engine_busy: 'The model is busy with another task. Try again in a moment.',
  reasoning_budget_exhausted: 'The model spent its whole token budget thinking and never wrote an answer.',
  empty_response: 'The model returned no answer text. Check the model in Settings → LLM.',
  invalid_text: 'Type a question first.',
  session_not_found: 'That conversation no longer exists.',
};

const friendly = (error) => FRIENDLY_ERRORS[String(error)] || `Something went wrong: ${String(error || 'unknown error')}`;

class LauncherView {
  /**
   * @param {{ doc: Document, ipc: { invoke: Function, on: Function }, prefersDark?: () => boolean, platform?: string }} deps
   */
  constructor({ doc, ipc, prefersDark, platform }) {
    if (!doc || !ipc) throw new TypeError('LauncherView requires doc and ipc');
    this.doc = doc;
    this.ipc = ipc;
    this.prefersDark = prefersDark || (() => true);
    this.platform = platform || process.platform;
    this.sessionId = null;
    this.buffer = '';
    this.streaming = false;
    this._pending = false;
    /** @type {any[]} */ this._early = [];
  }

  mount() {
    const $ = (id) => {
      const el = this.doc.getElementById(id);
      if (!el) throw new Error(`LauncherView: #${id} missing from launcher.html`);
      return el;
    };
    this.form = $('launcher-form');
    this.input = /** @type {HTMLInputElement} */ ($('launcher-input'));
    this.hint = $('launcher-hint');
    this.answerEl = $('launcher-answer');
    this.statusEl = $('launcher-status');
    this.openBtn = /** @type {HTMLButtonElement} */ ($('launcher-open'));
    $('launcher-mod-key').textContent = this.platform === 'darwin' ? '⌘' : 'Ctrl';
    bindCodeCopy(this.answerEl);

    this.form.addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    this.input.addEventListener('input', () => { this.hint.hidden = this.input.value.length > 0; });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.openInAssistant(); }
    });
    this.openBtn.addEventListener('click', () => this.openInAssistant());
    this.ipc.on('launcher:stream', (_e, payload) => this.onStream(payload));
    this.ipc.on('launcher:shown', (_e, payload) => this.onShown(payload));
    this.setStatus('');
    return this;
  }

  async submit() {
    const text = this.input.value.trim();
    if (!text || this._pending) return;
    this._pending = true;
    this._early = [];
    this.sessionId = null;
    this.buffer = '';
    this.answerEl.innerHTML = '';
    this.openBtn.hidden = true;
    this.setStatus('Thinking…');
    let res;
    try {
      res = await this.ipc.invoke('launcher:submit', { text });
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this._pending = false;
    const early = this._early;
    this._early = [];
    if (!res || !res.ok) {
      this.setStatus(friendly(res && res.error), 'error');
      return;
    }
    this.sessionId = res.sessionId;
    this.streaming = true;
    this.openBtn.hidden = false;
    for (const payload of early) this.onStream(payload);
  }

  /** @param {{ sessionId?: string, type?: string, delta?: string, error?: string }} payload */
  onStream(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (this._pending) { this._early.push(payload); return; }
    if (!this.sessionId || payload.sessionId !== this.sessionId) return;
    if (payload.type === 'chunk' && typeof payload.delta === 'string') {
      this.buffer += payload.delta;
      this.answerEl.innerHTML = mdToHtml(this.buffer);
      this.setStatus('');
    } else if (payload.type === 'done') {
      this.streaming = false;
      this.setStatus('');
    } else if (payload.type === 'error') {
      this.streaming = false;
      // engine_busy discards the session in main, so there is nothing to open.
      if (payload.error === 'engine_busy') this.openBtn.hidden = true;
      this.setStatus(friendly(payload.error), 'error');
    }
  }

  async openInAssistant() {
    if (!this.sessionId || this.openBtn.hidden) return;
    let res;
    try {
      res = await this.ipc.invoke('launcher:open-in-assistant', { sessionId: this.sessionId });
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res || !res.ok) this.setStatus(friendly(res && res.error), 'error');
  }

  /** @param {{ theme?: string }} [payload] */
  onShown(payload) {
    const theme = payload && payload.theme;
    const resolved = theme === 'light' || theme === 'dark' ? theme : (this.prefersDark() ? 'dark' : 'light');
    const body = this.doc.body;
    body.classList.remove('theme-light', 'theme-dark');
    body.classList.add(`theme-${resolved}`);
    this.input.focus();
    this.input.select();
  }

  setStatus(text, kind) {
    this.statusEl.textContent = text;
    this.statusEl.hidden = !text;
    this.statusEl.classList.toggle('is-error', kind === 'error');
  }
}

/** Entry point called from launcher.html. */
function boot(doc) {
  const { ipcRenderer } = require('electron');
  const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  return new LauncherView({ doc, ipc: ipcRenderer, prefersDark: () => !mq || mq.matches }).mount();
}

module.exports = { LauncherView, boot, friendly };
