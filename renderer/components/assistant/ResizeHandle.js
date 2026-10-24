// ResizeHandle — a vertical splitter on the leading (left) edge of a
// right-docked pane. Pointer drags run over a full-window shield so a webview
// under the cursor cannot swallow mousemove/mouseup; arrow keys resize too.

const DRAG_THRESHOLD_PX = 3;
const KEY_STEP_PX = 16;
const KEY_STEP_LARGE_PX = 64;

/**
 * @typedef {object} ResizeHandleOpts
 * @property {string} label           accessible name, e.g. "Resize assistant sidebar"
 * @property {string} controls        id of the pane this handle resizes
 * @property {number} min
 * @property {number} max
 * @property {() => number} getWidth
 * @property {(px: number) => void} setWidth   live update while dragging
 * @property {() => void} commit               persist the settled width
 */

class ResizeHandle {
  /** @param {ResizeHandleOpts} opts */
  constructor(opts) {
    if (!opts || typeof opts.getWidth !== 'function' || typeof opts.setWidth !== 'function' || typeof opts.commit !== 'function') {
      throw new TypeError('ResizeHandle requires getWidth, setWidth and commit functions');
    }
    this._opts = opts;
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    const el = document.createElement('div');
    el.className = 'assistant-resize-handle';
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'vertical');
    el.setAttribute('aria-label', opts.label);
    el.setAttribute('aria-controls', opts.controls);
    el.setAttribute('aria-valuemin', String(opts.min));
    el.setAttribute('aria-valuemax', String(opts.max));
    el.tabIndex = 0;
    el.addEventListener('mousedown', this._onMouseDown);
    el.addEventListener('keydown', this._onKeyDown);
    this.el = el;
    this.sync();
  }

  sync() {
    this.el.setAttribute('aria-valuenow', String(Math.round(this._opts.getWidth())));
  }

  _apply(px) {
    this._opts.setWidth(px);
    this.sync();
  }

  _onKeyDown(e) {
    const { min, max } = this._opts;
    const cur = this._opts.getWidth();
    const step = e.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
    let next;
    // The handle sits on the pane's left edge: moving it left widens the pane.
    if (e.key === 'ArrowLeft') next = cur + step;
    else if (e.key === 'ArrowRight') next = cur - step;
    else if (e.key === 'Home') next = max;
    else if (e.key === 'End') next = min;
    else return;
    e.preventDefault();
    e.stopPropagation();
    this._apply(next);
    this._opts.commit();
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = this._opts.getWidth();
    let moved = false;
    const shield = document.createElement('div');
    shield.className = 'space-resize-overlay assistant-resize-shield';
    document.body.appendChild(shield);
    document.body.classList.add('assistant-resizing');

    const onMove = (ev) => {
      const d = ev.clientX - startX;
      if (!moved && Math.abs(d) <= DRAG_THRESHOLD_PX) return;
      moved = true;
      this._apply(startWidth - d);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      shield.remove();
      document.body.classList.remove('assistant-resizing');
      if (moved) this._opts.commit();
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }
}

module.exports = ResizeHandle;
