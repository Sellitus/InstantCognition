// Dropdown.js — unified controller for chrome-bar dropdowns.
//
// Each chrome-bar panel owns one Dropdown instance and feeds content
// into it via mount(). The controller builds a backdrop + .app-dropdown
// surface, runs the open/close animation lifecycle, dismisses on Esc
// or backdrop click, and traps focus while open. CSS in dropdown.css
// owns the visual shell, sizing, and per-position slide animation.

const modalStack = require('../../utils/modalStack');
const { trap } = require('../../utils/focusTrap');
const { icon } = require('../Icon');

const ANIMATION_FALLBACK_MS = 320;

// focus() can throw on a detached or hidden element; a missed focus must not
// abort an open or close, but it is reported.
function focusOrWarn(el) {
  if (!el || typeof el.focus !== 'function') return;
  try { el.focus(); }
  catch (err) { console.warn('[Dropdown] focus failed:', (err instanceof Error && err.message) || err); }
}

class Dropdown {
  constructor(opts = {}) {
    this._id = opts.id || null;
    this._size = opts.size || 'md';
    this._ariaLabel = opts.ariaLabel || null;
    this._onOpen = opts.onOpen || null;
    this._onClose = opts.onClose || null;
    this._closeOnBackdrop = opts.closeOnBackdrop !== false;
    this._closeOnEsc = opts.closeOnEsc !== false;
    // Optional predicate: return false to let an inner control own this Esc
    // (Dropdown abstains — no close, no stopPropagation — so the event reaches
    // the focused field's own keydown handler).
    this._shouldCloseOnEsc = typeof opts.shouldCloseOnEsc === 'function' ? opts.shouldCloseOnEsc : null;
    // Persistent: keep surface + backdrop mounted in document.body for the
    // panel's lifetime. Used by panels that wire up event handlers via
    // document.getElementById and rely on their inputs being present in the
    // document tree even when closed (e.g., SettingsMenu).
    this._persistent = !!opts.persistent;
    // No backdrop: render the surface without the dimming overlay and let
    // the page behind stay interactive. Used by lightweight, non-modal
    // surfaces (e.g., FindBar) that should coexist with the page.
    this._noBackdrop = !!opts.noBackdrop;
    if (this._noBackdrop) this._closeOnBackdrop = false;

    this._backdrop = null;
    this._surface = null;
    this._header = null;
    this._titleEl = null;
    this._headerSlot = null;
    this._closeBtn = null;
    this._body = null;
    this._mounted = null;

    this._isOpen = false;
    this._layer = null;
    this._isAnimating = false;
    this._previousFocus = null;

    this._fallbackTimer = null;
    this._onAnimEnd = null;
    this._onKey = this._onKey.bind(this);
    this._onBackdropDown = this._onBackdropDown.bind(this);


    this._build();
  }

  // -------- Public API ----------------------------------------------------

  get el() { return this._surface; }
  get backdropEl() { return this._backdrop; }
  get bodyEl() { return this._body; }
  isOpen() { return this._isOpen; }

  mount(contentEl) {
    if (!contentEl || !this._body) return;
    this._mounted = contentEl;
    while (this._body.firstChild) this._body.removeChild(this._body.firstChild);
    this._body.appendChild(contentEl);
  }

  setHeader({ title = null, slot = null, showClose = true } = {}) {
    if (title === null && slot === null && !showClose) {
      if (this._header && this._header.parentNode) this._header.parentNode.removeChild(this._header);
      this._header = null;
      this._titleEl = null;
      this._headerSlot = null;
      this._closeBtn = null;
      return;
    }
    if (!this._header) this._buildHeader();
    if (this._titleEl) this._titleEl.textContent = title || '';
    if (this._headerSlot) {
      while (this._headerSlot.firstChild) this._headerSlot.removeChild(this._headerSlot.firstChild);
      if (slot) this._headerSlot.appendChild(slot);
    }
    if (this._closeBtn) this._closeBtn.style.display = showClose ? '' : 'none';
  }

