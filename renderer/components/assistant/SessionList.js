// SessionList — the Assistant's history column: every saved session from the
// session store (session:list), live via session:list-changed. Search, pin,
// inline rename, inline delete confirm, and project grouping when a session
// belongs to a project. Selecting a row notifies onSelect listeners; the
// panel decides how a session loads.
//
// The root keeps the .agent-history class: HistoryRail collapses that element
// and agent-panel.css sizes the column by it.

const { relTime } = require('../agent/format');
const { icon } = require('../Icon');

const SOURCE_LABELS = { routine: 'Routine', launcher: 'Launcher', fork: 'Fork', subagent: 'Subagent' };
const FRIENDLY_ERRORS = {
  session_busy: 'it is still running',
  session_not_found: 'it no longer exists',
  invalid_title: 'the name is too long',
};
const MAX_TITLE = 200;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(className, iconName, label) {
  const btn = el('button', className);
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.appendChild(icon(iconName));
  return btn;
}

function errText(err) {
  return (err instanceof Error && err.message) || String(err);
}

function friendly(code) {
  return FRIENDLY_ERRORS[code] || code;
}

/** Resolves an IPC reply, turning a rejection or `{ok:false}` into a thrown Error. */
async function call(ipc, channel, arg) {
  const res = await ipc.invoke(channel, arg);
  if (!res || res.ok === false) throw new Error((res && res.error) || `${channel} returned no reply`);
  return res;
}

function displayTitle(s) {
  return (typeof s.title === 'string' && s.title.trim()) || 'Untitled session';
}

class SessionList {
  /**
   * @param {{ root: HTMLElement, ipc?: any, onCountChange?: (n: number) => void }} opts
   */
  constructor(opts) {
    if (!opts || !(opts.root instanceof HTMLElement)) throw new TypeError('SessionList requires a root element');
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    this._onCountChange = typeof opts.onCountChange === 'function' ? opts.onCountChange : null;
    /** @type {any[]} */ this._rows = [];
    /** @type {Map<string, string>} */ this._projectNames = new Map();
    /** @type {Set<string>} */ this._running = new Set();
    /** @type {Map<string, string>} */ this._taskToSession = new Map();
    /** @type {Set<(id: string, row: any) => void>} */ this._selectListeners = new Set();
    this._query = '';
    this._activeId = null;
    this._loadError = null;
    this._actionError = null;
    this._renamingId = null;
    this._confirmDeleteId = null;
    this._seq = 0;
    this._inFlight = null;
    this._dirty = false;
    this.el = this._build();
    opts.root.appendChild(this.el);

    this._onListChanged = () => { this.refresh(); };
    this._onSessionEvent = (_e, ev) => this._applySessionEvent(ev);
    this._onAgentStarted = (_e, payload) => {
      if (payload && typeof payload.taskId === 'string' && typeof payload.sessionId === 'string') {
        this._taskToSession.set(payload.taskId, payload.sessionId);
      }
    };
    this._ipc.on('session:list-changed', this._onListChanged);
    this._ipc.on('session:event', this._onSessionEvent);
    this._ipc.on('agent:task-started', this._onAgentStarted);
    this._render();
  }

  _build() {
    const root = el('aside', 'agent-history session-list');
    root.setAttribute('aria-label', 'Sessions');
    const header = el('div', 'session-list__header');
    header.appendChild(el('span', 'session-list__title', 'Sessions'));
    const refresh = iconButton('session-list__icon-btn session-list__refresh', 'refresh', 'Refresh sessions');
    refresh.addEventListener('click', () => this.refresh());
    header.appendChild(refresh);
    this._searchEl = /** @type {HTMLInputElement} */ (el('input', 'session-list__search'));
    this._searchEl.type = 'search';
    this._searchEl.setAttribute('aria-label', 'Search sessions');
    this._searchEl.setAttribute('placeholder', 'Search sessions');
    this._searchEl.title = 'Search sessions';
    this._searchEl.addEventListener('input', () => {
      this._query = (this._searchEl.value || '').toLowerCase().trim();
      this._render();
    });
    this._errorEl = el('div', 'session-list__error');
    this._errorEl.setAttribute('role', 'alert');
    this._errorEl.hidden = true;
    this._listEl = el('div', 'session-list__list');
    this._listEl.setAttribute('role', 'list');
    this._listEl.addEventListener('click', (ev) => this._onListClick(ev));
    this._listEl.addEventListener('keydown', (ev) => this._onListKey(ev));
    root.append(header, this._searchEl, this._errorEl, this._listEl);
    return root;
  }

