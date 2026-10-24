// ApprovalCard — the agent's pending approval requests (agent:approval-request)
// as a FIFO queue; the head request renders as a card and the answer goes back
// over agent:approval-response. A response for a requestId that is no longer
// queued is never sent: main has already resolved it (timeout, stop, reset).
//
// Request kinds: fs_edit shows the proposed patch, shell shows the argv and the
// working directory, browser keeps the per-site/per-session grants, anything
// else shows its argument preview. "Always allow" only appears when main
// offered a suggestedRule, and main persists its own copy of that rule. A
// browser request with no single origin gets only the one-shot decisions:
// main ignores session/site grants it has no host to scope them to.

const DiffView = require('./DiffView');

const ARGS_FALLBACK_MAX = 200;

const BROWSER_BUTTONS = [
  { decision: 'approve', label: 'Approve once' },
  { decision: 'approve_session', label: 'Approve for session' },
  { decision: 'approve_origin', label: 'Always allow on this site' },
  { decision: 'reject', label: 'Reject' },
];
const BROWSER_ONE_SHOT = new Set(['approve', 'reject']);

const TITLES = {
  fs_edit: 'Allow this file change?',
  shell: 'Allow this command?',
  browser: 'Approve action?',
  tool: 'Allow this tool call?',
};

/** @param {string} tag @param {string} [className] @param {string} [text] */
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Mirrors main's kindOf for payloads that predate the `kind` field. */
function kindFor(payload) {
  if (['fs_edit', 'shell', 'browser', 'tool'].includes(payload.kind)) return payload.kind;
  const name = toolNameOf(payload);
  if (name === 'fs.write' || name === 'fs.edit') return 'fs_edit';
  if (name === 'shell.run') return 'shell';
  if (name.startsWith('browser.')) return 'browser';
  return 'tool';
}

function toolNameOf(payload) {
  if (typeof payload.toolName === 'string' && payload.toolName) return payload.toolName;
  return String((payload.call && payload.call.name) || '');
}

function argsTextOf(payload) {
  if (typeof payload.argsPreview === 'string') return payload.argsPreview;
  const args = payload.call && payload.call.args;
  return JSON.stringify(args && typeof args === 'object' ? args : {}).slice(0, ARGS_FALLBACK_MAX);
}

function isEditable(elx) {
  if (!elx) return false;
  const tag = elx.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || !!elx.isContentEditable;
}

class ApprovalCard {
  /**
   * @param {{
   *   container: HTMLElement,
   *   ipc?: { send: Function },
   *   focusRoot?: () => (HTMLElement|null),
   *   onDrained?: (hadFocus: boolean) => void,
   *   sessionLabel?: (payload: any) => (string|null),
   * }} opts
   *   focusRoot: the surface the card may take focus within (the panel); focus
   *   held anywhere else, or in an editable field, is left alone and the
   *   request is announced instead.
   *   onDrained: called after the last queued request is answered.
   *   sessionLabel: names the session a request came from when it is not the
   *   one on screen; null for the foreground session's own requests.
   */
  constructor(opts) {
    if (!opts || !opts.container) throw new TypeError('ApprovalCard needs a container');
    this._container = opts.container;
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    this._focusRoot = typeof opts.focusRoot === 'function' ? opts.focusRoot : () => null;
    this._onDrained = typeof opts.onDrained === 'function' ? opts.onDrained : () => {};
    this._sessionLabel = typeof opts.sessionLabel === 'function' ? opts.sessionLabel : () => null;
    /** @type {any[]} */
    this._queue = [];
    this._container.removeAttribute('aria-live');
    this._container.setAttribute('role', 'region');
    this._container.setAttribute('aria-label', 'Pending approvals');
    this._live = node('div', 'approval-card__live');
    this._live.setAttribute('role', 'status');
    this._live.setAttribute('aria-live', 'polite');
    if (this._container.parentNode) this._container.parentNode.insertBefore(this._live, this._container.nextSibling);
  }

  get size() { return this._queue.length; }

  /** @param {string} requestId */
  has(requestId) { return this._queue.some((p) => p.requestId === requestId); }