  setSize(tier) {
    if (!this._surface) return;
    this._surface.classList.remove('app-dropdown--sm', 'app-dropdown--md', 'app-dropdown--lg', 'app-dropdown--xl', 'app-dropdown--xxl');
    if (['sm', 'md', 'lg', 'xl', 'xxl'].includes(tier)) {
      this._surface.classList.add(`app-dropdown--${tier}`);
      this._size = tier;
    }
  }

  open() {
    if (this._isOpen || this._isAnimating) return;
    this._previousFocus = /** @type {HTMLElement} */ (document.activeElement);

    // A modal opened earlier marks every other body child inert, and a
    // persistent surface stays mounted while closed — so it can arrive here
    // already inert, which makes the whole panel unclickable.
    this._surface.removeAttribute('inert');
    this._backdrop.removeAttribute('inert');

    if (this._persistent) {
      // Already mounted; just unhide.
      if (!this._noBackdrop) this._backdrop.style.display = '';
      this._surface.style.display = '';
    } else {
      if (!this._noBackdrop) document.body.appendChild(this._backdrop);
      document.body.appendChild(this._surface);
    }

    // Force layout so the animation triggers from the initial frame.
    this._surface.offsetWidth;

    const noAnim = document.body.classList.contains('no-animations');
    this._isAnimating = true;

    if (!this._noBackdrop) this._backdrop.classList.add('is-opening');
    this._surface.classList.add('is-opening');

    if (noAnim) {
      this._finishOpen();
    } else {
      this._waitForAnimation(this._surface, () => this._finishOpen());
    }

    document.addEventListener('keydown', this._onKey, true);
    this._layer = modalStack.push();
    if (this._closeOnBackdrop) {
      this._backdrop.addEventListener('mousedown', this._onBackdropDown);
    }
    this._isOpen = true;
    if (this._noBackdrop) {
      // Non-modal: the trap would mark the whole app inert while it is open.
      focusOrWarn(this._initialFocusTarget());
    } else {
      // One trap implementation for every modal surface: wraps Tab, skips
      // hidden rows, and marks the rest of the document inert.
      this._releaseTrap = trap(this._surface, {
        initialFocus: this._initialFocusTarget(),
        allow: [this._backdrop],
      });
    }
    if (typeof this._onOpen === 'function') this._onOpen();
  }

  close() {
    if (!this._isOpen) return;
    this._isAnimating = true;
    if (!this._noBackdrop) {
      this._backdrop.classList.remove('is-opening', 'is-open');
      this._backdrop.classList.add('is-closing');
    }
    this._surface.classList.remove('is-opening', 'is-open');
    this._surface.classList.add('is-closing');

    document.removeEventListener('keydown', this._onKey, true);
    if (this._layer) { modalStack.pop(this._layer); this._layer = null; }
    this._backdrop.removeEventListener('mousedown', this._onBackdropDown);
    if (this._releaseTrap) {
      // Clear the handle first: a throwing release must not leave a trap that
      // the next close will try to release again.
      const release = this._releaseTrap;
      this._releaseTrap = null;
      try { release(); }
      catch (err) { console.error('[Dropdown] focus trap release failed:', (err instanceof Error && err.message) || err); }
    }

    const noAnim = document.body.classList.contains('no-animations');
    if (noAnim) {
      this._finishClose();
    } else {
      this._waitForAnimation(this._surface, () => this._finishClose());
    }
  }

  toggle() { this._isOpen ? this.close() : this.open(); }

  destroy() {
    this.close();
    this._backdrop = null;
    this._surface = null;
    this._header = null;
    this._titleEl = null;
    this._headerSlot = null;
    this._closeBtn = null;
    this._body = null;
  }

  // -------- Build ---------------------------------------------------------

