// CommandPalette.js — Cmd+K fuzzy command launcher.
// Renders inside the unified .app-dropdown shell (size: md). Filters as
// the user types, navigates with arrow keys, executes with Enter, dismisses
// with Escape or backdrop click.

const { getCommands, filterAndRank } = require('../utils/commandRegistry');
const Dropdown = require('./dropdown/Dropdown');
const fx = require('../fx');

class CommandPalette {
  constructor() {
    this.contextProvider = null;
    this.content = null;
    this.input = null;
    this.list = null;
    this.results = [];
    this.selectedIndex = 0;
    this._dropdown = null;
  }

  initialize(contextProvider) {
    this.contextProvider = typeof contextProvider === 'function' ? contextProvider : () => ({});
    this._buildContent();
    this._dropdown = new Dropdown({
      id: 'command-palette',
      size: 'md',
      ariaLabel: 'Command Palette',
      onClose: () => { /* no-op */ },
    });
    this._dropdown.mount(this.content);
  }

  _buildContent() {
    const root = document.createElement('div');
    root.className = 'command-palette-content';

    const inputWrap = document.createElement('div');
    inputWrap.className = 'command-palette-input-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'command-palette-input';
    input.placeholder = 'Search commands, spaces, or AI workflows…';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('data-autofocus', 'true');
    inputWrap.appendChild(input);

    const list = document.createElement('ul');
    list.className = 'command-palette-list';
    list.setAttribute('role', 'listbox');

    const footer = document.createElement('div');
    footer.className = 'command-palette-footer';
    footer.innerHTML = ''
      + '<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>'
      + '<span><kbd>Enter</kbd> run</span>'
      + '<span><kbd>Esc</kbd> close</span>';

    root.appendChild(inputWrap);
    root.appendChild(list);
    root.appendChild(footer);

    input.addEventListener('input', () => this._refresh());
    input.addEventListener('keydown', (e) => this._onInputKey(e));
    list.addEventListener('mousedown', (e) => {
      const tgt = /** @type {HTMLElement} */ (e.target);
      const item = tgt.closest('[data-index]');
      if (!item) return;
      e.preventDefault();
      const idx = parseInt(item.getAttribute('data-index'), 10);
      this._execute(idx);
    });

    this.content = root;
    this.input = input;
    this.list = list;
  }

  open() {
    if (!this._dropdown) return;
    this.input.value = '';
    this._refresh();
    this._dropdown.open();
  }

  close() {
    if (this._dropdown) this._dropdown.close();
  }

  toggle() {
    if (!this._dropdown) return;
    if (this._dropdown.isOpen()) this.close();
    else this.open();
  }

  get isOpen() {
    return !!(this._dropdown && this._dropdown.isOpen());
  }

  _onInputKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this._execute(this.selectedIndex);
    }
    // Esc handled by Dropdown controller.
  }

  _move(delta) {
    if (!this.results.length) return;
    this.selectedIndex = (this.selectedIndex + delta + this.results.length) % this.results.length;
    this._renderSelection();
    const el = this.list.querySelector('[data-index="' + this.selectedIndex + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  _refresh() {
    const ctx = this.contextProvider ? this.contextProvider() : {};
    const all = getCommands(ctx);
    const query = this.input.value.trim();
    this.results = filterAndRank(all, query).slice(0, 50);
    this.selectedIndex = 0;
    this._render();
  }

  _render() {
    if (!this.list) return;
    if (!this.results.length) {
      this.list.innerHTML = '<li class="command-palette-empty">No matching commands</li>';
      return;
    }
    const html = this.results.map((cmd, i) => {
      const sel = i === 0 ? ' selected' : '';
      const subtitle = cmd.subtitle ? '<div class="cp-sub">' + _escape(cmd.subtitle) + '</div>' : '';
      return ''
        + '<li class="command-palette-item' + sel + '" data-index="' + i + '" role="option">'
        + '  <span class="cp-icon">' + _escape(cmd.icon || '') + '</span>'
        + '  <div class="cp-text">'
        + '    <div class="cp-title">' + _escape(cmd.title) + '</div>'
        + subtitle
        + '  </div>'
        + '  <span class="cp-type">' + _escape(cmd.type || '') + '</span>'
        + '</li>';
    }).join('');
    this.list.innerHTML = html;
    fx.glide(this.list, '.command-palette-item.selected');
  }

  _renderSelection() {
    const items = this.list.querySelectorAll('[data-index]');
    items.forEach((el, i) => {
      if (i === this.selectedIndex) el.classList.add('selected');
      else el.classList.remove('selected');
    });
    fx.glide(this.list, '.command-palette-item.selected');
  }

  _execute(index) {
    const cmd = this.results[index];
    if (!cmd) return;
    this.close();
    try { if (typeof cmd.action === 'function') cmd.action(); }
    catch (err) { console.error('CommandPalette action failed:', err); }
  }
}

function _escape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = new CommandPalette();
