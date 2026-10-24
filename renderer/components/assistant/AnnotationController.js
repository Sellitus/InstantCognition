// AnnotationController — "point at something on the page and comment on it".
// start() asks the ACTIVE webview's preload (main/preload/annotate.js) to
// enter pick mode; the preload reports the picked element over ipc-message;
// a comment bubble anchored at that element sends the comment plus the
// element's context to the assistant.
//
// Picks are accepted only from the webview pick mode was started on, and
// only while it is still the active one. A navigation, Escape, or a cancel
// from the page ends the session. ShellStore.annotating mirrors it.

const MAX_COMMENT = 4000;
const BUBBLE_GAP = 8;
const BUBBLE_WIDTH = 320;
const BUBBLE_EST_HEIGHT = 180;

const errMsg = (err) => (err instanceof Error && err.message) || String(err);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Validate the preload's pick payload; null when it is not a usable pick. */
function normalizePick(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.selector !== 'string' || !raw.selector) return null;
  const rect = raw.rect && typeof raw.rect === 'object' ? raw.rect : {};
  const vp = raw.viewport && typeof raw.viewport === 'object' ? raw.viewport : {};
  return {
    selector: str(raw.selector, 300),
    role: str(raw.role, 40),
    name: str(raw.name, 80),
    tag: str(raw.tag, 20),
    text: str(raw.text, 500),
    htmlSnippet: str(raw.htmlSnippet, 2000),
    url: str(raw.url, 2048),
    title: str(raw.title, 200),
    rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
    viewport: { width: num(vp.width), height: num(vp.height) },
  };
}