  _build() {
    const backdrop = document.createElement('div');
    backdrop.className = 'app-dropdown-backdrop';
    if (this._id) backdrop.id = `${this._id}-backdrop`;

    const surface = document.createElement('div');
    const sizeTier = ['sm', 'md', 'lg', 'xl', 'xxl'].includes(this._size) ? this._size : 'md';
    this._size = sizeTier;
    surface.className = `app-dropdown app-dropdown--${sizeTier}`;
    surface.setAttribute('role', 'dialog');
    surface.setAttribute('aria-modal', this._noBackdrop ? 'false' : 'true');
    surface.tabIndex = -1;
    if (this._id) surface.id = this._id;
    if (this._ariaLabel) surface.setAttribute('aria-label', this._ariaLabel);

    const body = document.createElement('div');
    body.className = 'app-dropdown-body';
    surface.appendChild(body);

    this._backdrop = backdrop;
    this._surface = surface;
    this._body = body;

    if (this._persistent && document && document.body) {
      backdrop.style.display = 'none';
      surface.style.display = 'none';
      if (!this._noBackdrop) document.body.appendChild(backdrop);
      document.body.appendChild(surface);
    }
  }

  _buildHeader() {
    const header = document.createElement('div');
    header.className = 'app-dropdown-header';

    const title = document.createElement('div');
    title.className = 'app-dropdown-title';

    const slot = document.createElement('div');
    slot.className = 'app-dropdown-header-slot';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'app-dropdown-close';
    close.setAttribute('aria-label', 'Close');
    close.appendChild(icon('close', { size: 16 }));
    close.addEventListener('click', () => this.close());

    header.appendChild(title);
    header.appendChild(slot);
    header.appendChild(close);

    this._surface.insertBefore(header, this._body);

    this._header = header;
    this._titleEl = title;
    this._headerSlot = slot;
    this._closeBtn = close;
  }

  // -------- Lifecycle helpers --------------------------------------------

  _finishOpen() {
    if (!this._surface || !this._backdrop) return;
    if (!this._noBackdrop) {
      this._backdrop.classList.remove('is-opening');
      this._backdrop.classList.add('is-open');
    }
    this._surface.classList.remove('is-opening');
    this._surface.classList.add('is-open');
    this._isAnimating = false;
  }

  _finishClose() {
    this._isOpen = false;
    this._isAnimating = false;
    if (this._persistent) {
      if (this._backdrop && !this._noBackdrop) this._backdrop.style.display = 'none';
      if (this._surface) this._surface.style.display = 'none';
    } else {
      if (!this._noBackdrop && this._backdrop && this._backdrop.parentNode) this._backdrop.parentNode.removeChild(this._backdrop);
      if (this._surface && this._surface.parentNode) this._surface.parentNode.removeChild(this._surface);
    }
    if (this._backdrop) this._backdrop.classList.remove('is-closing', 'is-open');
    if (this._surface) this._surface.classList.remove('is-closing', 'is-open');

    const prev = this._previousFocus;
    this._previousFocus = null;
    if (prev && document.contains(prev)) focusOrWarn(prev);
    if (typeof this._onClose === 'function') this._onClose();
  }

  _waitForAnimation(el, done) {
    if (this._fallbackTimer) clearTimeout(this._fallbackTimer);
    let fired = false;
    const handler = (e) => {
      if (e.target !== el) return;
      if (fired) return;
      fired = true;
      el.removeEventListener('animationend', handler);
      el.removeEventListener('animationcancel', handler);
      clearTimeout(this._fallbackTimer);
      done();
    };
    el.addEventListener('animationend', handler);
    el.addEventListener('animationcancel', handler);
    this._fallbackTimer = setTimeout(() => {
      if (fired) return;
      fired = true;
      el.removeEventListener('animationend', handler);
      el.removeEventListener('animationcancel', handler);
      done();
    }, ANIMATION_FALLBACK_MS);
  }

  // An explicit [data-autofocus] wins; otherwise the trap picks the first
  // focusable itself.
  _initialFocusTarget() {
    if (!this._surface) return null;
    return /** @type {HTMLElement} */ (this._surface.querySelector('[data-autofocus]'));
  }

  _onKey(e) {
    if (!this._closeOnEsc) return;
    // A confirm or prompt opened over this dropdown owns Escape until it closes.
    if (this._layer && !modalStack.isTop(this._layer)) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      if (this._shouldCloseOnEsc && this._shouldCloseOnEsc(e) === false) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  _onBackdropDown(e) {
    if (e.target !== this._backdrop) return;
    e.preventDefault();
    this.close();
  }

}

module.exports = Dropdown;
