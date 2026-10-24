// BranchNav — the "‹ 2/3 ›" switcher on a message that has sibling versions
// (an edit or a regenerate creates one). It only reports the sibling to open;
// the caller moves the session head. Hidden for a node without siblings.

/** @param {string} tag @param {string} [className] @param {string} [text] */
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {string} className @param {string} [text] @returns {HTMLButtonElement} */
function button(className, text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  if (text !== undefined) b.textContent = text;
  return b;
}

class BranchNav {
  /** @param {{ onSelect: (siblingId: string) => void }} opts */
  constructor(opts) {
    if (!opts || typeof opts.onSelect !== 'function') throw new TypeError('BranchNav expects an onSelect function');
    this._onSelect = opts.onSelect;
    this._info = null;
    this._disabled = false;
    this.el = node('div', 'chat-branch-nav');
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Message versions');
    this.prevBtn = button('chat-branch-nav__btn', '‹');
    this.prevBtn.setAttribute('aria-label', 'Previous version');
    this.label = node('span', 'chat-branch-nav__label');
    this.label.setAttribute('aria-live', 'polite');
    this.nextBtn = button('chat-branch-nav__btn', '›');
    this.nextBtn.setAttribute('aria-label', 'Next version');
    this.el.append(this.prevBtn, this.label, this.nextBtn);
    this.prevBtn.addEventListener('click', () => this._step(-1));
    this.nextBtn.addEventListener('click', () => this._step(1));
    this.el.hidden = true;
  }

  /** @param {{ index: number, count: number, siblingIds: string[] }|null} info */
  set(info) {
    const valid = info && Array.isArray(info.siblingIds) && info.count > 1
      && Number.isInteger(info.index) && info.index >= 0 && info.index < info.siblingIds.length;
    this._info = valid ? info : null;
    this.el.hidden = !this._info;
    this._render();
  }

  // A running turn owns the head; switching versions under it is refused by
  // main, so the arrows stay disabled until the run ends.
  setDisabled(disabled) {
    this._disabled = !!disabled;
    this._render();
  }

  _render() {
    const info = this._info;
    if (!info) { this.label.textContent = ''; return; }
    this.label.textContent = `${info.index + 1}/${info.count}`;
    this.prevBtn.disabled = this._disabled || info.index <= 0;
    this.nextBtn.disabled = this._disabled || info.index >= info.siblingIds.length - 1;
  }

  _step(delta) {
    const info = this._info;
    if (!info || this._disabled) return;
    const target = info.siblingIds[info.index + delta];
    if (!target) return;
    this._onSelect(target);
  }
}

module.exports = BranchNav;
