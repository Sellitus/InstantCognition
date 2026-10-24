/**
 * Menu — anchored popover menu shared by the toolbar overflow, row menus and
 * the styled Select.
 *
 *   const menu = new Menu({
 *     anchor: buttonEl,
 *     items: () => [
 *       { type: 'label', label: 'View' },
 *       { id: 'multi', label: 'Multi-Space', icon: 'multi', checked: true, shortcut: '⌘M', onSelect },
 *       { type: 'separator' },
 *       { id: 'find', label: 'Find', onSelect },
 *     ],
 *   });
 *   menu.toggle();
 *
 * `items` may be an array or a function, re-read on every open so checkmarks
 * reflect live state. The surface is portalled to <body> at --z-popover so it
 * paints over modal dropdowns; it is appended after a modal's focus trap ran,
 * so the trap's inert sweep never reaches it.
 *
 * Escape is registered with modalStack, so a menu opened inside a modal closes
 * itself and leaves the modal open.
 */

const modalStack = require('../../utils/modalStack');
const { icon } = require('../Icon');

const GAP = 6;
const EDGE = 8;

let seq = 0;

/** Pure placement: where a surface of size `size` goes next to rect `r`. */
function computePlacement(r, size, viewport, side, align) {
  let top;
  let left;
  let placed = side;
  const fitsBelow = r.bottom + GAP + size.h <= viewport.h - EDGE;
  const fitsAbove = r.top - GAP - size.h >= EDGE;
  const fitsRight = r.right + GAP + size.w <= viewport.w - EDGE;
  const fitsLeft = r.left - GAP - size.w >= EDGE;
  if (placed === 'bottom' && !fitsBelow && fitsAbove) placed = 'top';
  else if (placed === 'top' && !fitsAbove && fitsBelow) placed = 'bottom';
  else if (placed === 'right' && !fitsRight && fitsLeft) placed = 'left';
  else if (placed === 'left' && !fitsLeft && fitsRight) placed = 'right';

  if (placed === 'bottom' || placed === 'top') {
    top = placed === 'bottom' ? r.bottom + GAP : r.top - GAP - size.h;
    left = align === 'start' ? r.left : r.right - size.w;
  } else {
    left = placed === 'right' ? r.right + GAP : r.left - GAP - size.w;
    top = align === 'end' ? r.bottom - size.h : r.top;
  }
  left = Math.min(Math.max(EDGE, left), Math.max(EDGE, viewport.w - size.w - EDGE));
  top = Math.min(Math.max(EDGE, top), Math.max(EDGE, viewport.h - size.h - EDGE));
  return { top: Math.round(top), left: Math.round(left), side: placed };
}

