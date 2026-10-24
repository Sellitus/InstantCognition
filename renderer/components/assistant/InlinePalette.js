// InlinePalette — the composer's `/` and `@` completion list.
//
// `/` at the very start of the message lists commands (commands:list: the
// built-in slash actions plus enabled skills). `@` after whitespace lists the
// context tokens chatContext.parseInlineContext understands (@page,
// @selection, @spaces, @browsing) followed by workspace files
// (workspace:search-files). While the project file @-mention menu is open the
// `@` palette stays closed so the two never stack.
//
// A plain listbox driven by aria-activedescendant: focus never leaves the
// textarea, options act on mousedown so they win against the textarea blur,
// and blur closes the palette. A failed IPC call becomes an error row.
//
// onKey(e) is the composer's first keydown hook. With a modal open it does
// nothing; with the palette open it consumes ↑/↓, Enter, Tab, Shift+Tab and
// Esc (Esc closes only the palette and stops propagation, so the panel's own
// Esc handling — typewriter skip, browser-mode close — does not also run).

const { errMsg } = require('../../../shared/errMsg');
const modalStack = require('../../utils/modalStack');

const CONTEXT_ITEMS = [
  { key: 'page', detail: 'Attach the active page' },
  { key: 'selection', detail: 'Attach the selected text' },
  { key: 'spaces', detail: 'Attach the visible panes' },
  { key: 'browsing', detail: 'Search your history and bookmarks' },
];
const MAX_QUERY = 64;
const MAX_ROWS = 30;
const FILE_SEARCH_DEBOUNCE_MS = 120;
const TRIGGER_RE = /(^|\s)([/@])([^\s]*)$/;

let paletteSeq = 0;

/** @param {string} tag @param {string} [className] @param {string} [text] */
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {string} p workspace-relative path */
function fileToken(p) { return /\s/.test(p) ? `@"${p.replace(/"/g, '')}"` : `@${p}`; }

/**
 * @typedef {{ id: string, label: string, detail?: string, kind: string, insert?: string, command?: any, error?: boolean, loading?: boolean }} PaletteItem
 */

class InlinePalette {
  /**
   * @param {{
   *   input: HTMLTextAreaElement,
   *   container: HTMLElement,
   *   ipc?: { invoke: Function },
   *   isModalOpen?: () => boolean,
   *   onCommand?: (command: any) => boolean,
   *   debounceMs?: number,
   * }} opts
   *   onCommand: runs a chosen command instead of inserting it; returns true
   *   when it handled the command (the typed `/token` is then removed).
   */
  constructor(opts) {
    this._input = opts.input;
    this._container = opts.container;
    this._ipc = opts.ipc || require('electron').ipcRenderer;
    this._isModalOpen = typeof opts.isModalOpen === 'function' ? opts.isModalOpen : () => modalStack.depth() > 0;
    this._onCommand = typeof opts.onCommand === 'function' ? opts.onCommand : () => false;
    this._debounceMs = Number.isFinite(opts.debounceMs) ? Number(opts.debounceMs) : FILE_SEARCH_DEBOUNCE_MS;
    this._id = `inline-palette-${++paletteSeq}`;
    /** @type {{ trigger: string, start: number, query: string }|null} */
    this._token = null;
    /** @type {PaletteItem[]} */
    this._items = [];
    this._active = -1;
    this._seq = 0;
    this._fileTimer = null;
    /** @type {any[]|null} commands cached for one open/close cycle */
    this._commands = null;
    this._inserting = false;

    this.el = node('div', 'inline-palette');
    this.el.id = this._id;
    this.el.setAttribute('role', 'listbox');
    this.el.setAttribute('aria-label', 'Suggestions');
    this.el.hidden = true;
    this.el.addEventListener('mousedown', (e) => this._onPointer(e));
    this._container.appendChild(this.el);

    this._onInput = () => { if (!this._inserting) this.update(); };
    this._onBlur = () => this.close();
    this._input.addEventListener('input', this._onInput);
    this._input.addEventListener('blur', this._onBlur);
  }

  isOpen() { return !this.el.hidden; }