  /** @param {(id: string, row: any) => void} cb @returns {() => void} */
  onSelect(cb) {
    if (typeof cb !== 'function') throw new TypeError('SessionList.onSelect expects a function');
    this._selectListeners.add(cb);
    return () => { this._selectListeners.delete(cb); };
  }

  focusSearch() { this._searchEl.focus(); }

  /** Sessions loaded (unfiltered); drives the collapsed rail's count badge. */
  count() { return this._rows.length; }

  /** @param {string} id */
  get(id) { return this._rows.find((r) => r.id === id) || null; }

  // Overlapping refreshes (a burst of list-changed pushes) collapse into one
  // trailing reload, so the list never renders an older reply over a newer one.
  refresh() {
    if (this._inFlight) {
      this._dirty = true;
      return this._inFlight;
    }
    const seq = ++this._seq;
    this._inFlight = this._load(seq).finally(() => {
      this._inFlight = null;
      if (this._dirty) {
        this._dirty = false;
        return this.refresh();
      }
      return undefined;
    });
    return this._inFlight;
  }

  async _load(seq) {
    try {
      const res = await call(this._ipc, 'session:list', {});
      if (seq !== this._seq) return;
      this._rows = Array.isArray(res.sessions) ? res.sessions.filter((s) => s && typeof s.id === 'string') : [];
      this._loadError = null;
      await this._loadProjectNames();
    } catch (err) {
      if (seq !== this._seq) return;
      this._loadError = errText(err);
    }
    this._render();
  }

  // Group headers read better with project names; ids stand in when the
  // project list is unreachable, and the failure is shown in the error row.
  async _loadProjectNames() {
    const missing = this._rows.some((r) => r.projectId && !this._projectNames.has(r.projectId));
    if (!missing) return;
    try {
      const res = await call(this._ipc, 'projects:list', undefined);
      for (const p of Array.isArray(res.projects) ? res.projects : []) {
        if (p && typeof p.id === 'string') this._projectNames.set(p.id, String(p.name || p.id));
      }
    } catch (err) {
      this._showActionError(`Couldn’t load project names: ${errText(err)}`);
    }
  }

  /** @param {string|null} id a session id, or a legacy run id an imported session carries */
  setActive(id) {
    const row = id ? this._rows.find((r) => r.id === id || r.legacyRunId === id) : null;
    this._activeId = row ? row.id : (id || null);
    this._render();
  }

  getActive() { return this._activeId; }

  // AgentLane reports foreground runs by task id; agent:task-started told us
  // which session each task belongs to.
  /** @param {{ taskId?: string }} run */
  prependRunning(run) {
    const sid = run && run.taskId ? this._taskToSession.get(run.taskId) : null;
    if (!sid) return;
    this._running.add(sid);
    this._activeId = sid;
    this._render();
  }

  /** @param {{ taskId?: string }} run */
  markFinal(run) {
    const sid = run && run.taskId ? this._taskToSession.get(run.taskId) : null;
    if (!sid) return;
    this._running.delete(sid);
    this._render();
  }

  _applySessionEvent(ev) {
    if (!ev || typeof ev.sessionId !== 'string') return;
    const before = this._running.has(ev.sessionId);
    if (ev.channel === 'task-started') this._running.add(ev.sessionId);
    else if (['task-completed', 'task-failed', 'start-failed', 'dequeued'].includes(ev.channel)) this._running.delete(ev.sessionId);
    if (before !== this._running.has(ev.sessionId)) this._render();
  }

  _filtered() {
    const q = this._query;
    if (!q) return this._rows.slice();
    return this._rows.filter((r) => displayTitle(r).toLowerCase().includes(q));
  }

  // Pinned first, then one group per project, then everything else. Group
  // labels appear only when there is more than one group to tell apart.
  _groups(rows) {
    const pinned = rows.filter((r) => r.pinned);
    const byProject = new Map();
    const rest = [];
    for (const r of rows) {
      if (r.pinned) continue;
      if (r.projectId) {
        if (!byProject.has(r.projectId)) byProject.set(r.projectId, []);
        byProject.get(r.projectId).push(r);
      } else rest.push(r);
    }
    const groups = [];
    if (pinned.length) groups.push({ label: 'Pinned', rows: pinned });
    for (const [pid, list] of byProject) groups.push({ label: this._projectNames.get(pid) || pid, rows: list, project: true });
    if (rest.length) groups.push({ label: 'Recent', rows: rest });
    return groups;
  }

