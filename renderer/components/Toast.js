/**
 * Toast — singleton bottom-right notification service.
 *
 * Replaces `alert()`, ad-hoc banners, and button-flash feedback with one
 * consistent, auto-dismissing surface. Max 3 visible at once; older ones
 * queue. Rate-limited: identical messages within 3s are coalesced.
 *
 * Usage:
 *   toast.success('Broadcast sent');
 *   toast.error('Failed to save', { title: 'Save error' });
 *   toast.info('Download complete', { action: { label: 'Show', onClick: () => ... } });
 *   toast.info('Update ready', { actions: [{ label: 'Later', onClick }, { label: 'Install', onClick }] });
 *   toast.warn('Config changed — restart required');
 *   toast.show({ kind: 'success', message: 'X', timeout: 6000 });
 */

const { iconHTML } = require('./Icon');
const { escapeHtml } = require('../utils/html');

const MAX_VISIBLE = 3;
const DEFAULT_TIMEOUT = 4000;
const DEDUP_WINDOW_MS = 3000;

// `actions` takes several buttons; the single `action` form is shorthand for one.
function normalizeActions(opts) {
  const list = Array.isArray(opts.actions) ? opts.actions : (opts.action ? [opts.action] : []);
  return list.filter((a) => a && a.label);
}

const ICON_FOR_KIND = {
  info: 'dot',
  success: 'check',
  warn: 'warn',
  error: 'warn',
};

class ToastService {
  constructor() {
    this._container = null;
    this._queue = [];
    this._visible = [];
    this._lastShown = new Map(); // "kind:message" -> timestamp
  }

  _ensureContainer() {
    if (this._container && document.body.contains(this._container)) return;
    if (!document || !document.body) return;
    const el = document.createElement('div');
    el.className = 'toast-stack';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Notifications');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    this._container = el;
  }

  _dedupKey(kind, message) { return `${kind}:${message}`; }

  show(opts) {
    if (!opts || !opts.message) return null;
    const kind = opts.kind && ICON_FOR_KIND[opts.kind] ? opts.kind : 'info';
    const message = String(opts.message);
    const now = Date.now();
    const key = this._dedupKey(kind, message);
    const last = this._lastShown.get(key);
    if (last && now - last < DEDUP_WINDOW_MS) return null;
    this._lastShown.set(key, now);

    const entry = {
      kind,
      message,
      title: opts.title || '',
      timeout: Number.isFinite(opts.timeout) ? opts.timeout : DEFAULT_TIMEOUT,
      actions: normalizeActions(opts),
      id: `toast-${now}-${Math.random().toString(36).slice(2, 7)}`,
    };

    if (this._visible.length >= MAX_VISIBLE) {
      this._queue.push(entry);
    } else {
      this._render(entry);
    }
    return entry.id;
  }

  info(message, opts = {})    { return this.show({ ...opts, kind: 'info',    message }); }
  success(message, opts = {}) { return this.show({ ...opts, kind: 'success', message }); }
  warn(message, opts = {})    { return this.show({ ...opts, kind: 'warn',    message }); }
  error(message, opts = {})   { return this.show({ ...opts, kind: 'error',   message, timeout: opts.timeout || 6000 }); }

  dismiss(id) {
    const idx = this._visible.findIndex((v) => v.entry.id === id);
    if (idx >= 0) {
      this._removeVisible(idx);
      return;
    }
    // Not yet rendered: still waiting in the queue behind MAX_VISIBLE.
    // Cancel it there so a recovery (e.g. a successful persist) can drop
    // a warning before it ever reaches the screen.
    const queued = this._queue.findIndex((e) => e.id === id);
    if (queued >= 0) this._queue.splice(queued, 1);
  }

  _render(entry) {
    this._ensureContainer();
    if (!this._container) return;

    const el = document.createElement('div');
    el.className = `toast toast-${entry.kind}`;
    const urgent = entry.kind === 'error' || entry.kind === 'warn';
    // The stack is aria-live=polite, which would otherwise queue a failure
    // behind whatever is being announced; failures interrupt.
    el.setAttribute('role', urgent ? 'alert' : 'status');
    el.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
    el.dataset.id = entry.id;

    const iconName = ICON_FOR_KIND[entry.kind];
    const titleHTML = entry.title ? `<div class="toast-title">${escapeHtml(entry.title)}</div>` : '';
    const buttons = entry.actions
      .map((a, i) => `<button type="button" class="toast-action" data-action-index="${i}">${escapeHtml(a.label)}</button>`)
      .join('');
    // One button sits beside the message; several get their own row under it.
    const stacked = entry.actions.length > 1;

    el.innerHTML = ''
      + `<span class="toast-icon">${iconHTML(iconName)}</span>`
      + '<div class="toast-body">'
      +   titleHTML
      +   `<div class="toast-message">${escapeHtml(entry.message)}</div>`
      +   (stacked ? `<div class="toast-actions">${buttons}</div>` : '')
      + '</div>'
      + (stacked ? '' : buttons)
      + `<button type="button" class="toast-close" aria-label="Dismiss">${iconHTML('close')}</button>`;

    this._container.appendChild(el);

    const removeFn = () => this.dismiss(entry.id);
    const closeBtn = el.querySelector('.toast-close');
    if (closeBtn) closeBtn.addEventListener('click', removeFn);
    el.querySelectorAll('.toast-action').forEach((actBtn) => {
      const action = entry.actions[Number(actBtn.getAttribute('data-action-index'))];
      actBtn.addEventListener('click', () => {
        if (typeof action.onClick === 'function') {
          try { action.onClick(); }
          catch (err) { console.error('[Toast] action handler failed:', (err instanceof Error && err.message) || err); }
        }
        removeFn();
      });
    });

    let timerId = null;
    if (entry.timeout > 0) {
      timerId = setTimeout(removeFn, entry.timeout);
    }

    this._visible.push({ entry, el, timerId });
  }

  _removeVisible(idx) {
    const rec = this._visible[idx];
    if (!rec) return;
    if (rec.timerId) clearTimeout(rec.timerId);
    rec.el.classList.add('toast-leaving');
    setTimeout(() => {
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    }, 180);
    this._visible.splice(idx, 1);
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      this._render(next);
    }
  }
}

const toast = new ToastService();
module.exports = toast;