/** The side a chrome-bar menu opens toward, from body[data-chrome-layout]. */
function chromeSide() {
  const layout = (document.body && document.body.dataset && document.body.dataset.chromeLayout) || 'left';
  return { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[layout] || 'bottom';
}

class Menu {
  /**
   * @param {{
   *   anchor: HTMLElement,
   *   items: Array<object> | (() => Array<object>),
   *   side?: 'bottom'|'top'|'left'|'right'|'chrome',
   *   align?: 'start'|'end',
   *   role?: 'menu'|'listbox',
   *   className?: string,
   *   ariaLabel?: string,
   *   onOpen?: () => void,
   *   onClose?: () => void,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.anchor) throw new Error('Menu requires an anchor element');
    this.anchor = opts.anchor;
    this._items = opts.items || [];
    this._side = opts.side || 'bottom';
    this._align = opts.align || 'end';
    this._role = opts.role || 'menu';
    this._className = opts.className || '';
    this._ariaLabel = opts.ariaLabel || null;
    this._onOpen = opts.onOpen || null;
    this._onClose = opts.onClose || null;
    this.id = `ic-menu-${++seq}`;
    this.el = null;
    this._layer = null;
    this._typeahead = '';
    this._typeaheadAt = 0;

    this._onDocKey = this._onDocKey.bind(this);
    this._onDocDown = this._onDocDown.bind(this);
    this._onViewportChange = this._onViewportChange.bind(this);

    this.anchor.setAttribute('aria-haspopup', this._role === 'listbox' ? 'listbox' : 'menu');
    this.anchor.setAttribute('aria-expanded', 'false');
  }

  isOpen() { return !!this.el; }

  toggle(opts) { this.isOpen() ? this.close() : this.open(opts); }

  /** @param {{focus?: 'first'|'last'|'selected'|'none'}} [opts] */
  open(opts = {}) {
    if (this.el) return;
    const items = typeof this._items === 'function' ? this._items() : this._items;
    const el = document.createElement('div');
    el.className = `ic-menu${this._className ? ' ' + this._className : ''}`;
    el.id = this.id;
    el.setAttribute('role', this._role);
    if (this._ariaLabel) el.setAttribute('aria-label', this._ariaLabel);
    el.tabIndex = -1;
    // A trailing check column on every row keeps shortcut hints aligned.
    if (this._role === 'listbox' || items.some((it) => typeof it.checked === 'boolean')) el.classList.add('ic-menu--checks');
    for (const item of items) el.appendChild(this._renderItem(item));
    el.addEventListener('keydown', (e) => this._onMenuKey(e));
    document.body.appendChild(el);
    this.el = el;
    this.anchor.setAttribute('aria-expanded', 'true');
    this.anchor.setAttribute('aria-controls', this.id);
    this.anchor.classList.add('is-menu-open');
    this._position();

    this._layer = modalStack.push();
    document.addEventListener('keydown', this._onDocKey, true);
    document.addEventListener('mousedown', this._onDocDown, true);
    window.addEventListener('resize', this._onViewportChange);
    window.addEventListener('blur', this._onViewportChange);

    const focusMode = opts.focus || 'first';
    const entries = this._entries();
    let target = null;
    if (focusMode === 'first') target = entries[0];
    else if (focusMode === 'last') target = entries[entries.length - 1];
    else if (focusMode === 'selected') target = entries.find((b) => b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-selected') === 'true') || entries[0];
    if (target) target.focus();
    else el.focus();
    if (typeof this._onOpen === 'function') this._onOpen();
  }

  /** @param {{restoreFocus?: boolean}} [opts] */
  close(opts = {}) {
    if (!this.el) return;
    const el = this.el;
    this.el = null;
    if (el.parentNode) el.parentNode.removeChild(el);
    if (this._layer) { modalStack.pop(this._layer); this._layer = null; }
    document.removeEventListener('keydown', this._onDocKey, true);
    document.removeEventListener('mousedown', this._onDocDown, true);
    window.removeEventListener('resize', this._onViewportChange);
    window.removeEventListener('blur', this._onViewportChange);
    this.anchor.setAttribute('aria-expanded', 'false');
    this.anchor.removeAttribute('aria-controls');
    this.anchor.classList.remove('is-menu-open');
    if (opts.restoreFocus && document.contains(this.anchor)) this.anchor.focus();
    if (typeof this._onClose === 'function') this._onClose();
  }

  destroy() { this.close(); }

  // -------- Rendering -----------------------------------------------------

  _renderItem(item) {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'ic-menu-sep';
      sep.setAttribute('role', 'separator');
      return sep;
    }
    if (item.type === 'label') {
      const label = document.createElement('div');
      label.className = 'ic-menu-label';
      label.setAttribute('role', 'presentation');
      label.textContent = item.label;
      return label;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ic-menu-item';
    if (item.danger) btn.classList.add('is-danger');
    if (item.id) btn.dataset.itemId = item.id;
    btn.tabIndex = -1;
    const checkable = typeof item.checked === 'boolean';
    if (this._role === 'listbox') {
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', item.checked ? 'true' : 'false');
    } else {
      btn.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
      if (checkable) btn.setAttribute('aria-checked', item.checked ? 'true' : 'false');
    }
    if (item.disabled) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    }

    const lead = document.createElement('span');
    lead.className = 'ic-menu-item-lead';
    if (item.icon) lead.appendChild(icon(item.icon));
    btn.appendChild(lead);

    const text = document.createElement('span');
    text.className = 'ic-menu-item-text';
    const title = document.createElement('span');
    title.className = 'ic-menu-item-title';
    title.textContent = item.label;
    text.appendChild(title);
    if (item.description) {
      const desc = document.createElement('span');
      desc.className = 'ic-menu-item-desc';
      desc.textContent = item.description;
      text.appendChild(desc);
    }
    btn.appendChild(text);

    if (item.shortcut) {
      const kbd = document.createElement('kbd');
      kbd.className = 'ic-menu-item-kbd';
      kbd.textContent = item.shortcut;
      btn.appendChild(kbd);
    }
    if (checkable || this._role === 'listbox') {
      const mark = document.createElement('span');
      mark.className = 'ic-menu-item-check';
      if (item.checked) mark.appendChild(icon('check'));
      btn.appendChild(mark);
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (item.disabled) return;
      this.close({ restoreFocus: true });
      if (typeof item.onSelect === 'function') item.onSelect(item);
    });
    btn.addEventListener('mousemove', () => {
      if (document.activeElement !== btn && !btn.disabled) btn.focus();
    });
    return btn;
  }

  _entries() {
    if (!this.el) return [];
    return /** @type {HTMLButtonElement[]} */ (Array.from(this.el.querySelectorAll('.ic-menu-item:not([disabled])')));
  }

  _position() {
    const el = this.el;
    if (!el) return;
    const side = this._side === 'chrome' ? chromeSide() : this._side;
    const r = this.anchor.getBoundingClientRect();
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    const viewport = {
      w: window.innerWidth || document.documentElement.clientWidth,
      h: window.innerHeight || document.documentElement.clientHeight,
    };
    const align = (side === 'left' || side === 'right') ? (this._align === 'end' && this._side === 'chrome' ? 'start' : this._align) : this._align;
    const p = computePlacement(r, size, viewport, side, align);
    el.style.top = `${p.top}px`;
    el.style.left = `${p.left}px`;
    el.dataset.side = p.side;
  }

  // -------- Events --------------------------------------------------------

  _onViewportChange() { this.close(); }

  _onDocDown(e) {
    if (!this.el) return;
    const t = /** @type {Node} */ (e.target);
    if (this.el.contains(t) || this.anchor.contains(t)) return;
    this.close();
  }

  _onDocKey(e) {
    if (!this.el || !this._layer || !modalStack.isTop(this._layer)) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      this.close({ restoreFocus: true });
    }
  }

  _onMenuKey(e) {
    const entries = this._entries();
    if (!entries.length) return;
    const idx = entries.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const move = (to) => { e.preventDefault(); entries[(to + entries.length) % entries.length].focus(); };
    switch (e.key) {
      case 'ArrowDown': return move(idx + 1);
      case 'ArrowUp': return move(idx < 0 ? entries.length - 1 : idx - 1);
      case 'Home': return move(0);
      case 'End': return move(entries.length - 1);
      case 'Tab': this.close(); return undefined;
      case 'Enter':
      case ' ':
        if (idx >= 0) { e.preventDefault(); entries[idx].click(); }
        return undefined;
      default:
        if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now();
          this._typeahead = (now - this._typeaheadAt < 600 ? this._typeahead : '') + e.key.toLowerCase();
          this._typeaheadAt = now;
          const start = idx + (this._typeahead.length === 1 ? 1 : 0);
          for (let i = 0; i < entries.length; i++) {
            const b = entries[(start + i) % entries.length];
            const t = (b.querySelector('.ic-menu-item-title') || b).textContent.toLowerCase();
            if (t.startsWith(this._typeahead)) { e.preventDefault(); b.focus(); break; }
          }
        }
        return undefined;
    }
  }
}

module.exports = Menu;
module.exports.Menu = Menu;
module.exports.computePlacement = computePlacement;
