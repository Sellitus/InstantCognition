// BrowserDock — in assistant mode the existing #tab-bar-wrap becomes a
// right-hand dock. This owns the collapse/expand button, the collapsed
// wrap's a11y state, and the dock's page tools: Record (RecordBar) and
// Annotate (AnnotationController). The wrap is only restyled in place: its
// webviews must never be reparented or hidden with display:none, or the
// guests reload.

const { icon } = require('../Icon');
const RecordBar = require('./RecordBar');
const AnnotationController = require('./AnnotationController');

const WRAP_ID = 'tab-bar-wrap';
const RECORD_LABELS = { off: 'Record actions as a skill', on: 'Stop recording' };
const ANNOTATE_LABELS = { off: 'Annotate an element on the page', on: 'Stop annotating' };

function defaultActiveWebview() {
  return typeof window.getActiveWebview === 'function' ? window.getActiveWebview() : null;
}

function toolButton(className, iconName, label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.appendChild(icon(iconName));
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function setPressed(btn, pressed, labels) {
  const label = pressed ? labels.on : labels.off;
  btn.setAttribute('aria-pressed', String(pressed));
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

/**
 * @typedef {object} BrowserDockOpts
 * @property {() => void} onToggle
 * @property {{ set: (k: string, v: any) => void }} [store]   ShellStore; mirrors recording/annotating
 * @property {any} [ipc]                                       ipcRenderer-shaped
 * @property {() => any} [getActiveWebview]
 * @property {(text: string) => void} [sendAnnotation]
 */

class BrowserDock {
  /** @param {BrowserDockOpts} opts */
  constructor(opts) {
    if (!opts || typeof opts.onToggle !== 'function') throw new TypeError('BrowserDock requires onToggle');
    // True while the dock holds the wrap collapsed, so expanding only strips
    // attributes the dock set. A modal's focus trap skips already-inert body
    // children, and data-inert-hold keeps a trap opened before the collapse
    // from releasing the wrap when it closes.
    this._ownsInert = false;
    this._opts = opts;
    this._getActiveWebview = opts.getActiveWebview || defaultActiveWebview;
    /** @type {RecordBar|null} */ this._recordBar = null;
    /** @type {AnnotationController|null} */ this._annotation = null;
    this._collapsed = false;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'assistant-dock-toggle';
    btn.setAttribute('aria-controls', WRAP_ID);
    btn.appendChild(icon('globe'));
    btn.addEventListener('click', () => opts.onToggle());
    this.el = btn;
    this.recordBtn = toolButton('assistant-dock-record', 'dot', RECORD_LABELS.off, () => this.recorder().toggle());
    this.annotateBtn = toolButton('assistant-dock-annotate', 'edit', ANNOTATE_LABELS.off, () => this.annotation().toggle());
    this.tools = [this.recordBtn, this.annotateBtn];
  }

  /** The Record & Replay bar, created on first use. */
  recorder() {
    if (!this._recordBar) {
      this._recordBar = new RecordBar({
        ipc: this._opts.ipc,
        store: this._opts.store,
        getActiveWebview: this._getActiveWebview,
        onStateChange: () => this._syncTools(),
        onSaved: (skill) => require('../Toast').success(`Saved skill${skill && skill.name ? ` "${skill.name}"` : ''}`),
      });
    }
    return this._recordBar;
  }

  /** The annotation controller, created on first use. */
  annotation() {
    if (!this._annotation) {
      this._annotation = new AnnotationController({
        store: this._opts.store,
        getActiveWebview: this._getActiveWebview,
        send: this._opts.sendAnnotation,
        onStateChange: () => this._syncTools(),
      });
    }
    return this._annotation;
  }

  _syncTools() {
    const recording = !!this._recordBar && this._recordBar.isRecording();
    const annotating = !!this._annotation && this._annotation.isActive();
    setPressed(this.recordBtn, recording, RECORD_LABELS);
    setPressed(this.annotateBtn, annotating, ANNOTATE_LABELS);
    // A live recording stays stoppable from a collapsed dock.
    this.recordBtn.disabled = this._collapsed && !recording;
    this.annotateBtn.disabled = this._collapsed;
  }

  /** @param {{ appMode: string, dockOpen: boolean }} state */
  sync(state) {
    const collapsed = state.appMode === 'assistant' && !state.dockOpen;
    const label = collapsed ? 'Show browser' : 'Hide browser';
    this.el.setAttribute('aria-label', label);
    this.el.title = label;
    this.el.setAttribute('aria-expanded', String(!collapsed));
    // The rail appends only this.el; the tools follow it once it is placed.
    if (this.el.parentNode && !this.recordBtn.isConnected) this.el.after(...this.tools);
    this._collapsed = collapsed;
    // The bubble is anchored to a page that is about to slide off screen.
    if (collapsed && this._annotation && this._annotation.isActive()) this._annotation.cancel();
    this._syncTools();
    if (this._recordBar) this._recordBar.reposition();
    const wrap = document.getElementById(WRAP_ID);
    if (!wrap) return;
    if (collapsed) {
      wrap.setAttribute('inert', '');
      wrap.setAttribute('data-inert-hold', '');
      wrap.setAttribute('aria-hidden', 'true');
      this._ownsInert = true;
    } else if (this._ownsInert) {
      wrap.removeAttribute('inert');
      wrap.removeAttribute('data-inert-hold');
      wrap.removeAttribute('aria-hidden');
      this._ownsInert = false;
    }
  }

  destroy() {
    if (this._annotation) this._annotation.destroy();
    if (this._recordBar) this._recordBar.destroy();
    for (const t of this.tools) t.remove();
  }
}

module.exports = BrowserDock;