/** A fence longer than any backtick run inside `text`, so the snippet cannot close it. */
function fenceFor(text) {
  const runs = text.match(/`+/g) || [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The message sent to the assistant: the user's comment first, then the
 * element context as a quoted block.
 * @param {ReturnType<typeof normalizePick>} pick
 * @param {string} comment
 */
function formatAnnotation(pick, comment) {
  const label = pick.name || pick.text.slice(0, 80);
  const lines = [
    comment.trim(),
    '',
    `[Annotation on ${pick.url || 'the current page'}${pick.title ? ` — ${pick.title}` : ''}]`,
    `Element: ${pick.role || pick.tag || 'element'}${label ? ` "${label}"` : ''} (selector: ${pick.selector})`,
  ];
  if (pick.text) lines.push(`Text: "${pick.text.slice(0, 300)}"`);
  if (pick.htmlSnippet) {
    const fence = fenceFor(pick.htmlSnippet);
    lines.push('HTML:', `${fence}html`, pick.htmlSnippet, fence);
  }
  return lines.join('\n');
}

function defaultSend(text) {
  // Lazy: AgentPanel → ViewShellManager → AssistantShell → BrowserDock → here.
  const agentPanel = require('../AgentPanel');
  agentPanel.openWithTask(text, { userSend: true });
}

/**
 * @typedef {object} AnnotationOpts
 * @property {() => any} getActiveWebview
 * @property {{ set: (k: string, v: any) => void }} [store]   ShellStore
 * @property {(text: string) => void} [send]
 * @property {(message: string) => void} [onError]
 * @property {(active: boolean) => void} [onStateChange]
 */

class AnnotationController {
  /** @param {AnnotationOpts} opts */
  constructor(opts) {
    if (!opts || typeof opts.getActiveWebview !== 'function') throw new TypeError('AnnotationController requires getActiveWebview');
    this._getActiveWebview = opts.getActiveWebview;
    this._store = opts.store || null;
    this._send = opts.send || defaultSend;
    this._onError = opts.onError || ((m) => require('../Toast').error(m));
    this._onStateChange = opts.onStateChange || null;
    this._wv = null;
    this._pick = null;
    this._bubble = null;
    this._onIpc = (e) => this._handleIpc(e);
    this._onNavigate = () => this.cancel();
    this._onKey = (e) => {
      if (e.key !== 'Escape' || !this.isActive()) return;
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
    };
  }

  isActive() { return this._wv !== null; }

  toggle() {
    if (this.isActive()) this.cancel();
    else this.start();
  }

  start() {
    if (this.isActive()) return false;
    const wv = this._getActiveWebview();
    if (!wv || typeof wv.send !== 'function' || typeof wv.addEventListener !== 'function') {
      this._onError('Open a page in the browser dock to annotate it.');
      return false;
    }
    try { wv.send('ic-annotate:start'); }
    catch (err) { this._onError(`Could not start annotating: ${errMsg(err)}`); return false; }
    this._wv = wv;
    wv.addEventListener('ipc-message', this._onIpc);
    wv.addEventListener('did-start-navigation', this._onNavigate);
    wv.addEventListener('destroyed', this._onNavigate);
    document.addEventListener('keydown', this._onKey, true);
    this._setActive(true);
    return true;
  }

  /** End the session; tells the page to leave pick mode unless it already did. */
  cancel() { this._end(true); }

  _end(stopPage) {
    const wv = this._wv;
    if (!wv) return;
    this._wv = null;
    this._pick = null;
    wv.removeEventListener('ipc-message', this._onIpc);
    wv.removeEventListener('did-start-navigation', this._onNavigate);
    wv.removeEventListener('destroyed', this._onNavigate);
    document.removeEventListener('keydown', this._onKey, true);
    if (stopPage && wv.isConnected !== false) {
      try { wv.send('ic-annotate:stop'); }
      catch (err) { this._onError(`Could not leave annotation mode on the page: ${errMsg(err)}`); }
    }
    this._closeBubble();
    this._setActive(false);
  }

  _handleIpc(e) {
    if (!e || e.currentTarget !== this._wv || this._getActiveWebview() !== this._wv) return;
    if (e.channel === 'ic-annotate:cancelled') { this._end(false); return; }
    if (e.channel !== 'ic-annotate:picked' || this._pick) return;
    const pick = normalizePick(Array.isArray(e.args) ? e.args[0] : null);
    if (!pick) { this._onError('The page sent an unreadable selection.'); this._end(false); return; }
    this._pick = pick;
    this._openBubble(pick);
  }

  _openBubble(pick) {
    const bubble = document.createElement('div');
    bubble.className = 'annotation-bubble';
    bubble.setAttribute('role', 'dialog');
    bubble.setAttribute('aria-label', 'Comment on the selected element');
    const target = document.createElement('div');
    target.className = 'annotation-bubble__target';
    const label = pick.name || pick.text.slice(0, 80);
    const kind = document.createElement('strong');
    kind.textContent = pick.role || pick.tag || 'element';
    target.append(kind, label ? ` ${label}` : '');
    target.title = pick.selector;
    const input = /** @type {HTMLTextAreaElement} */ (document.createElement('textarea'));
    input.className = 'annotation-bubble__input';
    input.rows = 3;
    input.maxLength = MAX_COMMENT;
    input.setAttribute('aria-label', 'Your comment');
    const actions = document.createElement('div');
    actions.className = 'annotation-bubble__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'annotation-bubble__btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.cancel());
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'annotation-bubble__btn annotation-bubble__btn--primary';
    send.textContent = 'Send';
    send.disabled = true;
    send.addEventListener('click', () => this.submit());
    input.addEventListener('input', () => { send.disabled = !input.value.trim(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit(); }
    });
    actions.append(cancel, send);
    bubble.append(target, input, actions);
    document.body.appendChild(bubble);
    this._bubble = { el: bubble, input };
    this._placeBubble(pick);
    input.focus();
  }

  // Map the pick's page-space rect onto the webview's on-screen box (the
  // ratio absorbs page zoom), then keep the bubble inside the window.
  _placeBubble(pick) {
    const wv = this._wv;
    const box = wv && typeof wv.getBoundingClientRect === 'function' ? wv.getBoundingClientRect() : null;
    const el = this._bubble.el;
    if (!box || !box.width || !pick.viewport.width) return;
    const scale = box.width / pick.viewport.width;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = box.left + pick.rect.x * scale;
    let top = box.top + (pick.rect.y + pick.rect.height) * scale + BUBBLE_GAP;
    if (top + BUBBLE_EST_HEIGHT > vh) top = Math.max(BUBBLE_GAP, box.top + pick.rect.y * scale - BUBBLE_EST_HEIGHT - BUBBLE_GAP);
    left = Math.min(Math.max(BUBBLE_GAP, left), Math.max(BUBBLE_GAP, vw - BUBBLE_WIDTH - BUBBLE_GAP));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  submit() {
    if (!this._pick || !this._bubble) return false;
    const comment = this._bubble.input.value.trim();
    if (!comment) return false;
    const text = formatAnnotation(this._pick, comment);
    this._end(false);
    try { this._send(text); }
    catch (err) { this._onError(`Could not send the annotation: ${errMsg(err)}`); return false; }
    return true;
  }

  _closeBubble() {
    if (this._bubble) this._bubble.el.remove();
    this._bubble = null;
  }

  _setActive(active) {
    if (this._store) this._store.set('annotating', active);
    if (this._onStateChange) this._onStateChange(active);
  }

  destroy() { this.cancel(); }
}

module.exports = AnnotationController;
module.exports.formatAnnotation = formatAnnotation;
module.exports.normalizePick = normalizePick;