  /**
   * Queue a request. Malformed and duplicate requests are ignored.
   * @returns {boolean} whether it was queued
   */
  enqueue(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.requestId !== 'string' || !payload.requestId) return false;
    if (this.has(payload.requestId)) return false;
    this._queue.push(payload);
    // Re-show the head if its card is not on screen.
    if (this._queue.length === 1 || !this._headShown()) this._render(true);
    else this._renderCounter();
    return true;
  }

  /**
   * Answer a queued request. An unknown or already-answered requestId is a
   * no-op: nothing is sent.
   * @returns {boolean} whether a response was sent
   */
  respond(requestId, decision) {
    const idx = this._queue.findIndex((p) => p.requestId === requestId);
    if (idx < 0) return false;
    const hadFocus = this._container.contains(document.activeElement);
    this._queue.splice(idx, 1);
    this._ipc.send('agent:approval-response', { requestId, decision });
    if (idx === 0) this._render(hadFocus);
    else this._renderCounter();
    if (!this._queue.length) this._onDrained(hadFocus);
    return true;
  }

  /**
   * Drop queued requests without answering them (main resolved them already).
   * @param {(payload: any) => boolean} [predicate] defaults to every request
   */
  clear(predicate) {
    const keep = typeof predicate === 'function' ? this._queue.filter((p) => !predicate(p)) : [];
    if (keep.length === this._queue.length) return;
    const headChanged = !keep.length || keep[0] !== this._queue[0];
    this._queue = keep;
    if (headChanged) this._render(false);
    else this._renderCounter();
  }

  /** Show the head card if it is off screen (hide the container when empty), without taking focus. */
  sync() { if (!this._headShown()) this._render(false); }

  /** Re-resolve the head card's session label, e.g. after the foreground session changed. */
  relabel() {
    const head = this._queue[0];
    const card = this._container.querySelector('.approval-card');
    if (!head || !card) return;
    const old = card.querySelector('.approval-card__session');
    const fresh = this._sessionNode(head);
    if (old && fresh) old.replaceWith(fresh);
    else if (old) old.remove();
    else if (fresh) card.querySelector('.approval-card__top').after(fresh);
  }

  _sessionNode(p) {
    const label = this._sessionLabel(p);
    if (typeof label !== 'string' || !label) return null;
    return node('div', 'approval-card__session', `From session: ${label}`);
  }

  _headShown() {
    const head = this._queue[0];
    const card = /** @type {HTMLElement|null} */ (this._container.querySelector('.approval-card'));
    return !!(head && card && !this._container.hidden && card.dataset.requestId === head.requestId);
  }

  _announce(text) {
    this._live.textContent = '';
    this._live.textContent = text;
  }

  _canTakeFocus() {
    const ae = /** @type {HTMLElement|null} */ (document.activeElement);
    if (!ae || ae === document.body) return true;
    if (isEditable(ae)) return false;
    const root = this._focusRoot();
    return !!(root && root.contains(ae));
  }

  /** @param {boolean} takeFocus whether the new head card may take focus */
  _render(takeFocus) {
    const c = this._container;
    c.innerHTML = '';
    const head = this._queue[0];
    if (!head) { c.hidden = true; return; }
    const card = this._buildCard(head);
    c.appendChild(card);
    c.hidden = false;
    this._renderCounter();
    const tool = toolNameOf(head) || 'a tool';
    const label = card.querySelector('.approval-card__session');
    const from = label ? ` ${label.textContent}.` : '';
    if (takeFocus && this._canTakeFocus()) card.focus();
    else this._announce(`Approval needed: ${tool}.${from} Use Tab to reach the approval buttons.`);
  }

  _renderCounter() {
    const counter = /** @type {HTMLElement|null} */ (this._container.querySelector('.approval-card__counter'));
    if (!counter) return;
    const n = this._queue.length;
    counter.hidden = n < 2;
    counter.textContent = n < 2 ? '' : `1 of ${n}`;
  }

  _buildCard(p) {
    const kind = kindFor(p);
    const name = toolNameOf(p);
    const titleId = `approval-card-title-${p.requestId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const card = node('div', `approval-card approval-card--${kind}`);
    card.tabIndex = -1;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-labelledby', titleId);
    card.dataset.requestId = p.requestId;

    const top = node('div', 'approval-card__top');
    const title = node('div', 'approval-card__title agent-panel-approval-title', TITLES[kind]);
    title.id = titleId;
    const counter = node('span', 'approval-card__counter');
    counter.hidden = true;
    top.append(title, counter);
    card.appendChild(top);
    const session = this._sessionNode(p);
    if (session) card.appendChild(session);
    card.appendChild(node('div', 'approval-card__meta agent-panel-approval-meta', `${p.class || 'unknown'} · ${p.origin || '(no origin)'}`));

    const call = node('div', 'approval-card__call agent-panel-approval-call');
    call.appendChild(node('code', 'approval-card__tool', name || '(unnamed tool)'));
    card.appendChild(call);

    if (kind === 'fs_edit') this._fsEditBody(card, p);
    else if (kind === 'shell') this._shellBody(card, p);
    else {
      if (typeof p.path === 'string' && p.path) card.appendChild(this._field('Path', p.path));
      if (kind === 'browser') this._originsList(card, p);
      const args = argsTextOf(p);
      if (args) card.appendChild(node('pre', 'approval-card__args', args));
    }

    card.appendChild(this._actions(p, kind));
    return card;
  }

  _field(label, value) {
    const row = node('div', 'approval-card__field');
    row.append(node('span', 'approval-card__label', label), node('code', 'approval-card__value', value));
    return row;
  }

  _fsEditBody(card, p) {
    if (typeof p.path === 'string' && p.path) card.appendChild(this._field('File', p.path));
    if (p.previewError) {
      const err = node('div', 'approval-card__error', `Preview unavailable: ${String(p.previewError)}`);
      err.setAttribute('role', 'note');
      card.appendChild(err);
    }
    if (typeof p.diff === 'string') card.appendChild(new DiffView({ diff: p.diff }).el);
    else if (!p.previewError) card.appendChild(node('pre', 'approval-card__args', argsTextOf(p)));
  }

  _originsList(card, p) {
    const origins = Array.isArray(p.origins) ? p.origins : [];
    if (!origins.length) return;
    const list = node('ul', 'approval-card__argv approval-card__origins');
    list.setAttribute('aria-label', 'Sites this action will open');
    for (const o of origins) list.appendChild(node('li', 'approval-card__chip', String(o)));
    card.appendChild(list);
  }

  _shellBody(card, p) {
    const argv = Array.isArray(p.argv) ? p.argv : [];
    const list = node('ul', 'approval-card__argv');
    list.setAttribute('aria-label', 'Command arguments');
    for (const a of argv) list.appendChild(node('li', 'approval-card__chip', String(a)));
    if (!argv.length) list.appendChild(node('li', 'approval-card__chip approval-card__chip--empty', '(no arguments)'));
    card.appendChild(list);
    card.appendChild(this._field('Working directory', p.cwd ? String(p.cwd) : '(workspace root)'));
    card.appendChild(node('p', 'approval-card__note', 'Runs outside the sandbox: only the working directory is locked to the workspace. The command can still reach any path your account can.'));
  }

  _actions(p, kind) {
    const row = node('div', 'approval-card__actions agent-panel-approval-actions');
    /** @type {{ decision: string, label: string, rule?: string }[]} */
    const buttons = kind !== 'browser' ? [{ decision: 'approve', label: 'Allow once' }]
      : p.origin ? BROWSER_BUTTONS.slice() : BROWSER_BUTTONS.filter((b) => BROWSER_ONE_SHOT.has(b.decision));
    if (kind !== 'browser' && typeof p.suggestedRule === 'string' && p.suggestedRule) {
      buttons.push({ decision: 'allow_rule_always', label: 'Always allow', rule: p.suggestedRule });
    }
    if (kind !== 'browser') buttons.push({ decision: 'reject', label: 'Deny' });
    for (const { decision, label, rule } of buttons) {
      const btn = node('button', `approval-card__btn approval-card__btn--${decision.replace(/_/g, '-')}`);
      btn.setAttribute('type', 'button');
      btn.dataset.decision = decision;
      btn.appendChild(node('span', 'approval-card__btn-label', label));
      if (rule) {
        btn.appendChild(node('code', 'approval-card__rule', rule));
        btn.setAttribute('aria-label', `Always allow: ${rule}`);
      }
      btn.addEventListener('click', () => this.respond(p.requestId, decision));
      row.appendChild(btn);
    }
    return row;
  }
}

module.exports = ApprovalCard;
module.exports.kindFor = kindFor;