  _render() {
    if (this._onCountChange) this._onCountChange(this._rows.length);
    this._renderError();
    this._listEl.replaceChildren();
    if (this._loadError) {
      const box = el('div', 'session-list__load-error');
      box.setAttribute('role', 'alert');
      box.append(el('span', 'session-list__load-error-title', 'Couldn’t load sessions'), el('span', 'session-list__load-error-detail', this._loadError));
      const retry = el('button', 'session-list__retry');
      retry.type = 'button';
      retry.append(icon('refresh'), el('span', '', 'Try again'));
      retry.addEventListener('click', () => this.refresh());
      box.appendChild(retry);
      this._listEl.appendChild(box);
      return;
    }
    const rows = this._filtered();
    if (!rows.length) {
      this._listEl.appendChild(el('div', 'session-list__empty', this._query
        ? 'No matching sessions.'
        : 'No sessions yet. Your conversations and agent runs appear here.'));
      return;
    }
    const groups = this._groups(rows);
    for (const g of groups) {
      if (groups.length > 1) {
        const label = el('div', `session-list__group${g.project ? ' session-list__group--project' : ''}`, g.label);
        label.setAttribute('role', 'presentation');
        this._listEl.appendChild(label);
      }
      for (const r of g.rows) this._listEl.appendChild(this._renderRow(r));
    }
  }

  _renderError() {
    this._errorEl.replaceChildren();
    this._errorEl.hidden = !this._actionError;
    if (!this._actionError) return;
    const dismiss = iconButton('session-list__icon-btn session-list__error-dismiss', 'close', 'Dismiss error');
    dismiss.addEventListener('click', () => {
      this._actionError = null;
      this._renderError();
    });
    this._errorEl.append(el('span', 'session-list__error-text', this._actionError), dismiss);
  }

  _showActionError(message) {
    this._actionError = message;
    this._renderError();
  }

  _renderRow(r) {
    const row = el('div', 'session-list__row');
    row.setAttribute('role', 'listitem');
    row.dataset.sessionId = r.id;
    row.classList.toggle('is-active', r.id === this._activeId);
    row.classList.toggle('is-pinned', !!r.pinned);
    if (r.error) row.classList.add('is-unreadable');

    if (this._renamingId === r.id) {
      row.appendChild(this._renameInput(r));
      return row;
    }
    if (this._confirmDeleteId === r.id) {
      row.appendChild(this._deleteConfirm(r));
      return row;
    }

    const open = el('button', 'session-list__open');
    open.type = 'button';
    open.dataset.action = 'open';
    if (r.id === this._activeId) open.setAttribute('aria-current', 'true');
    const titleLine = el('span', 'session-list__row-main');
    if (this._running.has(r.id)) {
      const dot = el('span', 'session-list__running');
      dot.setAttribute('aria-label', 'Running');
      dot.setAttribute('role', 'img');
      titleLine.appendChild(dot);
    }
    titleLine.appendChild(el('span', 'session-list__row-title', displayTitle(r)));
    const meta = el('span', 'session-list__row-meta');
    meta.appendChild(el('span', 'session-list__row-time', r.error ? 'Unreadable session' : relTime(r.updatedAt)));
    if (SOURCE_LABELS[r.source]) meta.appendChild(el('span', 'session-list__badge', SOURCE_LABELS[r.source]));
    if (r.corruptLines > 0) meta.appendChild(el('span', 'session-list__badge session-list__badge--warn', `${r.corruptLines} damaged`));
    open.append(titleLine, meta);
    open.title = displayTitle(r);

    const actions = el('div', 'session-list__actions');
    const pinLabel = r.pinned ? 'Unpin' : 'Pin';
    const pin = iconButton(`session-list__icon-btn${r.pinned ? ' is-on' : ''}`, 'pin', pinLabel);
    pin.dataset.action = 'pin';
    pin.setAttribute('aria-pressed', r.pinned ? 'true' : 'false');
    const rename = iconButton('session-list__icon-btn', 'edit', 'Rename');
    rename.dataset.action = 'rename';
    const del = iconButton('session-list__icon-btn session-list__icon-btn--danger', 'trash', 'Delete');
    del.dataset.action = 'delete';
    actions.append(pin, rename, del);
    row.append(open, actions);
    return row;
  }

  _renameInput(r) {
    const input = /** @type {HTMLInputElement} */ (el('input', 'session-list__rename-input'));
    input.type = 'text';
    input.value = typeof r.title === 'string' ? r.title : '';
    input.maxLength = MAX_TITLE;
    input.setAttribute('aria-label', 'Rename session');
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      if (commit) this._commitRename(r.id, input.value);
      else this._cancelInline();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      // Esc ends the rename only; it must not reach the panel's Esc-to-close.
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    queueMicrotask(() => { if (input.isConnected) { input.focus(); input.select(); } });
    return input;
  }