  /** Re-read the token under the caret and open, refresh or close. */
  update() {
    const token = this._readToken();
    if (!token) { this.close(); return; }
    const reopened = !this._token || this._token.trigger !== token.trigger;
    if (reopened) this._commands = null;
    this._token = token;
    if (token.trigger === '/') this._loadCommands(token.query);
    else this._loadMentions(token.query);
  }

  _readToken() {
    const input = this._input;
    const value = input.value || '';
    const caret = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
    const m = TRIGGER_RE.exec(value.slice(0, caret));
    if (!m) return null;
    const trigger = m[2];
    const query = m[3];
    const start = caret - query.length - 1;
    if (query.length > MAX_QUERY) return null;
    // Commands only lead the message; `/` mid-sentence is a path or a fraction.
    if (trigger === '/' && start !== 0) return null;
    if (trigger === '@' && this._container.querySelector('.proj-mention-menu')) return null;
    return { trigger, start, query };
  }

  _loadCommands(query) {
    const seq = ++this._seq;
    if (this._commands) { this._render(this._commandItems(this._commands, query)); return; }
    this._render([{ id: 'loading', label: 'Loading commands…', kind: 'status', loading: true }]);
    Promise.resolve()
      .then(() => this._ipc.invoke('commands:list'))
      .then((res) => {
        if (seq !== this._seq || !this._token) return;
        if (!res || res.ok === false || !Array.isArray(res.commands)) throw new Error((res && res.error) || 'commands_unavailable');
        this._commands = res.commands;
        this._render(this._commandItems(res.commands, this._token.query));
      })
      .catch((err) => {
        if (seq !== this._seq || !this._token) return;
        this._render([{ id: 'error', label: `Couldn’t load commands: ${errMsg(err)}`, kind: 'status', error: true }]);
      });
  }

  /** @returns {PaletteItem[]} */
  _commandItems(commands, query) {
    const q = String(query || '').toLowerCase();
    return commands
      .filter((c) => c && typeof c.name === 'string' && (!q || c.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
      .slice(0, MAX_ROWS)
      .map((c) => ({ id: `cmd-${c.name}`, label: `/${c.name}`, detail: c.description || '', kind: c.kind === 'skill' ? 'skill' : 'command', insert: `/${c.name} `, command: c }));
  }

  _loadMentions(query) {
    const seq = ++this._seq;
    const q = String(query || '').toLowerCase();
    const contexts = CONTEXT_ITEMS
      .filter((c) => !q || c.key.startsWith(q))
      .map((c) => ({ id: `ctx-${c.key}`, label: `@${c.key}`, detail: c.detail, kind: 'context', insert: `@${c.key} ` }));
    this._render([...contexts, { id: 'loading', label: 'Searching workspace files…', kind: 'status', loading: true }]);
    clearTimeout(this._fileTimer);
    this._fileTimer = setTimeout(() => {
      Promise.resolve()
        .then(() => this._ipc.invoke('workspace:search-files', { query }))
        .then((res) => {
          if (seq !== this._seq || !this._token) return;
          if (!res || res.ok === false || !Array.isArray(res.results)) throw new Error((res && res.error) || 'search_unavailable');
          const files = res.results.slice(0, MAX_ROWS).map((f, i) => ({
            id: `file-${i}`, label: f.path, detail: res.roots > 1 ? f.rootName : '', kind: 'file', insert: `${fileToken(f.path)} `,
          }));
          this._render([...contexts, ...files]);
        })
        .catch((err) => {
          if (seq !== this._seq || !this._token) return;
          this._render([...contexts, { id: 'error', label: `Couldn’t search workspace files: ${errMsg(err)}`, kind: 'status', error: true }]);
        });
    }, this._debounceMs);
  }

  /** @param {PaletteItem[]} items */
  _render(items) {
    this._items = items;
    this.el.textContent = '';
    if (!items.length) { this._hide(); return; }
    items.forEach((item, i) => {
      const row = node('div', `inline-palette__item inline-palette__item--${item.kind}`);
      row.id = `${this._id}-opt-${i}`;
      row.setAttribute('role', 'option');
      row.dataset.index = String(i);
      if (item.error || item.loading) row.setAttribute('aria-disabled', 'true');
      if (item.error) row.classList.add('is-error');
      row.appendChild(node('span', 'inline-palette__label', item.label));
      if (item.detail) row.appendChild(node('span', 'inline-palette__detail', item.detail));
      this.el.appendChild(row);
    });
    const firstPick = items.findIndex((it) => !it.error && !it.loading);
    this._setActive(firstPick);
    this.el.hidden = false;
    this._input.setAttribute('aria-controls', this._id);
    this._input.setAttribute('aria-autocomplete', 'list');
    this._input.setAttribute('aria-expanded', 'true');
  }

  _setActive(i) {
    this._active = i;
    Array.from(this.el.children).forEach((row, k) => row.setAttribute('aria-selected', k === i ? 'true' : 'false'));
    if (i >= 0) {
      const row = /** @type {HTMLElement} */ (this.el.children[i]);
      this._input.setAttribute('aria-activedescendant', row.id);
      if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    } else {
      this._input.removeAttribute('aria-activedescendant');
    }
  }

  _move(dir) {
    const picks = this._items.map((it, i) => (it.error || it.loading ? -1 : i)).filter((i) => i >= 0);
    if (!picks.length) return;
    const at = picks.indexOf(this._active);
    const next = at < 0 ? (dir > 0 ? 0 : picks.length - 1) : (at + dir + picks.length) % picks.length;
    this._setActive(picks[next]);
  }

  /**
   * Composer keydown hook. Returns true when the palette consumed the key.
   * @param {KeyboardEvent} e
   */
  onKey(e) {
    if (this._isModalOpen() || !this.isOpen() || e.isComposing) return false;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return true;
    }
    if (!plain) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._move(e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    // Shift+Tab walks the list too, so it never reaches the permission-mode cycle.
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); this._move(-1); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const item = this._items[this._active];
      if (item && !item.error && !item.loading) this.choose(item);
      else this.close();
      return true;
    }
    return false;
  }

