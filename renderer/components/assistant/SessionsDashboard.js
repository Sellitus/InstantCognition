// SessionsDashboard — the "Sessions" side pane: running, paused and queued
// sessions with their step counts, Stop and Open. Seeds from session:running,
// then follows session:event. A finished run whose payload carries `notify`
// raises a Toast, plus a desktop Notification while the window is unfocused.
//
// It stays subscribed while its pane is closed, so completion notices fire
// whichever pane is showing.

const { icon } = require('../Icon');

const STATE_LABELS = { running: 'Running', paused: 'Paused', queued: 'Queued' };
const END_CHANNELS = new Set(['task-completed', 'task-failed', 'start-failed', 'dequeued']);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errText(err) {
  return (err instanceof Error && err.message) || String(err);
}

function taskText(payload) {
  const t = payload && payload.task;
  if (t && typeof t.description === 'string') return t.description;
  return typeof t === 'string' ? t : '';
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/**
 * @typedef {{ sessionId: string, state: string, task: string, steps: number, position: number|null, lane: string, stopping?: boolean, error?: string|null }} RunRow
 *
 * @typedef {object} DashboardOpts
 * @property {HTMLElement} container
 * @property {(sessionId: string) => void} onOpen
 * @property {any} [ipc]             ipcRenderer-shaped
 * @property {any} [notifier]        the HTML5 Notification constructor
 * @property {() => boolean} [hasFocus]
 * @property {any} [toast]
 */

class SessionsDashboard {
  /** @param {DashboardOpts} opts */
  constructor(opts) {
    if (!opts || !(opts.container instanceof HTMLElement)) throw new TypeError('SessionsDashboard requires a container');
    if (typeof opts.onOpen !== 'function') throw new TypeError('SessionsDashboard requires onOpen');
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    this._onOpen = opts.onOpen;
    this._notifier = opts.notifier !== undefined ? opts.notifier : (typeof Notification === 'undefined' ? null : Notification);
    this._hasFocus = opts.hasFocus || (() => document.hasFocus());
    this._toast = opts.toast || require('../Toast');
    /** @type {Map<string, RunRow>} */ this._runs = new Map();
    this._loadError = null;
    this._seq = 0;
    this._build(opts.container);
    this._onEvent = (_e, ev) => this.applyEvent(ev);
    this._ipc.on('session:event', this._onEvent);
    this._render();
  }

  _build(container) {
    const root = el('section', 'sessions-dashboard');
    root.setAttribute('aria-label', 'Running sessions');
    const header = el('header', 'sessions-dashboard__header');
    header.appendChild(el('h2', 'sessions-dashboard__heading', 'Sessions'));
    this._summary = el('span', 'sessions-dashboard__summary');
    this._summary.setAttribute('role', 'status');
    header.appendChild(this._summary);
    this._status = el('div', 'sessions-dashboard__status');
    this._status.hidden = true;
    this._list = el('ul', 'sessions-dashboard__list');
    this._list.setAttribute('aria-label', 'Running and queued sessions');
    this._list.addEventListener('click', (ev) => this._onListClick(ev));
    root.append(header, this._status, this._list);
    container.appendChild(root);
    this.el = root;
  }

  /** @returns {{ running: number, paused: number, queued: number }} */
  counts() {
    const out = { running: 0, paused: 0, queued: 0 };
    for (const r of this._runs.values()) if (out[r.state] !== undefined) out[r.state] += 1;
    return out;
  }

  /** @param {string} id @returns {RunRow|null} */
  get(id) { return this._runs.get(id) || null; }

  // Replaces the table with main's snapshot; step counts already seen for a
  // still-running session are kept, since the snapshot does not carry them.
  async refresh() {
    const seq = ++this._seq;
    try {
      const res = await this._ipc.invoke('session:running', {});
      if (!res || res.ok === false) throw new Error((res && res.error) || 'session:running returned no reply');
      if (seq !== this._seq) return;
      const next = new Map();
      for (const r of Array.isArray(res.runs) ? res.runs : []) {
        if (!r || typeof r.sessionId !== 'string') continue;
        const prev = this._runs.get(r.sessionId);
        next.set(r.sessionId, {
          sessionId: r.sessionId,
          state: STATE_LABELS[r.state] ? r.state : 'running',
          task: typeof r.task === 'string' ? r.task : (prev ? prev.task : ''),
          steps: prev ? prev.steps : 0,
          position: Number.isFinite(r.position) ? r.position : null,
          lane: r.lane === 'foreground' ? 'foreground' : 'background',
          error: null,
        });
      }
      this._runs = next;
      this._loadError = null;
    } catch (err) {
      if (seq !== this._seq) return;
      this._loadError = errText(err);
    }
    this._render();
  }

  /** @param {{ sessionId?: string, channel?: string, payload?: any }} ev */
  applyEvent(ev) {
    if (!ev || typeof ev.sessionId !== 'string' || typeof ev.channel !== 'string') return;
    const id = ev.sessionId;
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    const run = this._runs.get(id);
    switch (ev.channel) {
      case 'task-started':
        this._runs.set(id, { sessionId: id, state: 'running', task: taskText(p) || (run ? run.task : ''), steps: 0, position: null, lane: run ? run.lane : 'background', error: null });
        break;
      case 'queued':
        this._runs.set(id, { sessionId: id, state: 'queued', task: run ? run.task : '', steps: 0, position: Number.isFinite(p.position) ? p.position : null, lane: 'background', error: null });
        break;
      // Progress for a session this table does not hold belongs to another
      // surface (or arrived after its end), so it never creates a row.
      case 'step-acted':
        if (!run) return;
        run.steps += 1;
        break;
      case 'task-paused':
      case 'task-resumed':
        if (!run) return;
        run.state = ev.channel === 'task-paused' ? 'paused' : 'running';
        break;
      // The run finished but its result never reached the inbox, so the
      // user would otherwise never learn of it.
      case 'inbox-failed':
        this._toast.error(`${run && run.task ? run.task : 'A background session'} finished, but its result could not be saved to the inbox: ${p.error || 'unknown error'}`, {
          title: 'Inbox', action: { label: 'Open', onClick: () => this._onOpen(id) },
        });
        return;
      default:
        if (!END_CHANNELS.has(ev.channel)) return;
        this._runs.delete(id);
        if (ev.channel === 'task-completed' && p.notify === true) this._announceCompleted(id, run, p);
        else if ((ev.channel === 'task-failed' || ev.channel === 'start-failed') && (!run || run.lane !== 'foreground')) {
          this._toast.error(`${run && run.task ? run.task : 'A background session'} failed: ${p.error || 'unknown error'}`, {
            title: 'Session failed', action: { label: 'Open', onClick: () => this._onOpen(id) },
          });
        }
    }
    this._render();
  }

  /**
   * Stops a running or queued session. A session that already finished is a
   * no-op: nothing is sent and the call resolves as finished.
   * @param {string} id
   */
  async stop(id) {
    const run = this._runs.get(id);
    if (!run) return { ok: true, state: 'finished' };
    run.stopping = true;
    run.error = null;
    this._render();
    let res;
    try {
      res = await this._ipc.invoke('session:stop', { sessionId: id });
    } catch (err) {
      res = { ok: false, error: errText(err) };
    }
    const current = this._runs.get(id);
    if (res && res.ok === false && res.error === 'not_running') {
      this._runs.delete(id);
      this._render();
      return { ok: true, state: 'finished' };
    }
    if (!res || res.ok === false) {
      const error = (res && res.error) || 'session:stop returned no reply';
      if (current) { current.stopping = false; current.error = `Couldn’t stop: ${error}`; }
      this._render();
      return { ok: false, error };
    }
    if (res.state === 'dequeued') this._runs.delete(id);
    this._render();
    return res;
  }

  _announceCompleted(id, run, p) {
    const task = run && run.task ? run.task : 'Background session';
    const stopped = p.reason === 'stopped';
    const ok = !!p.ok && !stopped;
    const verb = ok ? 'Finished' : (stopped ? 'Stopped' : 'Ended without an answer');
    const message = `${verb}: ${task}`;
    const open = { label: 'Open', onClick: () => this._onOpen(id) };
    if (ok) this._toast.success(message, { title: 'Session complete', action: open });
    else this._toast.warn(message, { title: 'Session ended', action: open });
    if (!this._hasFocus()) {
      const body = typeof p.summary === 'string' && p.summary.trim() ? p.summary.trim().slice(0, 240) : message;
      return this._desktopNotify(ok ? 'Session complete' : 'Session ended', body, id);
    }
    return Promise.resolve();
  }

  // The Toast above has already told the user, so a declined permission only
  // skips the desktop copy; an API that throws is reported, never dropped.
  async _desktopNotify(title, body, id) {
    const N = this._notifier;
    if (!N) return;
    try {
      let permission = N.permission;
      if (permission === 'default' && typeof N.requestPermission === 'function') permission = await N.requestPermission();
      if (permission !== 'granted') return;
      const note = new N(title, { body, tag: `session-${id}` });
      note.onclick = () => {
        if (typeof window.focus === 'function') window.focus();
        this._onOpen(id);
      };
    } catch (err) {
      console.error('[SessionsDashboard] desktop notification failed:', errText(err));
      this._toast.warn(`Desktop notification failed: ${errText(err)}`, { title: 'Notifications' });
    }
  }

  _onListClick(ev) {
    const target = /** @type {HTMLElement} */ (ev.target);
    const btn = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
    const row = /** @type {HTMLElement|null} */ (target.closest('[data-session-id]'));
    if (!btn || !row) return;
    const id = row.dataset.sessionId;
    if (btn.dataset.action === 'stop') this.stop(id);
    else if (btn.dataset.action === 'open') this._onOpen(id);
  }

  _render() {
    const c = this.counts();
    const parts = [];
    if (c.running) parts.push(`${c.running} running`);
    if (c.paused) parts.push(`${c.paused} paused`);
    if (c.queued) parts.push(`${c.queued} queued`);
    this._summary.textContent = parts.join(' · ');
    this._status.replaceChildren();
    this._status.hidden = !this._loadError;
    if (this._loadError) {
      this._status.setAttribute('role', 'alert');
      this._status.appendChild(el('span', '', `Couldn’t load running sessions: ${this._loadError}`));
      const retry = el('button', 'sessions-dashboard__retry', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', () => this.refresh());
      this._status.appendChild(retry);
    }
    this._list.replaceChildren();
    if (!this._runs.size) {
      this._list.appendChild(el('li', 'sessions-dashboard__empty', 'Nothing running. Background sessions and routines appear here while they work.'));
      return;
    }
    const order = { running: 0, paused: 1, queued: 2 };
    const rows = Array.from(this._runs.values()).sort((a, b) => (order[a.state] - order[b.state]) || ((a.position || 0) - (b.position || 0)));
    for (const r of rows) this._list.appendChild(this._renderRow(r));
  }

  /** @param {RunRow} r */
  _renderRow(r) {
    const li = el('li', `sessions-dashboard__row is-${r.state}`);
    li.dataset.sessionId = r.sessionId;
    const main = el('div', 'sessions-dashboard__row-main');
    main.appendChild(el('span', 'sessions-dashboard__task', r.task || 'Untitled task'));
    const meta = el('div', 'sessions-dashboard__meta');
    const stateText = r.state === 'queued' && r.position ? `Queued #${r.position}` : STATE_LABELS[r.state];
    meta.appendChild(el('span', `sessions-dashboard__state sessions-dashboard__state--${r.state}`, stateText));
    if (r.state !== 'queued') meta.appendChild(el('span', 'sessions-dashboard__steps', plural(r.steps, 'step')));
    if (r.lane === 'foreground') meta.appendChild(el('span', 'sessions-dashboard__lane', 'In panel'));
    main.appendChild(meta);
    if (r.error) {
      const err = el('div', 'sessions-dashboard__row-error', r.error);
      err.setAttribute('role', 'alert');
      main.appendChild(err);
    }
    const actions = el('div', 'sessions-dashboard__actions');
    const open = el('button', 'sessions-dashboard__btn');
    open.type = 'button';
    open.dataset.action = 'open';
    open.append(icon('external'), el('span', '', 'Open'));
    open.setAttribute('aria-label', `Open ${r.task || 'session'}`);
    const stop = el('button', 'sessions-dashboard__btn sessions-dashboard__btn--danger');
    stop.type = 'button';
    stop.dataset.action = 'stop';
    stop.disabled = !!r.stopping;
    stop.append(icon('stop'), el('span', '', r.stopping ? 'Stopping…' : 'Stop'));
    stop.setAttribute('aria-label', `Stop ${r.task || 'session'}`);
    actions.append(open, stop);
    li.append(main, actions);
    return li;
  }

  destroy() {
    this._ipc.removeListener('session:event', this._onEvent);
    this.el.remove();
  }
}

module.exports = SessionsDashboard;