  _deleteConfirm(r) {
    const box = el('div', 'session-list__confirm');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', `Delete ${displayTitle(r)}?`);
    box.appendChild(el('span', 'session-list__confirm-text', `Delete “${displayTitle(r)}”?`));
    const yes = el('button', 'session-list__confirm-btn session-list__confirm-btn--danger', 'Delete');
    yes.type = 'button';
    yes.dataset.action = 'confirm-delete';
    const no = el('button', 'session-list__confirm-btn', 'Cancel');
    no.type = 'button';
    no.dataset.action = 'cancel-inline';
    box.append(yes, no);
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this._cancelInline(); }
    });
    queueMicrotask(() => { if (no.isConnected) no.focus(); });
    return box;
  }

  _cancelInline() {
    const id = this._renamingId || this._confirmDeleteId;
    this._renamingId = null;
    this._confirmDeleteId = null;
    this._render();
    this._focusRow(id);
  }

  _focusRow(id) {
    if (!id) return;
    const row = Array.from(this._listEl.querySelectorAll('[data-session-id]')).find((n) => /** @type {HTMLElement} */ (n).dataset.sessionId === id);
    const btn = row && /** @type {HTMLElement|null} */ (row.querySelector('.session-list__open'));
    if (btn) btn.focus();
  }

  _onListClick(ev) {
    const target = /** @type {HTMLElement} */ (ev.target);
    const actionEl = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
    const row = /** @type {HTMLElement|null} */ (target.closest('[data-session-id]'));
    if (!actionEl || !row) return;
    const id = row.dataset.sessionId;
    switch (actionEl.dataset.action) {
      case 'open': this.select(id); break;
      case 'pin': this.togglePin(id); break;
      case 'rename': this.startRename(id); break;
      case 'delete': this.startDelete(id); break;
      case 'confirm-delete': this.delete(id); break;
      case 'cancel-inline': this._cancelInline(); break;
      default: break;
    }
  }

  // F2 renames and Delete asks to delete the focused row, as in a file list.
  _onListKey(ev) {
    const target = /** @type {HTMLElement} */ (ev.target);
    if (!target.classList.contains('session-list__open')) return;
    const row = /** @type {HTMLElement|null} */ (target.closest('[data-session-id]'));
    if (!row) return;
    if (ev.key === 'F2') { ev.preventDefault(); this.startRename(row.dataset.sessionId); }
    else if (ev.key === 'Delete') { ev.preventDefault(); this.startDelete(row.dataset.sessionId); }
  }

  /** @param {string} id */
  select(id) {
    const row = this.get(id);
    if (!row) return;
    this.setActive(id);
    for (const cb of Array.from(this._selectListeners)) cb(id, row);
  }

  startRename(id) {
    if (!this.get(id)) return;
    this._confirmDeleteId = null;
    this._renamingId = id;
    this._render();
  }

  startDelete(id) {
    if (!this.get(id)) return;
    this._renamingId = null;
    this._confirmDeleteId = id;
    this._render();
  }

  async _commitRename(id, value) {
    const row = this.get(id);
    this._renamingId = null;
    const title = String(value || '').trim();
    if (!row || title === (row.title || '').trim()) {
      this._render();
      this._focusRow(id);
      return;
    }
    if (!title) {
      this._render();
      this._showActionError('Couldn’t rename session: the name cannot be empty.');
      return;
    }
    try {
      const res = await call(this._ipc, 'session:rename', { sessionId: id, title });
      Object.assign(row, res.session && typeof res.session === 'object' ? res.session : { title });
      this._render();
      this._focusRow(id);
    } catch (err) {
      this._render();
      this._showActionError(`Couldn’t rename session: ${friendly(errText(err))}`);
    }
  }

  async togglePin(id) {
    const row = this.get(id);
    if (!row) return;
    const pinned = !row.pinned;
    try {
      const res = await call(this._ipc, 'session:pin', { sessionId: id, pinned });
      Object.assign(row, res.session && typeof res.session === 'object' ? res.session : { pinned });
      this._render();
    } catch (err) {
      this._showActionError(`Couldn’t ${pinned ? 'pin' : 'unpin'} session: ${friendly(errText(err))}`);
    }
  }

  async delete(id) {
    this._confirmDeleteId = null;
    try {
      await call(this._ipc, 'session:delete', { sessionId: id });
      this._rows = this._rows.filter((r) => r.id !== id);
      this._running.delete(id);
      if (this._activeId === id) this._activeId = null;
      this._render();
    } catch (err) {
      this._render();
      this._showActionError(`Couldn’t delete session: ${friendly(errText(err))}`);
    }
  }

  destroy() {
    this._ipc.removeListener('session:list-changed', this._onListChanged);
    this._ipc.removeListener('session:event', this._onSessionEvent);
    this._ipc.removeListener('agent:task-started', this._onAgentStarted);
    this._selectListeners.clear();
    this.el.remove();
  }
}

module.exports = SessionList;