  /** @param {MouseEvent} e */
  _onPointer(e) {
    e.preventDefault();
    const target = e.target instanceof Element ? e.target.closest('[role="option"]') : null;
    if (!target || target.getAttribute('aria-disabled') === 'true') return;
    const item = this._items[Number(/** @type {HTMLElement} */ (target).dataset.index)];
    if (item) this.choose(item);
  }

  /** @param {PaletteItem} item */
  choose(item) {
    const token = this._token;
    if (!token) return;
    const input = this._input;
    const value = input.value || '';
    const end = token.start + 1 + token.query.length;
    const handled = item.kind === 'command' && item.command ? this._onCommand(item.command) === true : false;
    let insert = handled ? '' : (item.insert || '');
    if (insert.endsWith(' ') && /^\s/.test(value.slice(end))) insert = insert.slice(0, -1);
    const next = value.slice(0, token.start) + insert + value.slice(end);
    this.close();
    input.value = next;
    const caret = token.start + insert.length;
    try { input.setSelectionRange(caret, caret); } catch (err) { console.error('[InlinePalette] setSelectionRange failed:', errMsg(err)); }
    // Listeners that size the textarea or mirror its value must see the change,
    // but it must not reopen the palette.
    this._inserting = true;
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } finally { this._inserting = false; }
  }

  _hide() {
    this.el.hidden = true;
    this._input.removeAttribute('aria-activedescendant');
    this._input.removeAttribute('aria-controls');
    this._input.setAttribute('aria-expanded', 'false');
  }

  close() {
    this._seq++;
    clearTimeout(this._fileTimer);
    this._fileTimer = null;
    this._token = null;
    this._items = [];
    this._active = -1;
    this._commands = null;
    this.el.textContent = '';
    this._hide();
  }

  destroy() {
    this.close();
    this._input.removeEventListener('input', this._onInput);
    this._input.removeEventListener('blur', this._onBlur);
    this.el.remove();
  }
}

module.exports = InlinePalette;
module.exports.CONTEXT_ITEMS = CONTEXT_ITEMS;
