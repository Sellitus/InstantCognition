// InboxPane — the "Inbox" side pane: results that background sessions and
// routines delivered (InboxService via inbox:list), live via inbox:changed.
// Opening an item marks it read and hands its session to onOpen. Items:
// {id, sessionId, title, summary, ok, createdAt, read}; sessionId is null when
// a routine failed to start, so such an item has nothing to open. An
// unreadable inbox file (inbox_corrupt:) is recovered by clearing it.

const { relTime } = require('../agent/format');
const { icon } = require('../Icon');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errText(err) {
  return (err instanceof Error && err.message) || String(err);
}

async function call(ipc, channel, arg) {
  const res = await ipc.invoke(channel, arg);
  if (!res || res.ok === false) throw new Error((res && res.error) || `${channel} returned no reply`);
  return res;
}

/** Unread count from an inbox:list reply or an inbox:changed push; a malformed one throws. */
function unreadCount(res) {
  if (res && res.ok !== false && Number.isFinite(res.unread)) return Math.max(0, res.unread);
  if (!res || res.ok === false || !Array.isArray(res.items)) throw new Error((res && res.error) || 'inbox:list returned no items');
  return res.items.filter((i) => i && !i.read).length;
}

class InboxPane {
  /** @param {{ container: HTMLElement, onOpen: (sessionId: string, item: any) => void, ipc?: any }} opts */
  constructor(opts) {
    if (!opts || !(opts.container instanceof HTMLElement)) throw new TypeError('InboxPane requires a container');
    if (typeof opts.onOpen !== 'function') throw new TypeError('InboxPane requires onOpen');
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    this._onOpen = opts.onOpen;
    /** @type {any[]} */ this._items = [];
    this._loadError = null;
    this._actionError = null;
    this._confirmClear = false;
    this._seq = 0;
    /** @type {Set<(n: number) => void>} */ this._unreadListeners = new Set();
    this._build(opts.container);
    this._onChanged = () => { this.refresh(); };
    this._ipc.on('inbox:changed', this._onChanged);
    this._render();
  }

  _build(container) {
    const root = el('section', 'inbox-pane');
    root.setAttribute('aria-label', 'Inbox');
    const header = el('header', 'inbox-pane__header');
    header.appendChild(el('h2', 'inbox-pane__heading', 'Inbox'));
    this._toolbar = el('div', 'inbox-pane__toolbar');
    header.appendChild(this._toolbar);
    this._error = el('div', 'inbox-pane__error');
    this._error.setAttribute('role', 'alert');
    this._error.hidden = true;
    this._list = el('ul', 'inbox-pane__list');
    this._list.setAttribute('aria-label', 'Inbox items');
    this._list.addEventListener('click', (ev) => this._onListClick(ev));
    root.append(header, this._error, this._list);
    container.appendChild(root);
    this.el = root;
  }

  /** @param {(n: number) => void} cb @returns {() => void} */
  onUnreadChange(cb) {
    if (typeof cb !== 'function') throw new TypeError('InboxPane.onUnreadChange expects a function');
    this._unreadListeners.add(cb);
    return () => { this._unreadListeners.delete(cb); };
  }

  unread() { return this._items.filter((i) => !i.read).length; }

  items() { return this._items.slice(); }

  async refresh() {
    const seq = ++this._seq;
    try {
      const res = await call(this._ipc, 'inbox:list', {});
      if (seq !== this._seq) return;
      const items = Array.isArray(res.items) ? res.items : [];
      this._items = items.filter((i) => i && typeof i.id === 'string')
        .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
      this._loadError = null;
    } catch (err) {
      if (seq !== this._seq) return;
      this._loadError = errText(err);
    }
    this._render();
  }

  /** @param {string} id */
  async open(id) {
    const item = this._items.find((i) => i.id === id);
    if (!item) return;
    if (!item.read) await this.markRead(id);
    if (typeof item.sessionId === 'string' && item.sessionId) this._onOpen(item.sessionId, item);
    else this._setActionError('This item has no session to open.');
  }

  /** @param {string} id */
  async markRead(id) {
    const item = this._items.find((i) => i.id === id);
    if (!item || item.read) return;
    try {
      await call(this._ipc, 'inbox:mark-read', { id });
      item.read = true;
      this._render();
    } catch (err) {
      this._setActionError(`Couldn’t mark as read: ${errText(err)}`);
    }
  }

  async markAllRead() {
    try {
      await call(this._ipc, 'inbox:mark-read', { all: true });
      for (const item of this._items) item.read = true;
      this._render();
    } catch (err) {
      this._setActionError(`Couldn’t mark all as read: ${errText(err)}`);
    }
  }

  /** @param {string} id */
  async delete(id) {
    try {
      await call(this._ipc, 'inbox:delete', { id });
      this._items = this._items.filter((i) => i.id !== id);
      this._render();
    } catch (err) {
      this._setActionError(`Couldn’t delete item: ${errText(err)}`);
    }
  }

  async clear() {
    this._confirmClear = false;
    try {
      await call(this._ipc, 'inbox:clear', {});
      this._items = [];
      this._loadError = null;
      this._render();
    } catch (err) {
      this._render();
      this._setActionError(`Couldn’t clear the inbox: ${errText(err)}`);
    }
  }

  _setActionError(message) {
    this._actionError = message;
    this._renderError();
  }

  _onListClick(ev) {
    const target = /** @type {HTMLElement} */ (ev.target);
    const btn = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
    const row = /** @type {HTMLElement|null} */ (target.closest('[data-item-id]'));
    if (!btn || !row) return;
    const id = row.dataset.itemId;
    if (btn.dataset.action === 'open') this.open(id);
    else if (btn.dataset.action === 'mark-read') this.markRead(id);
    else if (btn.dataset.action === 'delete') this.delete(id);
  }

  _renderError() {
    this._error.replaceChildren();
    const message = this._loadError ? `Couldn’t load the inbox: ${this._loadError}` : this._actionError;
    this._error.hidden = !message;
    if (!message) return;
    this._error.appendChild(el('span', '', message));
    const button = (label, onClick) => {
      const btn = el('button', 'inbox-pane__error-btn', label);
      btn.type = 'button';
      btn.addEventListener('click', onClick);
      this._error.appendChild(btn);
    };
    if (!this._loadError) {
      button('Dismiss', () => { this._actionError = null; this._renderError(); });
      return;
    }
    button('Retry', () => { this.refresh(); });
    // main never overwrites an unreadable inbox on its own; clearing is the
    // explicit recovery, and it discards whatever the file held.
    if (this._loadError.startsWith('inbox_corrupt:')) button('Clear inbox', () => { this.clear(); });
  }

  _renderToolbar() {
    this._toolbar.replaceChildren();
    if (!this._items.length) return;
    if (this._confirmClear) {
      const group = el('div', 'inbox-pane__confirm');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Clear the inbox?');
      group.appendChild(el('span', 'inbox-pane__confirm-text', 'Clear all?'));
      const yes = el('button', 'inbox-pane__tool inbox-pane__tool--danger', 'Clear');
      yes.type = 'button';
      yes.addEventListener('click', () => this.clear());
      const no = el('button', 'inbox-pane__tool', 'Cancel');
      no.type = 'button';
      no.addEventListener('click', () => { this._confirmClear = false; this._render(); });
      group.append(yes, no);
      this._toolbar.appendChild(group);
      queueMicrotask(() => { if (no.isConnected) no.focus(); });
      return;
    }
    if (this.unread()) {
      const all = el('button', 'inbox-pane__tool', 'Mark all read');
      all.type = 'button';
      all.addEventListener('click', () => this.markAllRead());
      this._toolbar.appendChild(all);
    }
    const clear = el('button', 'inbox-pane__tool', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', () => { this._confirmClear = true; this._render(); });
    this._toolbar.appendChild(clear);
  }

  _render() {
    this._renderError();
    this._renderToolbar();
    this._list.replaceChildren();
    const n = this.unread();
    for (const cb of Array.from(this._unreadListeners)) cb(n);
    if (this._loadError) return;
    if (!this._items.length) {
      this._list.appendChild(el('li', 'inbox-pane__empty', 'Nothing here yet. Results from background sessions and routines land in the inbox.'));
      return;
    }
    for (const item of this._items) this._list.appendChild(this._renderItem(item));
  }

  _renderItem(item) {
    const li = el('li', `inbox-pane__item${item.read ? '' : ' is-unread'}${item.ok === false ? ' is-failed' : ''}`);
    li.dataset.itemId = item.id;
    const canOpen = typeof item.sessionId === 'string' && item.sessionId !== '';
    const open = el(canOpen ? 'button' : 'div', 'inbox-pane__open');
    if (canOpen) {
      /** @type {HTMLButtonElement} */ (open).type = 'button';
      open.dataset.action = 'open';
    } else open.classList.add('is-static');
    const head = el('span', 'inbox-pane__item-head');
    if (!item.read) {
      const dot = el('span', 'inbox-pane__unread-dot');
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Unread');
      head.appendChild(dot);
    }
    head.appendChild(el('span', 'inbox-pane__title', typeof item.title === 'string' && item.title.trim() ? item.title : 'Session result'));
    head.appendChild(el('span', `inbox-pane__outcome inbox-pane__outcome--${item.ok === false ? 'failed' : 'ok'}`, item.ok === false ? 'Failed' : 'Done'));
    open.appendChild(head);
    if (typeof item.summary === 'string' && item.summary.trim()) open.appendChild(el('span', 'inbox-pane__summary', item.summary.trim()));
    open.appendChild(el('span', 'inbox-pane__time', relTime(item.createdAt)));
    const actions = el('div', 'inbox-pane__actions');
    if (!item.read) {
      const read = el('button', 'inbox-pane__icon-btn');
      read.type = 'button';
      read.dataset.action = 'mark-read';
      read.setAttribute('aria-label', 'Mark as read');
      read.title = 'Mark as read';
      read.appendChild(icon('check'));
      actions.appendChild(read);
    }
    const del = el('button', 'inbox-pane__icon-btn inbox-pane__icon-btn--danger');
    del.type = 'button';
    del.dataset.action = 'delete';
    del.setAttribute('aria-label', 'Delete');
    del.title = 'Delete';
    del.appendChild(icon('trash'));
    actions.appendChild(del);
    li.append(open, actions);
    return li;
  }

  destroy() {
    this._ipc.removeListener('inbox:changed', this._onChanged);
    this._unreadListeners.clear();
    this.el.remove();
  }
}

module.exports = InboxPane;
module.exports.unreadCount = unreadCount;
